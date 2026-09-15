/**
 * Local driver for one disposable review run.
 *
 * It is the only place that holds the Worker control secret. The GitHub token
 * resolves SHAs locally, while the Worker's separate read-only token serves the
 * container through the Git proxy. Neither credential reaches the container.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BROKER_LEDGER } from "./isolation";
import {
  adaptModelsConfig,
  assertRunId,
  CLOUD_MODEL,
  CLOUD_PROVIDER,
  MAX_FORMAT_CORRECTIONS,
  mintRunId,
  parseCandidateIds,
  parseSingleVerdict,
  planBroker,
  resolveRunCredentials,
  targetProviderEnv,
} from "./local";
import type { ReviewJob } from "./protocol";
import { SESSION_CAPS } from "./provider-budget";
import { parseCandidates, parseVerdicts } from "./swarm";

const argument = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const required = (name: string) => {
  const value = argument(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const githubToken = () =>
  process.env.GITHUB_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function github<T>(path: string, token: string) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** Confirm the SHA exists upstream before a container is ever created for it. */
export async function commitAt(repo: string, sha: string, token: string) {
  const commit = await github<{ sha: string }>(
    `repos/${repo}/commits/${sha}`,
    token,
  );
  return { sha: commit.sha };
}

export async function requestControl<T>(
  worker: string,
  path: string,
  secret: string,
  timeoutMs: number,
  init?: RequestInit,
) {
  const response = await fetch(`${worker}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `control ${path}: ${response.status} ${body.slice(0, 400)}`,
    );
  return JSON.parse(body) as T;
}

export async function runWithCleanup<U>(
  // The run's own result is deliberately dropped: its outcome is whether it
  // threw, and its work lands in the closure's bindings. A named return type
  // here would be a type nobody reads.
  // oxlint-disable-next-line anti-slop/no-unknown-returns
  run: () => Promise<unknown>,
  cleanup: () => Promise<U>,
) {
  let runError: unknown;
  try {
    await run();
  } catch (error) {
    runError = error;
  }

  let cleanupResult: U | undefined;
  let cleanupError: unknown;
  try {
    cleanupResult = await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  return { runError, cleanupResult, cleanupError };
}

type Artifact = {
  path: string;
  exists: boolean;
  bytes?: number;
  truncated?: boolean;
  content?: string;
};
type RunState = {
  runId: string;
  observedAt: string;
  placementId: string | null;
  processes?: { id: string; command: string; status: string }[];
  processesError?: string | null;
  control?: { modelUsage?: unknown };
  artifacts: Artifact[];
};
type RunStart = {
  runId: string;
  processId: string;
  startedAt: string;
  placementId: string | null;
  container: {
    runnerSha: string;
    piVersion: string;
    bunVersion: string;
    gitVersion: string;
  };
};
type RunStop = {
  runId: string;
  killed: number | null;
  killError: string | null;
  destroyedAt: string | null;
  artifacts: Artifact[];
  shutdown: {
    destroy: { attempted: true; acknowledged: boolean; error: string | null };
  };
};

const artifactOf = (state: RunState, name: string) =>
  state.artifacts.find((entry) => entry.path.endsWith(`/${name}`));

const FULL_SHA = /^[0-9a-f]{40}$/;

const parseJson = (raw: string | undefined) => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const reportCheckout = (raw: string | undefined) => {
  const parsed = parseJson(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const checkout = (parsed as { checkout?: unknown }).checkout;
  if (
    typeof checkout !== "object" ||
    checkout === null ||
    Array.isArray(checkout)
  ) {
    return undefined;
  }
  const record = checkout as Record<string, unknown>;
  return {
    checkedOutHead:
      typeof record["checkedOutHead"] === "string"
        ? record["checkedOutHead"]
        : "",
    checkedOutBase:
      typeof record["checkedOutBase"] === "string"
        ? record["checkedOutBase"]
        : "",
  };
};

const reportStepSucceeded = (raw: string | undefined) => {
  if (!raw) return false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseJson(line);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const step = parsed as Record<string, unknown>;
    if (step["step"] === "report" && step["exit"] === 0) return true;
  }
  return false;
};

/** Target-written status.json is not a completion signal. */
export function controlPlaneCompletion(
  state: RunState,
  requested: { head: string; base: string },
) {
  const reviewAlive = (state.processes ?? []).some(
    (process) =>
      process.command.includes("review-run.sh") &&
      (process.status === "starting" || process.status === "running"),
  );
  const checkout = reportCheckout(artifactOf(state, "report.json")?.content);
  const reportOk =
    checkout?.checkedOutHead === requested.head &&
    checkout.checkedOutBase === requested.base &&
    reportStepSucceeded(artifactOf(state, "steps.jsonl")?.content);
  // A process list the container failed to serve is no observation at all: a
  // control API that answers 500 while an install saturates the box says
  // nothing about the runner, and a driver that reads it as an exit destroys a
  // healthy lane.
  return { reviewAlive, reportOk, processesObserved: !state.processesError };
}

const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * How many times the lane reached the model, or null when nobody observed it.
 *
 * A relaunch is free only while this is zero: a container that died before its
 * first request spent nothing, and one that died after it would buy the same
 * tokens twice.
 */
export const observedModelRequests = (state: RunState | undefined) => {
  const totals = asRecord(asRecord(state?.control?.modelUsage)?.["totals"]);
  const requests = totals?.["requests"];
  return typeof requests === "number" ? requests : null;
};

const statusRecord = (state: RunState) =>
  asRecord(parseJson(artifactOf(state, "status.json")?.content));

const isHtml = (value: string) => /^\s*</.test(value);

const TERMINAL_PROMPT_FAILURES = new Set([
  "auth_blocked",
  "quota_blocked",
  "model_error",
  "process_exit",
  "process_spawn_error",
  "stdin_error",
]);

/** Provider/auth/model terminal errors must finish the attempt before the run budget. */
export function promptFailure(state: RunState) {
  const reviewError = asRecord(
    parseJson(artifactOf(state, "review-error.json")?.content),
  );
  const status = statusRecord(state);
  const reason =
    (typeof reviewError?.["reason"] === "string"
      ? reviewError["reason"]
      : undefined) ??
    (typeof status?.["terminalReason"] === "string"
      ? status["terminalReason"]
      : undefined);
  if (!reason || !TERMINAL_PROMPT_FAILURES.has(reason)) return undefined;
  const message =
    typeof reviewError?.["errorMessage"] === "string"
      ? reviewError["errorMessage"]
      : "";
  return isHtml(message)
    ? `provider ${reason}`
    : `provider ${reason}: ${message.slice(0, 200)}`.trim();
}

export function eligibleIdleCandidate(state: RunState) {
  const status = statusRecord(state);
  if (!status) return undefined;
  if (
    status["state"] !== "idle" &&
    status["state"] !== "failed" &&
    status["state"] !== "blocked"
  ) {
    return undefined;
  }
  if (status["childIdle"] !== true) return undefined;
  if (status["isStreaming"] === true) return undefined;
  if (status["inFlightTool"]) return undefined;
  const candidate = status["lastCandidateResult"];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

export function validateIdleCandidate(
  text: string,
  role: "single" | "reviewer" | "verifier",
  laneId: string,
  candidateIds: string[],
) {
  if (role === "reviewer") return parseCandidates(text, laneId).error;
  if (role === "verifier") {
    if (candidateIds.length === 0) {
      return "verifier run has no persisted candidate set; its verdicts cannot be validated";
    }
    return parseVerdicts(text, candidateIds).error;
  }
  return parseSingleVerdict(text).error;
}

/**
 * Requests held back from the broker's hard cap.
 *
 * The cap admits nothing once it is reached, so a lane that arrives there
 * mid-answer dies with no report at all. The driver spends one request telling
 * the lane to answer with what it has, and keeps the rest for the answer itself,
 * a correction and a second one.
 *
 * The margin is this wide because the trigger is observed, not intercepted: the
 * driver learns the request count from the control plane on its own poll, and a
 * lane that turns over a request every few seconds can clear several between two
 * of them. A reserve of three - one answer and two corrections, with nothing
 * left for what the poll missed - measured two verifier lanes hitting the cap at
 * 32 requests with an empty report, which is the one outcome this reserve exists
 * to prevent.
 */
export const FINALIZE_REQUEST_RESERVE = 8;

/**
 * How long the container is given to write its report after the driver tells it
 * to stop, before the sandbox is destroyed and the work goes with it.
 */
export const REPORT_GRACE_MS = 30_000;

/**
 * How much of a lane's verdict deadline the report is assumed to need.
 *
 * The instruction lands in the turn the lane is already running, the lane
 * answers with what it has, and the container then writes report.json, so the
 * verdict settles after the finalize rather than with it. The 2026-09-10 live
 * lanes measured that gap at 29 s and 73 s; a lane told any later than this
 * spends the run's own wall on a verdict the deadline no longer covers.
 */
export const FINALIZE_REPORT_MARGIN_MS = 60_000;

const finalizeInstruction = (
  trigger: "cap" | "deadline",
  used: number | null,
  max: number | null,
) =>
  `Stop investigating now: ${
    trigger === "cap" && used !== null && max !== null
      ? `you have spent ${used} of your ${max} model requests and the run needs your answer before the provider cuts you off`
      : "this lane's verdict deadline has arrived and the run needs your answer"
  }. Answer in this turn with the required fenced json block. If your review is unfinished, use status "partial" with a blockerReason naming exactly what you did not get to, and report every finding you already verified. Do not call any more tools.`;

/**
 * What a lane started without a prompt is eventually told to do. A `null`
 * prompt means nothing turned up for it and the prepared container is torn
 * down unused.
 */
export type LaneBrief = {
  prompt: string | null;
  candidateIds: string[];
  /**
   * The epoch instant the lane's verdict has to be settled by, or null when
   * the brief was written by something with no deadline to impose. A lane that
   * warmed up late carries less of the run into this instant, which is what
   * makes the deadline rather than the request cap the binding one.
   */
  verdictDeadlineAt?: number | null;
};

export async function readLaneBrief(path: string) {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const prompt = parsed["prompt"];
  const candidateIds = parsed["candidateIds"];
  const verdictDeadlineAt = parsed["verdictDeadlineAt"] ?? null;
  if (
    (prompt !== null && (typeof prompt !== "string" || !prompt)) ||
    !Array.isArray(candidateIds) ||
    !candidateIds.every((id) => typeof id === "string") ||
    (verdictDeadlineAt !== null &&
      (typeof verdictDeadlineAt !== "number" ||
        !Number.isInteger(verdictDeadlineAt) ||
        verdictDeadlineAt <= 0))
  ) {
    throw new Error(`brief at ${path} is malformed`);
  }
  return { prompt, candidateIds, verdictDeadlineAt } as LaneBrief;
}

export async function driveUntilComplete(input: {
  poll: () => Promise<RunState>;
  send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  requested: { head: string; base: string };
  role: "single" | "reviewer" | "verifier";
  laneId: string;
  candidateIds: string[];
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  brief?: () => Promise<LaneBrief | undefined>;
  /** The broker's own request ceiling for this lane; null when it has none. */
  maxRequests?: number;
  onFinalize?: (info: {
    at: string;
    usedRequests: number | null;
    maxRequests: number | null;
  }) => void;
}) {
  const interval = input.pollIntervalMs ?? 5_000;
  const maxRequests = input.maxRequests ?? null;
  let corrections = 0;
  let accepted = false;
  let finalizeSent = false;
  let cancelled: { reason: string; at: number } | null = null;
  let briefed = input.brief === undefined;
  let candidateIds = input.candidateIds;
  let verdictDeadlineAt: number | null = null;
  let state: RunState | undefined;
  while (input.now() < input.deadline) {
    state = await input.poll();
    const completion = controlPlaneCompletion(state, input.requested);
    if (completion.reportOk && !completion.reviewAlive) return state;
    if (!briefed && input.brief) {
      const brief = await input.brief();
      if (brief?.prompt === null) return state;
      // The prompt can only land once Pi is up and listening; before that the
      // container is still cloning or installing and the socket does not exist.
      const status = statusRecord(state);
      if (
        brief &&
        status?.["phase"] === "review" &&
        status["childIdle"] === true
      ) {
        await input.send({ type: "prompt", message: brief.prompt });
        candidateIds = brief.candidateIds;
        verdictDeadlineAt = brief.verdictDeadlineAt ?? null;
        briefed = true;
        console.log(
          `${new Date().toISOString()} brief sent (${candidateIds.length} candidates)`,
        );
      }
    }
    if (!accepted) {
      const candidate = eligibleIdleCandidate(state);
      if (candidate) {
        const validationError = validateIdleCandidate(
          candidate,
          input.role,
          input.laneId,
          candidateIds,
        );
        if (validationError) {
          if (corrections >= MAX_FORMAT_CORRECTIONS) {
            throw new Error(
              `final output stayed off-contract after ${corrections} corrections: ${validationError}`,
            );
          }
          corrections += 1;
          await input.send({
            type: "prompt",
            message: `Your final response did not satisfy the required output contract: ${validationError}. Please provide the complete required conclusion formatted correctly.`,
          });
        } else {
          const acceptRes = await input.send({ type: "accept" });
          if (acceptRes["success"]) accepted = true;
        }
      }
    }
    // A lane runs out of two things: the requests the broker will still admit,
    // and the instant the pool's verdicts have to be settled by. The cap is
    // enforced upstream and refuses everything once it is reached, so a lane
    // that spends its last requests on tools dies mid-answer with no report at
    // all. One instruction, with only the reserve or the report's own margin
    // left, turns either into an answer the lane can still give.
    if (!accepted && !finalizeSent && briefed) {
      const used = observedModelRequests(state);
      const status = statusRecord(state);
      const idle =
        status?.["childIdle"] === true &&
        status["isStreaming"] !== true &&
        !status["inFlightTool"];
      const capReached =
        maxRequests !== null &&
        used !== null &&
        used >= maxRequests - FINALIZE_REQUEST_RESERVE;
      const deadlineReached =
        verdictDeadlineAt !== null &&
        input.now() >= verdictDeadlineAt - FINALIZE_REPORT_MARGIN_MS;
      if ((capReached || deadlineReached) && status?.["phase"] === "review") {
        // A lane mid-turn keeps calling tools until it decides to stop, and the
        // lane that has to be told to stop is exactly the one that decided not
        // to. Pi takes the instruction into the running turn as a steer and
        // delivers it before the next model call, which is the last moment a
        // request can still be spent on an answer instead of on a tool.
        const response = await input.send({
          type: "prompt",
          message: finalizeInstruction(
            capReached ? "cap" : "deadline",
            used,
            maxRequests,
          ),
          ...(idle ? {} : { streamingBehavior: "steer" }),
        });
        if (response["success"] !== false) {
          finalizeSent = true;
          console.log(
            `${new Date().toISOString()} finalize sent ${
              capReached
                ? `at ${used}/${maxRequests} requests`
                : `at the verdict deadline (${used ?? "unknown"}/${maxRequests ?? "none"} requests spent)`
            }`,
          );
          input.onFinalize?.({
            at: new Date(input.now()).toISOString(),
            usedRequests: used,
            maxRequests,
          });
        }
      }
    }
    const blocked = promptFailure(state);
    if (blocked && !accepted) {
      // A refusal from the provider is terminal, but the container still holds
      // the work the lane reached and writes it down once it is told to stop.
      // Destroying the sandbox on the first observation is how a lane cut by
      // its request cap ends with no report at all.
      if (!cancelled) {
        cancelled = { reason: blocked, at: input.now() };
        await input.send({ type: "cancel" });
      } else if (input.now() - cancelled.at >= REPORT_GRACE_MS) {
        throw new Error(cancelled.reason);
      }
    }
    if (
      completion.processesObserved &&
      !completion.reviewAlive &&
      !completion.reportOk
    ) {
      throw new Error(
        "review process exited without a matching report checkout",
      );
    }
    await input.sleep(interval);
  }
  throw new Error("run deadline exceeded");
}

export function buildCloudStartPayload(input: {
  job: ReviewJob;
  broker: ReturnType<typeof planBroker>;
  modelsJson: string;
  canary?: boolean;
  canaryRequest?: { path: string; body: string };
}) {
  const bearer = input.broker.config.upstreamAuthorization.slice(
    "Bearer ".length,
  );
  const adapted = adaptModelsConfig(input.modelsJson, input.job.provider, {
    apiKey: input.broker.handle,
    baseUrl: input.broker.baseUrl,
  });
  if (JSON.stringify(input.job).includes(bearer)) {
    throw new Error("job must not carry the model bearer");
  }
  if (adapted.includes(bearer)) {
    throw new Error("models.json must not carry the model bearer");
  }
  return {
    job: { ...input.job, supervised: true as const },
    broker: input.broker.config,
    modelsJson: adapted,
    canary: input.canary === true,
    ...(input.canaryRequest ? { canaryRequest: input.canaryRequest } : {}),
  };
}

const positiveInt = (
  raw: string | undefined,
  fallback: number,
  label: string,
  max = 86_400,
) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

/**
 * The broker's caps for one lane, with its request ceiling overridden.
 *
 * The ceiling is how a lane that would spend its whole window investigating is
 * told to answer with what it has instead of being cut with nothing, because
 * the driver spends the finalize reserve out of it. Everything else - tokens
 * per request, cumulative budgets, bytes - stays the trial kind's own.
 */
export const brokerCaps = (
  trialKind: "t1a" | "t1b",
  rawMaxRequests: string | undefined,
) => ({
  ...SESSION_CAPS[trialKind],
  maxRequests: positiveInt(
    rawMaxRequests,
    SESSION_CAPS[trialKind].maxRequests,
    "max-requests",
    1_000,
  ),
});

async function main() {
  const token = githubToken();
  const secret = process.env.REVIEW_PI_CONTROL_SECRET ?? required("secret");
  const runId = assertRunId(argument("run-id") ?? mintRunId("run"));
  const outDir = join(required("out"), runId);
  const worker = required("worker");
  const repo = required("repo");
  const controlTimeoutMs = positiveInt(
    argument("control-timeout"),
    60_000,
    "control-timeout",
    600_000,
  );
  await mkdir(outDir, { recursive: true });

  const pullRequest = argument("pr");
  const headRef = pullRequest
    ? await github<{ head: { sha: string }; base: { sha: string } }>(
        `repos/${repo}/pulls/${pullRequest}`,
        token,
      )
    : undefined;
  const failStep = argument("fail-step") as ReviewJob["failStep"] | undefined;

  // Explicit revisions win over the pull request's own pair. A caller that
  // already resolved them - the swarm resolves the merge base, which
  // `pull.base.sha` is not - is naming the exact commits this lane must review,
  // and the pull request number is then only what makes its head fetchable.
  const head = await commitAt(
    repo,
    argument("head") ?? headRef?.head.sha ?? required("head"),
    token,
  );
  const base = await commitAt(
    repo,
    argument("base") ?? headRef?.base.sha ?? required("base"),
    token,
  );
  if (!FULL_SHA.test(head.sha) || !FULL_SHA.test(base.sha)) {
    throw new Error("head and base must be full SHAs");
  }
  const expectedHead = argument("expected-head");
  const expectedBase = argument("expected-base");
  if (expectedHead && head.sha !== expectedHead) {
    throw new Error("resolved head does not match --expected-head");
  }
  if (expectedBase && base.sha !== expectedBase) {
    throw new Error("resolved base does not match --expected-base");
  }
  const fixturePath = argument("fixture");
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  const runner = await readFile(
    join(packageRoot, "container", "review-run.sh"),
    "utf8",
  );
  const reviewerContext = await readFile(
    argument("context") ?? join(packageRoot, "prompts", "review-context.md"),
    "utf8",
  );
  const modelsJson = await readFile(
    join(packageRoot, "container", "models.json"),
    "utf8",
  );

  const provider = argument("provider") ?? CLOUD_PROVIDER;
  const model = argument("model") ?? CLOUD_MODEL;
  const trialKind = argument("trial-kind") === "t1a" ? "t1a" : "t1b";
  const canary = process.argv.includes("--canary");
  const rawRole = argument("role");
  const briefPath = argument("brief");
  const promptPath = briefPath
    ? ""
    : canary
      ? (argument("prompt") ?? "")
      : required("prompt");
  const role =
    rawRole === "single" || rawRole === "reviewer" || rawRole === "verifier"
      ? rawRole
      : promptPath.includes("verifier")
        ? "verifier"
        : promptPath.includes("reviewer") || pullRequest
          ? "reviewer"
          : "single";
  const laneId = argument("lane-id") ?? "lane-1";
  const rawCandidateIds = argument("candidate-ids");
  const candidateIds = rawCandidateIds
    ? parseCandidateIds(rawCandidateIds)
    : [];
  const credentials = await resolveRunCredentials(
    provider,
    positiveInt(argument("total-timeout"), 1800, "total-timeout"),
  );
  const broker = planBroker(
    provider,
    credentials,
    brokerCaps(trialKind, argument("max-requests")),
    BROKER_LEDGER,
  );

  const targetEnv = targetProviderEnv(provider, credentials);

  const job: ReviewJob = {
    runId,
    expectedRunnerSha: createHash("sha256").update(runner).digest("hex"),
    head,
    base,
    ...(Object.keys(targetEnv).length > 0 ? { targetEnv } : {}),
    ...(pullRequest ? { pullRequest: Number(pullRequest) } : {}),
    provider,
    model,
    thinking: argument("thinking") ?? "high",
    prompt: promptPath
      ? await readFile(promptPath, "utf8")
      : briefPath
        ? ""
        : "canary",
    supervised: true,
    reviewerContext,
    ...(fixturePath
      ? { fixturePatch: await readFile(fixturePath, "utf8") }
      : {}),
    checkCommand: argument("check") ?? "git --no-pager diff --stat base..HEAD",
    installTimeoutSeconds: positiveInt(
      argument("install-timeout"),
      900,
      "install-timeout",
    ),
    piTimeoutSeconds: positiveInt(argument("pi-timeout"), 900, "pi-timeout"),
    totalTimeoutSeconds: positiveInt(
      argument("total-timeout"),
      1800,
      "total-timeout",
    ),
    ...(failStep ? { failStep } : {}),
    budget: {
      requests: broker.config.caps.maxRequests,
      inputTokens: broker.config.caps.maxCumulativeInputTokens,
      seconds: positiveInt(argument("pi-timeout"), 900, "pi-timeout"),
    },
  };

  const startBody = buildCloudStartPayload({
    job,
    broker,
    modelsJson,
    canary,
    ...(canary
      ? {
          canaryRequest: {
            path:
              provider === "openai-codex"
                ? "/codex/responses"
                : "/chat/completions",
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "user",
                  content: "Reply with exactly pong and nothing else.",
                },
              ],
              max_tokens: 16,
            }),
          },
        }
      : {}),
  });

  const startedAt = Date.now();
  let started: RunStart | undefined;
  let state: RunState | undefined;
  let phase = "";
  let finalize: Record<string, unknown> | null = null;
  // A lane the host interrupts still owns a sandbox. The signal ends the poll
  // loop so the cleanup below runs and the container is destroyed, instead of
  // the driver dying and leaving it behind for nobody to notice.
  const controller = new AbortController();
  const interrupt = (name: string) =>
    controller.abort(new Error(`the lane was interrupted (${name})`));
  process.once("SIGINT", () => interrupt("SIGINT"));
  process.once("SIGTERM", () => interrupt("SIGTERM"));
  const lifecycle = await runWithCleanup(
    async () => {
      started = await requestControl<RunStart>(
        worker,
        "/runs",
        secret,
        controlTimeoutMs,
        {
          method: "POST",
          body: JSON.stringify(startBody),
          signal: controller.signal,
        },
      );
      await writeFile(
        join(outDir, "start.json"),
        JSON.stringify(started, null, 2),
      );
      if (canary) return started;

      const deadline = startedAt + job.totalTimeoutSeconds * 1000 + 60_000;
      state = await driveUntilComplete({
        requested: { head: head.sha, base: base.sha },
        role,
        laneId,
        candidateIds,
        deadline,
        now: Date.now,
        sleep: (ms) => sleep(ms, undefined, { signal: controller.signal }),
        maxRequests: broker.config.caps.maxRequests,
        onFinalize: (info) => {
          finalize = info;
        },
        ...(briefPath ? { brief: () => readLaneBrief(briefPath) } : {}),
        poll: async () => {
          const next = await requestControl<RunState>(
            worker,
            `/runs/${runId}/state`,
            secret,
            controlTimeoutMs,
            { signal: controller.signal },
          );
          state = next;
          await writeFile(
            join(outDir, "state.json"),
            JSON.stringify(next, null, 2),
          );
          for (const entry of next.artifacts) {
            if (!entry.exists || entry.content === undefined) continue;
            const name = entry.path.split("/").pop();
            if (!name) continue;
            await writeFile(join(outDir, name), entry.content);
          }
          const status = artifactOf(next, "status.json")?.content;
          const parsed = status
            ? (parseJson(status) as
                | { phase?: string; state?: string }
                | undefined)
            : undefined;
          if (
            parsed &&
            typeof parsed.phase === "string" &&
            typeof parsed.state === "string" &&
            `${parsed.phase}/${parsed.state}` !== phase
          ) {
            phase = `${parsed.phase}/${parsed.state}`;
            console.log(
              `${new Date().toISOString()} ${phase} (status.json untrusted)`,
            );
          }
          return next;
        },
        send: async (command) => {
          const response = await requestControl<Record<string, unknown>>(
            worker,
            `/runs/${runId}/command`,
            secret,
            controlTimeoutMs,
            {
              method: "POST",
              body: JSON.stringify(command),
              signal: controller.signal,
            },
          );
          await writeFile(
            join(outDir, `command-${String(command["type"])}.json`),
            JSON.stringify(response, null, 2),
          );
          return response;
        },
      });
      return state;
    },
    async () => {
      const stopped = await requestControl<RunStop>(
        worker,
        `/runs/${runId}/stop`,
        secret,
        controlTimeoutMs,
        { method: "POST" },
      );
      await writeFile(
        join(outDir, "stop.json"),
        JSON.stringify(stopped, null, 2),
      );
      for (const entry of stopped.artifacts) {
        if (entry.content === undefined) continue;
        await writeFile(
          join(outDir, entry.path.split("/").pop() ?? "artifact"),
          entry.content,
        );
      }
      return stopped;
    },
  );

  if (lifecycle.runError) {
    await writeFile(
      join(outDir, "run-error.json"),
      JSON.stringify({ error: messageOf(lifecycle.runError) }, null, 2),
    );
  }
  if (lifecycle.cleanupError) {
    await writeFile(
      join(outDir, "stop-error.json"),
      JSON.stringify({ error: messageOf(lifecycle.cleanupError) }, null, 2),
    );
  }
  if (finalize) {
    await writeFile(
      join(outDir, "finalize.json"),
      JSON.stringify(finalize, null, 2),
    );
  }

  const stopped = lifecycle.cleanupResult;
  const report = (() => {
    const raw = stopped?.artifacts.find((entry) =>
      entry.path.endsWith("/report.json"),
    )?.content;
    return raw
      ? (JSON.parse(raw) as { checkout?: Record<string, unknown> })
      : undefined;
  })();

  const receipt = {
    runId,
    attemptId: argument("attempt-id") ?? runId,
    repo,
    pullRequest: pullRequest ?? null,
    requested: { head, base },
    checkoutObserved: report?.checkout ?? null,
    fixture: fixturePath ?? null,
    provider: job.provider,
    model: job.model,
    checkCommand: job.checkCommand,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - startedAt) / 1000),
    placementId: started?.placementId ?? state?.placementId ?? null,
    processId: started?.processId ?? null,
    container: started?.container ?? null,
    modelRequests: observedModelRequests(state),
    finalize,
    runError: lifecycle.runError ? messageOf(lifecycle.runError) : null,
    shutdown: {
      stopReceived: Boolean(stopped),
      killedProcesses: stopped?.killed ?? null,
      killError: stopped?.killError ?? null,
      destroyedAt: stopped?.destroyedAt ?? null,
      destroyAcknowledged: stopped?.shutdown.destroy.acknowledged ?? false,
      independentShutdownVerified: null,
      error: lifecycle.cleanupError
        ? messageOf(lifecycle.cleanupError)
        : (stopped?.shutdown.destroy.error ?? null),
    },
  };
  await writeFile(
    join(outDir, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(`receipts: ${outDir}`);

  const failure = lifecycle.runError ?? lifecycle.cleanupError;
  if (failure) throw failure;
  if (!stopped?.shutdown.destroy.acknowledged) {
    throw new Error(
      `shutdown unverified: ${stopped?.shutdown.destroy.error ?? "missing stop receipt"}`,
    );
  }
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

if (import.meta.main) {
  await main();
}
