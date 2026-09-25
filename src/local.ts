/**
 * Local driver for one disposable review run.
 *
 * Same runner, same pinned image and same job contract as the Cloudflare
 * control plane; the only thing that changes is who owns the container. The
 * host keeps every authority it already has - GitHub, Docker, the model key -
 * and the container gets a run-owned checkout plus one selected model
 * credential in its disposable Pi configuration.
 *
 * Git objects reach the container as a run-owned depth-1 bare repository
 * carrying the requested commits, so the reviewed tree is the upstream commit
 * rather than a copy of whatever the host working tree happens to hold, and no
 * network credential is needed inside the container.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { forceRefreshClaudeCodeCreds } from "@cgaravitoq/claude-code-core";
import {
  ENVIRONMENT_PROBE_SCRIPT,
  evaluateAdmission,
  parseEnvironmentProbe,
} from "./admission";
import { writeAtomic } from "./attempt";
import { laneImageReference } from "./image-tag";
import {
  BROKER_PORT,
  CONTROL_DIR,
  CONTROL_UID,
  MODEL_BROKER,
  RUN_ID_PATTERN,
  TARGET_UID,
} from "./isolation";
import { OPENAI_CODEX_JWT_CLAIM, openaiCodexBrokerHandle } from "./model-proxy";
import {
  firstSourceMismatch,
  IMAGE_SOURCES,
  MAX_ARTIFACT_BYTES,
  parseSourceFingerprint,
  REVIEW_RUNNER,
  type ReviewJob,
  sourceFingerprintCommand,
  sourceMismatchDetail,
} from "./protocol";
import {
  laneCaps,
  PROVIDER_UPSTREAM,
  readLedgerUsage,
  type SessionCaps,
} from "./provider-budget";

export const DEFAULT_IMAGE = "review-pi-b5-local";
export const DEFAULT_PROVIDER = "cloudflare-workers-ai";
export const DEFAULT_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";

/**
 * The brief a reviewer reads when the caller names none.
 *
 * It carries the reviewer framing and nothing about the repository under
 * review, because a brief written for one repository is wrong for the next
 * one. `--context` replaces it.
 */
export const defaultContextPath = () =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "prompts",
    "review-context.md",
  );
/**
 * What a cloud lane reviews with unless the caller names something else.
 *
 * The gateway is the only route where Workers AI, xAI and Anthropic all answer
 * and bill to Cloudflare. The model is the one that was measured: Grok spends
 * 38-52s a turn through the same gateway and returns a sixth of the work.
 */
export const CLOUD_PROVIDER = "cloudflare-ai-gateway";
export const CLOUD_MODEL = "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731";

/** Bounded files copied out of the container, whatever the run's outcome. */
/** Aggregate grace for evidence export and container removal, reported apart. */
export const TEARDOWN_BUDGET_SECONDS = 90;

/**
 * Bound for a single control request against a live run. The container owns Pi
 * and its tools, so a slow or failed observation is uncertainty about the run,
 * never the end of it: only the run's deadline ends a lane nobody can see.
 */
export const CONTROL_REQUEST_BUDGET_SECONDS = 60;

/**
 * How far past `--total-timeout` a driver holds a lane, on either transport.
 * The lane's window is measured from the runner's start, which the driver's
 * own preparation delays, and a swarm cuts its lanes at their window plus
 * LANE_CUT_GRACE_SECONDS, so a driver's own deadline comes after both.
 */
export const RUN_DEADLINE_GRACE_SECONDS = 60;

/** Off-contract finals are corrected in the same session, never indefinitely. */
export const MAX_FORMAT_CORRECTIONS = 2;

export const EXPORTED_ARTIFACTS = [
  "status.json",
  "steps.jsonl",
  "report.json",
  "trace.jsonl",
  "review-error.json",
  "run.log",
  "install.log",
  "diff.stat",
  "check.log",
  "prompt.txt",
  "checkout-delta.patch",
  "checkout-status.txt",
  "checkout-untracked.txt",
] as const;

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const required = (argv: string[], name: string) => {
  const value = flag(argv, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

/**
 * The GitHub identity a run resolves its revisions against.
 *
 * There is no fallback: a run that does not name its target repository would
 * review whichever repository this package happens to sit in.
 */
export const requiredRepo = (repo: string | undefined) => {
  if (!repo) throw new Error("--repo is required");
  return repo;
};

/**
 * The local checkout whose commits a run reviews.
 *
 * Only a checkout on this host can serve a pull request head that was never
 * pushed to a fetchable ref, so the run is told where to read it rather than
 * guessing at a path relative to this package.
 */
export const requiredSource = (source: string | undefined) => {
  if (!source) throw new Error("--source is required");
  return source;
};

/** Run ids name a container, a directory and a path inside it. */
/**
 * A fresh id for a run nobody named.
 *
 * The clock alone is not one: two swarms launched in the same millisecond
 * (S/R1/K1 and S/R2/K1 of the 2026-09-14 wave, both `swarm-mu1am1st`) shared
 * every lane id on the Worker and answered each other's control calls.
 */
export const mintRunId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

export const assertRunId = (runId: string) => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `--run-id must match [a-z0-9]([a-z0-9._-]{0,46}[a-z0-9])?: ${runId}`,
    );
  }
  return runId;
};

export function parseOptions(argv: string[]) {
  const inspect = argv.includes("--inspect");
  const reconnect = argv.includes("--reconnect");
  const cancel = argv.includes("--cancel");
  const resume = argv.includes("--resume");
  const steer = flag(argv, "steer");
  const isControlAction =
    inspect || cancel || reconnect || resume || Boolean(steer);

  const pullRequest = flag(argv, "pr");
  const head = flag(argv, "head");
  const base = flag(argv, "base");
  if (!isControlAction && !pullRequest && !(head && base)) {
    throw new Error("--pr, or both --head and --base, are required");
  }
  // A briefed lane starts with no prompt and idles in its prepared checkout
  // until the conductor writes one: the verifier that clones beside the
  // reviewers instead of after them.
  const briefPath = flag(argv, "brief");
  const promptPath =
    isControlAction || briefPath
      ? (flag(argv, "prompt") ?? "")
      : required(argv, "prompt");

  const rawRole = flag(argv, "role");
  let role: "single" | "reviewer" | "verifier" = "single";
  if (
    rawRole === "single" ||
    rawRole === "reviewer" ||
    rawRole === "verifier"
  ) {
    role = rawRole;
  } else if (promptPath.includes("reviewer")) {
    role = "reviewer";
  } else if (promptPath.includes("verifier")) {
    role = "verifier";
  }

  const rawCandidateIds = flag(argv, "candidate-ids");
  const candidateIds = rawCandidateIds
    ? parseCandidateIds(rawCandidateIds)
    : undefined;

  const laneId = flag(argv, "lane-id") ?? "lane-1";
  const trialKind = (flag(argv, "trial-kind") === "t1a" ? "t1a" : "t1b") as
    | "t1a"
    | "t1b";
  // Refused at parse time, before a container exists: the number this lane is
  // cut at is the caller's, or the run never starts.
  const rawLaneInputCap = flag(argv, "lane-input-cap");
  if (isControlAction && rawLaneInputCap !== undefined) {
    throw new Error(
      "--lane-input-cap cannot change a run that already started: the ceiling in force is the one its metadata.json recorded",
    );
  }
  const laneInputCap = laneCaps(
    trialKind,
    rawLaneInputCap,
  ).maxCumulativeInputTokens;

  return {
    runId: assertRunId(flag(argv, "run-id") ?? mintRunId("local")),
    attemptId: assertRunId(flag(argv, "attempt-id") ?? randomUUID()),
    outDir: required(argv, "out"),
    repo: flag(argv, "repo"),
    source: flag(argv, "source"),
    image: flag(argv, "image") ?? DEFAULT_IMAGE,
    ...(pullRequest ? { pullRequest: Number(pullRequest) } : {}),
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
    promptPath,
    ...(briefPath ? { briefPath } : {}),
    ...(flag(argv, "context") ? { contextPath: flag(argv, "context") } : {}),
    role,
    candidateIds,
    laneId,
    ...(flag(argv, "fixture") ? { fixturePath: flag(argv, "fixture") } : {}),
    provider: flag(argv, "provider") ?? DEFAULT_PROVIDER,
    model: flag(argv, "model") ?? DEFAULT_MODEL,
    thinking: flag(argv, "thinking") ?? "high",
    checkCommand:
      flag(argv, "check") ?? "git --no-pager diff --stat base..HEAD",
    installTimeoutSeconds: Number(flag(argv, "install-timeout") ?? 300),
    piTimeoutSeconds: Number(flag(argv, "pi-timeout") ?? 420),
    totalTimeoutSeconds: Number(flag(argv, "total-timeout") ?? 600),
    ...(flag(argv, "lane-memory")
      ? { laneMemory: flag(argv, "lane-memory") }
      : {}),
    ...(flag(argv, "lane-cpus") ? { laneCpus: flag(argv, "lane-cpus") } : {}),
    ...(rawLaneInputCap === undefined ? {} : { laneInputCap }),
    ...(flag(argv, "fail-step")
      ? { failStep: flag(argv, "fail-step") as ReviewJob["failStep"] }
      : {}),
    trialKind,
    keepContainer: argv.includes("--keep"),
    liveActivity: argv.includes("--live-activity"),
    inspect,
    reconnect,
    cancel,
    resume,
    steer,
  };
}

export type LocalOptions = ReturnType<typeof parseOptions>;

export type RunMetadata = {
  runId: string;
  attemptId: string;
  repo: string;
  ownershipId: string;
  containerName: string;
  containerRunDir: string;
  outDir: string;
  image: { reference: string; id: string };
  revisions: { head: { sha: string }; base: { sha: string } };
  runnerSha: string;
  containerRunnerSha?: string | null;
  /** What the driver expected of the image's sources and what the container held at start. */
  expectedSources: Record<string, string>;
  observedSources: Record<string, string>;
  provider: string;
  credentialIsolation: {
    mode: "brokered";
    controlUid: number;
    targetUid: number;
    upstream: string;
    caps: SessionCaps;
  };
  admission?: ReturnType<typeof evaluateAdmission>;
  model: string;
  thinking: string;
  promptPath: string;
  promptSha: string;
  role: "single" | "reviewer" | "verifier";
  candidateIds?: string[];
  laneId?: string;
  fixturePath?: string;
  checkCommand: string;
  startedAt: string;
  /** The window this run was launched under, for a receipt another invocation writes. */
  deadlineSeconds: number;
  supervised: boolean;
  pullRequest?: number;
};

/** What a single-mode reviewer's answer parsed into, or why it did not. */
export type SingleVerdict = {
  error: string | null;
  verdict?: "safe" | "defect" | "unclear";
};

export function parseSingleVerdict(text: string): SingleVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { error: "empty assistant response" };
  const verdictMatch = text.match(/VERDICT:\s*`?(safe|defect|unclear)`?/i);
  if (!verdictMatch) {
    return {
      error: "missing or invalid VERDICT (must be safe, defect, or unclear)",
    };
  }
  if (!/CONSUMERS READ:/i.test(text)) {
    return { error: "missing CONSUMERS READ section" };
  }
  if (!/CHECK RUN:/i.test(text)) {
    return { error: "missing CHECK RUN section" };
  }
  return {
    error: null,
    verdict: (verdictMatch[1] ?? "").toLowerCase() as
      | "safe"
      | "defect"
      | "unclear",
  };
}

/** One response line from the in-container RPC bridge. */
export type BridgeResponse = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
};

/**
 * The sha256 of the host's copy of every file in `container/` the image is
 * built from, the Dockerfile among them, keyed by the path the image holds it
 * at.
 */
export async function readImageSources(
  containerDir: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(IMAGE_SOURCES).map(
      async ([path, name]) =>
        [
          path,
          createHash("sha256")
            .update(await readFile(join(containerDir, name)))
            .digest("hex"),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export async function sendBridgeCommand(
  containerName: string,
  containerRunDir: string,
  cmd: Record<string, unknown>,
  budget: ReturnType<typeof createBudget>,
  signal?: AbortSignal,
): Promise<BridgeResponse> {
  const output = await docker(
    [
      "exec",
      containerName,
      REVIEW_RUNNER,
      containerRunDir,
      "--send",
      JSON.stringify(cmd),
    ],
    budget,
    `bridge command ${String(cmd["type"])}`,
    signal,
  );
  try {
    return JSON.parse(output.trim()) as BridgeResponse;
  } catch {
    throw new Error(`failed to parse bridge response: ${output}`);
  }
}

/**
 * The credential for the selected route and nothing else, mirroring the
 * Worker: an unknown provider gets no key rather than a default one.
 */
/**
 * The verifier's candidate ids, however the caller spelled them.
 *
 * The swarm emits a JSON array; a hand-run lane is easier to type as a comma
 * list. A driver that read only one of the two would hold ids that match no
 * candidate, and every verdict it checked would be an unknown one.
 */
export function parseCandidateIds(raw: string) {
  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : list(raw);
  } catch {
    return list(raw);
  }
}

export function modelCredentials(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (provider === "opencode-go") {
    return { OPENCODE_API_KEY: env["OPENCODE_API_KEY"] };
  }
  if (provider === "cloudflare-workers-ai") {
    return {
      CLOUDFLARE_API_KEY:
        env["WORKERS_AI_API_KEY"] ?? env["CLOUDFLARE_AIG_TOKEN"],
      CLOUDFLARE_ACCOUNT_ID: env["CLOUDFLARE_ACCOUNT_ID"],
    };
  }
  if (provider === "cloudflare-ai-gateway") {
    return {
      CLOUDFLARE_API_KEY: env["CLOUDFLARE_AIG_TOKEN"],
      CLOUDFLARE_ACCOUNT_ID: env["CLOUDFLARE_ACCOUNT_ID"],
      CLOUDFLARE_GATEWAY_ID: env["CLOUDFLARE_AIG_ID"],
    };
  }
  return {} as Record<string, string | undefined>;
}

const XAI_OIDC_ISSUER = "https://auth.x.ai";
const XAI_OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_NATIVE_AUTH_ENTRY = `${XAI_OIDC_ISSUER}::${XAI_OIDC_CLIENT_ID}`;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const objectRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const readCredentialStore = async (path: string) => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw new Error(`cannot read credential store at ${path}`);
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Readonly<Record<string, unknown>>;
    }
  } catch {}
  throw new Error(`invalid credential store at ${path}`);
};

const selectPiOAuthCredential = (
  provider: "openai-codex" | "xai",
  value: unknown,
  _totalTimeoutSeconds: number,
) => {
  const credential = objectRecord(value);
  if (
    credential?.["type"] !== "oauth" ||
    !isNonEmptyString(credential["access"]) ||
    !isNonEmptyString(credential["refresh"]) ||
    typeof credential["expires"] !== "number"
  ) {
    throw new Error(`no model credential available for ${provider}`);
  }
  if (
    !Number.isFinite(credential["expires"]) ||
    credential["expires"] <= Date.now()
  ) {
    throw new Error(`expired model credential for ${provider}`);
  }
  const accountId =
    provider === "openai-codex" && isNonEmptyString(credential["accountId"])
      ? credential["accountId"]
      : null;
  return {
    type: "oauth" as const,
    access: credential["access"],
    refresh: credential["refresh"],
    expires: credential["expires"],
    ...(accountId ? { accountId } : {}),
  };
};

const CLAUDE_CODE_PROVIDER = "claude-code";

/**
 * How close to its own expiry a subscription token has to be before it is
 * replaced.
 *
 * Pi refreshes an OAuth credential inside the same window, and a bearer that
 * lapses between two of a lane's requests fails a review with an auth error
 * that says nothing about what actually happened. The window stays short on
 * purpose: a refresh rotates the pair, and one that runs per lane rather than
 * once per run would invalidate the token the lanes before it are still using.
 */
const CLAUDE_CODE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type ClaudeCodeTokens = {
  access: string;
  refresh: string;
  expires: number;
};

const piAuthPath = (env: Readonly<Record<string, string | undefined>>) =>
  env["PI_CODING_AGENT_DIR"]
    ? join(env["PI_CODING_AGENT_DIR"], "auth.json")
    : join(homedir(), ".pi", "agent", "auth.json");

/** The refresh the Claude Code plugin performs: the OAuth endpoint, then its CLI. */
const refreshClaudeCodeTokens = async (current: ClaudeCodeTokens) => {
  const refreshed = await forceRefreshClaudeCodeCreds({
    accessToken: current.access,
    refreshToken: current.refresh,
    expiresAt: current.expires,
  });
  return {
    access: refreshed.accessToken,
    refresh: refreshed.refreshToken,
    expires: refreshed.expiresAt,
  };
};

/**
 * The Claude Code subscription's bearer, replaced when it is about to expire.
 *
 * `/login claude-code` in Pi writes this entry and Pi refreshes it under the
 * same rules, so a review run reads the store Pi owns rather than a second copy
 * of the same subscription. The refreshed pair is written back because a
 * refresh rotates it: a rotated token nobody persists leaves the next run - and
 * the next lane - holding a dead one.
 *
 * Only the access token leaves this function, and only as far as the broker.
 */
export async function resolveClaudeCodeTokens(
  env: Readonly<Record<string, string | undefined>>,
  refresh: (
    current: ClaudeCodeTokens,
  ) => Promise<ClaudeCodeTokens> = refreshClaudeCodeTokens,
) {
  const path = piAuthPath(env);
  const store = await readCredentialStore(path);
  const stored = objectRecord(store[CLAUDE_CODE_PROVIDER]);
  const access = stored?.["access"];
  const refreshToken = stored?.["refresh"];
  const expires = stored?.["expires"];
  if (
    !isNonEmptyString(access) ||
    !isNonEmptyString(refreshToken) ||
    typeof expires !== "number"
  ) {
    throw new Error(
      "no Claude Code subscription credential: run pi, then /login claude-code",
    );
  }
  const current = { access, refresh: refreshToken, expires };
  if (expires - Date.now() > CLAUDE_CODE_REFRESH_MARGIN_MS) return current;
  const refreshed = await refresh(current);
  const written = `${path}.${process.pid}.tmp`;
  await writeFile(
    written,
    JSON.stringify({
      ...store,
      [CLAUDE_CODE_PROVIDER]: {
        type: "oauth",
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
      },
    }),
    { mode: 0o600 },
  );
  await rename(written, path);
  return refreshed;
}

export async function resolveRunCredentials(
  provider: string,
  totalTimeoutSeconds: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const apiCredentials = Object.fromEntries(
    Object.entries(modelCredentials(provider, env)).flatMap(([key, value]) =>
      value ? [[key, value]] : [],
    ),
  );
  if (Object.keys(apiCredentials).length > 0) {
    return {
      authRoute: "api-key" as const,
      accessToken: undefined,
      authJson: null,
      env: apiCredentials,
      redactions: Object.values(apiCredentials),
    };
  }

  if (provider === CLAUDE_CODE_PROVIDER) {
    const tokens = await resolveClaudeCodeTokens(env);
    return {
      authRoute: "subscription-oauth" as const,
      accessToken: tokens.access,
      expires: tokens.expires,
      authJson: null,
      env: {},
      redactions: [tokens.access, tokens.refresh],
    };
  }

  if (provider !== "openai-codex" && provider !== "xai") {
    throw new Error(`no model credential available for ${provider}`);
  }

  const piAuthPath = env["PI_CODING_AGENT_DIR"]
    ? join(env["PI_CODING_AGENT_DIR"], "auth.json")
    : join(homedir(), ".pi", "agent", "auth.json");
  const piAuth = await readCredentialStore(piAuthPath);
  const stored = piAuth[provider];
  if (stored !== undefined) {
    const credential = selectPiOAuthCredential(
      provider,
      stored,
      totalTimeoutSeconds,
    );
    return {
      authRoute: "subscription-oauth" as const,
      accessToken: credential.access,
      expires: credential.expires,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
      authJson: null,
      env: {},
      redactions: [credential.access, credential.refresh],
    };
  }

  if (provider === "openai-codex") {
    throw new Error("no model credential available for openai-codex");
  }

  const grokAuthPath = env["GROK_AUTH_DIR"]
    ? join(env["GROK_AUTH_DIR"], "auth.json")
    : join(homedir(), ".grok", "auth.json");
  const nativeAuth = await readCredentialStore(grokAuthPath);
  const nativeCredential = objectRecord(nativeAuth[XAI_NATIVE_AUTH_ENTRY]);
  if (
    nativeCredential?.["auth_mode"] !== "oidc" ||
    nativeCredential["oidc_issuer"] !== XAI_OIDC_ISSUER ||
    nativeCredential["oidc_client_id"] !== XAI_OIDC_CLIENT_ID ||
    !isNonEmptyString(nativeCredential["key"]) ||
    !isNonEmptyString(nativeCredential["refresh_token"]) ||
    typeof nativeCredential["expires_at"] !== "string"
  ) {
    throw new Error("no model credential available for xai");
  }
  const credential = selectPiOAuthCredential(
    "xai",
    {
      type: "oauth",
      access: nativeCredential["key"],
      refresh: nativeCredential["refresh_token"],
      expires: Date.parse(nativeCredential["expires_at"]),
    },
    totalTimeoutSeconds,
  );
  return {
    authRoute: "subscription-oauth" as const,
    accessToken: credential.access,
    expires: credential.expires,
    authJson: null,
    env: {},
    redactions: [credential.access, credential.refresh],
  };
}

export function adaptModelsConfig(
  existingJson: string,
  provider: string,
  overrides: { apiKey?: string; baseUrl?: string },
): string {
  const parsed: unknown = JSON.parse(existingJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("models.json: expected a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  const providers = (
    typeof config["providers"] === "object" &&
    config["providers"] !== null &&
    !Array.isArray(config["providers"])
      ? { ...(config["providers"] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  const currentProvider = (
    typeof providers[provider] === "object" &&
    providers[provider] !== null &&
    !Array.isArray(providers[provider])
      ? { ...(providers[provider] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;

  providers[provider] = { ...currentProvider, ...overrides };
  return JSON.stringify({ ...config, providers }, null, 2);
}

export {
  BROKER_PORT,
  CONTROL_DIR,
  CONTROL_UID,
  MODEL_BROKER,
  openaiCodexBrokerHandle,
  TARGET_UID,
};

const openaiCodexAccountIdFromToken = (token: string) => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const padded =
      payload.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payload.length % 4)) % 4);
    const parsed: unknown = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    );
    const auth = objectRecord(parsed)?.[OPENAI_CODEX_JWT_CLAIM];
    const accountId = objectRecord(auth)?.["chatgpt_account_id"];
    return isNonEmptyString(accountId) ? accountId : null;
  } catch {
    return null;
  }
};

/**
 * Resolves the one endpoint and bearer a provider's credential authorises.
 *
 * A provider with no single upstream is refused by name rather than quietly
 * downgraded onto another provider's endpoint, and an API-key credential is as
 * valid a bearer as an OAuth access token.
 */
export function upstreamFor(provider: string) {
  const upstream = PROVIDER_UPSTREAM.get(provider);
  if (!upstream) {
    throw new Error(
      `provider ${provider} has no brokered upstream, so its credential cannot be isolated from the reviewed code`,
    );
  }
  return upstream;
}

export function resolveUpstream(
  provider: string,
  credentials: Awaited<ReturnType<typeof resolveRunCredentials>>,
) {
  const upstream = upstreamFor(provider);
  const credentialEnv = { ...credentials.env };
  let baseUrl = upstream.baseUrl;
  if (upstream.accountIdPlaceholder) {
    const accountId = credentialEnv["CLOUDFLARE_ACCOUNT_ID"];
    if (!accountId) {
      throw new Error(`no CLOUDFLARE_ACCOUNT_ID available for ${provider}`);
    }
    baseUrl = baseUrl.replace(upstream.accountIdPlaceholder, accountId);
  }
  if (upstream.gatewayIdPlaceholder) {
    const gatewayId = credentialEnv["CLOUDFLARE_GATEWAY_ID"];
    if (!gatewayId) {
      throw new Error(`no CLOUDFLARE_GATEWAY_ID available for ${provider}`);
    }
    baseUrl = baseUrl.replace(upstream.gatewayIdPlaceholder, gatewayId);
  }
  const bearer =
    credentials.accessToken ??
    Object.entries(credentialEnv).find(([key]) => key.endsWith("API_KEY"))?.[1];
  if (!bearer) {
    throw new Error(`no model credential available for ${provider}`);
  }
  return { baseUrl, bearer };
}

/**
 * How one run reaches its provider without the target ever holding the bearer.
 *
 * Pi is configured with a per-run handle and a loopback base URL; the real
 * credential only ever exists in the broker's own 0600 configuration and in the
 * broker process, both owned by a uid the reviewed repository never executes
 * as.
 */
/**
 * The addressing half of a provider's identity, for the target's environment.
 *
 * Pi will not configure Workers AI without the account id in its own
 * environment, and refusing to pass it leaves the isolated modes unable to run
 * the provider they default to. The bearer stays with the broker either way.
 */
export const targetProviderEnv = (
  provider: string,
  credentials: Awaited<ReturnType<typeof resolveRunCredentials>>,
) => {
  if (!provider.startsWith("cloudflare-")) return {};
  return Object.fromEntries(
    Object.entries(credentials.env).filter(
      ([name]) =>
        name === "CLOUDFLARE_ACCOUNT_ID" || name === "CLOUDFLARE_GATEWAY_ID",
    ),
  );
};

export function planBroker(
  provider: string,
  credentials: Awaited<ReturnType<typeof resolveRunCredentials>>,
  caps: SessionCaps,
  ledgerPath: string,
) {
  const { baseUrl, bearer } = resolveUpstream(provider, credentials);
  const nonce = randomUUID();
  const storedAccountId =
    "accountId" in credentials && isNonEmptyString(credentials.accountId)
      ? credentials.accountId
      : null;
  const openaiAccountId =
    provider === "openai-codex"
      ? (storedAccountId ?? openaiCodexAccountIdFromToken(bearer))
      : null;
  if (provider === "openai-codex" && !openaiAccountId) {
    throw new Error("Failed to extract accountId from token");
  }
  const handle =
    provider === "openai-codex"
      ? openaiCodexBrokerHandle(nonce)
      : `review-pi-${nonce}`;
  return {
    handle,
    baseUrl: `http://127.0.0.1:${BROKER_PORT}`,
    config: {
      port: BROKER_PORT,
      handle,
      upstreamBaseUrl: baseUrl,
      upstreamAuthorization: `Bearer ${bearer}`,
      ...(openaiAccountId ? { upstreamAccountId: openaiAccountId } : {}),
      caps,
      ledgerPath,
    },
  };
}

/**
 * Puts the credential where only the control identity can read it, and starts
 * the broker there.
 *
 * Root appears exactly here and does nothing but create the directory and hand
 * it over: the broker itself is launched through `setpriv`, which drops to the
 * control uid with no supplementary groups before `node` ever runs, so no
 * runtime process in the container holds uid 0.
 */
export const brokerInstallCommands = (
  containerName: string,
  configPath: string,
) => ({
  prepare: [
    "exec",
    "--user",
    "root",
    containerName,
    "sh",
    "-c",
    `mkdir -p ${CONTROL_DIR} && chown ${CONTROL_UID}:${CONTROL_UID} ${CONTROL_DIR} && chmod 0700 ${CONTROL_DIR}`,
  ],
  copy: ["cp", configPath, `${containerName}:${CONTROL_DIR}/broker.json`],
  secure: [
    "exec",
    "--user",
    "root",
    containerName,
    "sh",
    "-c",
    `chown ${CONTROL_UID}:${CONTROL_UID} ${CONTROL_DIR}/broker.json && chmod 0600 ${CONTROL_DIR}/broker.json`,
  ],
  start: [
    "exec",
    "--detach",
    "--user",
    "root",
    containerName,
    "setpriv",
    `--reuid=${CONTROL_UID}`,
    `--regid=${CONTROL_UID}`,
    "--clear-groups",
    "bun",
    MODEL_BROKER,
    `${CONTROL_DIR}/broker.json`,
  ],
});

async function installBroker(
  containerName: string,
  configPath: string,
  budget: ReturnType<typeof createBudget>,
  signal?: AbortSignal,
) {
  const commands = brokerInstallCommands(containerName, configPath);
  await docker(commands.prepare, budget, "broker directory", signal);
  await docker(commands.copy, budget, "broker config upload", signal);
  await docker(commands.secure, budget, "broker config mode", signal);
  await docker(commands.start, budget, "broker start", signal);
}

/**
 * Container arguments for one run: no host mount of any kind, no Docker
 * socket, no host environment, and no credential in the container
 * configuration - the model key is only ever passed to the review exec.
 */
export const containerRunArgs = (
  containerName: string,
  image: string,
  ownershipId: string = randomUUID(),
  limits?: { memory?: string; cpus?: string },
) => [
  "run",
  "--detach",
  "--platform",
  "linux/amd64",
  "--name",
  containerName,
  "--label",
  `review-pi.ownership=${ownershipId}`,
  // Unset by default on purpose: a limit low enough to matter is also low
  // enough to OOM-kill a legitimate typecheck in the middle of a review.
  ...(limits?.memory ? ["--memory", limits.memory] : []),
  ...(limits?.cpus ? ["--cpus", limits.cpus] : []),
  "--entrypoint",
  "sleep",
  image,
  "infinity",
];

/**
 * One deadline for the whole run. Host resolution, the git transport, every
 * container command and the poll loop draw from it, so no phase can spend the
 * review's time and no single call can outlive the run.
 */
export function createBudget(startedAt: number, totalSeconds: number) {
  const deadline = startedAt + totalSeconds * 1000;
  const remainingMs = () => deadline - Date.now();
  return {
    remainingMs,
    /** Milliseconds left for `phase`, or a throw when the run is already over. */
    take(phase: string) {
      const left = remainingMs();
      if (left <= 0) throw new Error(`total deadline exceeded before ${phase}`);
      return left;
    },
  };
}

/** Secret values learned at runtime; every error message is scrubbed of them. */
const redactions = new Set<string>();

export const redactValues = (text: string, secrets: Iterable<string>) => {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length > 0) scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  return scrubbed;
};

/** Argv for an error message: the value of every `--env KEY=value` is dropped. */
export const redactArgs = (args: string[]) =>
  args.map((argument, index) =>
    args[index - 1] === "--env" || args[index - 1] === "-e"
      ? `${argument.split("=")[0]}=[redacted]`
      : argument,
  );

const messageOf = (error: unknown) =>
  redactValues(
    error instanceof Error ? error.message : String(error),
    redactions,
  );

export const execute = (
  file: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
) =>
  new Promise<string>((resolvePromise, reject) => {
    let stopError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(file, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    // Decoded here rather than with `setEncoding`: Bun 1.4.2's own utf8
    // decoder at times never ends a stream whose chunk ends mid-character, and
    // a stream that never ends never emits `close`, so the driver would wait
    // forever for a child that already exited.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const killGroup = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        child.kill(signalName);
      }
    };
    const terminate = (error: Error) => {
      if (stopError) return;
      stopError = error;
      if (child.pid) {
        killGroup("SIGTERM");
        forceKill = setTimeout(() => killGroup("SIGKILL"), 250);
        forceKill.unref();
      }
    };
    const abort = () =>
      terminate(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("interrupted"),
      );
    const deadline = setTimeout(
      () =>
        terminate(new Error(`command deadline exceeded after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      if (forceKill) {
        clearTimeout(forceKill);
        killGroup("SIGKILL");
      }
      if (error) reject(error);
      else resolvePromise(stdout);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += stdoutDecoder.write(chunk);
      if (stdout.length + stderr.length > 32 * 1024 * 1024) {
        terminate(new Error("command output exceeded 32 MiB"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
      if (stdout.length + stderr.length > 32 * 1024 * 1024) {
        terminate(new Error("command output exceeded 32 MiB"));
      }
    });
    child.once("error", (error) => finish(stopError ?? error));
    child.once("close", (code, signalName) => {
      // A stream that ends mid-character still contributes its replacement
      // character, so a clipped tail is never silently dropped.
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (stopError) finish(stopError);
      else if (code === 0) finish();
      else
        finish(
          new Error(
            `${file} exited ${code ?? signalName}: ${stderr.trim().split("\n")[0] ?? ""}`,
          ),
        );
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

/**
 * Runs one docker command inside the shared budget. Failures never carry the
 * raw argv or provider output: both hold the injected model credential.
 */
const docker = async (
  args: string[],
  budget: ReturnType<typeof createBudget>,
  phase: string,
  signal?: AbortSignal,
) => {
  try {
    return await execute("docker", args, budget.take(phase), signal);
  } catch (error) {
    throw new Error(
      `docker ${redactArgs(args).slice(0, 3).join(" ")} failed: ${messageOf(error).split("\n")[0]}`,
    );
  }
};

async function githubJson<T>(
  path: string,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** Resolves a PR to exact SHAs on the host, where the GitHub token lives. */
export async function resolveRevisions(
  options: Pick<LocalOptions, "pullRequest" | "head" | "base" | "repo">,
  budget: ReturnType<typeof createBudget>,
  signal?: AbortSignal,
) {
  if (!options.pullRequest) {
    if (!options.head || !options.base) throw new Error("missing revisions");
    return { head: { sha: options.head }, base: { sha: options.base } };
  }
  const token =
    process.env["GITHUB_TOKEN"] ??
    (
      await execute(
        "gh",
        ["auth", "token"],
        budget.take("github token"),
        signal,
      )
    ).trim();
  redactions.add(token);
  const repo = requiredRepo(options.repo);
  const pull = await githubJson<{
    head: { sha: string };
    base: { sha: string };
  }>(
    `repos/${repo}/pulls/${options.pullRequest}`,
    token,
    budget.take("pull request lookup"),
    signal,
  );
  const head = options.head ?? pull.head.sha;
  if (options.base) return { head: { sha: head }, base: { sha: options.base } };
  // `pull.base.sha` is the base branch as it stands now, not where this branch
  // left it. Diffing against it shows every commit the base gained since, in
  // reverse, as though this change had deleted other people's merged work - so
  // reviewers investigate files the pull request never touched. The merge base
  // is what GitHub itself shows.
  const comparison = await githubJson<{
    merge_base_commit: { sha: string };
  }>(
    `repos/${repo}/compare/${pull.base.sha}...${head}`,
    token,
    budget.take("merge base lookup"),
    signal,
  );
  return {
    head: { sha: head },
    base: { sha: comparison.merge_base_commit.sha },
  };
}

const git = async (
  args: string[],
  budget: ReturnType<typeof createBudget>,
  phase: string,
  signal?: AbortSignal,
  cwd?: string,
) => {
  try {
    return (await execute("git", args, budget.take(phase), signal, cwd)).trim();
  } catch (error) {
    throw new Error(
      `git ${args[0]} failed: ${messageOf(error).split("\n")[0]}`,
    );
  }
};

/**
 * Builds a run-owned bare repository holding exactly the two requested
 * commits, fetched from the host clone's object store. Fetching by SHA needs
 * the source side to answer arbitrary wants, hence the explicit upload-pack.
 */
export async function prepareTransport(
  sourceRepo: string,
  target: string,
  head: string,
  base: string,
  budget: ReturnType<typeof createBudget>,
  signal?: AbortSignal,
) {
  await git(
    ["init", "--quiet", "--bare", target],
    budget,
    "transport init",
    signal,
  );
  const source = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    budget,
    "transport source",
    signal,
    sourceRepo,
  );
  await git(
    [
      "-C",
      target,
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--upload-pack",
      "git -c uploadpack.allowAnySHA1InWant=true upload-pack",
      `file://${source}`,
      `${head}:refs/heads/head`,
      `${base}:refs/heads/base`,
    ],
    budget,
    "transport fetch",
    signal,
    sourceRepo,
  );
  await git(
    ["-C", target, "symbolic-ref", "HEAD", "refs/heads/head"],
    budget,
    "transport head",
    signal,
  );
  const served = {
    head: await git(
      ["-C", target, "rev-parse", "refs/heads/head"],
      budget,
      "transport verify",
      signal,
    ),
    base: await git(
      ["-C", target, "rev-parse", "refs/heads/base"],
      budget,
      "transport verify",
      signal,
    ),
  };
  if (served.head !== head || served.base !== base) {
    throw new Error(
      `transport identity mismatch: served ${served.head}/${served.base}, requested ${head}/${base}`,
    );
  }
  return served;
}

/** Ensures the host clone actually holds both commits before a run starts. */
export async function ensureObjects(
  sourceRepo: string,
  head: string,
  base: string,
  budget: ReturnType<typeof createBudget>,
  pullRequest?: number,
  signal?: AbortSignal,
) {
  const present = async (sha: string) => {
    try {
      await git(
        ["-C", sourceRepo, "cat-file", "-e", `${sha}^{commit}`],
        budget,
        "commit lookup",
        signal,
      );
      return true;
    } catch {
      return false;
    }
  };
  if ((await present(head)) && (await present(base))) return;
  const refspec = pullRequest
    ? [`refs/pull/${pullRequest}/head`]
    : [head, base];
  await git(
    ["-C", sourceRepo, "fetch", "--quiet", "--no-tags", "origin", ...refspec],
    budget,
    "origin fetch",
    signal,
  );
  if (!(await present(head)) || !(await present(base))) {
    await git(
      ["-C", sourceRepo, "fetch", "--quiet", "--no-tags", "origin", base],
      budget,
      "origin fetch",
      signal,
    );
  }
  if (!(await present(head)) || !(await present(base))) {
    throw new Error(`host clone is missing ${head} or ${base}`);
  }
}

/**
 * JSON crossing back from the container is input, not a promise: every reader
 * below validates the fields it uses so the rest of the code infers its types
 * from a checked shape rather than from an assertion.
 */
const jsonObject = (raw: string, source: string) => {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const stringAt = (
  object: Readonly<Record<string, unknown>>,
  key: string,
  source: string,
) => {
  const value = object[key];
  if (typeof value !== "string")
    throw new Error(`${source}: ${key} is not a string`);
  return value;
};

const numberAt = (
  object: Readonly<Record<string, unknown>>,
  key: string,
  source: string,
) => {
  const value = object[key];
  if (typeof value !== "number")
    throw new Error(`${source}: ${key} is not a number`);
  return value;
};

const optionalString = (
  object: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = object[key];
  return typeof value === "string" ? value : null;
};

const optionalNumber = (
  object: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = object[key];
  return typeof value === "number" ? value : null;
};

const optionalBoolean = (
  object: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = object[key];
  return typeof value === "boolean" ? value : null;
};

const optionalRecord = (
  object: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = object[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
};

const recordAt = (
  object: Readonly<Record<string, unknown>>,
  key: string,
  source: string,
) => {
  const value = object[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: ${key} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

/** Numeric fields, keeping the null a writer recorded for a count it never observed. */
const numberRecord = (
  object: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = object[key];
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, entry]) =>
      typeof entry === "number" || entry === null
        ? [[field, entry] as const]
        : [],
    ),
  );
};

export const readStatus = (raw: string) => {
  const status = jsonObject(raw, "status.json");
  return {
    runId: stringAt(status, "runId", "status.json"),
    phase: stringAt(status, "phase", "status.json"),
    state: stringAt(status, "state", "status.json"),
    detail: optionalString(status, "detail") ?? "",
  };
};

/**
 * The install the runner recorded in report.json.
 *
 * A skipped install is not a completed one, and a report written before the
 * runner recorded either observed neither: the first reads true, the second
 * false, and an install nobody observed reads null rather than as one that ran.
 */
const readInstallEvidence = (report: Readonly<Record<string, unknown>>) => {
  const value = report["install"];
  const install =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  const status = install?.["status"];
  return {
    skipped:
      status === "skipped" ? true : status === "installed" ? false : null,
    reason:
      status === "skipped" && install
        ? optionalString(install, "reason")
        : null,
  };
};

/**
 * The isolation verdicts the cloud driver recorded for the lane.
 *
 * A receipt that carries no verdict, and a verdict the control plane could not
 * take, each read null: never as a probe that found the target contained.
 */
const readIsolationEvidence = (receipt: Readonly<Record<string, unknown>>) => {
  const isolation = optionalRecord(receipt, "isolation");
  if (!isolation) return null;
  const controlApi = optionalRecord(isolation, "controlApi");
  const brokerRead = optionalRecord(isolation, "targetReadBroker");
  return {
    controlApi: controlApi
      ? {
          uid: optionalNumber(controlApi, "uid"),
          reason: optionalString(controlApi, "reason"),
          escaped: optionalBoolean(controlApi, "escaped"),
        }
      : null,
    targetReadBroker: brokerRead
      ? {
          verdict: optionalString(brokerRead, "verdict"),
          reason: optionalString(brokerRead, "reason"),
        }
      : null,
  };
};

const readReport = (raw: string) => {
  const report = jsonObject(raw, "report.json");
  const checkout = recordAt(report, "checkout", "report.json");
  if (checkout["commitIdentityPreserved"] !== true) {
    throw new Error("report.json: checkout identity is not preserved");
  }
  const usage = numberRecord(report, "usage");
  if (!usage) throw new Error("report.json: usage is not an object");
  return {
    checkout: {
      commitIdentityPreserved: true as const,
      requestedHeadSha: stringAt(
        checkout,
        "requestedHeadSha",
        "report.json checkout",
      ),
      requestedBaseSha: stringAt(
        checkout,
        "requestedBaseSha",
        "report.json checkout",
      ),
      checkedOutHead: stringAt(
        checkout,
        "checkedOutHead",
        "report.json checkout",
      ),
      checkedOutBase: stringAt(
        checkout,
        "checkedOutBase",
        "report.json checkout",
      ),
      fixtureCommitApplied: stringAt(
        checkout,
        "fixtureCommitApplied",
        "report.json checkout",
      ),
    },
    install: readInstallEvidence(report),
    usage,
    piVersion: stringAt(report, "piVersion", "report.json"),
  };
};

/** The lane's own report, when it wrote one before the run ended. */
const readExportedReport = (outDir: string) =>
  readFile(join(outDir, "report.json"), "utf8")
    .then(readReport)
    .catch(() => undefined);

/** Optional list of strings on an optional object; anything else reads empty. */
const stringList = (container: unknown, key: string) => {
  if (typeof container !== "object" || container === null) return [];
  const value = (container as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const OUTCOMES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "blocked",
  "unverified",
] as const;

const readOutcome = (value: string) => {
  const outcome = OUTCOMES.find((known) => known === value);
  if (!outcome) throw new Error(`local-receipt.json: unknown outcome ${value}`);
  return outcome;
};

/** Reads one receipt back through the shape the driver itself writes. */
export async function readLocalReceipt(directory: string) {
  const receipt = jsonObject(
    await readFile(join(directory, "local-receipt.json"), "utf8"),
    "local-receipt.json",
  );
  return {
    runId: stringAt(receipt, "runId", "local-receipt.json"),
    attemptId: stringAt(receipt, "attemptId", "local-receipt.json"),
    outcome: readOutcome(stringAt(receipt, "outcome", "local-receipt.json")),
    provider: stringAt(receipt, "provider", "local-receipt.json"),
    model: stringAt(receipt, "model", "local-receipt.json"),
    wallSeconds: numberAt(receipt, "wallSeconds", "local-receipt.json"),
    teardownSeconds: numberAt(receipt, "teardownSeconds", "local-receipt.json"),
    usage: numberRecord(receipt, "usage"),
    installSkipped: optionalBoolean(receipt, "installSkipped"),
    installSkipReason: optionalString(receipt, "installSkipReason"),
    truncatedArtifacts: stringList(receipt["shutdown"], "truncatedArtifacts"),
    modelRequests: optionalNumber(receipt, "modelRequests"),
    laneInputCap: optionalNumber(receipt, "laneInputCap") ?? null,
    isolation: readIsolationEvidence(receipt),
    error: optionalString(receipt, "error"),
  };
}

export const isMissingFile = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/** Local driver writes local-receipt.json; the cloud driver writes receipt.json. */
export async function readLaneReceipt(directory: string) {
  try {
    return await readLocalReceipt(directory);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const receipt = jsonObject(
    await readFile(join(directory, "receipt.json"), "utf8"),
    "receipt.json",
  );
  let install: ReturnType<typeof readInstallEvidence> | null = null;
  try {
    const report = jsonObject(
      await readFile(join(directory, "report.json"), "utf8"),
      "report.json",
    );
    install = readInstallEvidence(report);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const runError = optionalString(receipt, "runError");
  return {
    runId: stringAt(receipt, "runId", "receipt.json"),
    attemptId:
      optionalString(receipt, "attemptId") ??
      stringAt(receipt, "runId", "receipt.json"),
    outcome: readOutcome(runError ? "failed" : "completed"),
    provider: stringAt(receipt, "provider", "receipt.json"),
    model: stringAt(receipt, "model", "receipt.json"),
    wallSeconds: numberAt(receipt, "wallSeconds", "receipt.json"),
    // The cloud driver times no teardown and lists no truncated artifact, and
    // a zero or an empty list here would be a measurement nobody took.
    teardownSeconds: null,
    // The Worker's session totals, which is the only side that held the
    // credential. A lane whose session was never observed spent nothing the
    // host can price, which is unobserved and not zero.
    usage: numberRecord(receipt, "usage"),
    installSkipped: install?.skipped ?? null,
    installSkipReason: install?.reason ?? null,
    truncatedArtifacts: null,
    modelRequests: optionalNumber(receipt, "modelRequests"),
    isolation: readIsolationEvidence(receipt),
    error: runError,
  };
}

/** Writes the local driver's receipt so a reader never sees it half-written. */
export const writeLocalReceipt = async (
  directory: string,
  receipt: Record<string, unknown>,
) =>
  writeAtomic(
    join(directory, "local-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );

async function exportArtifacts(
  containerName: string,
  containerRunDir: string,
  outDir: string,
  budget: ReturnType<typeof createBudget>,
) {
  const exported: string[] = [];
  const absent: string[] = [];
  const truncated: string[] = [];
  const errors: string[] = [];
  for (const name of EXPORTED_ARTIFACTS) {
    try {
      // One byte past the ceiling: without it a file that lands exactly on the
      // limit is indistinguishable from one the export cut in half.
      const result = await docker(
        [
          "exec",
          containerName,
          "sh",
          "-c",
          `if [ -f ${containerRunDir}/${name} ]; then printf 'review-pi-present\\n'; head -c ${MAX_ARTIFACT_BYTES + 1} ${containerRunDir}/${name}; elif [ ! -e ${containerRunDir}/${name} ]; then printf 'review-pi-absent\\n'; else exit 2; fi`,
        ],
        budget,
        `export ${name}`,
      );
      const markerEnd = result.indexOf("\n");
      const marker = result.slice(0, markerEnd);
      if (marker === "review-pi-absent") {
        absent.push(name);
        continue;
      }
      if (marker !== "review-pi-present") {
        throw new Error(`${name}: invalid export marker`);
      }
      const rawText = result.slice(markerEnd + 1);
      const rawContent = Buffer.from(rawText);
      const content = Buffer.from(redactValues(rawText, redactions));
      if (
        rawContent.byteLength > MAX_ARTIFACT_BYTES ||
        content.byteLength > MAX_ARTIFACT_BYTES
      ) {
        truncated.push(name);
        await writeFile(
          join(outDir, name),
          content.subarray(0, MAX_ARTIFACT_BYTES),
        );
      } else {
        await writeFile(join(outDir, name), content);
      }
      exported.push(name);
    } catch (error) {
      errors.push(`${name}: ${messageOf(error)}`);
    }
  }
  return { exported, absent, truncated, errors };
}

/**
 * Copy the Pi session out of the lane before its container goes away.
 *
 * Every other artifact is evidence *about* the run; this one is the run. Without
 * it a finished review cannot be reopened and read turn by turn, so the only
 * account of what the reviewer saw dies with the container. It travels by
 * `docker cp` rather than the exec-and-clip path the other artifacts use,
 * because a session clipped at MAX_ARTIFACT_BYTES no longer opens.
 */
async function exportSession(
  containerName: string,
  containerRunDir: string,
  outDir: string,
  budget: ReturnType<typeof createBudget>,
) {
  const listed = await docker(
    [
      "exec",
      containerName,
      "sh",
      "-c",
      `ls -1t ${containerRunDir}/sessions/*.jsonl 2>/dev/null | head -1`,
    ],
    budget,
    "locate session",
  );
  const sessionPath = listed.trim();
  if (!sessionPath) return null;
  const target = join(outDir, "session.jsonl");
  await docker(
    ["cp", `${containerName}:${sessionPath}`, target],
    budget,
    "export session",
  );
  await writeFile(
    target,
    redactValues(await readFile(target, "utf8"), redactions),
  );
  return basename(sessionPath);
}

/**
 * Watch the runner turn an accepted candidate into a complete report.
 *
 * Acceptance is not completion: the runner still has to write report.json,
 * trace.jsonl and a checkout that matches the pinned revisions. A run whose
 * finalization is merely unobserved keeps its container and its evidence.
 */
export async function observeFinalization(
  containerName: string,
  containerRunDir: string,
  expected: { head: string; base: string },
  signal?: AbortSignal,
  attempts = 60,
): Promise<{ validated: boolean; detail: string; error: string | null }> {
  let detail = "report.json was never written";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reviewError = await docker(
      ["exec", containerName, "cat", `${containerRunDir}/review-error.json`],
      createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS),
      "finalization error check",
      signal,
    ).catch(() => "");
    if (reviewError.trim()) {
      return {
        validated: false,
        detail: "",
        error: `runner rejected the accepted final: ${reviewError.trim().slice(0, 2000)}`,
      };
    }

    const raw = await docker(
      ["exec", containerName, "cat", `${containerRunDir}/report.json`],
      createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS),
      "report read",
      signal,
    ).catch(() => "");
    if (!raw.trim()) {
      await sleep(1000, undefined, signal ? { signal } : undefined);
      continue;
    }

    let report: ReturnType<typeof readReport>;
    try {
      report = readReport(raw);
    } catch (error) {
      return {
        validated: false,
        detail: "",
        error: `report.json is not a valid review report: ${messageOf(error)}`,
      };
    }
    if (
      report.checkout.requestedHeadSha !== expected.head ||
      report.checkout.requestedBaseSha !== expected.base
    ) {
      return {
        validated: false,
        detail: "",
        error: `report claims ${report.checkout.requestedHeadSha}/${report.checkout.requestedBaseSha} instead of the pinned ${expected.head}/${expected.base}`,
      };
    }
    const traceLines = await docker(
      [
        "exec",
        containerName,
        "sh",
        "-c",
        `wc -l < ${containerRunDir}/trace.jsonl`,
      ],
      createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS),
      "trace read",
      signal,
    ).catch(() => "0");
    if (Number(traceLines.trim()) <= 0) {
      detail = "report.json is complete but trace.jsonl is still empty";
      await sleep(1000, undefined, signal ? { signal } : undefined);
      continue;
    }
    return { validated: true, detail: "", error: null };
  }
  return { validated: false, detail, error: null };
}

/**
 * The runner's own status file, read straight from the container.
 *
 * Before the review starts there is no bridge to ask: the socket only exists
 * once Pi is up. A run that dies in clone, install or check writes its terminal
 * state here and then has nothing left to answer with, so this is the only
 * place that fact lives.
 */
export async function readContainerStatus(
  containerName: string,
  containerRunDir: string,
  signal?: AbortSignal,
) {
  const raw = await docker(
    ["exec", containerName, "cat", `${containerRunDir}/status.json`],
    createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS),
    "status.json read",
    signal,
  ).catch(() => "");
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const process_ = (parsed["process"] ?? {}) as Record<string, unknown>;
    return {
      phase: String(parsed["phase"] ?? ""),
      state: String(parsed["state"] ?? ""),
      detail: String(parsed["detail"] ?? ""),
      terminalReason: parsed["terminalReason"]
        ? String(parsed["terminalReason"])
        : null,
      alive: process_["alive"] === true,
    };
  } catch {
    return null;
  }
}

/** Runner states that end a lane whose bridge is gone. */
const LANE_ENDING_STATES: readonly string[] = [
  "failed",
  "blocked",
  "cancelled",
];

/** Live events worth a line; the rest of the raw stream is per-token noise. */
const ACTIVITY_TYPES = [
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
] as const;

/**
 * A model-written field rendered into someone's terminal.
 *
 * Tool arguments and results are never printed: they carry the reviewed
 * repository's content and the run's own environment, and a raw byte range
 * pasted into a pty is also a place to hide control sequences. Only bounded
 * identity and status fields survive, stripped of anything but printable text.
 */
const safeField = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/\p{Cc}/gu, "").slice(0, 60) || "?"
    : "?";

/**
 * One line of readable activity from one raw Pi event.
 *
 * Phase changes alone say a review is running, not what it is doing. These are
 * the events that name the reviewer's actual moves - which tool it reached
 * for, whether that tool failed, and what each turn cost.
 */
export function formatActivityEvent(line: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  const type = record["type"];
  const tool = safeField(record["toolName"]);
  if (type === "tool_execution_start") {
    return `tool ${tool} start`;
  }
  if (type === "tool_execution_end") {
    const bytes = record["resultBytes"];
    return `tool ${tool} ${record["isError"] === true ? "error" : "ok"}${
      typeof bytes === "number" ? ` ${bytes}b` : ""
    }`;
  }
  if (type === "turn_end") {
    const message = (record["message"] ?? {}) as Record<string, unknown>;
    const usage = (message["usage"] ?? {}) as Record<string, unknown>;
    const count = (key: string) =>
      typeof usage[key] === "number" ? String(usage[key]) : "?";
    return `turn ${safeField(message["stopReason"])} in=${count("input")} out=${count("output")}`;
  }
  return null;
}

/**
 * Reads the raw Pi stream past a line cursor, filtered in the container.
 *
 * The raw file carries one event per streamed token, so the filter and the tail
 * cap both run container-side: what crosses the docker boundary each tick is a
 * handful of lines, not the transcript.
 */
export async function readActivity(
  containerName: string,
  containerRunDir: string,
  fromLine: number,
  signal?: AbortSignal,
  maxLines = 20,
) {
  const unchanged = { nextLine: fromLine, lines: [] as string[] };
  const selector = ACTIVITY_TYPES.map((type) => `.type == "${type}"`).join(
    " or ",
  );
  // The line count and the read come from one snapshot: `sed` stops at the
  // counted line, so an append landing mid-read is left for the next tick
  // instead of being replayed under a cursor that already moved past it.
  const raw = await docker(
    [
      "exec",
      containerName,
      "sh",
      "-c",
      `f=${containerRunDir}/pi-raw.jsonl; [ -f "$f" ] || exit 1; n=$(wc -l < "$f"); echo "$n"; ` +
        `[ "$n" -ge ${fromLine} ] && sed -n '${fromLine},'"$n"'p' "$f" | ` +
        `jq -c -R 'fromjson? | select(${selector})' | tail -n ${maxLines}; exit 0`,
    ],
    createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS),
    "activity read",
    signal,
  ).catch(() => "");
  const [total, ...events] = raw.split("\n");
  const counted = (total ?? "").trim();
  // An unreadable stream is uncertainty about this tick only. Resetting the
  // cursor here would replay every event already printed.
  if (!/^\d+$/.test(counted)) return unchanged;
  return {
    nextLine: Number(counted) + 1,
    lines: events
      .map((line) => formatActivityEvent(line))
      .filter((line): line is string => line !== null),
  };
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const options = parseOptions(argv);
  // One value for the whole lane: the broker cuts it at these caps and the
  // runner's notice is measured against the same numbers, so a lane cannot be
  // told one budget and stopped at another.
  const caps = laneCaps(options.trialKind, options.laneInputCap);
  const isControlAction =
    options.inspect ||
    options.cancel ||
    options.reconnect ||
    options.resume ||
    Boolean(options.steer);
  /**
   * Preparation and one-shot control actions draw from `--total-timeout`; the
   * review ends at the run's deadline.
   */
  const budget = createBudget(startedAt, options.totalTimeoutSeconds);
  /** A fresh bound per control request inside the run's deadline. */
  const controlBudget = () =>
    createBudget(Date.now(), CONTROL_REQUEST_BUDGET_SECONDS);
  // A run names both halves of its target: the GitHub identity its revisions
  // are resolved against and the checkout that holds the commits it reviews.
  // A control action names neither - it acts on a run that already recorded
  // them in its own metadata.
  const repo = isControlAction ? "" : requiredRepo(options.repo);
  const sourceRepo = isControlAction ? "" : requiredSource(options.source);
  const runnerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "container",
    "review-run.sh",
  );
  if (!isControlAction) {
    const containerDir = dirname(runnerPath);
    options.image = await laneImageReference(
      repo,
      flag(argv, "image"),
      containerDir,
      join(containerDir, "context", "bun.lock"),
    );
  }
  await mkdir(options.outDir, { recursive: true });
  const outDir = join(options.outDir, options.runId);
  await mkdir(outDir, { recursive: true });
  const metadataPath = join(outDir, "metadata.json");
  let containerRunDir = `/workspace/runs/${options.runId}`;
  let containerName = `review-pi-local-${options.runId}`;
  let ownershipId: string = randomUUID();
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // A closed Orca tab reaches the driver as SIGHUP, and an unhandled SIGHUP
  // would end it before teardown - leaving the container it owns running.
  process.once("SIGHUP", onSignal);
  // A runner that never ends, a container that stops answering and a status
  // file that says done forever all end here, with the usual teardown.
  const deadlineSeconds =
    options.totalTimeoutSeconds + RUN_DEADLINE_GRACE_SECONDS;
  let deadlineReached = false;
  const deadlineTimer = setTimeout(
    () => {
      deadlineReached = true;
      controller.abort(new Error("run deadline exceeded"));
    },
    startedAt + deadlineSeconds * 1000 - Date.now(),
  );
  deadlineTimer.unref();

  let revisions: { head: { sha: string }; base: { sha: string } } | undefined;
  let stage: string | undefined;
  let runnerSha: string | null = null;
  let startAttempted = false;
  let containerCreated = false;
  let reviewStarted = false;
  let finalAccepted = false;
  // Where the runner itself stopped, when the driver saw it stop. A container
  // whose end was observed, or whose deadline passed, is disposed of like an
  // accepted one; a container the driver lost sight of is kept with its
  // evidence, and an auth-blocked one is kept because it is the one kind of
  // end a resume can pick up.
  let runnerTerminalReason: string | null = null;
  // The state the runner said the lane ended in, whichever poll heard it: the
  // receipt's outcome is read from this, never from the error's wording.
  let runnerEnding: string | null = null;
  const containerDisposable = () =>
    options.cancel ||
    finalAccepted ||
    deadlineReached ||
    !reviewStarted ||
    (runnerTerminalReason !== null && runnerTerminalReason !== "auth_blocked");
  let imageId: string | null = null;
  let containerRunnerSha: string | null = null;
  let status: ReturnType<typeof readStatus> | undefined;
  let credentials:
    | Awaited<ReturnType<typeof resolveRunCredentials>>
    | undefined;
  let broker: ReturnType<typeof planBroker> | undefined;
  let admission: ReturnType<typeof evaluateAdmission> | undefined;
  let promptSha: string | null = null;
  let runError: string | null = null;
  let activeRole = options.role;
  let activeCandidateIds = options.candidateIds ?? [];
  let activeLaneId = options.laneId;
  let laneInputCap = caps.maxCumulativeInputTokens;
  const interventions: Array<{ at: string; type: string; reason: string }> = [];
  let corrections = 0;

  const teardown = async (beganAt: number) => {
    const teardownBudget = createBudget(beganAt, TEARDOWN_BUDGET_SECONDS);
    let ownedContainer = containerCreated ? containerName : null;
    let ownershipError: string | null = null;
    if (!ownedContainer && startAttempted) {
      try {
        const matches = (
          await docker(
            [
              "ps",
              "--all",
              "--quiet",
              "--filter",
              `label=review-pi.ownership=${ownershipId}`,
            ],
            teardownBudget,
            "owned container lookup",
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        if (matches.length > 1) {
          ownershipError = `ownership label matched ${matches.length} containers`;
        } else {
          ownedContainer = matches[0] ?? null;
        }
      } catch (error) {
        ownershipError = messageOf(error);
      }
    }
    const exportBudget = createBudget(beganAt, 60);
    const artifacts = ownedContainer
      ? await exportArtifacts(
          ownedContainer,
          containerRunDir,
          outDir,
          exportBudget,
        )
      : { exported: [], absent: [], truncated: [], errors: [] };
    let sessionExported: string | null = null;
    let sessionExportError: string | null = null;
    if (ownedContainer) {
      try {
        sessionExported = await exportSession(
          ownedContainer,
          containerRunDir,
          outDir,
          exportBudget,
        );
      } catch (error) {
        sessionExportError = messageOf(error);
      }
    }
    let authRemoved = false;
    let authRemoveError: string | null = null;
    let providerUsage: string | null = null;
    // The broker's ledger is the only unforgeable record of what the provider
    // was actually asked, so it leaves before the credential does.
    if (ownedContainer) {
      try {
        providerUsage = await docker(
          [
            "exec",
            "--user",
            "root",
            ownedContainer,
            "cat",
            `${CONTROL_DIR}/provider-usage.jsonl`,
          ],
          teardownBudget,
          "provider usage export",
        );
        await writeFile(join(outDir, "provider-usage.jsonl"), providerUsage);
      } catch {
        providerUsage = null;
      }
    }
    // A run that keeps its container for evidence must not keep the bearer
    // inside it. Resume re-stages a renewed credential, so removing the staged
    // one costs the run nothing and leaves no token in a live container.
    if (ownedContainer && broker) {
      try {
        await docker(
          [
            "exec",
            "--user",
            "root",
            ownedContainer,
            "sh",
            "-c",
            // The file is one copy of the bearer; the running broker is the
            // other, so both go before the container is left for inspection.
            `pkill --uid ${CONTROL_UID} --full model-broker.ts; rm --force ${CONTROL_DIR}/broker.json`,
          ],
          teardownBudget,
          "auth removal",
        );
        authRemoved = true;
      } catch (error) {
        authRemoveError = messageOf(error);
      }
    }
    let removed = false;
    let removeError: string | null = null;
    let removalSkippedReason: string | null = null;
    const shouldRemoveContainer =
      ownedContainer && !options.keepContainer && containerDisposable();
    if (ownedContainer && !shouldRemoveContainer) {
      removalSkippedReason = options.keepContainer
        ? "kept by --keep"
        : runnerTerminalReason === "auth_blocked"
          ? "run is auth-blocked, so its container is retained for resume"
          : "run is unfinished, so its container is retained for inspection and resume";
    }

    if (shouldRemoveContainer && ownedContainer) {
      try {
        await docker(
          ["rm", "--force", "--volumes", ownedContainer],
          teardownBudget,
          "container removal",
        );
        removed = true;
      } catch (error) {
        removeError = messageOf(error);
      }
    }
    let transportError: string | null = null;
    if (stage) {
      try {
        await execute(
          "rm",
          ["-rf", "--", stage],
          teardownBudget.take("transport removal"),
        );
      } catch (error) {
        transportError = messageOf(error);
      }
    }
    return {
      ownedContainer,
      ownershipError,
      exported: artifacts.exported,
      absent: artifacts.absent,
      truncated: artifacts.truncated,
      exportErrors: artifacts.errors,
      authRemoved,
      authRemoveError,
      providerUsage,
      removed,
      removeError,
      removalSkippedReason,
      sessionExported,
      sessionExportError,
      transportError,
    };
  };

  try {
    if (isControlAction) {
      let metadata: RunMetadata;
      try {
        metadata = JSON.parse(
          await readFile(metadataPath, "utf8"),
        ) as RunMetadata;
      } catch {
        throw new Error(
          `run ${options.runId} not found in ${options.outDir}: missing metadata.json`,
        );
      }

      const matches = (
        await docker(
          [
            "ps",
            "--all",
            "--quiet",
            "--filter",
            `label=review-pi.ownership=${metadata.ownershipId}`,
          ],
          budget,
          "ownership lookup",
          controller.signal,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      if (matches.length === 0) {
        throw new Error(
          `container for run ${options.runId} not found with ownership ${metadata.ownershipId}`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `ownership collision: multiple containers match ownership ${metadata.ownershipId}`,
        );
      }

      const nameMatches = (
        await docker(
          [
            "ps",
            "--all",
            "--quiet",
            "--filter",
            `name=^${metadata.containerName}$`,
          ],
          budget,
          "name lookup",
          controller.signal,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      if (nameMatches.length === 0 || nameMatches[0] !== matches[0]) {
        throw new Error(
          `container name mismatch or collision for run ${options.runId}`,
        );
      }

      const containerImageId = (
        await docker(
          ["inspect", "--format", "{{.Image}}", metadata.containerName],
          budget,
          "container image inspect",
          controller.signal,
        )
      ).trim();
      if (
        metadata.image.id &&
        containerImageId &&
        containerImageId !== metadata.image.id
      ) {
        throw new Error(
          `container image mismatch: ${containerImageId} !== ${metadata.image.id}`,
        );
      }

      // A resume restarts the broker and pi with this checkout's staging, so
      // it holds the image to the host's copies as a fresh start does. Every
      // other action only reattaches to the lane its metadata recorded, and a
      // checkout that moved since must not keep an operator from inspecting
      // or cancelling it.
      const attachSources = options.resume
        ? await readImageSources(dirname(runnerPath))
        : metadata.observedSources;
      if (!attachSources) {
        throw new Error(
          `lane metadata for ${metadata.containerName} carries no source fingerprints and cannot be verified`,
        );
      }
      const attachFingerprint = await docker(
        [
          "exec",
          metadata.containerName,
          "sh",
          "-c",
          sourceFingerprintCommand(),
        ],
        budget,
        "source fingerprint check",
        controller.signal,
      );
      const attachMismatch = firstSourceMismatch(
        attachSources,
        parseSourceFingerprint(attachFingerprint).sources,
      );
      if (attachMismatch) {
        throw new Error(sourceMismatchDetail(attachMismatch));
      }

      const containerJobJson = await docker(
        [
          "exec",
          metadata.containerName,
          "cat",
          `${metadata.containerRunDir}/job.json`,
        ],
        budget,
        "job json check",
        controller.signal,
      );
      let parsedJob: ReviewJob;
      try {
        parsedJob = JSON.parse(containerJobJson) as ReviewJob;
      } catch (error) {
        throw new Error(
          `unreadable job.json in container ${metadata.containerName}: ${messageOf(error)}`,
        );
      }
      if (
        parsedJob.head.sha !== metadata.revisions.head.sha ||
        parsedJob.base.sha !== metadata.revisions.base.sha ||
        firstSourceMismatch(
          metadata.expectedSources,
          parsedJob.expectedSources ?? {},
        ) !== null
      ) {
        throw new Error(
          `job revision or source mismatch in container ${metadata.containerName}`,
        );
      }

      containerName = metadata.containerName;
      containerRunDir = metadata.containerRunDir;
      ownershipId = metadata.ownershipId;
      containerCreated = true;
      startAttempted = true;
      reviewStarted = true;
      revisions = metadata.revisions;
      runnerSha = metadata.runnerSha;
      containerRunnerSha = metadata.containerRunnerSha ?? null;
      promptSha = metadata.promptSha;
      imageId = metadata.image.id;
      laneInputCap = metadata.credentialIsolation.caps.maxCumulativeInputTokens;
      activeRole = metadata.role ?? options.role;
      activeCandidateIds = metadata.candidateIds ?? options.candidateIds ?? [];
      activeLaneId = metadata.laneId ?? options.laneId ?? "lane-1";

      if (options.inspect) {
        let inspectRes: Record<string, unknown> | undefined;
        try {
          inspectRes = await sendBridgeCommand(
            metadata.containerName,
            metadata.containerRunDir,
            { type: "inspect" },
            budget,
            controller.signal,
          );
        } catch {
          const statusRaw = await docker(
            [
              "exec",
              metadata.containerName,
              "cat",
              `${metadata.containerRunDir}/status.json`,
            ],
            budget,
            "read status.json",
            controller.signal,
          ).catch(() => null);
          if (statusRaw) {
            try {
              const parsed = JSON.parse(statusRaw.trim());
              inspectRes = {
                success: true,
                data: {
                  runId: parsed.runId ?? metadata.runId,
                  phase: parsed.phase ?? "preparation",
                  state: parsed.state ?? "running",
                  detail: parsed.detail ?? "",
                  childIdle:
                    parsed.state === "done" || parsed.state === "failed",
                  terminalReason:
                    parsed.state === "failed"
                      ? parsed.detail || "preparation_failed"
                      : undefined,
                },
              };
            } catch {}
          }
        }
        if (!inspectRes) {
          throw new Error(
            "cannot inspect container: bridge and status.json unavailable",
          );
        }
        await exportArtifacts(
          metadata.containerName,
          metadata.containerRunDir,
          outDir,
          budget,
        );
        console.log(JSON.stringify(inspectRes, null, 2));
        return;
      }

      if (options.steer) {
        const steerRes = await sendBridgeCommand(
          metadata.containerName,
          metadata.containerRunDir,
          { type: "steer", message: options.steer },
          budget,
          controller.signal,
        );
        console.log(JSON.stringify(steerRes, null, 2));
        return;
      }

      if (options.cancel) {
        let cancelRes: BridgeResponse;
        let cancelError: string | null = null;
        try {
          cancelRes = await sendBridgeCommand(
            metadata.containerName,
            metadata.containerRunDir,
            { type: "cancel", reason: "cancelled_by_conductor" },
            budget,
            controller.signal,
          );
        } catch (error) {
          cancelError = messageOf(error);
          cancelRes = {
            success: false,
            command: "cancel",
            error: cancelError,
          };
        }
        const teardownBeganAt = Date.now();
        const shutdown = await teardown(teardownBeganAt);
        const cancelUsage =
          shutdown.providerUsage === null
            ? null
            : readLedgerUsage(shutdown.providerUsage);
        const cancelledReport = await readExportedReport(outDir);
        const receipt = {
          runId: metadata.runId,
          attemptId: metadata.attemptId,
          repo: metadata.repo,
          pullRequest: metadata.pullRequest ?? null,
          requested: metadata.revisions,
          checkoutObserved: null,
          installSkipped: cancelledReport?.install.skipped ?? null,
          installSkipReason: cancelledReport?.install.reason ?? null,
          image: metadata.image,
          runnerSha: metadata.runnerSha,
          containerRunnerSha: metadata.containerRunnerSha ?? null,
          provider: metadata.provider,
          model: metadata.model,
          authRoute: null,
          thinking: metadata.thinking,
          promptSha: metadata.promptSha,
          piVersion: null,
          usage: cancelUsage,
          modelRequests: cancelUsage?.requests ?? null,
          // The ceiling that run recorded for itself, not this controlling
          // invocation's own idea of one.
          laneInputCap:
            metadata.credentialIsolation.caps.maxCumulativeInputTokens,
          fixture: metadata.fixturePath ?? null,
          checkCommand: metadata.checkCommand,
          failStep: null,
          startedAt: metadata.startedAt,
          finishedAt: new Date().toISOString(),
          deadlineSeconds: metadata.deadlineSeconds,
          wallSeconds: Math.round((teardownBeganAt - startedAt) / 1000),
          teardownSeconds: Math.round((Date.now() - teardownBeganAt) / 1000),
          finalStatus: {
            runId: metadata.runId,
            phase: "review",
            state:
              cancelError && !shutdown.removed ? "unverified" : "cancelled",
            detail: cancelError ?? "cancelled_by_conductor",
          },
          outcome:
            cancelError && !shutdown.removed
              ? ("unverified" as const)
              : ("cancelled" as const),
          error: cancelError,
          teardownBudgetSeconds: TEARDOWN_BUDGET_SECONDS,
          shutdown: {
            containerRemoved: shutdown.removed,
            removeError: shutdown.removeError,
            removalSkippedReason: shutdown.removalSkippedReason,
            sessionExported: shutdown.sessionExported,
            sessionExportError: shutdown.sessionExportError,
            ownershipError: shutdown.ownershipError,
            exportedArtifacts: shutdown.exported,
            absentArtifacts: shutdown.absent,
            truncatedArtifacts: shutdown.truncated,
            exportErrors: shutdown.exportErrors,
            authRemoved: shutdown.authRemoved,
            authRemoveError: shutdown.authRemoveError,
            providerUsage: cancelUsage,
            transportRemoved: shutdown.transportError === null,
            transportError: shutdown.transportError,
          },
        };
        await writeLocalReceipt(outDir, receipt);
        console.log(JSON.stringify(cancelRes, null, 2));
        return;
      }

      if (options.resume) {
        const inspectRes = await sendBridgeCommand(
          metadata.containerName,
          metadata.containerRunDir,
          { type: "inspect" },
          budget,
          controller.signal,
        );
        const data = (inspectRes["data"] ?? {}) as Record<string, unknown>;
        if (
          data["terminalReason"] !== "auth_blocked" ||
          data["state"] !== "blocked"
        ) {
          throw new Error(
            `cannot resume run: state ${String(data["state"])} / ${String(data["terminalReason"])} is not auth-blocked`,
          );
        }
        credentials = await resolveRunCredentials(
          metadata.provider,
          options.totalTimeoutSeconds,
        );
        for (const secret of credentials.redactions) redactions.add(secret);
        // Resuming an auth-blocked run means replacing the bearer the broker
        // holds, so the broker is restarted with the renewed credential rather
        // than the run being handed a second credential path.
        broker = planBroker(
          metadata.provider,
          credentials,
          metadata.credentialIsolation.caps,
          `${CONTROL_DIR}/provider-usage.jsonl`,
        );
        const resumeStage = await mkdtemp(join(tmpdir(), "review-pi-resume-"));
        const resumeConfig = join(resumeStage, "broker.json");
        await writeFile(resumeConfig, JSON.stringify(broker.config), {
          mode: 0o600,
        });
        await docker(
          [
            "exec",
            "--user",
            "root",
            metadata.containerName,
            "sh",
            "-c",
            `pkill --uid ${CONTROL_UID} --full model-broker.ts || true`,
          ],
          budget,
          "broker stop",
          controller.signal,
        );
        await installBroker(
          metadata.containerName,
          resumeConfig,
          budget,
          controller.signal,
        );
        const resumedModels = adaptModelsConfig(
          await docker(
            [
              "exec",
              metadata.containerName,
              "cat",
              `${metadata.containerRunDir}/models.json`,
            ],
            budget,
            "model config read",
            controller.signal,
          ),
          metadata.provider,
          { apiKey: broker.handle, baseUrl: broker.baseUrl },
        );
        const resumedModelsPath = join(resumeStage, "models.json");
        await writeFile(resumedModelsPath, resumedModels);
        await docker(
          [
            "cp",
            resumedModelsPath,
            `${metadata.containerName}:${metadata.containerRunDir}/models.json`,
          ],
          budget,
          "model config copy",
          controller.signal,
        );
        await rm(resumeStage, { recursive: true, force: true });
        const restartRes = await sendBridgeCommand(
          metadata.containerName,
          metadata.containerRunDir,
          { type: "restart_process" },
          budget,
          controller.signal,
        );
        if (!options.reconnect) {
          console.log(JSON.stringify(restartRes, null, 2));
          return;
        }
      }
    } else {
      if (
        (
          await docker(
            ["ps", "--all", "--quiet", "--filter", `name=^${containerName}$`],
            budget,
            "container name check",
            controller.signal,
          )
        ).trim()
      ) {
        throw new Error(`container ${containerName} already exists`);
      }

      const resolvedRevisions = await resolveRevisions(
        options,
        budget,
        controller.signal,
      );
      revisions = resolvedRevisions;
      await ensureObjects(
        sourceRepo,
        resolvedRevisions.head.sha,
        resolvedRevisions.base.sha,
        budget,
        options.pullRequest,
        controller.signal,
      );
      const expectedSources = await readImageSources(dirname(runnerPath));
      const currentRunnerSha = expectedSources[REVIEW_RUNNER] ?? "";
      runnerSha = currentRunnerSha;
      const prompt = options.briefPath
        ? ""
        : await readFile(options.promptPath, "utf8");
      // Pi loads the first context file in the checkout root, which would
      // otherwise be the repo's contributor guide. A reviewer gets a
      // role-appropriate override built from this versioned fragment, or from
      // the brief the caller wrote for the repository under review.
      const reviewerContext = await readFile(
        options.contextPath ?? defaultContextPath(),
        "utf8",
      );
      const currentPromptSha = createHash("sha256")
        .update(prompt)
        .digest("hex");
      promptSha = currentPromptSha;
      credentials = await resolveRunCredentials(
        options.provider,
        options.totalTimeoutSeconds,
      );
      for (const secret of credentials.redactions) redactions.add(secret);
      const job: ReviewJob & {
        supervised?: boolean;
        reviewerContext?: string;
      } = {
        runId: options.runId,
        expectedRunnerSha: currentRunnerSha,
        expectedSources,
        head: resolvedRevisions.head,
        base: resolvedRevisions.base,
        gitRemote: `file://${containerRunDir}/origin.git`,
        provider: options.provider,
        model: options.model,
        thinking: options.thinking,
        prompt,
        supervised: true,
        reviewerContext,
        ...(options.fixturePath
          ? { fixturePatch: await readFile(options.fixturePath, "utf8") }
          : {}),
        checkCommand: options.checkCommand,
        installTimeoutSeconds: options.installTimeoutSeconds,
        piTimeoutSeconds: options.piTimeoutSeconds,
        totalTimeoutSeconds: options.totalTimeoutSeconds,
        ...(options.failStep ? { failStep: options.failStep } : {}),
        budget: {
          requests: caps.maxRequests,
          inputTokens: caps.maxCumulativeInputTokens,
        },
      };
      stage = await mkdtemp(join(tmpdir(), "review-pi-local-"));
      imageId = (
        await docker(
          ["image", "inspect", "--format", "{{.Id}}", options.image],
          budget,
          "image inspect",
          controller.signal,
        )
      ).trim();

      const probeOutput = await docker(
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "--entrypoint",
          "sh",
          options.image,
          "-c",
          ENVIRONMENT_PROBE_SCRIPT,
        ],
        budget,
        "environment probe",
        controller.signal,
      );
      admission = evaluateAdmission(parseEnvironmentProbe(probeOutput), 1);
      if (!admission.admitted) {
        throw new Error(
          `environment admission failed: ${admission.reasons.join("; ")}`,
        );
      }

      await prepareTransport(
        sourceRepo,
        join(stage, "origin.git"),
        revisions.head.sha,
        revisions.base.sha,
        budget,
        controller.signal,
      );
      await writeFile(join(stage, "job.json"), JSON.stringify(job));
      broker = planBroker(
        options.provider,
        credentials,
        caps,
        `${CONTROL_DIR}/provider-usage.jsonl`,
      );
      await writeFile(
        join(stage, "broker.json"),
        JSON.stringify(broker.config),
        { mode: 0o600 },
      );

      startAttempted = true;
      await docker(
        containerRunArgs(containerName, options.image, ownershipId, {
          ...(options.laneMemory ? { memory: options.laneMemory } : {}),
          ...(options.laneCpus ? { cpus: options.laneCpus } : {}),
        }),
        budget,
        "container start",
        controller.signal,
      );
      containerCreated = true;
      await docker(
        ["exec", containerName, "mkdir", "-p", containerRunDir],
        budget,
        "run directory",
        controller.signal,
      );
      let existingModelsJson = "";
      try {
        existingModelsJson = await docker(
          ["exec", containerName, "cat", "/opt/review/pi-config/models.json"],
          budget,
          "model config read",
          controller.signal,
        );
      } catch (error) {
        throw new Error(`model config read failed: ${messageOf(error)}`);
      }

      const adaptedModels = adaptModelsConfig(
        existingModelsJson,
        options.provider,
        { apiKey: broker.handle, baseUrl: broker.baseUrl },
      );

      await writeFile(join(stage, "models.json"), adaptedModels);
      await docker(
        [
          "cp",
          join(stage, "models.json"),
          `${containerName}:${containerRunDir}/models.json`,
        ],
        budget,
        "model config copy",
        controller.signal,
      );
      await docker(
        [
          "cp",
          join(stage, "origin.git"),
          `${containerName}:${containerRunDir}/origin.git`,
        ],
        budget,
        "transport upload",
        controller.signal,
      );
      await installBroker(
        containerName,
        join(stage, "broker.json"),
        budget,
        controller.signal,
      );
      await docker(
        [
          "cp",
          join(stage, "job.json"),
          `${containerName}:${containerRunDir}/job.json`,
        ],
        budget,
        "job upload",
        controller.signal,
      );
      // The image's own runner is judged before the driver's copy of the
      // host's replaces it: an upload would otherwise erase the one source
      // whose staleness this gate exists to catch.
      const fingerprint = await docker(
        ["exec", containerName, "sh", "-c", sourceFingerprintCommand()],
        budget,
        "source fingerprint",
        controller.signal,
      );
      const observedSources = parseSourceFingerprint(fingerprint).sources;
      const mismatch = firstSourceMismatch(expectedSources, observedSources);
      if (mismatch) {
        throw new Error(sourceMismatchDetail(mismatch));
      }
      // The gate just proved the image's runner hash and the host's are the
      // same value, so the upload below replaces it with identical bytes.
      containerRunnerSha = observedSources[REVIEW_RUNNER] ?? null;
      await docker(
        ["cp", runnerPath, `${containerName}:${REVIEW_RUNNER}`],
        budget,
        "runner upload",
        controller.signal,
      );
      await docker(
        [
          "exec",
          "--user",
          "root",
          containerName,
          "chmod",
          "0755",
          REVIEW_RUNNER,
        ],
        budget,
        "runner mode",
        controller.signal,
      );
      await docker(
        [
          "exec",
          "--user",
          "root",
          containerName,
          "chown",
          "-R",
          `${TARGET_UID}:${TARGET_UID}`,
          containerRunDir,
        ],
        budget,
        "run directory ownership",
        controller.signal,
      );

      const metadata: RunMetadata = {
        runId: options.runId,
        attemptId: options.attemptId,
        repo,
        ownershipId,
        containerName,
        containerRunDir,
        outDir,
        image: { reference: options.image, id: imageId ?? "" },
        revisions: resolvedRevisions,
        runnerSha: currentRunnerSha,
        containerRunnerSha,
        expectedSources,
        observedSources,
        provider: options.provider,
        credentialIsolation: {
          mode: "brokered",
          controlUid: CONTROL_UID,
          targetUid: TARGET_UID,
          upstream: broker.config.upstreamBaseUrl,
          caps: broker.config.caps,
        },
        ...(admission ? { admission } : {}),
        model: options.model,
        thinking: options.thinking,
        promptPath: options.promptPath,
        promptSha: currentPromptSha,
        role: options.role,
        ...(options.candidateIds ? { candidateIds: options.candidateIds } : {}),
        laneId: options.laneId,
        ...(options.fixturePath ? { fixturePath: options.fixturePath } : {}),
        checkCommand: options.checkCommand,
        startedAt: new Date(startedAt).toISOString(),
        deadlineSeconds: options.totalTimeoutSeconds,
        supervised: true,
        ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
      };
      await writeAtomic(metadataPath, JSON.stringify(metadata, null, 2));

      await docker(
        [
          "exec",
          "--detach",
          "--user",
          `${TARGET_UID}:${TARGET_UID}`,
          "--env",
          "HOME=/home/review-target",
          "--env",
          "PI_OFFLINE=1",
          "--env",
          "PI_SKIP_VERSION_CHECK=1",
          "--env",
          `PI_CODING_AGENT_DIR=${containerRunDir}`,
          ...Object.entries(
            targetProviderEnv(options.provider, credentials),
          ).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
          containerName,
          "bash",
          "-c",
          `${REVIEW_RUNNER} ${containerRunDir} >> ${containerRunDir}/run.log 2>&1`,
        ],
        budget,
        "review start",
        controller.signal,
      );
      reviewStarted = true;
    }

    let reported = "";
    let activityLine = 1;
    let briefed = !options.briefPath;
    const childIdleOf = (data: Record<string, unknown>) =>
      Boolean(data["childIdle"]);
    while (!interrupted) {
      await sleep(1000, undefined, { signal: controller.signal });
      let inspectRes: Record<string, unknown> | undefined;
      try {
        inspectRes = await sendBridgeCommand(
          containerName,
          containerRunDir,
          { type: "inspect" },
          controlBudget(),
          controller.signal,
        );
      } catch (err) {
        // No bridge yet, or no bridge any more. The runner's status file is the
        // only witness for a run that died before Pi came up, and a lane that
        // has already failed must not be waited on for the rest of the run.
        // Its done is never believed: the target's uid can write this file,
        // and only the bridge may say that a review ended well. A failure it
        // claims only ends the target's own lane. One the bridge wrote at the
        // review is followed by the runner's own last word once its evidence
        // is written, and the lane ends on that.
        const runnerStatus = await readContainerStatus(
          containerName,
          containerRunDir,
          controller.signal,
        );
        if (
          runnerStatus &&
          LANE_ENDING_STATES.includes(runnerStatus.state) &&
          runnerStatus.phase !== "review"
        ) {
          status = {
            runId: options.runId,
            phase: runnerStatus.phase,
            state: runnerStatus.state,
            detail: runnerStatus.detail,
          };
          runError = `run ${runnerStatus.state} at ${runnerStatus.phase}: ${runnerStatus.terminalReason ?? (runnerStatus.detail || "no reason recorded")}`;
          runnerTerminalReason =
            runnerStatus.terminalReason ?? runnerStatus.state;
          runnerEnding = runnerStatus.state;
          break;
        }
        // The socket exists only once Pi is up. While the runner is still
        // cloning, installing or checking, or writing a failed review's
        // evidence, its own status file is a truthful observation of the
        // lane, not a lost one.
        if (runnerStatus && runnerStatus.state !== "done") {
          status = {
            runId: options.runId,
            phase: runnerStatus.phase,
            state: runnerStatus.state,
            detail: runnerStatus.detail,
          };
          const observed = `${runnerStatus.phase}/${runnerStatus.state}`;
          if (observed !== reported) {
            reported = observed;
            console.log(`${new Date().toISOString()} ${reported}`);
          }
          continue;
        }
        console.warn(`status observation uncertain: ${messageOf(err)}`);
        continue;
      }

      if (!inspectRes || typeof inspectRes !== "object") continue;
      const data = (inspectRes["data"] ?? {}) as Record<string, unknown>;
      const phase = String(data["phase"] ?? "review");
      const curState = String(data["state"] ?? "");
      status = {
        runId: String(data["runId"] ?? options.runId),
        phase,
        state: curState,
        detail: String(data["detail"] ?? ""),
      };
      const current = `${phase}/${curState}`;
      if (current !== reported) {
        reported = current;
        console.log(`${new Date().toISOString()} ${reported}`);
      }

      if (options.liveActivity) {
        const activity = await readActivity(
          containerName,
          containerRunDir,
          activityLine,
          controller.signal,
        );
        activityLine = activity.nextLine;
        for (const line of activity.lines) {
          console.log(`${new Date().toISOString()} ${line}`);
        }
      }

      if (curState === "cancelled") {
        const reason = String(data["terminalReason"] ?? "cancelled");
        runError = `run cancelled at ${phase}: ${reason}`;
        runnerTerminalReason = reason;
        runnerEnding = curState;
        break;
      }
      // The brief lands once Pi is up and idle; before that the container is
      // still cloning or installing. A null brief is the conductor saying
      // there is nothing to rule on, and the lane ends unused.
      if (
        options.briefPath &&
        !briefed &&
        curState === "idle" &&
        childIdleOf(data)
      ) {
        const { readLaneBrief } = await import("./drive");
        const brief = await readLaneBrief(options.briefPath);
        if (brief?.prompt === null) {
          await sendBridgeCommand(
            containerName,
            containerRunDir,
            { type: "cancel", reason: "no_candidates" },
            budget,
            controller.signal,
          );
          briefed = true;
          continue;
        }
        if (brief) {
          const promptRes = await sendBridgeCommand(
            containerName,
            containerRunDir,
            { type: "prompt", message: brief.prompt },
            budget,
            controller.signal,
          );
          if (!promptRes["success"]) {
            runError = `brief rejected: ${String(promptRes["error"] ?? "prompt_rejected")}`;
            break;
          }
          activeCandidateIds = brief.candidateIds;
          briefed = true;
          console.log(
            `${new Date().toISOString()} brief sent (${brief.candidateIds.length} candidates)`,
          );
          continue;
        }
      }
      if (curState === "failed") {
        const reason = String(
          data["terminalReason"] ?? data["detail"] ?? "unknown failure",
        );
        runError = `run failed at ${phase}: ${reason}`;
        runnerTerminalReason = reason;
        runnerEnding = curState;
        break;
      }
      if (curState === "blocked") {
        const reason = String(data["terminalReason"] ?? "blocked");
        runError = `run blocked at ${phase}: ${reason}`;
        runnerTerminalReason = reason;
        runnerEnding = curState;
        break;
      }
      if (curState === "done") {
        const finalization = await observeFinalization(
          containerName,
          containerRunDir,
          { head: revisions?.head.sha ?? "", base: revisions?.base.sha ?? "" },
          controller.signal,
        );
        if (finalization.error) runError = finalization.error;
        else if (!finalization.validated) {
          runError = `finalization not observed: ${finalization.detail}`;
        } else finalAccepted = true;
        break;
      }

      const childIdle = Boolean(data["childIdle"]);
      const lastCandidate = data["lastCandidateResult"];
      if (
        curState === "idle" &&
        childIdle &&
        typeof lastCandidate === "string" &&
        lastCandidate
      ) {
        let validationError: string | null = null;
        if (activeRole === "reviewer") {
          const { parseCandidates } = await import("./swarm");
          const candidates = parseCandidates(lastCandidate, activeLaneId);
          if (candidates.error) validationError = candidates.error;
        } else if (activeRole === "verifier") {
          if (activeCandidateIds.length === 0) {
            runError =
              "verifier run has no persisted candidate set; its verdicts cannot be validated";
            break;
          }
          const { parseVerdicts } = await import("./swarm");
          const verdicts = parseVerdicts(lastCandidate, activeCandidateIds);
          if (verdicts.error) validationError = verdicts.error;
        } else {
          const single = parseSingleVerdict(lastCandidate);
          if (single.error) validationError = single.error;
        }

        if (validationError && corrections >= MAX_FORMAT_CORRECTIONS) {
          runError = `final output stayed off-contract after ${corrections} corrections: ${validationError}`;
          break;
        }
        if (validationError) {
          corrections += 1;
          console.log(
            `candidate review output off-contract: ${validationError}, requesting correction`,
          );
          interventions.push({
            at: new Date().toISOString(),
            type: "format_correction",
            reason: validationError,
          });
          await sendBridgeCommand(
            containerName,
            containerRunDir,
            {
              type: "prompt",
              message: `Your final response did not satisfy the required output contract: ${validationError}. Please provide the complete required conclusion formatted correctly.`,
            },
            controlBudget(),
            controller.signal,
          );
          continue;
        }

        const acceptRes = await sendBridgeCommand(
          containerName,
          containerRunDir,
          { type: "accept" },
          controlBudget(),
          controller.signal,
        );
        if (!acceptRes["success"]) continue;

        const finalization = await observeFinalization(
          containerName,
          containerRunDir,
          {
            head: revisions?.head.sha ?? "",
            base: revisions?.base.sha ?? "",
          },
          controller.signal,
        );
        if (finalization.error) {
          runError = finalization.error;
          break;
        }
        if (!finalization.validated) {
          runError = `finalization not observed: ${finalization.detail}`;
          break;
        }
        finalAccepted = true;
        break;
      }
    }
    if (interrupted) {
      runError = "interrupted";
    }
  } catch (error) {
    runError = interrupted ? "interrupted" : messageOf(error);
  }
  clearTimeout(deadlineTimer);
  if (deadlineReached && !interrupted) {
    runError = `run deadline exceeded after ${deadlineSeconds} s`;
  }

  const teardownBeganAt = Date.now();
  const shutdown = await teardown(teardownBeganAt);
  const teardownSeconds = Math.round((Date.now() - teardownBeganAt) / 1000);
  const teardownErrors = [
    shutdown.ownershipError,
    ...shutdown.exportErrors,
    shutdown.authRemoveError,
    shutdown.removeError,
    shutdown.transportError,
  ].filter((error): error is string => Boolean(error));
  if (
    shutdown.ownedContainer &&
    !options.keepContainer &&
    containerDisposable() &&
    !shutdown.removed &&
    !shutdown.removeError
  ) {
    teardownErrors.push("owned container was not removed");
  }
  if (teardownErrors.length > 0) {
    const teardownError = `teardown failed: ${teardownErrors.join("; ")}`;
    runError = runError ? `${runError}; ${teardownError}` : teardownError;
  }
  const parsedReport = await readExportedReport(outDir);
  const traceValid = await readFile(join(outDir, "trace.jsonl"), "utf8")
    .then((raw) => {
      const lines = raw.split("\n").filter(Boolean);
      const events: unknown[] = lines.map((line) => JSON.parse(line));
      return (
        events.every((event) => typeof event === "object" && event !== null) &&
        events.some((event) => {
          const type = (event as Readonly<Record<string, unknown>>)["type"];
          return (
            type === "tool_execution_start" ||
            type === "tool_execution_end" ||
            type === "turn_end"
          );
        })
      );
    })
    .catch(() => false);
  const checkout = parsedReport?.checkout;
  const requestedCheckoutValid = Boolean(
    checkout &&
      revisions &&
      checkout.requestedHeadSha === revisions.head.sha &&
      checkout.requestedBaseSha === revisions.base.sha,
  );
  const checkoutValid = options.fixturePath
    ? requestedCheckoutValid &&
      checkout?.fixtureCommitApplied === "true" &&
      checkout.checkedOutBase === revisions?.head.sha &&
      checkout.checkedOutHead !== revisions?.head.sha
    : requestedCheckoutValid &&
      checkout?.fixtureCommitApplied === "false" &&
      checkout.checkedOutHead === revisions?.head.sha &&
      checkout.checkedOutBase === revisions?.base.sha;
  // Evidence the export cut is not evidence. A run whose report or trace hit
  // the ceiling fails with that exact reason rather than with the generic
  // "invalid JSON" the clipped tail happens to produce.
  const truncatedEvidence = shutdown.truncated.filter(
    (name) => name === "report.json" || name === "trace.jsonl",
  );
  if (!runError && truncatedEvidence.length > 0) {
    runError = `evidence truncated at ${MAX_ARTIFACT_BYTES} bytes: ${truncatedEvidence.join(", ")}`;
  }
  if (!runError && (!parsedReport || !traceValid || !checkoutValid)) {
    runError = "completed run is missing valid report.json or trace.jsonl";
  }

  const providerUsage =
    shutdown.providerUsage === null
      ? null
      : readLedgerUsage(shutdown.providerUsage);
  const receipt = {
    runId: options.runId,
    attemptId: options.attemptId,
    repo,
    pullRequest: options.pullRequest ?? null,
    requested: revisions ?? {
      head: options.head ? { sha: options.head } : null,
      base: options.base ? { sha: options.base } : null,
    },
    checkoutObserved: parsedReport?.checkout ?? null,
    installSkipped: parsedReport?.install.skipped ?? null,
    installSkipReason: parsedReport?.install.reason ?? null,
    image: { reference: options.image, id: imageId },
    runnerSha,
    containerRunnerSha,
    provider: options.provider,
    model: options.model,
    authRoute: credentials?.authRoute ?? null,
    thinking: options.thinking,
    promptSha,
    piVersion: parsedReport?.piVersion ?? null,
    // The lane's usage is what the broker saw cross its own socket. Pi's
    // report.json is written by the uid the reviewed repository executes as,
    // so a token count in it is the target's word and is never the row's.
    usage: providerUsage,
    // The broker's own count: a lane cut after it spent requests is finished
    // work, not a lane that never reached the model and can be relaunched.
    modelRequests: providerUsage?.requests ?? null,
    // The input ceiling this lane ran under, from the trial's table or the
    // caller's own --lane-input-cap, as the run recorded it for itself.
    laneInputCap,
    fixture: options.fixturePath ?? null,
    checkCommand: options.checkCommand,
    failStep: options.failStep ?? null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    deadlineSeconds: options.totalTimeoutSeconds,
    wallSeconds: Math.round((teardownBeganAt - startedAt) / 1000),
    teardownSeconds,
    finalStatus: status ?? null,
    outcome: runError
      ? interrupted
        ? "interrupted"
        : runnerEnding === "cancelled" || runnerEnding === "blocked"
          ? runnerEnding
          : "failed"
      : "completed",
    error: runError,
    teardownBudgetSeconds: TEARDOWN_BUDGET_SECONDS,
    shutdown: {
      containerRemoved: shutdown.removed,
      removeError: shutdown.removeError,
      removalSkippedReason: shutdown.removalSkippedReason,
      sessionExported: shutdown.sessionExported,
      sessionExportError: shutdown.sessionExportError,
      ownershipError: shutdown.ownershipError,
      exportedArtifacts: shutdown.exported,
      absentArtifacts: shutdown.absent,
      truncatedArtifacts: shutdown.truncated,
      exportErrors: shutdown.exportErrors,
      authRemoved: shutdown.authRemoved,
      authRemoveError: shutdown.authRemoveError,
      providerUsage,
      transportRemoved: shutdown.transportError === null,
      transportError: shutdown.transportError,
    },
  };
  await writeLocalReceipt(outDir, receipt);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
  console.log(`receipts: ${outDir}`);
  if (runError) {
    process.exitCode = 1;
    throw new Error(runError);
  }
}

if (import.meta.main) {
  await main();
}
