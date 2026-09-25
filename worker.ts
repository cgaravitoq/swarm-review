/**
 * Disposable review-Pi control Worker.
 *
 * One sandbox per run, keyed by `runId`. The Worker is a control plane: git
 * and model bytes leave through run-scoped proxies. Usage counters live in the
 * run's Durable Object; a caller bearer lives there, and Worker credentials
 * live in the vault. Neither reaches a container uid.
 */

import { DurableObject } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

import { createCodexRelayTransport } from "./src/codex-relay";
import { CredentialVault } from "./src/credential-vault";
import { gitCapability, proxyGitFetch } from "./src/git-proxy";
import {
  assertCloudRunId,
  BRIDGE_COMMAND_MAX_BYTES,
  bridgeCommandFile,
  bridgeCommandPayload,
  CANARY_MAX_BYTES,
  CONTROL_API_PROBE_PATH,
  CONTROL_UID,
  interpretControlApiProbe,
  interpretProviderCanary,
  parseBridgeCommand,
  parseCloudRunRequest,
  posixQuote,
  TARGET_UID,
  targetCanaryCommand,
  targetChownCommand,
  targetControlApiProbe,
  targetReviewCommand,
  targetSendCommand,
  targetSendFileCommand,
} from "./src/isolation";
import {
  emptyModelTotals,
  type ModelSession,
  type ModelUsage,
  modelCapability,
  modelProxyBaseUrl,
  modelsJsonForProxy,
  openaiCodexBrokerHandle,
  proxyModelFetch,
  publicModelUsage,
  reserveAttempt,
} from "./src/model-proxy";
import {
  firstSourceMismatch,
  MAX_ARTIFACT_BYTES,
  parseExpectedSources,
  parseSourceFingerprint,
  REVIEW_RUNNER,
  runDir,
  sourceFingerprintCommand,
  sourceMismatchDetail,
} from "./src/protocol";
import { SESSION_CAPS } from "./src/provider-budget";

const MODEL_SESSION_KEY = "modelSession";
const PROBE_SESSIONS_KEY = "probeSessions";
const MODEL_SEALS_KEY = "modelSeals";
const COMMAND_SEQUENCE_KEY = "commandSequence";

export class CredentialVaultObject extends DurableObject<unknown> {
  private readonly vault: CredentialVault;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.vault = new CredentialVault(state.storage);
  }

  seed(provider: string, value: unknown) {
    return this.vault.seed(provider, value);
  }
  status() {
    return this.vault.status();
  }
  credential(provider: string, rejectedAccessToken?: string) {
    return this.vault.credential(provider, rejectedAccessToken);
  }
}

export class ReviewSandbox extends Sandbox<ReviewPiEnv> {
  async putProbeSessions(sessions: Record<string, ModelSession>) {
    await this.ctx.storage.put(PROBE_SESSIONS_KEY, sessions);
  }

  async clearProbeSessions() {
    await this.ctx.storage.delete(PROBE_SESSIONS_KEY);
  }

  private async sessionFor(handle?: string) {
    const probes =
      await this.ctx.storage.get<Record<string, ModelSession>>(
        PROBE_SESSIONS_KEY,
      );
    if (probes) return { session: probes[handle ?? ""], probes };
    return {
      session: await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY),
      probes: null,
    };
  }

  async putModelSession(session: ModelSession) {
    await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    await this.ctx.storage.put(MODEL_SEALS_KEY, []);
  }

  async consumeModelAttempt(handle?: string) {
    const { session, probes } = await this.sessionFor(handle);
    if (!session) return { ok: false as const, reason: "no_session" };
    const refusal = reserveAttempt(
      session.totals,
      session.caps,
      session.retryPending === true,
    );
    if (refusal) return { ok: false as const, reason: refusal };
    session.retryPending = false;
    if (probes) await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
    else await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    return { ok: true as const, session };
  }

  async recordModelAttempt(
    usage: ModelUsage | null,
    retryable: boolean,
    seal: string | null,
    handle?: string,
  ) {
    const { session, probes } = await this.sessionFor(handle);
    if (!session) return;
    const input = usage?.input ?? null;
    if (input !== null) {
      session.totals.input = (session.totals.input ?? 0) + input;
    } else if (session.totals.inputUnobserved !== undefined) {
      session.totals.inputUnobserved += 1;
    }
    const output = usage?.output ?? null;
    if (output !== null) {
      session.totals.output = (session.totals.output ?? 0) + output;
    } else if (session.totals.outputUnobserved !== undefined) {
      session.totals.outputUnobserved += 1;
    }
    if (session.totals.unended !== undefined) session.totals.unended -= 1;
    session.retryPending = retryable;
    if (probes) await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
    else await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    if (probes) return;
    await this.ctx.storage.put(MODEL_SEALS_KEY, [
      ...((await this.modelSeals()) ?? []),
      seal,
    ]);
  }

  /**
   * Kept apart from the session, so clearing the credential at stop leaves
   * the record a repeated stop has to answer with.
   */
  async modelSeals() {
    return (
      (await this.ctx.storage.get<(string | null)[]>(MODEL_SEALS_KEY)) ?? null
    );
  }

  async modelUsage() {
    return publicModelUsage(
      await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY),
    );
  }

  /** What the proxy checks a request against before it spends a slot on it. */
  async openModelSession(handle?: string) {
    const { session } = await this.sessionFor(handle);
    if (!session) return null;
    return {
      handle: session.handle,
      caps: session.caps,
      upstreamBaseUrl: session.upstreamBaseUrl,
    };
  }

  async clearModelSession() {
    await this.ctx.storage.delete(MODEL_SESSION_KEY);
  }

  async nextCommandSequence() {
    const sequence =
      ((await this.ctx.storage.get<number>(COMMAND_SEQUENCE_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(COMMAND_SEQUENCE_KEY, sequence);
    return sequence;
  }
}

export class CodexRelaySandbox extends Sandbox<ReviewPiEnv> {
  override enableInternet = true;
  override allowedHosts = ["chatgpt.com"];
  override interceptHttps = false;
}

type ReviewPiEnv = Record<
  "REVIEW_SANDBOX",
  DurableObjectNamespace<ReviewSandbox>
> &
  Record<"CREDENTIAL_VAULT", DurableObjectNamespace<CredentialVaultObject>> &
  Record<"CODEX_RELAY", DurableObjectNamespace<CodexRelaySandbox>> &
  Record<"PROBE_RESULTS", R2Bucket> &
  Record<"CONTROL_SECRET" | "GITHUB_READ_TOKEN", string> & {
    /** https clone URL the run's containers fetch through the Git proxy. */
    TARGET_REPOSITORY?: string;
  };

const ARTIFACTS = [
  "status.json",
  "steps.jsonl",
  "report.json",
  "trace.jsonl",
  "review-error.json",
  "run.log",
  "install.log",
] as const;
const RPC_TIMEOUT_MS = 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const authorized = (request: Request, secret: string) => {
  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered.length !== secret.length) return false;
  let mismatch = 0;
  for (let index = 0; index < secret.length; index += 1) {
    mismatch |= offered.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return mismatch === 0;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function bounded<T>(
  label: string,
  work: Promise<T>,
  timeoutMs = RPC_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function destroySandbox(sandbox: ReturnType<typeof getSandbox>) {
  try {
    await bounded("sandbox.destroy", sandbox.destroy());
    return {
      attempted: true as const,
      acknowledged: true as const,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true as const,
      acknowledged: false as const,
      error: messageOf(error),
    };
  }
}

/** Read one bounded file, reporting its real size so truncation is never silent. */
async function readArtifact(
  sandbox: ReturnType<typeof getSandbox>,
  path: string,
) {
  const quoted = posixQuote(path);
  const size = await bounded(
    `artifact stat ${path}`,
    sandbox.exec(`stat -c %s ${quoted} 2>/dev/null || echo -1`),
  );
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes < 0)
    return { path, exists: false as const };
  const head = await bounded(
    `artifact read ${path}`,
    sandbox.exec(`head -c ${MAX_ARTIFACT_BYTES} ${quoted}`),
  );
  return {
    path,
    exists: true as const,
    bytes,
    truncated: bytes > MAX_ARTIFACT_BYTES,
    content: head.stdout,
  };
}

const readArtifacts = (
  sandbox: ReturnType<typeof getSandbox>,
  directory: string,
) =>
  Promise.all(
    ARTIFACTS.map(async (name) => {
      const path = `${directory}/${name}`;
      try {
        return await readArtifact(sandbox, path);
      } catch (error) {
        return { path, exists: false as const, error: messageOf(error) };
      }
    }),
  );

const isolation = {
  mode: "worker-proxy" as const,
  controlUid: CONTROL_UID,
  targetUid: TARGET_UID,
};

type ProbePhase = {
  status: "ok" | "failed" | "unobserved";
  durationMs: number | null;
  durationReason: string | null;
  phase: string | null;
  httpStatus: number | null;
  reason: string | null;
};

const unobserved = (): ProbePhase => ({
  status: "unobserved",
  durationMs: null,
  durationReason: "not_started",
  phase: null,
  httpStatus: null,
  reason: "not_started",
});

// A Worker's clock only advances across I/O, so a phase that ends before any
// has no duration to observe.
const elapsed = (start: number) => {
  const durationMs = Math.round((performance.now() - start) * 1000) / 1000;
  return durationMs > 0
    ? { durationMs, durationReason: null }
    : { durationMs: null, durationReason: "no_clock_delta" };
};

// Pi sends a lane's whole request, tools and system prompt included, so the
// probe spends a lane's caps. Two requests cover Pi's openai-codex transport,
// which tries a WebSocket before it falls back to a streamed POST.
const probeCaps = { ...SESSION_CAPS.t1b, maxRequests: 2 };

const PI_PROBE_FAMILIES = {
  "workers-ai": {
    provider: "cloudflare-workers-ai",
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  },
  "openai-codex": { provider: "openai-codex", model: "gpt-5.6-sol" },
  "claude-code": { provider: "claude-code", model: "claude-opus-5" },
} as const;

const PI_PROBE_SECONDS = 100;
const PI_MODELS_PATH = "/opt/review/pi-config/models.json";
const CLAUDE_CODE_EXTENSION = "/opt/review/extensions/claude-code-provider.js";

const asTarget = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups`;

const piProbeCommand = (
  directory: string,
  family: keyof typeof PI_PROBE_FAMILIES,
  accountId: string,
) => {
  const { provider, model } = PI_PROBE_FAMILIES[family];
  const account =
    family === "workers-ai"
      ? `CLOUDFLARE_ACCOUNT_ID=${posixQuote(accountId)} `
      : "";
  const extension =
    family === "claude-code" ? ` -e ${posixQuote(CLAUDE_CODE_EXTENSION)}` : "";
  return `cd ${posixQuote(directory)} && ${asTarget} env HOME=/home/review-target PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ${account}PI_CODING_AGENT_DIR=${posixQuote(directory)} timeout -k 5 ${PI_PROBE_SECONDS} pi --provider ${posixQuote(provider)} --model ${posixQuote(model)} --thinking high --mode json --print --no-session --no-extensions --no-skills --no-prompt-templates --approve${extension} -- ${posixQuote("Reply with exactly pong and nothing else.")} < /dev/null > events.jsonl 2> pi.stderr`;
};

// The same reading `validate_review_events` gives a lane's stream, plus the
// HTTP status Pi puts at the head of a provider error message.
const PI_SUMMARY = `([.[] | select(.type == "turn_end")] | last | .message) as $m
| {stopReason: ($m.stopReason // null),
   httpStatus: (($m.errorMessage // "") | (capture("^(?<code>[1-5][0-9][0-9])\\\\b").code | tonumber)? // null),
   hasFinal: (([.[] | select(.type == "agent_end")] | last | (.messages // [])
     | map(select(.role == "assistant")) | last | (.content // [])
     | map(select(.type == "text") | .text) | join("\\n") | test("\\\\S")) // false)}`;

const piSummaryCommand = (directory: string) =>
  `${asTarget} jq -sc ${posixQuote(PI_SUMMARY)} ${posixQuote(`${directory}/events.jsonl`)}`;

const parsePiSummary = (stdout: string) => {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null) return null;
    const summary = value as Record<string, unknown>;
    return {
      stopReason:
        typeof summary["stopReason"] === "string"
          ? summary["stopReason"]
          : null,
      httpStatus:
        typeof summary["httpStatus"] === "number"
          ? summary["httpStatus"]
          : null,
      hasFinal: summary["hasFinal"] === true,
    };
  } catch {
    return null;
  }
};

async function operatorProbe(
  request: Request,
  env: ReviewPiEnv,
  origin: string,
) {
  if (!env.TARGET_REPOSITORY) {
    return json({ error: "target_repository_unset" }, 400);
  }
  let expectedSources: Record<string, string>;
  let accountId: string;
  let workersBearer: string;
  try {
    const input: unknown = await request.json();
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error();
    const body = input as Record<string, unknown>;
    expectedSources = parseExpectedSources(body["expectedSources"]);
    const workers = body["workersAi"];
    if (
      typeof workers !== "object" ||
      workers === null ||
      Array.isArray(workers)
    )
      throw new Error();
    const ai = workers as Record<string, unknown>;
    if (
      typeof ai["accountId"] !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(ai["accountId"]) ||
      typeof ai["bearer"] !== "string" ||
      !ai["bearer"] ||
      /[\r\n]/.test(ai["bearer"])
    )
      throw new Error();
    accountId = ai["accountId"];
    workersBearer = ai["bearer"];
  } catch {
    return json({ error: "invalid_probe" }, 400);
  }

  const runId = assertCloudRunId(`probe-${crypto.randomUUID()}`);
  const key = `probes/${runId}.json`;
  if (await env.PROBE_RESULTS.head(key))
    return json({ error: "probe_exists" }, 409);
  const sandbox = getSandbox(env.REVIEW_SANDBOX, runId);
  const directory = runDir(runId);
  const families = ["workers-ai", "openai-codex", "claude-code"] as const;
  type Family = (typeof families)[number];
  const models: Record<Family, ProbePhase> = {
    "workers-ai": unobserved(),
    "openai-codex": unobserved(),
    "claude-code": unobserved(),
  };
  const receipt = {
    runId,
    clock: "worker.performance.now",
    startedAt: new Date().toISOString(),
    coldStart: unobserved(),
    clone: unobserved(),
    sessionSetup: unobserved(),
    models,
    sessionClear: unobserved(),
    shutdown: unobserved(),
  };
  let stored = true;
  try {
    let start = performance.now();
    try {
      const fingerprint = await bounded(
        "probe cold start",
        sandbox.exec(sourceFingerprintCommand()),
      );
      const mismatch = firstSourceMismatch(
        expectedSources,
        parseSourceFingerprint(fingerprint.stdout).sources,
      );
      receipt.coldStart = mismatch
        ? {
            status: "failed",
            ...elapsed(start),
            phase: "source_fingerprint",
            httpStatus: null,
            reason: `source_mismatch:${mismatch.file}`,
          }
        : {
            status: "ok",
            ...elapsed(start),
            phase: "source_fingerprint",
            httpStatus: null,
            reason: null,
          };
    } catch {
      receipt.coldStart = {
        status: "failed",
        ...elapsed(start),
        phase: "source_fingerprint",
        httpStatus: null,
        reason: "sandbox_exec_failed",
      };
    }
    if (receipt.coldStart.status === "ok") {
      start = performance.now();
      try {
        await bounded(
          "probe directory",
          sandbox.mkdir(directory, { recursive: true }),
        );
        await bounded(
          "probe ownership",
          sandbox.exec(targetChownCommand(directory)),
        );
        const remote = `${origin}/git/${await gitCapability(runId, env.CONTROL_SECRET)}`;
        const command = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups git -c ${posixQuote(`http.extraHeader=x-review-run: ${runId}`)} clone --depth 1 --no-tags --quiet ${posixQuote(remote)} ${posixQuote(`${directory}/clone`)}`;
        const result = await bounded("probe clone", sandbox.exec(command));
        receipt.clone =
          result.exitCode === 0
            ? {
                status: "ok",
                ...elapsed(start),
                phase: "git_clone",
                httpStatus: null,
                reason: null,
              }
            : {
                status: "failed",
                ...elapsed(start),
                phase: "git_clone",
                httpStatus: null,
                reason: "nonzero_exit",
              };
      } catch {
        receipt.clone = {
          status: "failed",
          ...elapsed(start),
          phase: "git_clone",
          httpStatus: null,
          reason: "sandbox_exec_failed",
        };
      }

      const capability = await modelCapability(runId, env.CONTROL_SECRET);
      const base = modelProxyBaseUrl(origin, runId, capability);
      const handles = {
        "workers-ai": `review-pi-${crypto.randomUUID()}`,
        "openai-codex": openaiCodexBrokerHandle(crypto.randomUUID()),
        "claude-code": `review-pi-${crypto.randomUUID()}`,
      } satisfies Record<Family, string>;
      const sessions = {
        [handles["workers-ai"]]: {
          handle: handles["workers-ai"],
          upstreamBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
          upstreamAuthorization: `Bearer ${workersBearer}`,
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
        [handles["openai-codex"]]: {
          handle: handles["openai-codex"],
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          credentialProvider: "openai-codex",
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
        [handles["claude-code"]]: {
          handle: handles["claude-code"],
          upstreamBaseUrl: "https://api.anthropic.com",
          credentialProvider: "claude-code",
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
      } satisfies Record<string, ModelSession>;
      start = performance.now();
      try {
        const laneModels = await readArtifact(sandbox, PI_MODELS_PATH);
        if (!laneModels.exists || laneModels.truncated) throw new Error();
        await bounded("probe sessions", sandbox.putProbeSessions(sessions));
        receipt.sessionSetup = {
          status: "ok",
          ...elapsed(start),
          phase: "session_setup",
          httpStatus: null,
          reason: null,
        };
        for (const family of families) {
          const { provider } = PI_PROBE_FAMILIES[family];
          const piDirectory = `${directory}/pi-${family}`;
          start = performance.now();
          let phase = "config_write";
          try {
            await bounded(
              "probe pi directory",
              sandbox.mkdir(piDirectory, { recursive: true }),
            );
            await bounded(
              "probe models",
              sandbox.writeFile(
                `${piDirectory}/models.json`,
                modelsJsonForProxy(
                  laneModels.content,
                  provider,
                  handles[family],
                  base,
                ),
              ),
            );
            await bounded(
              "probe pi ownership",
              sandbox.exec(targetChownCommand(piDirectory)),
            );
            phase = "model_request";
            const pi = await bounded(
              "probe pi",
              sandbox.exec(piProbeCommand(piDirectory, family, accountId)),
              (PI_PROBE_SECONDS + 15) * 1000,
            );
            if (pi.exitCode !== 0) {
              models[family] = {
                status: "failed",
                ...elapsed(start),
                phase,
                httpStatus: null,
                reason:
                  pi.exitCode === 124 || pi.exitCode === 137
                    ? "pi_timeout"
                    : "pi_exit",
              };
              continue;
            }
            phase = "response_read";
            const summary = await bounded(
              "probe pi summary",
              sandbox.exec(piSummaryCommand(piDirectory)),
            );
            const outcome = parsePiSummary(summary.stdout);
            if (summary.exitCode !== 0 || !outcome) {
              models[family] = {
                status: "failed",
                ...elapsed(start),
                phase,
                httpStatus: null,
                reason: "invalid_event_stream",
              };
              continue;
            }
            const reason =
              outcome.stopReason === "error" || outcome.stopReason === "aborted"
                ? "model_error"
                : outcome.stopReason !== "stop"
                  ? "incomplete_result"
                  : outcome.hasFinal
                    ? null
                    : "empty_result";
            models[family] = {
              status: reason ? "failed" : "ok",
              ...elapsed(start),
              phase:
                reason === "model_error"
                  ? "model_request"
                  : "response_interpret",
              httpStatus: outcome.httpStatus,
              reason,
            };
          } catch {
            models[family] = {
              status: "failed",
              ...elapsed(start),
              phase,
              httpStatus: null,
              reason: "probe_step_failed",
            };
          }
        }
      } catch {
        receipt.sessionSetup = {
          status: "failed",
          ...elapsed(start),
          phase: "session_setup",
          httpStatus: null,
          reason: "session_setup_failed",
        };
      }
    }
  } finally {
    let start = performance.now();
    try {
      await bounded("probe session clear", sandbox.clearProbeSessions());
      receipt.sessionClear = {
        status: "ok",
        ...elapsed(start),
        phase: "session_clear",
        httpStatus: null,
        reason: null,
      };
    } catch {
      receipt.sessionClear = {
        status: "failed",
        ...elapsed(start),
        phase: "session_clear",
        httpStatus: null,
        reason: "clear_failed",
      };
    }
    start = performance.now();
    const shutdown = await destroySandbox(sandbox);
    receipt.shutdown = {
      status: shutdown.acknowledged ? "ok" : "failed",
      ...elapsed(start),
      phase: "sandbox_destroy",
      httpStatus: null,
      reason: shutdown.acknowledged ? null : "destroy_failed",
    };
    try {
      await env.PROBE_RESULTS.put(key, JSON.stringify(receipt), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      stored = false;
    }
  }
  if (!stored) return json({ error: "r2_put_failed", runId }, 500);
  return json({
    key,
    runId,
    status:
      receipt.coldStart.status === "ok" &&
      receipt.clone.status === "ok" &&
      receipt.sessionSetup.status === "ok" &&
      families.every((family) => models[family].status === "ok") &&
      receipt.sessionClear.status === "ok" &&
      receipt.shutdown.status === "ok"
        ? "ok"
        : "failed",
  });
}

export default {
  async fetch(request: Request, env: ReviewPiEnv) {
    const url0 = new URL(request.url);
    if (url0.pathname.startsWith("/git/")) {
      if (!env.TARGET_REPOSITORY) {
        return json({ error: "target_repository_unset" }, 400);
      }
      return proxyGitFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        env.GITHUB_READ_TOKEN,
        env.TARGET_REPOSITORY,
      );
    }

    if (url0.pathname.startsWith("/model/")) {
      return proxyModelFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        async (runId, handle) =>
          getSandbox(env.REVIEW_SANDBOX, runId).openModelSession(handle),
        async (runId, handle) =>
          getSandbox(env.REVIEW_SANDBOX, runId).consumeModelAttempt(handle),
        async (runId, usage, retryable, seal, handle) =>
          getSandbox(env.REVIEW_SANDBOX, runId).recordModelAttempt(
            usage,
            retryable,
            seal,
            handle,
          ),
        (provider, rejectedAccessToken) =>
          env.CREDENTIAL_VAULT.getByName("worker").credential(
            provider,
            rejectedAccessToken,
          ),
        createCodexRelayTransport(env.CODEX_RELAY),
      );
    }

    if (!authorized(request, env.CONTROL_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = url0;
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      segments[0] === "probe" &&
      segments.length === 1 &&
      request.method === "POST"
    ) {
      return operatorProbe(request, env, url.origin);
    }

    if (segments[0] === "credentials") {
      const vault = env.CREDENTIAL_VAULT.getByName("worker");
      if (request.method === "GET" && segments.length === 1) {
        return json({ credentials: await vault.status() });
      }
      if (request.method === "PUT" && segments.length === 2) {
        try {
          await vault.seed(segments[1] ?? "", await request.json());
          return json({ provider: segments[1], stored: true });
        } catch (error) {
          const reason =
            error instanceof Error &&
            [
              "invalid_credential",
              "invalid_codex_access_token",
              "unsupported_provider",
            ].includes(error.message)
              ? error.message
              : "credential_store_failed";
          return json(
            { error: reason },
            reason === "unsupported_provider" ? 404 : 400,
          );
        }
      }
      return json({ error: "not_found" }, 404);
    }

    if (segments[0] !== "runs" || segments.length < 1) {
      return json({ error: "not_found" }, 404);
    }

    if (request.method === "POST" && segments.length === 1) {
      // A run that does not name the repository its lanes clone cannot be
      // served: every container fetches through this Worker's Git proxy, and
      // there is no upstream to fall back to.
      if (!env.TARGET_REPOSITORY) {
        return json(
          {
            error: "target_repository_unset",
            detail: "TARGET_REPOSITORY is unset",
          },
          400,
        );
      }
      let parsed: ReturnType<typeof parseCloudRunRequest>;
      let expectedSources: Record<string, string>;
      try {
        const body: unknown = await request.json();
        parsed = parseCloudRunRequest(body);
        expectedSources = parseExpectedSources(
          (body as { job?: { expectedSources?: unknown } }).job
            ?.expectedSources,
        );
      } catch (error) {
        return json({ error: "invalid_run", detail: messageOf(error) }, 400);
      }
      if (parsed.credentialProvider) {
        const credentials =
          await env.CREDENTIAL_VAULT.getByName("worker").status();
        if (
          !credentials.some(
            (entry) => entry.provider === parsed.credentialProvider,
          )
        ) {
          return json({ error: "credential_unconfigured" }, 400);
        }
      }
      const job = {
        ...parsed.job,
        expectedSources,
        gitRemote: `${url.origin}/git/${await gitCapability(parsed.job.runId, env.CONTROL_SECRET)}`,
      };
      const sandbox = getSandbox(env.REVIEW_SANDBOX, job.runId);
      const directory = runDir(job.runId);
      try {
        const fingerprint = await bounded(
          "source fingerprint",
          sandbox.exec(
            `${sourceFingerprintCommand()}; pi --version; bun --version; git --version`,
          ),
        );
        const { sources: observedSources, versions } = parseSourceFingerprint(
          fingerprint.stdout,
        );
        const [piVersion = "", bunVersion = "", gitVersion = ""] = versions;
        const mismatch = firstSourceMismatch(
          job.expectedSources,
          observedSources,
        );
        if (mismatch) {
          return json(
            {
              error: "source_mismatch",
              file: mismatch.file,
              expected: mismatch.expected,
              observed: mismatch.observed,
              detail: sourceMismatchDetail(mismatch),
              shutdown: { destroy: await destroySandbox(sandbox) },
            },
            409,
          );
        }
        const runnerSha = observedSources[REVIEW_RUNNER] ?? "";
        await bounded(
          "model session",
          sandbox.putModelSession({
            handle: parsed.broker.handle,
            upstreamBaseUrl: parsed.broker.upstreamBaseUrl,
            ...(parsed.broker.upstreamAuthorization
              ? { upstreamAuthorization: parsed.broker.upstreamAuthorization }
              : {}),
            ...(parsed.credentialProvider
              ? { credentialProvider: parsed.credentialProvider }
              : {}),
            ...(parsed.broker.upstreamAccountId
              ? { upstreamAccountId: parsed.broker.upstreamAccountId }
              : {}),
            caps: parsed.broker.caps,
            totals: emptyModelTotals(),
          }),
        );
        const controlApiHttp = await bounded(
          "control api probe",
          sandbox.exec(targetControlApiProbe),
        );
        const controlApiStatus = Number.parseInt(
          controlApiHttp.stdout.trim(),
          10,
        );
        const controlApiArtifact = await readArtifact(
          sandbox,
          CONTROL_API_PROBE_PATH,
        );
        const controlApiBody =
          controlApiArtifact.exists && "content" in controlApiArtifact
            ? controlApiArtifact.content.slice(0, CANARY_MAX_BYTES)
            : "";
        const controlApi = interpretControlApiProbe(
          Number.isInteger(controlApiStatus) ? controlApiStatus : 0,
          controlApiBody,
        );
        const probes = {
          // The bearer stays in this Durable Object, so no broker config is
          // ever staged in the container: a probe here would answer DENIED for
          // the life of the image and report containment nobody measured.
          targetReadBroker: {
            verdict: null,
            reason: "broker_config_not_staged",
          },
          controlApi: {
            httpStatus: Number.isInteger(controlApiStatus)
              ? controlApiStatus
              : null,
            uid: controlApi.uid,
            reason: controlApi.reason,
            escaped: controlApi.escaped,
          },
        };
        const capability = await modelCapability(job.runId, env.CONTROL_SECRET);
        const modelsJson = modelsJsonForProxy(
          parsed.modelsJson,
          job.provider,
          parsed.broker.handle,
          modelProxyBaseUrl(url.origin, job.runId, capability),
        );
        await bounded(
          "run directory creation",
          sandbox.mkdir(directory, { recursive: true }),
        );
        await bounded(
          "job write",
          sandbox.writeFile(`${directory}/job.json`, JSON.stringify(job)),
        );
        await bounded(
          "models write",
          sandbox.writeFile(`${directory}/models.json`, modelsJson),
        );
        await bounded(
          "run directory ownership",
          sandbox.exec(targetChownCommand(directory)),
        );
        const container = { runnerSha, piVersion, bunVersion, gitVersion };
        const placementId = await bounded(
          "placement lookup",
          sandbox.getContainerPlacementId(),
        );

        if (parsed.canary) {
          let provider = null;
          if (parsed.canaryRequest) {
            await bounded(
              "canary body",
              sandbox.writeFile(
                `${directory}/canary-request.json`,
                parsed.canaryRequest.body,
              ),
            );
            await bounded(
              "canary body ownership",
              sandbox.exec(targetChownCommand(directory)),
            );
            const completion = await bounded(
              "canary provider",
              sandbox.exec(
                targetCanaryCommand(
                  directory,
                  parsed.broker.handle,
                  `${modelProxyBaseUrl(url.origin, job.runId, capability)}${parsed.canaryRequest.path}`,
                ),
              ),
            );
            const httpStatus = Number.parseInt(completion.stdout.trim(), 10);
            const artifact = await readArtifact(
              sandbox,
              `${directory}/canary-response.txt`,
            );
            const body =
              artifact.exists && "content" in artifact
                ? artifact.content.slice(0, CANARY_MAX_BYTES)
                : "";
            const interpreted = interpretProviderCanary(
              Number.isInteger(httpStatus) ? httpStatus : 0,
              body,
            );
            provider = {
              httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
              bytes: artifact.exists ? artifact.bytes : 0,
              truncated: artifact.exists ? artifact.truncated : false,
              ...interpreted,
            };
            if (!interpreted.completed) {
              return json(
                {
                  error: "canary_incomplete",
                  probes: { ...probes, provider },
                  shutdown: { destroy: await destroySandbox(sandbox) },
                },
                409,
              );
            }
          }
          return json({
            runId: job.runId,
            processId: null,
            startedAt: new Date().toISOString(),
            canary: true,
            placementId,
            container,
            credentialIsolation: isolation,
            probes: { ...probes, provider },
          });
        }

        const process = await bounded(
          "review process start",
          sandbox.startProcess(
            targetReviewCommand(
              directory,
              job.totalTimeoutSeconds,
              REVIEW_RUNNER,
              job.targetEnv,
            ),
            { autoCleanup: false },
          ),
        );
        return json({
          runId: job.runId,
          processId: process.id,
          startedAt: new Date().toISOString(),
          placementId,
          container,
          credentialIsolation: isolation,
          probes,
        });
      } catch (error) {
        return json(
          {
            error: "start_failed",
            detail: messageOf(error),
            shutdown: { destroy: await destroySandbox(sandbox) },
          },
          500,
        );
      }
    }

    const runIdRaw = segments[1];
    if (!runIdRaw) return json({ error: "not_found" }, 404);
    let runId: string;
    try {
      runId = assertCloudRunId(runIdRaw);
    } catch (error) {
      return json({ error: "invalid_run", detail: messageOf(error) }, 400);
    }
    const sandbox = getSandbox(env.REVIEW_SANDBOX, runId);
    const directory = runDir(runId);

    if (request.method === "GET" && segments[2] === "state") {
      const artifacts = await readArtifacts(sandbox, directory);
      let processes: { id: string; command: string; status: string }[] = [];
      let processesError: string | null = null;
      try {
        const listed = await bounded("process list", sandbox.listProcesses());
        processes = listed.map((process) => ({
          id: process.id,
          command: process.command,
          status: process.status,
        }));
      } catch (error) {
        processesError = messageOf(error);
      }
      let modelUsage = null;
      try {
        modelUsage = await bounded("model usage", sandbox.modelUsage());
      } catch (error) {
        processesError = processesError ?? messageOf(error);
      }
      return json({
        runId,
        observedAt: new Date().toISOString(),
        placementId: await bounded(
          "placement lookup",
          sandbox.getContainerPlacementId(),
        ),
        processes,
        processesError,
        control: { modelUsage },
        artifacts,
      });
    }

    if (request.method === "POST" && segments[2] === "command") {
      let command: ReturnType<typeof parseBridgeCommand>;
      try {
        command = parseBridgeCommand(await request.json());
      } catch (error) {
        return json(
          { error: "invalid_command", detail: messageOf(error) },
          400,
        );
      }
      try {
        const payload = bridgeCommandPayload(command);
        const path =
          payload.length > BRIDGE_COMMAND_MAX_BYTES
            ? bridgeCommandFile(
                directory,
                await bounded(
                  "command sequence",
                  sandbox.nextCommandSequence(),
                ),
              )
            : null;
        if (path) {
          await bounded("command write", sandbox.writeFile(path, payload));
        }
        const sent = await bounded(
          "bridge command",
          sandbox.exec(
            path
              ? targetSendFileCommand(directory, REVIEW_RUNNER, path)
              : targetSendCommand(directory, REVIEW_RUNNER, command),
          ),
        );
        const raw = sent.stdout.trim();
        try {
          return json(JSON.parse(raw) as unknown);
        } catch {
          return json(
            { error: "bridge_unparsed", detail: raw.slice(0, 400) },
            502,
          );
        }
      } catch (error) {
        return json({ error: "bridge_failed", detail: messageOf(error) }, 502);
      }
    }

    if (request.method === "POST" && segments[2] === "stop") {
      let killed: number | null = null;
      let killError: string | null = null;
      // This is the only control-side record of what the model channel
      // carried, and the artifacts this response ships beside it are
      // target-writable.
      let modelSeals: (string | null)[] | null = null;
      try {
        modelSeals = await bounded("model seals", sandbox.modelSeals());
      } catch (error) {
        killError = killError ?? messageOf(error);
      }
      try {
        killed = await bounded("process cleanup", sandbox.killAllProcesses());
      } catch (error) {
        killError = messageOf(error);
      }
      const artifacts = await readArtifacts(sandbox, directory);
      try {
        await bounded("clear model session", sandbox.clearModelSession());
      } catch (error) {
        killError = killError ?? messageOf(error);
      }
      const destroy = await destroySandbox(sandbox);
      return json({
        runId,
        killed,
        killError,
        destroyedAt: destroy.acknowledged ? new Date().toISOString() : null,
        control: { modelSeals },
        artifacts,
        shutdown: { destroy },
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
