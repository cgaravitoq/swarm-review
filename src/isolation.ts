/**
 * Control/target identities shared by the local driver and the Cloudflare
 * Worker. The Sandbox SDK has no uid option on exec/startProcess, so every
 * runtime command drops with setpriv; root is setup only.
 */

export const CONTROL_UID = 1101;
export const TARGET_UID = 1102;
export const BROKER_PORT = 8317;
export const CONTROL_DIR = "/opt/review/control";
export const MODEL_BROKER = "/opt/review/model-broker.ts";
export const BROKER_LEDGER = `${CONTROL_DIR}/provider-usage.jsonl`;
export const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/i;
export const CANARY_MAX_BYTES = 16_384;
const SHA_40 = /^[0-9a-f]{40}$/;
const SHA_64 = /^[0-9a-f]{64}$/;
const CANARY_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_TIMEOUT_SECONDS = 86_400;

export const posixQuote = (value: string) =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export function assertCloudRunId(runId: string) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `run id must match [a-z0-9]([a-z0-9._-]{0,46}[a-z0-9])?: ${runId}`,
    );
  }
  return runId;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isNonNegInt = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;

const isPositiveInt = (value: unknown, max: number): value is number =>
  isNonNegInt(value, max) && value > 0;

export const brokerPrepareCommand = `mkdir -p ${CONTROL_DIR} && chown ${CONTROL_UID}:${CONTROL_UID} ${CONTROL_DIR} && chmod 0700 ${CONTROL_DIR}`;

export const brokerSecureCommand = `chown ${CONTROL_UID}:${CONTROL_UID} ${CONTROL_DIR}/broker.json && chmod 0600 ${CONTROL_DIR}/broker.json`;

export const brokerStartCommand = `setpriv --reuid=${CONTROL_UID} --regid=${CONTROL_UID} --clear-groups bun ${posixQuote(MODEL_BROKER)} ${posixQuote(`${CONTROL_DIR}/broker.json`)}`;

export const targetChownCommand = (directory: string) =>
  `chown -R ${TARGET_UID}:${TARGET_UID} ${posixQuote(directory)}`;

/**
 * Environment the target is allowed to hold: the addressing half of a
 * provider's identity, never its credential.
 *
 * Pi refuses to configure Workers AI unless the account id is in its own
 * environment, and an account id is an address - the broker still holds the
 * only bearer that makes it usable. The allowlist is what keeps this from
 * becoming a channel for anything else.
 */
const TARGET_ENV_NAMES = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"];

export function parseTargetEnv(value: unknown) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("targetEnv must be an object");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
      if (!TARGET_ENV_NAMES.includes(name)) {
        throw new Error(`targetEnv name not allowed: ${name}`);
      }
      if (!isNonEmptyString(raw) || /\s/.test(raw)) {
        throw new Error(`targetEnv value invalid: ${name}`);
      }
      return [name, raw];
    }),
  );
}

export const targetReviewCommand = (
  directory: string,
  totalTimeoutSeconds: number,
  runner: string,
  targetEnv: Readonly<Record<string, string>> = {},
) => {
  if (!isPositiveInt(totalTimeoutSeconds, MAX_TIMEOUT_SECONDS)) {
    throw new Error("totalTimeoutSeconds invalid");
  }
  const quotedDir = posixQuote(directory);
  const quotedLog = posixQuote(`${directory}/run.log`);
  const provided = Object.entries(parseTargetEnv(targetEnv))
    .map(([name, value]) => `${name}=${posixQuote(value)} `)
    .join("");
  return `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups env HOME=/home/review-target PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ${provided}PI_CODING_AGENT_DIR=${quotedDir} timeout -k 15 ${totalTimeoutSeconds} ${posixQuote(runner)} ${quotedDir} >> ${quotedLog} 2>&1`;
};

export const BRIDGE_COMMAND_MAX_BYTES = 16_384;

export function parseBridgeCommand(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("command must be an object");
  }
  const command = value as Record<string, unknown>;
  const type = command["type"];
  if (
    type !== "accept" &&
    type !== "prompt" &&
    type !== "inspect" &&
    type !== "cancel"
  ) {
    throw new Error(`unsupported command: ${String(type)}`);
  }
  if (type === "prompt") {
    if (typeof command["message"] !== "string" || !command["message"]) {
      throw new Error("prompt command requires message");
    }
    const streamingBehavior = command["streamingBehavior"];
    if (
      streamingBehavior !== undefined &&
      streamingBehavior !== "steer" &&
      streamingBehavior !== "followUp"
    ) {
      throw new Error("prompt command has an unsupported streamingBehavior");
    }
    return {
      type,
      message: command["message"],
      ...(streamingBehavior ? { streamingBehavior } : {}),
    };
  }
  return { type };
}

const targetSetpriv = (runner: string, directory: string) =>
  `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups ${posixQuote(runner)} ${posixQuote(directory)}`;

export const bridgeCommandPayload = (
  command: ReturnType<typeof parseBridgeCommand>,
) => JSON.stringify(command);

export const bridgeCommandFile = (directory: string, sequence: number) =>
  `${directory}/command-${sequence}.json`;

export function targetSendCommand(
  directory: string,
  runner: string,
  command: ReturnType<typeof parseBridgeCommand>,
) {
  const payload = bridgeCommandPayload(command);
  if (payload.length > BRIDGE_COMMAND_MAX_BYTES) {
    throw new Error("command too large");
  }
  return `${targetSetpriv(runner, directory)} --send ${posixQuote(payload)}`;
}

export function targetSendFileCommand(
  directory: string,
  runner: string,
  path: string,
) {
  return `${targetSetpriv(runner, directory)} --send-file ${posixQuote(path)}`;
}

export const targetBrokerReadProbe = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups sh -c 'if cat ${CONTROL_DIR}/broker.json >/dev/null 2>&1; then printf READ; else printf DENIED; fi'`;

export const controlBrokerStatProbe = `setpriv --reuid=${CONTROL_UID} --regid=${CONTROL_UID} --clear-groups sh -c 'if test -r ${CONTROL_DIR}/broker.json; then printf READABLE; else printf UNREADABLE; fi'`;

export const brokerListenProbe = `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${BROKER_PORT}/`;

/** Installed SDK CommandClient posts here with Content-Type only, no bearer. */
export const CONTROL_API_URL = "http://127.0.0.1:3000/api/execute";
export const CONTROL_API_PROBE_PATH = "/tmp/review-pi-control-api-probe.json";
const CONTROL_API_PROBE_BODY =
  '{"command":"id -u","sessionId":"containment-probe"}';

export const targetControlApiProbe = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups curl -sS --max-time 15 -o ${posixQuote(CONTROL_API_PROBE_PATH)} -w '%{http_code}' -H ${posixQuote("content-type: application/json")} --data-binary ${posixQuote(CONTROL_API_PROBE_BODY)} ${CONTROL_API_URL}`;

export function interpretControlApiProbe(httpStatus: number, body: string) {
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    return {
      escaped: false as const,
      uid: null,
      reason: `http_${httpStatus}`,
    };
  }
  let stdout = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      if (typeof record["stdout"] === "string")
        stdout = record["stdout"].trim();
    }
  } catch {}
  const uid = Number.parseInt(stdout, 10);
  if (!Number.isInteger(uid)) {
    return { escaped: false as const, uid: null, reason: "unparsed" };
  }
  if (uid === 0 || uid === CONTROL_UID) {
    return {
      escaped: true as const,
      uid,
      reason: "control_api_runs_privileged",
    };
  }
  return { escaped: false as const, uid, reason: "contained" };
}

export function parseBrokerConfig(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("broker config missing");
  }
  const config = value as Record<string, unknown>;
  const capsValue = config["caps"];
  if (
    typeof capsValue !== "object" ||
    capsValue === null ||
    Array.isArray(capsValue)
  ) {
    throw new Error("broker caps missing");
  }
  const capsRecord = capsValue as Record<string, unknown>;
  const maxRequests = capsRecord["maxRequests"];
  const maxRetriesPerRequest = capsRecord["maxRetriesPerRequest"];
  const maxCumulativeInputTokens = capsRecord["maxCumulativeInputTokens"];
  const maxCumulativeOutputTokens = capsRecord["maxCumulativeOutputTokens"];
  const maxRequestBytes = capsRecord["maxRequestBytes"];
  if (
    !isPositiveInt(maxRequests, 10_000) ||
    !isNonNegInt(maxRetriesPerRequest, 16) ||
    !isPositiveInt(maxCumulativeInputTokens, 100_000_000) ||
    !isPositiveInt(maxCumulativeOutputTokens, 100_000_000) ||
    !isPositiveInt(maxRequestBytes, 64 * 1024 * 1024)
  ) {
    throw new Error("broker caps invalid");
  }
  const caps = {
    maxRequests,
    maxRetriesPerRequest,
    maxCumulativeInputTokens,
    maxCumulativeOutputTokens,
    maxRequestBytes,
  };
  if (config["port"] !== BROKER_PORT) {
    throw new Error("broker port mismatch");
  }
  if (!isNonEmptyString(config["handle"]) || /[\r\n]/.test(config["handle"])) {
    throw new Error("broker handle missing");
  }
  if (!isNonEmptyString(config["upstreamBaseUrl"])) {
    throw new Error("broker upstream missing");
  }
  if (!config["upstreamBaseUrl"].startsWith("https://")) {
    throw new Error("broker upstream must be https");
  }
  if (
    !isNonEmptyString(config["upstreamAuthorization"]) ||
    !config["upstreamAuthorization"].startsWith("Bearer ")
  ) {
    throw new Error("broker authorization missing");
  }
  const bearer = config["upstreamAuthorization"].slice("Bearer ".length);
  if (!bearer || config["handle"].includes(bearer)) {
    throw new Error("broker handle must not carry the bearer");
  }
  if (config["ledgerPath"] !== BROKER_LEDGER) {
    throw new Error("broker ledger must stay in the control directory");
  }
  const accountId = config["upstreamAccountId"];
  return {
    port: BROKER_PORT,
    handle: config["handle"],
    upstreamBaseUrl: config["upstreamBaseUrl"],
    upstreamAuthorization: config["upstreamAuthorization"],
    ...(isNonEmptyString(accountId) ? { upstreamAccountId: accountId } : {}),
    caps,
    ledgerPath: BROKER_LEDGER,
  };
}

const shaObject = (value: unknown, label: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} missing`);
  }
  const sha = (value as Record<string, unknown>)["sha"];
  if (!isNonEmptyString(sha) || !SHA_40.test(sha)) {
    throw new Error(`${label} must be a full SHA`);
  }
  return { sha };
};

export function parseCloudJob(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job missing");
  }
  const job = value as Record<string, unknown>;
  if (!isNonEmptyString(job["runId"])) throw new Error("runId missing");
  const runId = assertCloudRunId(job["runId"]);
  if (
    !isNonEmptyString(job["expectedRunnerSha"]) ||
    !SHA_64.test(job["expectedRunnerSha"])
  ) {
    throw new Error("expectedRunnerSha must be a sha256 hex digest");
  }
  if (!isNonEmptyString(job["provider"])) throw new Error("provider missing");
  if (!isNonEmptyString(job["model"])) throw new Error("model missing");
  if (!isNonEmptyString(job["thinking"])) throw new Error("thinking missing");
  if (typeof job["prompt"] !== "string") throw new Error("prompt missing");
  if (!isNonEmptyString(job["checkCommand"]))
    throw new Error("checkCommand missing");
  if (!isPositiveInt(job["installTimeoutSeconds"], MAX_TIMEOUT_SECONDS)) {
    throw new Error("installTimeoutSeconds invalid");
  }
  if (!isPositiveInt(job["piTimeoutSeconds"], MAX_TIMEOUT_SECONDS)) {
    throw new Error("piTimeoutSeconds invalid");
  }
  if (!isPositiveInt(job["totalTimeoutSeconds"], MAX_TIMEOUT_SECONDS)) {
    throw new Error("totalTimeoutSeconds invalid");
  }
  const FAIL_STEPS = ["clone", "install", "check", "review"] as const;
  const failStep = FAIL_STEPS.find((step) => step === job["failStep"]);
  if (job["failStep"] !== undefined && failStep === undefined) {
    throw new Error("failStep invalid");
  }
  const pullRequest = job["pullRequest"];
  if (pullRequest !== undefined && !isPositiveInt(pullRequest, 1_000_000_000)) {
    throw new Error("pullRequest invalid");
  }
  const targetEnv = parseTargetEnv(job["targetEnv"]);
  return {
    ...(Object.keys(targetEnv).length > 0 ? { targetEnv } : {}),
    runId,
    expectedRunnerSha: job["expectedRunnerSha"],
    head: shaObject(job["head"], "head"),
    base: shaObject(job["base"], "base"),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    provider: job["provider"],
    model: job["model"],
    thinking: job["thinking"],
    prompt: job["prompt"],
    checkCommand: job["checkCommand"],
    installTimeoutSeconds: job["installTimeoutSeconds"],
    piTimeoutSeconds: job["piTimeoutSeconds"],
    totalTimeoutSeconds: job["totalTimeoutSeconds"],
    supervised: true as const,
    ...(typeof job["reviewerContext"] === "string"
      ? { reviewerContext: job["reviewerContext"] }
      : {}),
    ...(failStep !== undefined ? { failStep } : {}),
  };
}

export function parseCloudRunRequest(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid run request");
  }
  const request = value as Record<string, unknown>;
  const job = parseCloudJob(request["job"]);
  const broker = parseBrokerConfig(request["broker"]);
  if (typeof request["modelsJson"] !== "string") {
    throw new Error("modelsJson missing");
  }
  const bearer = broker.upstreamAuthorization.slice("Bearer ".length);
  if (JSON.stringify(job).includes(bearer)) {
    throw new Error("job must not carry the model bearer");
  }
  if (request["modelsJson"].includes(bearer)) {
    throw new Error("models.json must not carry the model bearer");
  }
  const canaryRequest = request["canaryRequest"];
  let parsedCanary: { path: string; body: string } | undefined;
  if (canaryRequest !== undefined) {
    if (
      typeof canaryRequest !== "object" ||
      canaryRequest === null ||
      Array.isArray(canaryRequest)
    ) {
      throw new Error("canary request invalid");
    }
    const path = (canaryRequest as Record<string, unknown>)["path"];
    const body = (canaryRequest as Record<string, unknown>)["body"];
    if (
      !isNonEmptyString(path) ||
      !CANARY_PATH.test(path) ||
      path.includes("..")
    ) {
      throw new Error("canary request path must be origin-form");
    }
    if (!isNonEmptyString(body)) {
      throw new Error("canary request body missing");
    }
    parsedCanary = { path, body };
  }
  return {
    job,
    broker,
    modelsJson: request["modelsJson"],
    canary: request["canary"] === true,
    ...(parsedCanary ? { canaryRequest: parsedCanary } : {}),
  };
}

export const targetCanaryCommand = (
  directory: string,
  handle: string,
  targetUrl: string,
) => {
  if (
    !isNonEmptyString(targetUrl) ||
    !/^https?:\/\//.test(targetUrl) ||
    /[\s]/.test(targetUrl)
  ) {
    throw new Error("canary target url invalid");
  }
  if (!isNonEmptyString(handle) || /[\r\n]/.test(handle)) {
    throw new Error("broker handle missing");
  }
  return `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups curl -sS --max-time 60 -o ${posixQuote(`${directory}/canary-response.txt`)} -w '%{http_code}' -H ${posixQuote(`authorization: Bearer ${handle}`)} -H ${posixQuote("content-type: application/json")} --data-binary @${posixQuote(`${directory}/canary-request.json`)} ${posixQuote(targetUrl)}`;
};

const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : null;

const providerEvents = (body: string) => {
  const events: Record<string, unknown>[] = [];
  const push = (raw: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (record) events.push(record);
    } catch {}
  };
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (payload && payload !== "[DONE]") push(payload);
    }
  }
  push(body);
  return events;
};

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record["content"] === "string") return record["content"];
  if (typeof record["text"] === "string") return record["text"];
  if (Array.isArray(record["content"])) {
    return record["content"].map(textOf).join("");
  }
  return "";
};

const eventError = (event: Record<string, unknown>) => {
  if (event["error"] != null) return true;
  if (event["type"] === "error") return true;
  if (event["stopReason"] === "error" || event["finish_reason"] === "error") {
    return true;
  }
  const nested = asRecord(event["response"]);
  return nested?.["error"] != null;
};

const eventStop = (event: Record<string, unknown>) => {
  if (event["done"] === true) return "stop";
  if (typeof event["stopReason"] === "string") return event["stopReason"];
  if (typeof event["finish_reason"] === "string") return event["finish_reason"];
  if (
    event["status"] === "completed" ||
    event["type"] === "response.completed"
  ) {
    return "stop";
  }
  const choices = event["choices"];
  if (Array.isArray(choices) && choices[0]) {
    const choice = asRecord(choices[0]);
    if (typeof choice?.["finish_reason"] === "string") {
      return choice["finish_reason"];
    }
  }
  return "";
};

const eventOutput = (event: Record<string, unknown>) => {
  const parts: string[] = [];
  if (typeof event["output_text"] === "string")
    parts.push(event["output_text"]);
  if (typeof event["text"] === "string") parts.push(event["text"]);
  const choices = event["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const record = asRecord(choice);
      if (!record) continue;
      parts.push(textOf(record["message"]));
      parts.push(textOf(record["delta"]));
      parts.push(textOf(record["text"]));
    }
  }
  const output = event["output"];
  if (Array.isArray(output)) {
    for (const item of output) parts.push(textOf(item));
  }
  return parts.join("");
};

/** A 200 SSE/JSON body is not success until it carries a stop and output. */
export function interpretProviderCanary(httpStatus: number, body: string) {
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    return {
      completed: false as const,
      reason: `http_${httpStatus}`,
      stopReason: "",
      output: "",
    };
  }
  const events = providerEvents(body);
  if (events.some(eventError)) {
    return {
      completed: false as const,
      reason: "provider_error",
      stopReason: "error",
      output: "",
    };
  }
  let output = "";
  let stopReason = "";
  for (const event of events) {
    output += eventOutput(event);
    const stop = eventStop(event);
    if (stop) stopReason = stop;
  }
  const clipped = output.trim().slice(0, 400);
  if (stopReason === "error") {
    return {
      completed: false as const,
      reason: "provider_error",
      stopReason,
      output: clipped,
    };
  }
  if (stopReason !== "stop" && stopReason !== "completed") {
    return {
      completed: false as const,
      reason: "incomplete",
      stopReason,
      output: clipped,
    };
  }
  if (!clipped) {
    return {
      completed: false as const,
      reason: "empty_output",
      stopReason,
      output: "",
    };
  }
  return {
    completed: true as const,
    reason: "completed",
    stopReason,
    output: clipped,
  };
}

export const reviewProcessActive = (
  processes: readonly { command?: string; status?: string }[],
) =>
  processes.some(
    (process) =>
      typeof process.command === "string" &&
      process.command.includes("review-run.sh") &&
      (process.status === "starting" || process.status === "running"),
  );
