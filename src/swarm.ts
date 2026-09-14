/**
 * Host coordinator for one bounded review swarm.
 *
 * It owns no model loop of its own: every lane is an independent Pi session
 * launched through the same public local driver, in its own container and its
 * own writable checkout, so a lane that runs an executable probe cannot race
 * another lane's files and no reviewer can see a competitor's findings.
 *
 * The host keeps GitHub: revisions are resolved once here and handed to every
 * lane as exact SHAs, which both freezes the inputs across lanes and means no
 * lane ever needs a GitHub credential.
 *
 * Reviewers propose; only the verifier decides. Agreement between reviewers is
 * recorded as provenance and never promoted into a verdict, and a lane that
 * failed, was blocked or answered off-contract turns the run partial rather
 * than clean.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openAttempt,
  type PreparationStage,
  planTrialReservation,
  preparationFailureReceipt,
  reserveWholeTrial,
  sessionLedger,
  writeTerminalReceipt,
} from "./attempt";
import {
  canaryModels,
  completeOnce,
  FAST_REASONING_LEVELS,
  FAST_REVIEWER_PROMPT,
  FAST_VERIFIER_PROMPT,
  type FastReasoning,
  type ModelCanary,
  writeFastLaneArtifacts,
} from "./fast-review";
import {
  assertRunId,
  createBudget,
  ensureObjects,
  readLaneReceipt,
  requiredRepo,
  requiredSource,
  resolveRevisions,
  resolveRunCredentials,
  resolveUpstream,
  TEARDOWN_BUDGET_SECONDS,
  upstreamFor,
} from "./local";
import {
  assertOrcaAvailable,
  closeTerminal,
  createLaneTerminal,
  laneCommandLine,
  laneExitPath,
  laneScriptPath,
  laneTerminalLedger,
  reclaimLostLane,
  resolveWorktreeSelector,
  startLaneCommand,
  superviseLaneTerminal,
} from "./orca";
import {
  packBudgetChars,
  packLaneContext,
  wholeChangeFits,
} from "./pack-context";
import { ADVISORY_SEVERITY, publicationDisposition } from "./publish";

/** Distinct from the P2 tag: this image adds ripgrep, so it is not that image. */
export const DEFAULT_SWARM_IMAGE = "review-pi-b5-swarm";

/** The packed default's model; any other provider must name its own. */
export const DEFAULT_FAST_MODEL = "grok-4.6";

/** The packed default's provider, and the only upstream it resolves without one. */
export const DEFAULT_FAST_PROVIDER = "xai";

/**
 * The model one packed lane calls.
 *
 * A packed swarm resolves one upstream, not one model: the gateway carries the
 * lab in the model id, so one bearer serves several labs and each lane may name
 * its own id. A lane that names none falls back to the swarm's model, and only
 * the default provider can answer to a model nobody named.
 */
export const packedLaneModel = (options: SwarmOptions, laneId: string) => {
  const named = resolveLaneConfig(options, laneId).model ?? options.model;
  if (named) return named;
  if ((options.provider ?? DEFAULT_FAST_PROVIDER) === DEFAULT_FAST_PROVIDER) {
    return DEFAULT_FAST_MODEL;
  }
  throw new Error(
    `packed review needs --model for provider ${options.provider}, or a model on every lane: ${laneId} names none`,
  );
};

/** Every packed lane's model, in lane order, verifier last. */
export const packedLaneModels = (options: SwarmOptions) => [
  ...Array.from({ length: options.reviewerLanes }, (_, index) =>
    packedLaneModel(options, reviewerLaneId(index)),
  ),
  packedLaneModel(options, "verifier"),
];

/** Reviewer contexts when `--reviewers` is absent; the verifier runs alone after them. */
export const REVIEWER_LANES = 2;

/** Concurrent reviewer containers. */
export const MAX_CONCURRENT_LANES = 2;

/**
 * Concurrent cloud reviewer sandboxes: the Worker's max_instances minus the
 * verifier that idles alongside them, minus one slot for a container still
 * being torn down while the next lane asks for one.
 */
export const CLOUD_CONCURRENT_LANES = 3;
/** Relaunches a lane is allowed when its container never reached the model. */
export const LANE_RELAUNCHES = 2;
/**
 * How long a relaunch waits for the platform to reclaim the dead container.
 *
 * The sandboxes run against a small instance pool, and the deaths cluster on
 * whoever asks for a slot while another is still being torn down. Relaunching
 * the instant the lane died asks at the one moment the pool is guaranteed to
 * be full, so each attempt waits longer than the last.
 */
export const RELAUNCH_BACKOFF_MS = 30_000;

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Grace between a lane's SIGINT and the group SIGKILL that ends it for sure. */
export const LANE_KILL_GRACE_MS = TEARDOWN_BUDGET_SECONDS * 1000;

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const required = (argv: string[], name: string) => {
  const value = flag(argv, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const defaultPrompt = (role: "reviewer" | "verifier") =>
  fileURLToPath(
    new URL(`../prompts/review-prompt-swarm-${role}.txt`, import.meta.url).href,
  );

export function parseSwarmOptions(argv: string[]) {
  const pullRequest = flag(argv, "pr");
  const head = flag(argv, "head");
  const base = flag(argv, "base");
  if (!pullRequest && !(head && base)) {
    throw new Error("--pr, or both --head and --base, are required");
  }
  const worker = flag(argv, "worker");
  const totalTimeoutSeconds = Number(flag(argv, "total-timeout") ?? 600);
  const verifierReserveSeconds = Number(
    flag(argv, "verifier-reserve") ?? (worker ? 150 : 200),
  );
  if (verifierReserveSeconds >= totalTimeoutSeconds) {
    throw new Error("--verifier-reserve must be under --total-timeout");
  }
  const packBudget = Number(flag(argv, "pack-budget") ?? 0);
  if (flag(argv, "pack-budget") && !(packBudget > 0)) {
    throw new Error("--pack-budget must be a positive number of characters");
  }
  const reviewerLanes = Number(flag(argv, "reviewers") ?? REVIEWER_LANES);
  if (
    !Number.isInteger(reviewerLanes) ||
    reviewerLanes < 1 ||
    reviewerLanes > MAX_REVIEWER_LANES
  ) {
    throw new Error(
      `--reviewers must be a whole number between 1 and ${MAX_REVIEWER_LANES}`,
    );
  }
  const reasoningLevel = (name: string, fallback?: FastReasoning) => {
    const level = (flag(argv, name) ?? fallback) as FastReasoning | undefined;
    if (level !== undefined && !FAST_REASONING_LEVELS.includes(level)) {
      throw new Error(`--${name} must be off, low, medium or high`);
    }
    return level;
  };
  const fastReasoning = reasoningLevel(
    "fast-reasoning",
    "off",
  ) as FastReasoning;
  // One lane may reason at its own level: through the gateway, DeepSeek with
  // its template's thinking on never reaches an answer (phase 2 arm B, 408 at
  // 32k), while the other labs do at medium.
  const reviewerOverrides = Object.fromEntries(
    Array.from({ length: MAX_REVIEWER_LANES }, (_, index) => {
      const laneId = reviewerLaneId(index);
      return [
        laneId,
        {
          provider: flag(argv, `${laneId}-provider`),
          model: flag(argv, `${laneId}-model`),
          thinking: flag(argv, `${laneId}-thinking`),
          reasoning: reasoningLevel(`${laneId}-reasoning`),
        },
      ] as const;
    }),
  );
  const verifierProvider = flag(argv, "verifier-provider");
  const verifierModel = flag(argv, "verifier-model");
  const verifierThinking = flag(argv, "verifier-thinking");
  const orca = argv.includes("--orca");
  const sandbox = argv.includes("--sandbox");
  const fastFlag = argv.includes("--fast");
  if (orca && worker) {
    throw new Error("--orca and --worker cannot be combined");
  }
  if (sandbox && (orca || worker)) {
    throw new Error("--sandbox cannot be combined with --orca or --worker");
  }
  // Packed reviewers beside sandbox verifiers is the hybrid mode: `--fast`
  // says how the reviewers answer, `--worker` says where the verifiers run.
  if (fastFlag && (orca || sandbox)) {
    throw new Error("--fast cannot be combined with --orca or --sandbox");
  }
  const fast = fastFlag || (!sandbox && !orca && !worker);
  // One packed swarm reaches one upstream: a per-lane provider would be
  // resolved once and then recorded per lane as something it never called.
  if (
    fast &&
    (verifierProvider ||
      Object.values(reviewerOverrides).some((override) => override.provider))
  ) {
    throw new Error(
      "packed review resolves one provider for the whole swarm; drop the per-lane provider flags",
    );
  }

  return {
    swarmId: assertRunId(
      flag(argv, "swarm-id") ?? `swarm-${Date.now().toString(36)}`,
    ),
    outDir: required(argv, "out"),
    repo: flag(argv, "repo"),
    source: flag(argv, "source"),
    image: flag(argv, "image") ?? DEFAULT_SWARM_IMAGE,
    ...(pullRequest ? { pullRequest: Number(pullRequest) } : {}),
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
    reviewerPromptPath:
      flag(argv, "reviewer-prompt") ?? defaultPrompt("reviewer"),
    verifierPromptPath:
      flag(argv, "verifier-prompt") ?? defaultPrompt("verifier"),
    ...(flag(argv, "context") ? { contextPath: flag(argv, "context") } : {}),
    ...(flag(argv, "fixture") ? { fixturePath: flag(argv, "fixture") } : {}),
    ...(flag(argv, "provider") ? { provider: flag(argv, "provider") } : {}),
    ...(flag(argv, "model") ? { model: flag(argv, "model") } : {}),
    ...(flag(argv, "thinking")
      ? { thinking: flag(argv, "thinking") }
      : fast
        ? { thinking: "low" }
        : worker
          ? { thinking: "medium" }
          : {}),
    reviewerLanes,
    reviewerOverrides,
    fastReasoning,
    ...(verifierProvider ? { verifierProvider } : {}),
    ...(verifierModel ? { verifierModel } : {}),
    ...(verifierThinking ? { verifierThinking } : {}),
    ...(flag(argv, "check") ? { checkCommand: flag(argv, "check") } : {}),
    ...(flag(argv, "lane-memory")
      ? { laneMemory: flag(argv, "lane-memory") }
      : {}),
    ...(flag(argv, "lane-cpus") ? { laneCpus: flag(argv, "lane-cpus") } : {}),
    trialKind: flag(argv, "trial-kind") ?? "t1b",
    ...(flag(argv, "pack-budget")
      ? { packBudget: Number(flag(argv, "pack-budget")) }
      : {}),
    ...(flag(argv, "rates") ? { ratesPath: flag(argv, "rates") } : {}),
    ...(flag(argv, "remaining-subcap")
      ? { remainingSubCapUsd: Number(flag(argv, "remaining-subcap")) }
      : {}),
    orca,
    sandbox,
    fast,
    ...(worker ? { worker } : {}),
    ...(flag(argv, "attempt-id")
      ? { attemptId: assertRunId(flag(argv, "attempt-id") ?? "") }
      : {}),
    totalTimeoutSeconds,
    verifierReserveSeconds,
  };
}

export type SwarmOptions = ReturnType<typeof parseSwarmOptions>;

export function resolveLaneConfig(options: SwarmOptions, laneId: string) {
  const override = options.reviewerOverrides[laneId];
  // Every lane of the warm verifier pool is a verifier, and `verifier-model`
  // has to reach all of them: a pool whose lanes silently fell back to the
  // reviewer's model would adjudicate with the lab it is supposed to check.
  const verifier = laneId === "verifier" || laneId.startsWith("verifier-");
  const provider =
    (verifier ? options.verifierProvider : override?.provider) ??
    options.provider;
  const model =
    (verifier ? options.verifierModel : override?.model) ?? options.model;
  const thinking =
    (verifier ? options.verifierThinking : override?.thinking) ??
    options.thinking;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** The level one packed reviewer reasons at: its own, else the swarm's. */
export const packedLaneReasoning = (options: SwarmOptions, laneId: string) =>
  options.reviewerOverrides[laneId]?.reasoning ?? options.fastReasoning;

/**
 * Names the workspace packages a set of changed files belongs to.
 *
 * The nearest `package.json` above a path owns it, so a file under
 * `packages/agents/src` resolves to the package that owns it.
 */
export async function packagesForFiles(
  sourceRepo: string,
  files: readonly string[],
) {
  const names = new Set<string>();
  for (const file of files) {
    let dir = dirname(file);
    while (dir !== "." && dir !== "/" && dir !== "") {
      const manifest = await readFile(
        join(sourceRepo, dir, "package.json"),
        "utf8",
      ).catch(() => null);
      if (manifest) {
        try {
          const name = (JSON.parse(manifest) as { name?: unknown })["name"];
          if (typeof name === "string" && name) names.add(name);
        } catch {}
        break;
      }
      dir = dirname(dir);
    }
  }
  return [...names].sort();
}

/**
 * A scoped check to start from, not the check to run.
 *
 * The coordinator knows which files changed; it does not know the defect. A
 * filter derived from the producing package says nothing about a consumer the
 * change breaks, so this is offered as a starting point and the reviewer stays
 * free to run whatever its mechanism actually needs.
 */
export const recommendedCheck = (packages: readonly string[]) => {
  if (packages.length === 0) return "";
  return packages.map((name) => `bun --filter ${name} test`).join(" && ");
};

/**
 * What each reviewer is asked to look for. Lanes on the same file are separate
 * reviews only if they are pointed at different things.
 */
export const LANE_FOCUS = [
  "the changed code itself - whether the new lines are correct on their own terms, in the diff and in the file they land in",
  "the blast radius of the change - the consumers, callers, contracts and configuration elsewhere in the repository that the new lines have to keep working",
  "the change as it is deployed and lived with - the window in which the old code and the new one are both running against the same data, what the change makes irreversible, and what has to already be true of the environment for it to work at all",
] as const;

/** A lane with no focus of its own is a second copy of another lane, not a review. */
export const MAX_REVIEWER_LANES = LANE_FOCUS.length;

export const reviewerLaneId = (index: number) => `reviewer-${index + 1}`;

/**
 * Assigns the changed files to reviewers.
 *
 * `wholeChange` is the caller's measurement of one question: does the whole
 * change fit one lane's window? When it does, every lane takes the whole set
 * and the lanes stay independent through their focus alone.
 *
 * Otherwise it is round-robin over the sorted paths, so the same change always
 * produces the same split and every file belongs to exactly one lane - a hash
 * could hand every file to one reviewer and leave the swarm running a single
 * context under two names. With fewer files than lanes, splitting would idle a
 * reviewer, and an idle reviewer is not a review, so every lane takes the whole
 * (small) file set.
 */
export function assignLanes(
  files: readonly string[],
  laneCount = REVIEWER_LANES,
  wholeChange = false,
) {
  if (laneCount < 1) throw new Error("laneCount must be at least 1");
  const unique = [...new Set(files)].sort();
  const shared =
    unique.length > 0 && (wholeChange || unique.length < laneCount);
  const split: string[][] = Array.from({ length: laneCount }, () => []);
  for (const [index, file] of unique.entries()) {
    (split[index % laneCount] as string[]).push(file);
  }
  return split.map((laneFiles, index) => ({
    files: shared ? unique : laneFiles,
    focus: LANE_FOCUS[index % LANE_FOCUS.length] as string,
    shared,
  }));
}

export type LaneAssignment = ReturnType<typeof assignLanes>[number];

/** Files a patch touches, for a fixture whose change is not in the git range. */
export const patchFiles = (patch: string) => [
  ...new Set(
    patch
      .split("\n")
      .flatMap((line) =>
        line.startsWith("+++ b/") ? [line.slice("+++ b/".length).trim()] : [],
      )
      .filter((path) => path && path !== "/dev/null"),
  ),
];

const SEVERITIES = ["P0", "P1", "P2"] as const;
const LANE_COMPLETION = ["complete", "partial"] as const;

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;

const parseJson = (body: string) => {
  try {
    return { value: JSON.parse(body) as unknown, error: null };
  } catch (error) {
    return {
      value: undefined,
      error: `unparsable json block: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * The body of the last JSON block a lane ended with.
 *
 * A lab that opens the block and never closes the fence still handed over the
 * whole answer - `workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731` does this
 * on every packed call - and the closing fence is punctuation next to the JSON.
 * The same lab sometimes answers with the bare object and no fence at all
 * (run swarm-mtxj62kn), which is still the whole answer. What
 * rejects a lane that was cut mid-answer is the parse, not the fence.
 */
const lastJsonBlock = (finalText: string) => {
  const fences = [...finalText.matchAll(/```json\s*([\s\S]*?)```/g)];
  const closed = fences.at(-1)?.[1];
  if (closed) return parseJson(closed);
  const opened = finalText.lastIndexOf("```json");
  if (opened !== -1)
    return parseJson(finalText.slice(opened + "```json".length));
  const bare = finalText.trim();
  if (bare.startsWith("{")) return parseJson(bare);
  return { value: undefined, error: "no fenced json block" };
};

/**
 * A cut answer that never left its thinking.
 *
 * With thinking disabled in the request, `anthropic/claude-sonnet-5` still
 * opened a `<think>` in plain text and spent the whole 16k ceiling inside it
 * (run swarm-mu14gmts, 45k characters, no report). That is not a report the
 * ceiling cut, which the same ceiling would cut again: the report never began,
 * so a fresh sample can still be one. A closed `<think>` is the other case.
 */
export const cutWhileThinking = (
  finalText: string,
  finishReason: string | null,
) =>
  (finishReason === "length" || finishReason === "max_tokens") &&
  /^\s*<think>/.test(finalText) &&
  !finalText.includes("</think>");

const failedCandidates = (error: string) => ({
  completion: null,
  blockerReason: null,
  candidates: [],
  droppedFindings: [],
  error,
});

const lineNumber = (value: unknown) => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
};

const optionalString = (value: unknown) =>
  nonEmptyString(value) ? String(value).trim() : "";

/**
 * Reads the fenced JSON block a reviewer is asked to end with.
 *
 * A lane that answers off-contract is malformed, not empty, and an empty
 * `findings` array only means "no defect" when the lane also says it finished:
 * a reviewer blocked halfway through its files reports `partial` with a
 * blocker, and that keeps the aggregate from reading as clean. A single
 * finding that misses the contract is dropped and named in `droppedFindings`
 * instead: the lane keeps the findings it did write.
 */
export function parseCandidates(finalText: string, laneId: string) {
  const block = lastJsonBlock(finalText);
  if (block.error) return failedCandidates(block.error);
  const parsed = block.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failedCandidates("json block is not an object");
  }
  const answer = parsed as Record<string, unknown>;
  const completion = LANE_COMPLETION.find(
    (known) => known === answer["status"],
  );
  if (!completion) {
    return failedCandidates("status is not complete or partial");
  }
  const blockerReason = nonEmptyString(answer["blockerReason"])
    ? String(answer["blockerReason"]).trim()
    : null;
  if (completion === "partial" && !blockerReason) {
    return failedCandidates("partial status without a blockerReason");
  }
  const findings = answer["findings"];
  if (!Array.isArray(findings)) {
    return failedCandidates("findings is not an array");
  }
  const candidates: {
    laneId: string;
    severity: (typeof SEVERITIES)[number];
    file: string;
    line: number;
    mechanism: string;
    evidence: string;
    affectedBehavior: string;
  }[] = [];
  const droppedFindings: { index: number; reason: string }[] = [];
  for (const [index, entry] of findings.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      droppedFindings.push({
        index,
        reason: `findings[${index}] is not an object`,
      });
      continue;
    }
    const finding = entry as Record<string, unknown>;
    const severity = SEVERITIES.find((known) => known === finding["severity"]);
    const line = lineNumber(finding["line"]);
    if (
      !severity ||
      !nonEmptyString(finding["file"]) ||
      line === null ||
      !nonEmptyString(finding["mechanism"])
    ) {
      droppedFindings.push({
        index,
        reason: `findings[${index}] does not satisfy the candidate contract`,
      });
      continue;
    }
    candidates.push({
      laneId,
      severity,
      file: String(finding["file"]).trim(),
      line,
      mechanism: String(finding["mechanism"]).trim(),
      evidence: optionalString(finding["evidence"]),
      affectedBehavior: optionalString(finding["affectedBehavior"]),
    });
  }
  return {
    completion,
    blockerReason,
    candidates,
    droppedFindings,
    error: null,
  };
}

export type Candidate = ReturnType<
  typeof parseCandidates
>["candidates"][number];

/** Location plus the mechanism's words, lowercased and stripped of punctuation. */
const exactKey = (candidate: Candidate) =>
  `${candidate.file}:${candidate.line}:${candidate.mechanism
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}`;

/**
 * Collapses candidates whose location and mechanism wording are identical.
 *
 * This is lexical equality, not semantic deduplication: two reviewers wording
 * the same defect differently, or landing a line apart, both survive here on
 * purpose. Collapsing them is a judgement about the defect, and that judgement
 * belongs to the verifier, which sees the source. What this prepass buys is
 * determinism and a shorter candidate list for it to rule on.
 */
export function collapseIdenticalCandidates(candidates: readonly Candidate[]) {
  const byKey = new Map<
    string,
    Candidate & { id: string; reportedBy: string[] }
  >();
  for (const candidate of candidates) {
    const key = exactKey(candidate);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.reportedBy.includes(candidate.laneId)) {
        existing.reportedBy.push(candidate.laneId);
      }
      continue;
    }
    byKey.set(key, {
      ...candidate,
      id: `c${byKey.size + 1}`,
      reportedBy: [candidate.laneId],
    });
  }
  return [...byKey.values()];
}

export type DedupedCandidate = ReturnType<
  typeof collapseIdenticalCandidates
>[number];

const VERDICT_STATUSES = ["confirmed", "rejected", "duplicate"] as const;
const VERDICT_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const EVIDENCE_STRENGTHS = ["executable", "static"] as const;

/**
 * How a mechanism sits relative to the change under review.
 *
 * `added` and `touched` both mean the change is what put the mechanism there or
 * is what now reaches it; `untouched` means neither, so a confirmed defect at
 * that location predates the change. A verdict that names none is adjudicated
 * exactly as it was before the field existed: the verifier's answer is read when
 * it gives one and never invented here.
 */
const DIFF_RELATIONS = ["added", "touched", "untouched"] as const;

const failedVerdicts = (error: string) => ({ verdicts: [], error });

/**
 * Reads the verifier's fenced JSON block against the exact candidate ids it was
 * given. An id the verifier invented, an id it ruled on twice, or a block that
 * covers fewer candidates than were sent is a contract failure: a verdict list
 * that does not line up with the candidates cannot be used to clear them.
 *
 * A `duplicate` verdict names the canonical candidate it folds into. That
 * canonical id must itself be ruled on directly, so a chain of duplicates can
 * never leave a defect with no verdict behind it.
 */
export function parseVerdicts(
  finalText: string,
  candidateIds: readonly string[],
) {
  const block = lastJsonBlock(finalText);
  if (block.error) return failedVerdicts(block.error);
  const parsed = block.value;
  const list =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["verdicts"]
      : undefined;
  if (!Array.isArray(list)) return failedVerdicts("verdicts is not an array");
  const known = new Set(candidateIds);
  const seen = new Set<string>();
  const verdicts: {
    id: string;
    status: (typeof VERDICT_STATUSES)[number];
    severity: (typeof VERDICT_SEVERITIES)[number] | null;
    evidenceStrength: (typeof EVIDENCE_STRENGTHS)[number];
    reason: string;
    duplicateOf: string | null;
    command: string | null;
    exitStatus: number | null;
    diffRelation: (typeof DIFF_RELATIONS)[number] | null;
    declaredIntent: string | null;
  }[] = [];
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return failedVerdicts(`verdicts[${index}] is not an object`);
    }
    const verdict = entry as Record<string, unknown>;
    const status = VERDICT_STATUSES.find(
      (known_) => known_ === verdict["status"],
    );
    const duplicateOf = nonEmptyString(verdict["duplicateOf"])
      ? String(verdict["duplicateOf"]).trim()
      : null;
    const strength =
      status === "duplicate"
        ? ("static" as const)
        : EVIDENCE_STRENGTHS.find(
            (known_) => known_ === verdict["evidenceStrength"],
          );
    if (
      !status ||
      !strength ||
      !nonEmptyString(verdict["id"]) ||
      !nonEmptyString(verdict["reason"])
    ) {
      return failedVerdicts(
        `verdicts[${index}] does not satisfy the verdict contract`,
      );
    }
    const id = String(verdict["id"]).trim();
    if (!known.has(id))
      return failedVerdicts(`verdicts[${index}]: unknown candidate ${id}`);
    if (seen.has(id))
      return failedVerdicts(`verdicts[${index}]: duplicate verdict for ${id}`);
    if (status === "duplicate") {
      if (!duplicateOf) {
        return failedVerdicts(
          `verdicts[${index}]: duplicate without duplicateOf`,
        );
      }
      if (!known.has(duplicateOf)) {
        return failedVerdicts(
          `verdicts[${index}]: unknown canonical ${duplicateOf}`,
        );
      }
      if (duplicateOf === id) {
        return failedVerdicts(`verdicts[${index}]: ${id} is its own duplicate`);
      }
    }
    seen.add(id);
    verdicts.push({
      id,
      status,
      severity:
        VERDICT_SEVERITIES.find((known_) => known_ === verdict["severity"]) ??
        null,
      evidenceStrength: strength,
      reason: String(verdict["reason"]).trim(),
      duplicateOf: status === "duplicate" ? duplicateOf : null,
      command: nonEmptyString(verdict["command"])
        ? String(verdict["command"])
        : null,
      exitStatus:
        typeof verdict["exitStatus"] === "number"
          ? verdict["exitStatus"]
          : null,
      diffRelation:
        DIFF_RELATIONS.find((known_) => known_ === verdict["diffRelation"]) ??
        null,
      declaredIntent: nonEmptyString(verdict["declaredIntent"])
        ? String(verdict["declaredIntent"]).trim()
        : null,
    });
  }
  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return failedVerdicts(`no verdict for ${missing.join(", ")}`);
  }
  const chained = verdicts.filter(
    (verdict) =>
      verdict.duplicateOf &&
      verdicts.find((other) => other.id === verdict.duplicateOf)?.status ===
        "duplicate",
  );
  if (chained.length > 0) {
    return failedVerdicts(
      `${chained[0]?.id} folds into another duplicate, so no candidate is adjudicated`,
    );
  }
  return { verdicts, error: null };
}

export type Verdict = ReturnType<typeof parseVerdicts>["verdicts"][number];

/**
 * Drops a declared intent the change's own body does not contain.
 *
 * `declaredIntent` is contractually a verbatim quote, and a verifier that
 * paraphrases or invents one has answered the question wrong. Publishing a
 * paraphrase as the author's own words is worse than publishing nothing, so
 * only an exact substring of the body survives; anything else is no
 * declaration.
 */
export const withVerbatimDeclarations = (
  verdicts: readonly Verdict[],
  body: string | null,
) =>
  verdicts.map((verdict) =>
    verdict.declaredIntent && !(body ?? "").includes(verdict.declaredIntent)
      ? { ...verdict, declaredIntent: null }
      : verdict,
  );

/**
 * Joins candidates to verdicts.
 *
 * A candidate the verifier folded into another is not a finding of its own; it
 * moves to `duplicates` and lends its lanes to the canonical finding's
 * provenance, which is how two differently worded reports of one defect end up
 * as one finding both lanes are credited with.
 *
 * A candidate the verifier never ruled on stays `unverified` and keeps its
 * reviewer evidence: neither reported as a confirmed defect nor silently
 * dropped, and it holds the run to `partial`.
 */
export function applyVerdicts(
  candidates: readonly DedupedCandidate[],
  verdicts: readonly Verdict[],
) {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const merged = new Map(
    candidates.map((candidate) => [candidate.id, [...candidate.reportedBy]]),
  );
  const duplicates: {
    id: string;
    duplicateOf: string;
    reason: string;
    reportedBy: string[];
    file: string;
    line: number;
    mechanism: string;
    diffRelation: (typeof DIFF_RELATIONS)[number] | null;
    declaredIntent: string | null;
  }[] = [];
  for (const candidate of candidates) {
    const verdict = byId.get(candidate.id);
    if (verdict?.status !== "duplicate" || !verdict.duplicateOf) continue;
    const canonical = merged.get(verdict.duplicateOf);
    for (const lane of candidate.reportedBy) {
      if (canonical && !canonical.includes(lane)) canonical.push(lane);
    }
    duplicates.push({
      id: candidate.id,
      duplicateOf: verdict.duplicateOf,
      reason: verdict.reason,
      reportedBy: candidate.reportedBy,
      file: candidate.file,
      line: candidate.line,
      mechanism: candidate.mechanism,
      diffRelation: verdict.diffRelation,
      declaredIntent: verdict.declaredIntent,
    });
  }
  const findings = candidates
    .filter((candidate) => byId.get(candidate.id)?.status !== "duplicate")
    .map((candidate) => {
      const verdict = byId.get(candidate.id);
      const reportedBy = merged.get(candidate.id) ?? candidate.reportedBy;
      // What the change itself says about this finding: the verifier's own
      // relation to the diff, and the change's sentence declaring it intended.
      const diffRelation = verdict?.diffRelation ?? null;
      const declaredIntent = verdict?.declaredIntent ?? null;
      const publication = publicationDisposition({
        diffRelation,
        declaredIntent,
      });
      const adjudication = {
        diffRelation,
        declaredIntent,
        publication,
        // A declared behavior is not a defect: it is published as a P3
        // advisory and kept out of the risk index.
        severity:
          publication === "advisory"
            ? ADVISORY_SEVERITY
            : (verdict?.severity ?? candidate.severity),
      };
      if (!verdict) {
        return {
          ...candidate,
          ...adjudication,
          reportedBy,
          status: "unverified" as const,
          evidenceStrength: "reviewer-only" as const,
          verifierReason: null,
          verifierCommand: null,
          verifierExitStatus: null,
        };
      }
      return {
        ...candidate,
        ...adjudication,
        reportedBy,
        status: verdict.status,
        evidenceStrength: verdict.evidenceStrength,
        verifierReason: verdict.reason,
        verifierCommand: verdict.command,
        verifierExitStatus: verdict.exitStatus,
      };
    });
  return { findings, duplicates };
}

export type AdjudicatedFinding = ReturnType<
  typeof applyVerdicts
>["findings"][number];

/**
 * The candidate payload a brief carries: the contract fields, nothing else.
 *
 * Lane provenance stays out on purpose. A verifier judges the claim, and its
 * own prompt already says that several reviewers agreeing proves nothing, so
 * sending who reported what would only invite counting votes.
 */
export const candidatePayload = (candidates: readonly DedupedCandidate[]) =>
  candidates.map(
    ({ id, severity, file, line, mechanism, evidence, affectedBehavior }) => ({
      id,
      severity,
      file,
      line,
      mechanism,
      evidence,
      affectedBehavior,
    }),
  );

/**
 * The candidates one verifier is briefed with: every candidate on one file.
 *
 * Grouping by file is what lets a small pool cover a candidate list without
 * briefing anything twice: one verifier reads a file once instead of three
 * verifiers reading the same lines three times, and the group is the unit the
 * atomic claim takes. Order follows the candidate list, which follows lane
 * order, so the same run always produces the same groups and the same names.
 */
export function candidateGroups(candidates: readonly DedupedCandidate[]) {
  const byFile = new Map<string, DedupedCandidate[]>();
  for (const candidate of candidates) {
    const group = byFile.get(candidate.file);
    if (group) group.push(candidate);
    else byFile.set(candidate.file, [candidate]);
  }
  return [...byFile.entries()].map(([file, members], index) => ({
    name: `${String(index + 1).padStart(2, "0")}-${file
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 120)}.json`,
    file,
    candidateIds: members.map((member) => member.id),
    candidates: candidatePayload(members),
  }));
}

export type CandidateGroup = ReturnType<typeof candidateGroups>[number];

/** A group that one verifier already owns. */
export type CandidateClaim = CandidateGroup & { claimPath: string };

/** The verifier lane's own claim on a queued candidate, and where it stands. */
type VerifierLaneState = {
  claim: CandidateClaim | null;
  claimedAt: number | null;
  briefedAt: number | null;
  releasedReason: string | null;
};

/**
 * The change's own title and body.
 *
 * It is the only place a change can declare that a behavior is intended, so it
 * travels with the candidates. It is absent - never guessed - when the run was
 * given revisions instead of a pull request, or when GitHub did not answer.
 */
export type PullRequestContext = {
  number: number;
  title: string;
  body: string;
};

/** What one verifier is briefed with besides the claims themselves. */
export type VerifierBrief = {
  pullRequest: PullRequestContext | null;
  diff: { file: string; hunks: string }[];
  candidates: ReturnType<typeof candidatePayload>;
};

/** The ceiling for one candidate file's hunks, so a huge diff cannot dwarf the pack. */
const MAX_HUNK_BYTES = 512_000;

/**
 * The hunks one change makes to one file, empty when it makes none.
 *
 * The three-dot range is what the review was cut from; the two-dot range is the
 * fallback for a base the host clone resolved differently, exactly as the
 * reviewer pack does it. A file the change never touches produces no output at
 * all, and that empty answer is the evidence a verdict of `untouched` rests on.
 */
export function fileDiffHunks(input: {
  repo: string;
  base: string;
  head: string;
  file: string;
}) {
  for (const range of [
    `${input.base}...${input.head}`,
    `${input.base}..${input.head}`,
  ]) {
    try {
      return execFileSync(
        "git",
        ["-C", input.repo, "diff", range, "--", input.file],
        { encoding: "utf8", maxBuffer: MAX_HUNK_BYTES },
      ).trim();
    } catch {
      // A range the clone cannot walk falls through to the next one, and a
      // file git has nothing to say about falls through to the empty hunks.
    }
  }
  return "";
}

/**
 * The brief one verifier reads: the change's intent, the hunks it makes to the
 * candidate files, and the candidates themselves.
 *
 * `diffRelation` and `declaredIntent` are questions about the change rather
 * than about the source, so the change's own words and its own hunks are the
 * evidence they are answered from.
 */
export function verifierBrief(input: {
  repo: string;
  base: string;
  head: string;
  files: readonly string[];
  pullRequest: PullRequestContext | null;
  candidates: ReturnType<typeof candidatePayload>;
}): VerifierBrief {
  return {
    pullRequest: input.pullRequest,
    diff: input.files.map((file) => ({
      file,
      hunks: fileDiffHunks({
        repo: input.repo,
        base: input.base,
        head: input.head,
        file,
      }),
    })),
    candidates: input.candidates,
  };
}

/**
 * Renders the brief into the one placeholder the verifier prompt has, with the
 * source pack between the brief and the questions.
 *
 * The questions come after the evidence on purpose: the declared-intent answer
 * is about the pull request's own words, and a model that reads the pack after
 * the question answers from the source instead.
 */
export const renderVerifierBrief = (
  template: string,
  brief: VerifierBrief,
  pack?: string,
) =>
  template.replace(
    "{{CANDIDATES}}",
    pack
      ? `${JSON.stringify(brief, null, 2)}\n\n${pack}`
      : JSON.stringify(brief, null, 2),
  );

/**
 * The host's GitHub credential, the same one revisions are resolved with.
 *
 * It is never logged and never reaches a lane: the pull request body is read
 * here, on the host, and only its text travels in the brief.
 */
const githubToken = () => {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

/**
 * The change's title and body, or null when they cannot be read.
 *
 * A brief without the change's own words weakens the declared-intent answer -
 * the verifier is told there is no declaration rather than fed a guess at one -
 * so a refused or unreachable lookup is recorded as an absence, never a failure.
 */
export async function pullRequestContext(input: {
  repo: string;
  pullRequest?: number | undefined;
  signal?: AbortSignal;
}): Promise<PullRequestContext | null> {
  if (!input.pullRequest) return null;
  const token = githubToken();
  if (!token) return null;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${input.repo}/pulls/${input.pullRequest}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "review-pi",
        },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (!response.ok) return null;
    const pull = (await response.json()) as { title?: unknown; body?: unknown };
    return {
      number: input.pullRequest,
      title: typeof pull.title === "string" ? pull.title : "",
      body: typeof pull.body === "string" ? pull.body : "",
    };
  } catch {
    return null;
  }
}

const writeAtomic = async (path: string, body: string) => {
  await writeFile(`${path}.tmp`, body);
  await rename(`${path}.tmp`, path);
};

/**
 * The work queue the verifier pool claims from.
 *
 * A claim is a rename: the group appears in `taken/` for exactly one caller,
 * because the loser of the race finds no source left to rename. Nothing reads
 * a queue entry without moving it first, so a candidate can be briefed to at
 * most one verifier, and a lane that finds nothing to claim is either told to
 * wait or told to end.
 */
export function claimQueue(root: string) {
  const pendingDir = join(root, "pending");
  const takenDir = join(root, "taken");
  const namesIn = (directory: string) =>
    readdir(directory).catch(() => [] as string[]);
  return {
    root,
    async publish(groups: readonly CandidateGroup[]) {
      await mkdir(pendingDir, { recursive: true });
      await mkdir(takenDir, { recursive: true });
      for (const group of groups) {
        await writeAtomic(join(pendingDir, group.name), JSON.stringify(group));
      }
    },
    async claim(laneId: string): Promise<CandidateClaim | null> {
      for (const name of (await namesIn(pendingDir)).sort()) {
        const to = join(takenDir, `${laneId}-${name}`);
        try {
          await rename(join(pendingDir, name), to);
        } catch {
          // Another lane renamed it first, and a claim is never shared.
          continue;
        }
        const group = JSON.parse(await readFile(to, "utf8")) as CandidateGroup;
        return { ...group, claimPath: to };
      }
      return null;
    },
    /**
     * Returns a claim no model ever saw. Only a lane that reached no model may
     * do this: its tokens are unspent, so briefing the group into a fresh
     * sandbox is a retry rather than a second verdict on one candidate.
     */
    async release(claim: CandidateClaim) {
      await rename(claim.claimPath, join(pendingDir, claim.name)).catch(
        () => {},
      );
    },
    async remaining() {
      return (await namesIn(pendingDir)).length;
    },
    async claimed() {
      return (await namesIn(takenDir)).length;
    },
  };
}

export type CandidateQueue = ReturnType<typeof claimQueue>;

/** How long an idle pool lane waits between looks at the queue. */
export const VERIFIER_CLAIM_POLL_MS = 2_000;

/**
 * What one idle pool lane is told next, or null while it should keep waiting.
 *
 * A lane claims the moment there is work: the queue only ever holds candidates
 * whose ids are already final. A lane that finds nothing waits while the
 * reviewers are still answering, and once the reviewer set is frozen an empty
 * queue means there is nothing left for it - a null brief is how it ends
 * without answering, and it never takes a candidate away from another lane.
 */
export async function nextVerifierBrief(input: {
  queue: CandidateQueue;
  laneId: string;
  settled: boolean;
  /**
   * The instant the candidate set's verdicts have to be settled by, or null
   * while the candidate set is not frozen and no claim can exist yet.
   */
  verdictDeadlineAt: number | null;
  prompt: (claim: CandidateClaim) => string;
}): Promise<
  | {
      claim: CandidateClaim;
      brief: {
        prompt: string;
        candidateIds: string[];
        verdictDeadlineAt: number | null;
      };
    }
  | {
      claim: null;
      brief: {
        prompt: null;
        candidateIds: [];
        verdictDeadlineAt: number | null;
      };
    }
  | null
> {
  const claim = await input.queue.claim(input.laneId);
  if (claim) {
    return {
      claim,
      brief: {
        prompt: input.prompt(claim),
        candidateIds: claim.candidateIds,
        verdictDeadlineAt: input.verdictDeadlineAt,
      },
    };
  }
  return input.settled
    ? {
        claim: null,
        brief: {
          prompt: null,
          candidateIds: [],
          verdictDeadlineAt: input.verdictDeadlineAt,
        },
      }
    : null;
}

/**
 * Model requests one pool verifier may spend before it is asked to answer.
 *
 * A verifier rules on a file's candidates; it does not owe the run a finished
 * reproduction. Measured on the 2026-09-10 replay: two candidates were ruled
 * in 25 requests and 255s, while a single candidate spent 50 requests, overran
 * its 510s window and was cut with an empty answer. This cap sits between the
 * two, and the driver's finalize reserve turns its last requests into an
 * answer the lane can still give rather than a report that says nothing.
 */
export const POOL_VERIFIER_MAX_REQUESTS = 32;

/**
 * The pool's own verdict deadline, measured from the instant the candidate set
 * froze.
 *
 * Candidate-ready to verdict is what the pool is judged on, and the 2026-09-10
 * live run spent 419 s on the candidate whose lane warmed up last: 107 s of
 * clone and install before it could claim, then the ~300 s of review every lane
 * spent whatever it was briefed with. No pool can make a slow sandbox warm up
 * faster, so the difference comes out of that lane's investigation instead: the
 * brief carries this deadline, the driver tells the lane to answer 60 s before
 * it, and the verdict settles with the report inside the 360 s the run is
 * measured against.
 */
export const POOL_VERDICT_SECONDS = 300;

/**
 * Waves the pool may run: the warm one, plus the retries one group is allowed.
 */
export const VERIFIER_POOL_WAVES = 1 + LANE_RELAUNCHES;

/**
 * How many pool lanes the next wave holds, and why it holds none.
 *
 * The first wave is the declared pool even before there is anything to claim:
 * those sandboxes are what makes verification warm, and they idle in their
 * prepared checkouts while the reviewers answer. Every later wave exists only
 * to pick up groups the previous one did not claim, so it is sized by what is
 * left, refused outright when a fresh sandbox could no longer reach the model
 * and rule inside the window that remains, and capped at the same number of
 * retries a single reviewer lane is allowed - otherwise a control plane that
 * refuses every container would be relaunched against until the run's wall.
 */
export const verifierWavePlan = (input: {
  wave: number;
  poolLanes: number;
  remaining: number;
  windowSeconds: number;
}) => {
  if (input.wave === 0) return { size: input.poolLanes, refusal: null };
  if (input.remaining === 0) return { size: 0, refusal: null };
  if (input.wave >= VERIFIER_POOL_WAVES) {
    return {
      size: 0,
      refusal: `${input.remaining} candidate group(s) stayed unclaimed after ${input.wave} waves, the most a group is retried (${LANE_RELAUNCHES} relaunches)`,
    };
  }
  if (input.windowSeconds < RELAUNCH_MINIMUM_SECONDS) {
    return {
      size: 0,
      refusal: `${input.remaining} candidate group(s) were left to a verifier window of ${input.windowSeconds}s, under the ${RELAUNCH_MINIMUM_SECONDS}s a fresh sandbox needs to reach the model and rule`,
    };
  }
  return {
    size: Math.min(input.poolLanes, input.remaining),
    refusal: null,
  };
};

/**
 * The candidate ids no verdict covered.
 *
 * Exactly-once is the aggregation's contract: an id is settled when one
 * verifier ruled on it, and anything left here is unverified rather than
 * clean, which is what holds the run to partial.
 */
export const unadjudicated = (
  candidates: readonly DedupedCandidate[],
  verdicts: readonly Verdict[],
) => {
  const settled = new Set(verdicts.map((verdict) => verdict.id));
  return candidates
    .filter((candidate) => !settled.has(candidate.id))
    .map((candidate) => candidate.id);
};

/**
 * Nearest-rank percentile of the values given, or null when there are none.
 *
 * With a handful of verifiers the nearest rank is the honest reading: it never
 * reports a number between two measurements the run actually took.
 */
export const percentile = (values: readonly number[], fraction: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
};

export type LaneOutcome = {
  laneId: string;
  role: "reviewer" | "verifier";
  status:
    | "completed"
    | "blocked"
    | "malformed"
    | "failed"
    | "cancelled"
    | "not_run";
};

/**
 * The run's status. A required lane that failed, stopped early, answered
 * off-contract or was cancelled makes the whole review partial or failed, and
 * so does a candidate nobody adjudicated - never a clean verdict on a change
 * the swarm did not actually finish covering.
 *
 * Verifiers are read as a set: a pool lane that found no work ended on a null
 * brief and decided nothing, which is fine as long as every candidate a
 * verifier was briefed with was settled. The candidates, not the lane count,
 * are what has to add up, and an unsettled id arrives here as an unverified
 * finding.
 */
export function swarmStatus(
  lanes: readonly LaneOutcome[],
  uncoveredFiles: readonly string[],
  findings: readonly { status: string }[] = [],
  { verifierRequired = true } = {},
) {
  const reviewers = lanes.filter((lane) => lane.role === "reviewer");
  const verifiers = lanes.filter((lane) => lane.role === "verifier");
  const healthy = reviewers.filter((lane) => lane.status === "completed");
  if (healthy.length === 0) return "failed" as const;
  const verifierSettled = verifierRequired
    ? verifiers.length > 0 &&
      verifiers.every(
        (lane) => lane.status === "completed" || lane.status === "not_run",
      )
    : verifiers.every((lane) => lane.status === "not_run");
  if (
    healthy.length < reviewers.length ||
    !verifierSettled ||
    uncoveredFiles.length > 0 ||
    findings.some((finding) => finding.status === "unverified")
  ) {
    return "partial" as const;
  }
  return "completed" as const;
}

/** Reviewer time is what is left after the verifier's reservation is set aside. */
export const laneBudgets = (options: SwarmOptions, elapsedSeconds: number) => {
  const remaining = options.totalTimeoutSeconds - elapsedSeconds;
  const reviewerSeconds =
    remaining - options.verifierReserveSeconds - TEARDOWN_BUDGET_SECONDS;
  return {
    reviewerSeconds,
    verifierSeconds: options.verifierReserveSeconds,
    exhausted: reviewerSeconds <= 0,
  };
};

/**
 * The wall window one lane is handed, by role.
 *
 * A reviewer gets what is left of the run after the verifier's reservation and
 * teardown are set aside. A cold verifier, which starts once the reviewers are
 * done, gets exactly that reservation. A warm verifier starts beside the
 * reviewers and idles until the brief, so its clock is the whole remaining run:
 * the window the reviewers did not use plus its own reserve, still less the
 * teardown every lane owes the run.
 *
 * This is the number the lane's container is wrapped in by `timeout`, so a lane
 * runs out of its own window rather than the swarm's, and the runner still has
 * the teardown to write down what it reached.
 */
export const laneWindowSeconds = (
  options: SwarmOptions,
  elapsedSeconds: number,
  role: "reviewer" | "verifier",
  warmVerifier = false,
) => {
  const budgets = laneBudgets(options, elapsedSeconds);
  if (role === "reviewer") return budgets.reviewerSeconds;
  return warmVerifier
    ? budgets.verifierSeconds + budgets.reviewerSeconds
    : budgets.verifierSeconds;
};

/**
 * What every cloud lane pays before it can review anything.
 *
 * Clone plus install measured 53-126 s across the lanes of the 2026-09-07
 * receipts, on top of container boot and the runner's own start, so 90 s is
 * what a lane has to be given before the model gets its first turn at all.
 */
export const RELAUNCH_PLATFORM_SECONDS = 90;

/**
 * The shortest review a relaunch can still buy.
 *
 * `cloudv6` is the quickest cloud lane on record that still produced a report:
 * 290 s of wall, 65 s of it clone and install and 213 s of it the review
 * itself. 200 s is that review rounded down, and a relaunch that lands under it
 * buys a container cut before it reads a file - which is what
 * `warm6567b-reviewer-1` spent 1233 s and 64 requests discovering.
 */
export const RELAUNCH_REVIEW_SECONDS = 200;

/** The window a relaunch has to open inside, or it is not made at all. */
export const RELAUNCH_MINIMUM_SECONDS =
  RELAUNCH_PLATFORM_SECONDS + RELAUNCH_REVIEW_SECONDS;

/**
 * Why a lane was not relaunched, or null when the window still admits one.
 *
 * The window is measured for the moment the relaunch would actually start,
 * after the backoff the platform needs to reclaim the dead container, because
 * what matters is how much run is left for the lane to use, not how much was
 * left when the lane died.
 */
export const relaunchRefusal = (
  options: SwarmOptions,
  elapsedSeconds: number,
  role: "reviewer" | "verifier",
) => {
  const windowSeconds = laneWindowSeconds(options, elapsedSeconds, role);
  if (windowSeconds >= RELAUNCH_MINIMUM_SECONDS) return null;
  return `only ${windowSeconds}s of ${role} window left, under the ${RELAUNCH_MINIMUM_SECONDS}s a relaunch needs to reach the model and review (${RELAUNCH_PLATFORM_SECONDS}s of platform plus a ${RELAUNCH_REVIEW_SECONDS}s review)`;
};

/**
 * Slack after a lane's window before the coordinator cuts it itself.
 *
 * The container's own `timeout` fires at the window and the runner writes its
 * partial report on the way out; the driver then stops the container and keeps
 * the evidence. This is that handshake, and the point past which a lane the
 * control plane never accounted for stops being awaited.
 */
export const LANE_CUT_GRACE_SECONDS = 30;

/**
 * The whole seconds a lane's container is wrapped in, never zero.
 *
 * The lane's budget and the number the runner is timed out with are this one
 * value: a receipt that quotes a window no container ever ran under cannot be
 * used to check that the deadline was the budget.
 */
export const laneTimeoutSeconds = (seconds: number) =>
  Math.max(1, Math.floor(seconds));

const localScript = join(dirname(fileURLToPath(import.meta.url)), "local.ts");
const driveScript = join(dirname(fileURLToPath(import.meta.url)), "drive.ts");

/**
 * Waits for one lane process under cancellation.
 *
 * Cancellation interrupts the child's own group first, so its container
 * teardown runs, and kills the group outright once the grace is spent. Without
 * that escalation a lane that ignores SIGINT outlives the swarm's deadline and
 * leaves its container behind, so the swarm's own deadline would bound nothing.
 */
export function superviseLane(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal,
  graceMs = LANE_KILL_GRACE_MS,
) {
  return new Promise<number>((resolvePromise) => {
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    };
    const stop = () => {
      signalGroup("SIGINT");
      hardKill = setTimeout(() => signalGroup("SIGKILL"), graceMs);
      hardKill.unref();
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    const settle = (code: number) => {
      if (hardKill) clearTimeout(hardKill);
      signal.removeEventListener("abort", stop);
      resolvePromise(code);
    };
    child.once("error", () => settle(1));
    child.once("exit", (code) => settle(code ?? 1));
  });
}

export type LaneRunner = (
  lane: { laneId: string; role: "reviewer" | "verifier"; runId: string },
  args: string[],
  signal: AbortSignal,
) => Promise<number>;

/** The default lane: a detached child nobody can look at while it runs. */
const detachedRunner: LaneRunner = (_lane, args, signal) =>
  superviseLane(
    spawn(process.execPath, [localScript, ...args], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    }),
    signal,
  );

const cloudRunner: LaneRunner = (_lane, args, signal) =>
  superviseLane(
    spawn(process.execPath, [driveScript, ...args], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    }),
    signal,
  );

/**
 * The Orca lane: one visible terminal per reviewer and verifier, each running
 * the driver itself, each closable from the workspace it appears in.
 */
export const orcaRunner = (
  swarmId: string,
  suiteDir: string,
  worktree: string,
  ledger: ReturnType<typeof laneTerminalLedger>,
  abort: (reason: Error) => void,
): LaneRunner => {
  return async (lane, args, signal) => {
    const exitPath = laneExitPath(suiteDir, lane.runId);
    let terminal: Awaited<ReturnType<typeof createLaneTerminal>> | null = null;
    try {
      // The terminal is opened empty, recorded, and only then given the
      // driver: nothing owns a container until its handle is on disk.
      terminal = await createLaneTerminal(
        `${swarmId} ${lane.laneId}`,
        worktree,
      );
      await ledger.record({
        laneId: lane.laneId,
        role: lane.role,
        runId: lane.runId,
        exitPath,
        terminal,
      });
      // A sibling that failed while this terminal was being opened has already
      // aborted the swarm: the driver is never launched into it afterwards.
      if (signal.aborted) {
        await closeTerminal(terminal.handle).catch(() => {});
        await ledger.recordFailure({
          laneId: lane.laneId,
          runId: lane.runId,
          error: "swarm aborted before this lane started",
          reclaimError: null,
        });
        return 1;
      }
      await startLaneCommand(
        terminal.handle,
        laneCommandLine(localScript, [...args, "--live-activity"], exitPath),
        laneScriptPath(suiteDir, lane.runId),
      );
    } catch (error) {
      // A lane that cannot start ends the swarm, but through the same abort a
      // Ctrl-C uses: the sibling lanes already running are interrupted and
      // awaited by the coordinator instead of being orphaned by a throw, and
      // the failure is kept where the lane identities are.
      const message = error instanceof Error ? error.message : String(error);
      // Siblings are interrupted first: reclaim is slow, and a lane that
      // cannot start must not keep the others running while it cleans up.
      abort(new Error(`lane ${lane.laneId} could not start: ${message}`));
      // Only a lane that actually got a terminal can have left a container
      // behind; a create that never returned one has nothing to reclaim.
      let reclaimError: string | null = null;
      if (terminal) {
        await closeTerminal(terminal.handle).catch(() => {});
        reclaimError = await reclaimLostLane(localScript, lane.runId, suiteDir);
      }
      await ledger.recordFailure({
        laneId: lane.laneId,
        runId: lane.runId,
        error: message,
        reclaimError,
      });
      console.warn(`${lane.laneId}: could not start: ${message}`);
      return 1;
    }
    const live = terminal;
    console.log(`${lane.laneId}: orca terminal ${live.handle} (${lane.runId})`);
    const settled = await superviseLaneTerminal(
      live.handle,
      exitPath,
      signal,
      LANE_KILL_GRACE_MS,
    );
    // A terminal that vanished with no receipt may have taken the driver down
    // before its container: the driver's own cancel path is what actually
    // removes it, and a reclaim that fails is reported, never assumed.
    const reclaimError = settled.lost
      ? await reclaimLostLane(localScript, lane.runId, suiteDir)
      : null;
    if (settled.lost) {
      console.warn(
        `${lane.laneId}: terminal ended without a receipt; reclaimed ${lane.runId}${reclaimError ? ` (failed: ${reclaimError})` : ""}`,
      );
    }
    await ledger.recordCleanup({
      laneId: lane.laneId,
      runId: lane.runId,
      lost: settled.lost,
      cleanupError: settled.cleanupError,
      reclaimError,
    });
    if (settled.cleanupError || reclaimError) {
      // An unconfirmed close is an unknown process, and an unknown process is
      // never a lane that passed.
      if (settled.cleanupError)
        console.warn(`${lane.laneId}: ${settled.cleanupError}`);
      return settled.code === 0 ? 1 : settled.code;
    }
    return settled.code;
  };
};

/** Runs lanes with at most `limit` containers alive at once. */
async function withConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
) {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      while (next < tasks.length) {
        const index = next;
        next += 1;
        results[index] = await (tasks[index] as () => Promise<T>)();
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Reads the changed paths from the host clone, inside the shared deadline. */
function changedFilesFromGit(
  sourceRepo: string,
  base: string,
  head: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  return new Promise<string[]>((resolvePromise, reject) => {
    const child = spawn(
      "git",
      ["-C", sourceRepo, "diff", "--name-only", `${base}..${head}`],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const stop = (error: Error) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      reject(error);
    };
    const deadline = setTimeout(
      () => stop(new Error("git diff exceeded its deadline")),
      timeoutMs,
    );
    const abort = () => stop(new Error("interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      if (code !== 0) reject(new Error(`git diff exited ${code}`));
      else {
        resolvePromise(
          output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        );
      }
    });
  });
}

export const laneArguments = (
  options: SwarmOptions,
  runId: string,
  outDir: string,
  promptPath: string,
  head: string,
  base: string,
  totalSeconds: number,
  laneConfig?: ReturnType<typeof resolveLaneConfig>,
  lane?: {
    role: "reviewer" | "verifier";
    laneId: string;
    candidateIds?: readonly string[];
    brief?: string;
    maxRequests?: number;
  },
  attemptId?: string,
) => {
  const provider = laneConfig?.provider ?? options.provider;
  const model = laneConfig?.model ?? options.model;
  const thinking = laneConfig?.thinking ?? options.thinking;
  return [
    "--run-id",
    runId,
    "--out",
    outDir,
    ...(lane?.brief ? ["--brief", lane.brief] : ["--prompt", promptPath]),
    // The brief written for the repository under review. Every lane reads the
    // same one, so a reviewer and the verifier that judges it share a vocabulary.
    ...(options.contextPath ? ["--context", options.contextPath] : []),
    "--head",
    head,
    "--base",
    base,
    // The identity the lane's own GitHub lookups are built from, and the
    // checkout a local lane serves its commits out of. A cloud lane clones
    // through the Worker's Git proxy instead, so it names no source.
    ...(options.repo ? ["--repo", options.repo] : []),
    ...(options.worker || !options.source ? [] : ["--source", options.source]),
    // The number, not the revisions: a cloud lane clones through the proxy and
    // a pull request head is not reachable from the default branch, so without
    // it the checkout fails on a commit git never fetched.
    ...(options.pullRequest ? ["--pr", String(options.pullRequest)] : []),
    "--attempt-id",
    attemptId ?? runId,
    ...(options.worker
      ? ["--worker", options.worker]
      : ["--image", options.image]),
    "--total-timeout",
    // The lane's own window, not the run's: it is the number the container is
    // wrapped in, and the receipt quotes it back from the lane's own state.
    String(laneTimeoutSeconds(totalSeconds)),
    "--pi-timeout",
    String(Math.max(30, Math.floor(totalSeconds * 0.7))),
    ...(options.fixturePath ? ["--fixture", options.fixturePath] : []),
    ...(provider ? ["--provider", provider] : []),
    ...(model ? ["--model", model] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    "--trial-kind",
    options.trialKind,
    ...(options.checkCommand ? ["--check", options.checkCommand] : []),
    ...(options.laneMemory ? ["--lane-memory", options.laneMemory] : []),
    ...(options.laneCpus ? ["--lane-cpus", options.laneCpus] : []),
    ...(lane ? ["--role", lane.role, "--lane-id", lane.laneId] : []),
    ...(lane?.candidateIds
      ? ["--candidate-ids", JSON.stringify(lane.candidateIds)]
      : []),
    ...(lane?.maxRequests ? ["--max-requests", String(lane.maxRequests)] : []),
  ];
};

/**
 * What one finished lane left in its report, or null when it left none.
 *
 * `completion` is the runner's own marking: a lane that was cut writes its
 * report on the way out and marks it partial, so a lane that never answered
 * and a lane that answered "nothing to report" are never the same file.
 */
const laneReport = async (artifactDir: string) => {
  const raw = await readFile(join(artifactDir, "report.json"), "utf8").catch(
    () => null,
  );
  if (!raw) return null;
  try {
    const report: unknown = JSON.parse(raw);
    if (typeof report !== "object" || report === null) return null;
    const record = report as Record<string, unknown>;
    const finalText = record["finalText"];
    const completion = record["completion"];
    const partialReason = record["partialReason"];
    return {
      finalText: typeof finalText === "string" ? finalText : null,
      partial: completion === "partial",
      partialReason:
        completion === "partial" && typeof partialReason === "string"
          ? partialReason
          : null,
    };
  } catch {
    return null;
  }
};

/**
 * What the driver wrote about the finalize it sent, or null when it sent none.
 *
 * A lane cut by its request cap leaves this behind: the driver spends one
 * instruction telling it to answer with what it has, and the receipt has to
 * show that the lane was asked rather than that it stopped on its own.
 */
const laneFinalize = async (artifactDir: string) => {
  const raw = await readFile(join(artifactDir, "finalize.json"), "utf8").catch(
    () => null,
  );
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const laneReceipt = (artifactDir: string) =>
  readLaneReceipt(artifactDir).catch(() => null);

/**
 * Whether a lane never reached the model: no receipt at all, or one whose run
 * failed before a first request was counted. A container refused at admission
 * (`409 runner_mismatch` during a rollout) leaves `modelRequests: null`, which
 * is as free to repeat as a zero. A lane that completed with an unobserved
 * count is finished, not free.
 */
export const neverReachedModel = (
  receipt: { outcome: string; modelRequests?: number | null } | null,
) =>
  receipt === null ||
  (receipt.outcome !== "completed" && !receipt.modelRequests);

async function main() {
  const options = parseSwarmOptions(process.argv.slice(2));
  // The target is an input, not a property of where this package sits: the
  // identity every GitHub path is built from and the checkout the diffs, packs
  // and objects are read out of. Both are required before anything is paid for.
  const repo = requiredRepo(options.repo);
  const sourceRepo = requiredSource(options.source);
  const suiteDir = resolve(options.outDir, options.swarmId);
  await mkdir(options.outDir, { recursive: true });
  await mkdir(suiteDir);
  // The identity comes first. Everything below can fail, and a preparation
  // that fails without an id is a trial that leaves no trace and no
  // denominator behind it.
  const attempt = await openAttempt(
    suiteDir,
    {
      swarmId: options.swarmId,
      head: options.head ?? null,
      base: options.base ?? null,
      pullRequest: options.pullRequest ?? null,
      image: options.image,
      reviewers: options.reviewerLanes,
      orca: options.orca,
      fixture: options.fixturePath ?? null,
      reviewerPromptPath: options.reviewerPromptPath,
      verifierPromptPath: options.verifierPromptPath,
      deadlineSeconds: options.totalTimeoutSeconds,
      verifierReserveSeconds: options.verifierReserveSeconds,
    },
    options.attemptId,
  );
  const startedAt = attempt.startedAt;
  const fastProvider = options.provider ?? DEFAULT_FAST_PROVIDER;
  // A lane's pack is bounded by the model that will read it: three labs behind
  // one gateway do not share a prompt ceiling, and a pack sized for the largest
  // is one the smallest refuses whole.
  const packBudgetFor = (model: string) =>
    options.packBudget ??
    packBudgetChars(options.trialKind === "t1a" ? "t1a" : "t1b", model);
  const budget = createBudget(startedAt, options.totalTimeoutSeconds);
  const elapsedSeconds = () => Math.round((Date.now() - startedAt) / 1000);
  const laneWindow = (role: "reviewer" | "verifier", warmVerifier = false) =>
    laneWindowSeconds(options, elapsedSeconds(), role, warmVerifier);
  // The packed lane runs in this process, so the swarm's own deadline is the
  // only thing that can stop it: what is left of the run, minus the
  // verifier's reservation while reviewers are still going.
  const laneDeadlineMs = (role: "reviewer" | "verifier") =>
    Math.max(laneWindow(role), 1) * 1000;

  const ledger = laneTerminalLedger(suiteDir);
  const sessions = sessionLedger(attempt.attemptId, suiteDir);
  const controller = new AbortController();
  let abortReason: "interrupted" | "deadline" | null = null;
  const onSignal = () => {
    abortReason ??= "interrupted";
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  /**
   * A lane's own signal: the swarm's, plus a cut after its window is spent.
   *
   * Every lane's container is wrapped in its window, so this only ever fires
   * for a lane the control plane could not account for; the grace is what the
   * container needs to land its own report first.
   */
  const laneSignal = (windowSeconds: number) =>
    AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(
        Math.max(windowSeconds + LANE_CUT_GRACE_SECONDS, 1) * 1000,
      ),
    ]);

  let stage: PreparationStage = "orca-admission";
  const identity = {
    attemptId: attempt.attemptId,
    swarmId: options.swarmId,
    requested: {
      head: options.head ?? null,
      base: options.base ?? null,
      pullRequest: options.pullRequest ?? null,
    },
    fixture: options.fixturePath ?? null,
    image: options.image,
    reviewers: options.reviewerLanes,
    fastReasoning: options.fastReasoning,
    trialKind: options.trialKind,
    orca: options.orca ? { lanesPath: ledger.path } : null,
    piSessionsPath: sessions.path,
    deadlineSeconds: options.totalTimeoutSeconds,
    verifierReserveSeconds: options.verifierReserveSeconds,
    teardownBudgetSeconds: TEARDOWN_BUDGET_SECONDS,
  };
  const prepared = await (async () => {
    // Availability is proven before any lane exists: explicit Orca mode never
    // falls back to lanes nobody can see.
    if (options.orca) await assertOrcaAvailable();
    const startLane: LaneRunner = options.orca
      ? orcaRunner(
          options.swarmId,
          suiteDir,
          await resolveWorktreeSelector(),
          ledger,
          (error) => {
            abortReason ??= "interrupted";
            controller.abort(error);
          },
        )
      : options.worker
        ? cloudRunner
        : detachedRunner;

    // The whole trial is held before its first paid session, never lane by
    // lane: a swarm that runs out of budget at the verifier has already spent
    // the reviewers'. The rates are an explicit input; without them nothing is
    // priced and the receipt says so rather than reserving zero.
    stage = "budget-reservation";
    const reservationRequest = {
      trialId: attempt.attemptId,
      provider: options.provider ?? null,
      trialKind: options.trialKind,
      sessions: planTrialReservation({
        attemptId: attempt.attemptId,
        reviewerLanes: options.reviewerLanes,
        retriesPerLane: LANE_RELAUNCHES,
      }),
      ratesPath: options.ratesPath ?? null,
      remainingSubCapUsd: options.remainingSubCapUsd ?? null,
    };
    const reservation = await reserveWholeTrial(
      reservationRequest,
      options.ratesPath
        ? {
            script: join(dirname(localScript), "provider-budget.ts"),
            rates: JSON.parse(await readFile(options.ratesPath, "utf8")),
          }
        : null,
    );
    // A refused budget stops the trial where it costs nothing, and the refusal
    // is still one countable attempt with its own terminal receipt.
    if (reservation.status === "denied") {
      throw new Error(
        `provider budget refused the trial: ${reservation.reason}`,
      );
    }

    stage = "revision-resolution";
    const revisions = await resolveRevisions(
      options,
      budget,
      controller.signal,
    );
    const head = revisions.head.sha;
    const base = revisions.base.sha;

    // The host clone is not guaranteed to hold a freshly pushed PR head, and
    // the diff below reads it before any lane exists to fetch it.
    stage = "object-fetch";
    await ensureObjects(
      sourceRepo,
      head,
      base,
      budget,
      options.pullRequest,
      controller.signal,
    );

    stage = "changed-files";
    const changedFiles = options.fixturePath
      ? patchFiles(await readFile(options.fixturePath, "utf8"))
      : await changedFilesFromGit(
          sourceRepo,
          base,
          head,
          budget.take("changed files"),
          controller.signal,
        );
    if (changedFiles.length === 0)
      throw new Error("no changed files to review");

    // The verifier judges whether the change introduced a mechanism and
    // whether the change declares it as intended. Both answers are about the
    // change, so its own title and body are read once here, on the host, and
    // handed to every verifier the same way the revisions are.
    const pullRequest = await pullRequestContext({
      repo,
      pullRequest: options.pullRequest,
      signal: controller.signal,
    });

    stage = "lane-preparation";
    const wholeChange =
      options.fast &&
      wholeChangeFits({
        repo: sourceRepo,
        head,
        base,
        files: changedFiles,
        budget: Math.min(
          ...Array.from({ length: options.reviewerLanes }, (_, index) =>
            packBudgetFor(packedLaneModel(options, reviewerLaneId(index))),
          ),
        ),
      });
    const assignments = assignLanes(
      changedFiles,
      options.reviewerLanes,
      wholeChange,
    );
    const reviewerPrompt = await readFile(options.reviewerPromptPath, "utf8");
    const promptDir = join(suiteDir, "prompts");
    await mkdir(promptDir);
    // The packed path calls the provider from this process, so the endpoint it
    // will reach is resolved from the named provider before any lane exists.
    // A provider without one is refused here rather than having its credential
    // sent to whichever upstream happened to be hardcoded.
    let fastUpstream: ReturnType<typeof resolveUpstream> | null = null;
    let canaries: ModelCanary[] = [];
    if (options.fast) {
      // Named by every lane, or refused here: a packed swarm reaches one
      // upstream, and only the default one answers to a model nobody named.
      const laneModels = packedLaneModels(options);
      // Refused by name before the credential is looked up: an unreachable
      // provider is not a missing key, and saying so would send the reader
      // after the wrong problem.
      upstreamFor(fastProvider);
      fastUpstream = resolveUpstream(
        fastProvider,
        await resolveRunCredentials(fastProvider, options.totalTimeoutSeconds),
      );
      // Every lab a lane will call is proven before any pack is built: a model
      // the gateway does not serve is a lane that cannot review, and finding
      // that out after the pack was paid for buys nothing.
      canaries = await canaryModels({
        baseUrl: fastUpstream.baseUrl,
        bearer: fastUpstream.bearer,
        models: laneModels,
        reasoning: options.fastReasoning,
        // The canary lives inside the same window the reviewers do: a model
        // that has not answered by the time the lanes must start is a lane
        // that cannot run, not a call worth waiting out.
        timeoutMs: laneDeadlineMs("reviewer"),
        signal: controller.signal,
      });
    }
    return {
      startLane,
      reservation,
      head,
      base,
      changedFiles,
      assignments,
      wholeChange,
      reviewerPrompt,
      promptDir,
      fastUpstream,
      canaries,
      pullRequest,
    };
  })().catch(async (error: unknown) => {
    await writeTerminalReceipt(
      suiteDir,
      preparationFailureReceipt(attempt, stage, error, {
        ...identity,
        abortReason,
        quota: "unknown",
        billing: "unknown",
        reservation: null,
        trialKind: options.trialKind,
        coverage: null,
      }),
    );
    throw error;
  });
  const {
    startLane,
    reservation,
    head,
    base,
    changedFiles,
    assignments,
    wholeChange,
    reviewerPrompt,
    promptDir,
    fastUpstream,
    canaries,
    pullRequest,
  } = prepared;

  const laneLedgerFor = (laneId: string) =>
    ledger.entries.find((entry) => entry["laneId"] === laneId) ?? null;
  const laneTerminalFor = (laneId: string) =>
    laneLedgerFor(laneId)?.["terminal"] ?? null;
  /**
   * What nobody proved about a lane's teardown.
   *
   * Only the Orca path can report it, so on the detached path it is `null`
   * meaning "not observed" - never an assertion that the lane cleaned up.
   */
  const laneCleanupFor = (laneId: string) =>
    laneLedgerFor(laneId)?.["cleanup"] ?? null;

  const lanes: LaneOutcome[] = [];
  const laneRows: Record<string, unknown>[] = [];
  const candidates: Candidate[] = [];
  // Lanes finish in whatever order the containers do; the receipt is assembled
  // by lane index so the same run always produces the same candidate ids.
  const laneResults: {
    outcome: LaneOutcome;
    row: Record<string, unknown>;
    candidates: Candidate[];
  }[] = new Array(assignments.length);

  const reviewerTasks = assignments.map((assignment, index) => async () => {
    const { files } = assignment;
    const laneId = reviewerLaneId(index);
    let runId = assertRunId(`${options.swarmId}-${laneId}`);
    let artifactDir = join(suiteDir, runId);
    const promptPath = join(promptDir, `${laneId}.txt`);
    const laneConfig = resolveLaneConfig(options, laneId);
    // The packed lane's model is the lane's own; a sandbox lane resolves through
    // the driver's flags, which the coordinator only forwards.
    const laneModel = options.fast
      ? packedLaneModel(options, laneId)
      : (laneConfig.model ?? options.model ?? "");
    // A model the gateway refused in the canary is a lane that cannot review.
    // It is blocked with the provider's own words and never handed to another
    // lab, because the receipt would then name a model that never answered.
    const canary = canaries.find((entry) => entry.model === laneModel) ?? null;
    const canaryError =
      canary && !canary.ok ? (canary.error ?? "canary failed") : null;
    let promptBody = (options.fast ? FAST_REVIEWER_PROMPT : reviewerPrompt)
      .replace(
        "{{ASSIGNED_FILES}}",
        files.map((file) => `- ${file}`).join("\n") || "- (none)",
      )
      .replace("{{LANE_FOCUS}}", assignment.focus)
      .replace(
        "{{RECOMMENDED_CHECK}}",
        recommendedCheck(await packagesForFiles(sourceRepo, files)) ||
          "(none derived; pick the check your mechanism needs)",
      );
    const packed = options.fast
      ? packLaneContext({
          repo: sourceRepo,
          head,
          base,
          files,
          budget: packBudgetFor(laneModel),
        })
      : null;
    if (packed) promptBody = `${promptBody}\n\n${packed.pack}`;
    await writeFile(promptPath, promptBody);
    const skipped = files.length === 0 || controller.signal.aborted;
    // The nested session is claimed before it is launched and never reused: a
    // second launch for this lane would be a retry with its own row, so a
    // silent restart cannot hide inside one identity.
    let session = skipped
      ? null
      : await sessions.start({
          laneId,
          role: "reviewer",
          runId,
          provider: laneConfig.provider ?? options.provider,
          model: laneConfig.model ?? options.model,
        });
    let finishReason: string | null = null;
    if (fastUpstream && canaryError) {
      await writeFastLaneArtifacts({
        artifactDir,
        runId,
        attemptId: attempt.attemptId,
        provider: fastProvider,
        model: laneModel,
        finalText: "",
        wallSeconds: canary?.seconds ?? 0,
        error: canaryError,
      });
    }
    // A lane's own window is set when it starts and never inherited from the
    // run: three lanes that all claim the whole deadline are three lanes the
    // run cannot pay for.
    let laneAbort: AbortSignal = controller.signal;
    // What the lane's container was actually wrapped in, kept for the receipt:
    // the window is recomputed at every launch, so reading it back later would
    // record a number no container ever ran under.
    let laneBudgetSeconds = laneTimeoutSeconds(laneWindow("reviewer"));
    const launchReviewer = async (attemptRunId: string) => {
      const windowSeconds = laneTimeoutSeconds(laneWindow("reviewer"));
      laneBudgetSeconds = windowSeconds;
      laneAbort = laneSignal(windowSeconds);
      return startLane(
        { laneId, role: "reviewer", runId: attemptRunId },
        laneArguments(
          options,
          attemptRunId,
          suiteDir,
          promptPath,
          head,
          base,
          windowSeconds,
          laneConfig,
          { role: "reviewer", laneId },
          attempt.attemptId,
        ),
        laneAbort,
      );
    };
    let relaunchAttempts = 0;
    let exitCode = skipped
      ? 1
      : fastUpstream
        ? canaryError
          ? 1
          : await (async () => {
              const startedLane = Date.now();
              try {
                const ask = () =>
                  completeOnce({
                    baseUrl: fastUpstream.baseUrl,
                    bearer: fastUpstream.bearer,
                    model: laneModel,
                    prompt: promptBody,
                    timeoutMs: laneDeadlineMs("reviewer"),
                    signal: controller.signal,
                    reasoning: packedLaneReasoning(options, laneId),
                  });
                let answer = await ask();
                let usage: Record<string, number> = answer.usage;
                // A packed model that answers with JSON it cannot close is asked
                // once more: the second answer is a fresh sample, not a replay,
                // and one more request is cheaper than a lane the run must do
                // without. The receipt prices both answers. An answer the
                // ceiling cut is not asked again: the same ceiling cuts the
                // same report. Unless the ceiling fell before the report began.
                const cut =
                  answer.finishReason === "length" ||
                  answer.finishReason === "max_tokens";
                if (
                  parseCandidates(answer.content, laneId).error &&
                  (!cut ||
                    cutWhileThinking(answer.content, answer.finishReason)) &&
                  !controller.signal.aborted
                ) {
                  relaunchAttempts += 1;
                  const spent = usage;
                  answer = await ask();
                  const second: Record<string, number> = answer.usage;
                  usage = Object.fromEntries(
                    Object.keys({ ...spent, ...second }).map((key) => [
                      key,
                      (spent[key] ?? 0) + (second[key] ?? 0),
                    ]),
                  );
                }
                finishReason = answer.finishReason;
                await writeFastLaneArtifacts({
                  artifactDir,
                  runId,
                  attemptId: attempt.attemptId,
                  provider: fastProvider,
                  model: laneModel,
                  finalText: answer.content,
                  usage,
                  wallSeconds: Math.round((Date.now() - startedLane) / 1000),
                });
                return 0;
              } catch (error) {
                await writeFastLaneArtifacts({
                  artifactDir,
                  runId,
                  attemptId: attempt.attemptId,
                  provider: fastProvider,
                  model: laneModel,
                  finalText: "",
                  wallSeconds: Math.round((Date.now() - startedLane) / 1000),
                  error: error instanceof Error ? error.message : String(error),
                });
                return 1;
              }
            })()
        : await launchReviewer(runId);
    let receipt = skipped ? null : await laneReceipt(artifactDir);
    // A container that died before the lane reached the model burned nothing,
    // so relaunching it costs a run what an infrastructure hiccup already cost
    // it. A lane cut after its first request is not relaunched: its tokens are
    // spent and buying them twice is not a recovery. What the run will not do
    // either is buy a container the window can no longer host a review in.
    let relaunchRefused: string | null = null;
    for (
      let relaunch = 1;
      !skipped &&
      !fastUpstream &&
      relaunch <= LANE_RELAUNCHES &&
      !laneAbort.aborted &&
      neverReachedModel(receipt);
      relaunch += 1
    ) {
      if (session) {
        await sessions.finish(session.sessionId, {
          status: "relaunched",
          exitCode,
          outcome: receipt?.outcome ?? null,
          usage: null,
        });
      }
      await delay(RELAUNCH_BACKOFF_MS * relaunch, laneAbort);
      if (laneAbort.aborted) break;
      relaunchRefused = relaunchRefusal(options, elapsedSeconds(), "reviewer");
      if (relaunchRefused) break;
      relaunchAttempts += 1;
      runId = assertRunId(`${options.swarmId}-${laneId}-r${relaunch + 1}`);
      artifactDir = join(suiteDir, runId);
      session = await sessions.start({
        laneId,
        role: "reviewer",
        runId,
        provider: laneConfig.provider ?? options.provider,
        model: laneConfig.model ?? options.model,
      });
      exitCode = await launchReviewer(runId);
      receipt = await laneReceipt(artifactDir);
    }
    const report = skipped ? null : await laneReport(artifactDir);
    const finalize = skipped ? null : await laneFinalize(artifactDir);
    const finalText = report?.finalText ?? null;
    const laneCandidates: Candidate[] = [];
    let status: LaneOutcome["status"];
    let contractError: string | null = null;
    let parseResult: ReturnType<typeof parseCandidates> | null = null;
    let blockerReason: string | null = null;
    // What the lane never got to see, whichever end it was cut at. Either way
    // the lane judged less than its assignment, so its answer is a blocked
    // one: an empty finding list here means "not reached", not "clean".
    const droppedAssigned =
      packed?.droppedFiles.filter((file) => files.includes(file)) ?? [];
    const cutReason =
      finishReason === "length" || finishReason === "max_tokens"
        ? `answer cut at ${receipt?.usage?.["outputTokens"] ?? 0} output tokens`
        : null;
    const evidenceGap = packed?.truncated
      ? "pack truncated: the assigned diff alone exceeds the pack budget"
      : droppedAssigned.length > 0
        ? `pack budget dropped ${droppedAssigned.join(", ")}`
        : null;
    if (files.length === 0) {
      // Nothing to investigate is a lane that did not review, never a pass.
      status = "failed";
    } else if (abortReason || receipt?.outcome === "interrupted") {
      status = "cancelled";
    } else if (canaryError) {
      // The model itself was refused before the pack was built, so the lane
      // read nothing; the provider's own words are the reason it did not.
      status = "blocked";
      blockerReason = canaryError;
    } else if (report?.partial) {
      // The runner wrote this report while it was being cut, so the lane judged
      // less than its assignment whichever way its answer parses. This is the
      // deadline, the request cap and the answer that never came, and none of
      // them is a failed review: the lane read what it could and said so.
      status = "blocked";
      blockerReason =
        report.partialReason ?? "the lane was cut before it finished";
    } else if (exitCode !== 0 || receipt?.outcome !== "completed") {
      status = "failed";
    } else {
      const parsed = parseCandidates(finalText ?? "", laneId);
      contractError = parsed.error;
      parseResult = parsed;
      blockerReason = parsed.blockerReason ?? evidenceGap;
      if (cutReason) {
        status = "blocked";
        blockerReason = cutReason;
      } else if (parsed.error) status = "malformed";
      else {
        status =
          parsed.completion === "partial" || evidenceGap
            ? "blocked"
            : "completed";
        laneCandidates.push(...parsed.candidates);
      }
    }
    if (session) {
      await sessions.finish(session.sessionId, {
        status,
        exitCode,
        outcome: receipt?.outcome ?? null,
        usage: receipt?.usage ?? null,
      });
    }
    laneResults[index] = {
      outcome: { laneId, role: "reviewer", status },
      candidates: laneCandidates,
      row: {
        laneId,
        role: "reviewer",
        runId,
        status,
        assignedFiles: files,
        focus: assignment.focus,
        sharedAssignment: assignment.shared,
        pack: packed
          ? {
              bytes: packed.bytes,
              budget: packBudgetFor(laneModel),
              allocation: wholeChange ? "whole-change" : "split",
              truncated: packed.truncated,
              filesPacked: packed.filesPacked,
              droppedFiles: packed.droppedFiles,
              missingAtHead: packed.missingAtHead,
              symbols: packed.symbols,
            }
          : null,
        canary,
        finishReason,
        promptPath,
        artifactDir: skipped ? null : artifactDir,
        contractError,
        droppedFindings: parseResult?.droppedFindings ?? [],
        blockerReason,
        reportCompletion: report
          ? report.partial
            ? "partial"
            : "complete"
          : null,
        finalize,
        relaunch: {
          attempts: relaunchAttempts,
          refusedReason: relaunchRefused,
        },
        image: options.image,
        provider:
          receipt?.provider ?? laneConfig.provider ?? options.provider ?? null,
        model: receipt?.model ?? laneConfig.model ?? options.model ?? null,
        thinking:
          laneConfig.thinking ??
          options.thinking ??
          (options.fast ? "low" : "high"),
        reasoning: fastUpstream ? packedLaneReasoning(options, laneId) : null,
        usage: receipt?.usage ?? null,
        wallSeconds: receipt?.wallSeconds ?? null,
        teardownSeconds: receipt?.teardownSeconds ?? null,
        truncatedArtifacts: receipt?.truncatedArtifacts ?? [],
        error: receipt?.error ?? null,
        orcaTerminal: laneTerminalFor(laneId),
        cleanup: laneCleanupFor(laneId),
        piSessionId: session?.sessionId ?? null,
        piSessionAttempt: session?.attemptNumber ?? null,
        laneWindowSeconds: laneBudgetSeconds,
      },
    };
  });

  let verifierRunId = assertRunId(`${options.swarmId}-verifier`);
  let verifierDir = join(suiteDir, verifierRunId);
  const verifierPromptPath = join(promptDir, "verifier.txt");
  const verifierBriefPath = join(promptDir, "verifier-brief.json");
  const verifierLaneConfig = resolveLaneConfig(options, "verifier");
  let verifierSession: { sessionId: string; attemptNumber: number } | null =
    null;
  // What the verifier's container ran under, by whichever path launched it.
  let verifierWindowSeconds = 0;
  // A cloud verifier starts with the reviewers and idles in its prepared
  // checkout until the candidates exist, so its clone and install overlap the
  // reviews instead of following them. Its clock starts with theirs, so its
  // window is the run the reviewers did not use, on top of its own reserve.
  let warmVerifier: Promise<number> | null = null;
  if (options.worker && !fastUpstream && !controller.signal.aborted) {
    verifierSession = await sessions.start({
      laneId: "verifier",
      role: "verifier",
      runId: verifierRunId,
      provider: verifierLaneConfig.provider ?? options.provider,
      model: verifierLaneConfig.model ?? options.model,
    });
    verifierWindowSeconds = laneTimeoutSeconds(laneWindow("verifier", true));
    warmVerifier = startLane(
      { laneId: "verifier", role: "verifier", runId: verifierRunId },
      laneArguments(
        options,
        verifierRunId,
        suiteDir,
        verifierPromptPath,
        head,
        base,
        verifierWindowSeconds,
        verifierLaneConfig,
        { role: "verifier", laneId: "verifier", brief: verifierBriefPath },
        attempt.attemptId,
      ),
      laneSignal(verifierWindowSeconds),
    );
  }
  const writeBrief = async (
    path: string,
    brief: { prompt: string | null; candidateIds: string[] },
  ) => {
    await writeAtomic(path, JSON.stringify(brief));
  };

  /**
   * Packed reviewers beside sandbox verifiers.
   *
   * The reviewers answer in this process, so every sandbox slot belongs to a
   * verifier: a pool of CLOUD_CONCURRENT_LANES lanes starts with them, idles in
   * its prepared checkout while they answer, and each lane claims one file's
   * candidates the moment the reviewer set is frozen. A lane with nothing left
   * to claim ends on a null brief instead of answering nothing, and a lane
   * whose sandbox died before any model saw its claim hands the group back for
   * a fresh sandbox rather than leaving the candidate unverified.
   */
  const verifierPoolLanes =
    fastUpstream && options.worker ? CLOUD_CONCURRENT_LANES : 0;
  const verifierQueue = claimQueue(join(suiteDir, "claims"));
  const verifierPromptTemplate = verifierPoolLanes
    ? await readFile(options.verifierPromptPath, "utf8")
    : "";
  // Frozen once every reviewer has settled and the queue holds the final ids:
  // before that a lane waits, after it a lane with nothing to claim is done.
  let verifierSetFrozen = false;
  let candidateReadyAtMs: number | null = null;
  let poolRefusal: string | null = null;
  const poolWaves: {
    wave: number;
    laneIds: string[];
    startedAt: string;
    finishedAt: string;
  }[] = [];
  const poolRows: Record<string, unknown>[] = [];
  const poolSettlements: {
    laneId: string;
    wave: number;
    status: LaneOutcome["status"];
    candidateIds: string[];
    claimedFile: string | null;
    settledAtMs: number;
    verdicts: Verdict[];
  }[] = [];

  const runPoolLane = async (laneIndex: number, wave: number) => {
    const laneId = `verifier-${laneIndex}`;
    const runId = assertRunId(`${options.swarmId}-${laneId}`);
    const artifactDir = join(suiteDir, runId);
    const briefPath = join(promptDir, `${laneId}-brief.json`);
    // A pool lane starts with the reviewers, so its clock is the whole run the
    // reviewers did not use on top of the verifier reserve, less teardown.
    const windowSeconds = laneTimeoutSeconds(laneWindow("verifier", true));
    const session = await sessions.start({
      laneId,
      role: "verifier",
      runId,
      provider: verifierLaneConfig.provider ?? options.provider,
      model: verifierLaneConfig.model ?? options.model,
    });
    const laneAbort = laneSignal(windowSeconds);
    const laneState: VerifierLaneState = {
      claim: null,
      claimedAt: null,
      briefedAt: null,
      releasedReason: null,
    };
    const briefWriter = (async () => {
      while (!laneAbort.aborted) {
        const next = await nextVerifierBrief({
          queue: verifierQueue,
          laneId,
          settled: verifierSetFrozen,
          verdictDeadlineAt:
            candidateReadyAtMs === null
              ? null
              : candidateReadyAtMs + POOL_VERDICT_SECONDS * 1000,
          prompt: (claimed) =>
            renderVerifierBrief(
              verifierPromptTemplate,
              verifierBrief({
                repo: sourceRepo,
                base,
                head,
                files: [claimed.file],
                pullRequest,
                candidates: claimed.candidates,
              }),
            ),
        });
        if (!next) {
          await delay(VERIFIER_CLAIM_POLL_MS, laneAbort);
          continue;
        }
        if (next.claim) {
          laneState.claim = next.claim;
          laneState.claimedAt = Date.now();
        }
        await writeBrief(briefPath, next.brief);
        laneState.briefedAt = Date.now();
        return;
      }
    })();
    const exitCode = await startLane(
      { laneId, role: "verifier", runId },
      laneArguments(
        options,
        runId,
        suiteDir,
        verifierPromptPath,
        head,
        base,
        windowSeconds,
        verifierLaneConfig,
        {
          role: "verifier",
          laneId,
          brief: briefPath,
          maxRequests: POOL_VERIFIER_MAX_REQUESTS,
        },
        attempt.attemptId,
      ),
      laneAbort,
    );
    await briefWriter;
    const receipt = await laneReceipt(artifactDir);
    const report = await laneReport(artifactDir);
    const claimed = laneState.claim;
    // A lane that died before any model answered spent nothing on its claim, so
    // the group goes back to the queue for a fresh sandbox. A claim a model
    // already read is never briefed twice.
    if (claimed && neverReachedModel(receipt)) {
      laneState.releasedReason = `the lane never reached the model: ${receipt?.error ?? "no lane receipt"}`;
      await verifierQueue.release(claimed);
    }
    let status: LaneOutcome["status"];
    let contractError: string | null = null;
    let blockerReason: string | null = null;
    let laneVerdicts: Verdict[] = [];
    if (laneState.releasedReason) {
      status = "not_run";
      blockerReason = laneState.releasedReason;
    } else if (!claimed) {
      // Nothing was claimed, so nothing was decided: the lane either found the
      // queue empty and ended, or the run was cut while it waited.
      status = abortReason ? "cancelled" : "not_run";
    } else if (abortReason || receipt?.outcome === "interrupted") {
      status = "cancelled";
    } else if (report?.partial) {
      status = "blocked";
      blockerReason =
        report.partialReason ?? "the verifier was cut before it ruled";
    } else if (exitCode !== 0 || receipt?.outcome !== "completed") {
      status = "failed";
      blockerReason = receipt?.error ?? null;
    } else {
      const parsed = parseVerdicts(
        report?.finalText ?? "",
        claimed.candidateIds,
      );
      contractError = parsed.error;
      if (parsed.error) status = "malformed";
      else {
        laneVerdicts = withVerbatimDeclarations(
          parsed.verdicts,
          pullRequest?.body ?? null,
        );
        status = "completed";
      }
    }
    const settledAtMs = Date.now();
    await sessions.finish(session.sessionId, {
      status,
      exitCode,
      outcome: receipt?.outcome ?? null,
      usage: receipt?.usage ?? null,
    });
    const finalize = laneState.briefedAt
      ? await laneFinalize(artifactDir)
      : null;
    return {
      settlement: {
        laneId,
        wave,
        status,
        candidateIds: claimed?.candidateIds ?? [],
        claimedFile: claimed?.file ?? null,
        settledAtMs,
        verdicts: laneVerdicts,
      },
      row: {
        laneId,
        role: "verifier",
        runId,
        status,
        wave,
        warmStart: true,
        claimedFile: claimed?.file ?? null,
        candidateIds: claimed?.candidateIds ?? [],
        candidatesSent: claimed?.candidateIds.length ?? 0,
        claimedAt: laneState.claimedAt
          ? new Date(laneState.claimedAt).toISOString()
          : null,
        briefedAt: laneState.briefedAt
          ? new Date(laneState.briefedAt).toISOString()
          : null,
        settledAt: new Date(settledAtMs).toISOString(),
        released: laneState.releasedReason,
        promptPath: laneState.briefedAt ? briefPath : null,
        artifactDir,
        contractError,
        blockerReason,
        canary: null,
        finishReason: null,
        image: options.image,
        reportCompletion: report
          ? report.partial
            ? "partial"
            : "complete"
          : null,
        finalize,
        relaunch: { attempts: 0, refusedReason: null },
        provider:
          receipt?.provider ??
          verifierLaneConfig.provider ??
          options.provider ??
          null,
        model:
          receipt?.model ?? verifierLaneConfig.model ?? options.model ?? null,
        thinking: verifierLaneConfig.thinking ?? options.thinking ?? "low",
        usage: receipt?.usage ?? null,
        wallSeconds: receipt?.wallSeconds ?? null,
        teardownSeconds: receipt?.teardownSeconds ?? null,
        truncatedArtifacts: receipt?.truncatedArtifacts ?? [],
        error: receipt?.error ?? null,
        orcaTerminal: laneTerminalFor(laneId),
        cleanup: laneCleanupFor(laneId),
        piSessionId: session.sessionId,
        piSessionAttempt: session.attemptNumber,
        laneWindowSeconds: windowSeconds,
      } satisfies Record<string, unknown>,
    };
  };

  let poolRun: Promise<void> | null = null;
  if (verifierPoolLanes > 0) {
    poolRun = (async () => {
      let launched = 0;
      let wave = 0;
      while (!controller.signal.aborted) {
        const remaining =
          wave === 0 ? verifierPoolLanes : await verifierQueue.remaining();
        const plan = verifierWavePlan({
          wave,
          poolLanes: verifierPoolLanes,
          remaining,
          windowSeconds: laneWindowSeconds(
            options,
            elapsedSeconds(),
            "verifier",
            true,
          ),
        });
        if (plan.size === 0) {
          poolRefusal = plan.refusal;
          break;
        }
        wave += 1;
        const startedAt = new Date().toISOString();
        const settled = await Promise.all(
          Array.from({ length: plan.size }, (_, index) =>
            runPoolLane(launched + index + 1, wave),
          ),
        );
        launched += plan.size;
        for (const result of settled) {
          poolRows.push(result.row);
          poolSettlements.push(result.settlement);
        }
        poolWaves.push({
          wave,
          laneIds: settled.map((result) => result.settlement.laneId),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    })();
  }

  const reviewerConcurrency = options.fast
    ? options.reviewerLanes
    : options.worker
      ? Math.min(options.reviewerLanes, CLOUD_CONCURRENT_LANES)
      : MAX_CONCURRENT_LANES;
  // The run's own declared wall. Every lane's container is cut by its window
  // before this, and a verifier's window is measured from the same clock, so
  // this only ever ends a lane the control plane lost track of. It is what makes
  // the swarm's wall a number rather than the sum of whatever its lanes did.
  const swarmDeadline = setTimeout(() => {
    abortReason ??= "deadline";
    controller.abort(new Error("swarm deadline"));
  }, options.totalTimeoutSeconds * 1000);
  swarmDeadline.unref();
  await withConcurrency(reviewerTasks, reviewerConcurrency);
  for (const result of laneResults) {
    lanes.push(result.outcome);
    laneRows.push(result.row);
    candidates.push(...result.candidates);
  }

  const deduped = collapseIdenticalCandidates(candidates);
  // The reviewer set is what makes candidate ids final, so the queue is
  // published once, here, and never grows afterwards: a group a verifier
  // claims cannot be one whose id changes under it.
  if (verifierPoolLanes > 0) {
    candidateReadyAtMs = Date.now();
    await verifierQueue.publish(candidateGroups(deduped));
  }
  verifierSetFrozen = true;
  if (poolRun) await poolRun;
  const poolVerdicts = poolSettlements.flatMap((entry) => entry.verdicts);
  for (const settlement of poolSettlements) {
    lanes.push({
      laneId: settlement.laneId,
      role: "verifier",
      status: settlement.status,
    });
  }
  laneRows.push(...poolRows);
  let verdicts: Verdict[] = verifierPoolLanes > 0 ? poolVerdicts : [];
  let verifierContractError: string | null = null;
  let verifierFinishReason: string | null = null;
  let verifierCanary: ModelCanary | null = null;
  let verifierStatus: LaneOutcome["status"] = "not_run";
  let verifierReceipt: Awaited<ReturnType<typeof laneReceipt>> = null;
  let verifierReport: Awaited<ReturnType<typeof laneReport>> = null;
  let verifierRelaunchRefused: string | null = null;
  let verifierRelaunchAttempts = 0;
  const verifierRan = deduped.length > 0 && !controller.signal.aborted;

  if (verifierPoolLanes === 0 && !verifierRan && warmVerifier) {
    // Nothing to rule on: the idle verifier is told so and tears down unused.
    await writeBrief(verifierBriefPath, { prompt: null, candidateIds: [] });
    const exitCode = await warmVerifier;
    verifierReport = await laneReport(verifierDir);
    if (verifierSession) {
      await sessions.finish(verifierSession.sessionId, {
        status: abortReason ? "cancelled" : "not_run",
        exitCode,
        outcome: null,
        usage: null,
      });
    }
  }

  if (verifierPoolLanes === 0 && verifierRan) {
    verifierSession ??= await sessions.start({
      laneId: "verifier",
      role: "verifier",
      runId: verifierRunId,
      provider: verifierLaneConfig.provider ?? options.provider,
      model: verifierLaneConfig.model ?? options.model,
    });
    const verifierLaneModel = options.fast
      ? packedLaneModel(options, "verifier")
      : (verifierLaneConfig.model ?? options.model ?? "");
    verifierCanary =
      canaries.find((entry) => entry.model === verifierLaneModel) ?? null;
    const verifierCanaryError =
      verifierCanary && !verifierCanary.ok
        ? (verifierCanary.error ?? "canary failed")
        : null;
    const verifierPacked = fastUpstream
      ? packLaneContext({
          repo: sourceRepo,
          head,
          base,
          files: [...new Set(deduped.map((candidate) => candidate.file))],
          budget: packBudgetFor(verifierLaneModel),
        })
      : null;
    // Every candidate's own file travels with the change's intent, so the
    // verifier can answer whether the change introduced the mechanism and
    // whether the change declares that behavior as intended. The questions sit
    // after the pack, so they are what the verifier reads last.
    const verifierFiles = [...new Set(deduped.map((entry) => entry.file))];
    await writeFile(
      verifierPromptPath,
      renderVerifierBrief(
        options.fast
          ? FAST_VERIFIER_PROMPT
          : await readFile(options.verifierPromptPath, "utf8"),
        verifierBrief({
          repo: sourceRepo,
          base,
          head,
          files: verifierFiles,
          pullRequest,
          candidates: candidatePayload(deduped),
        }),
        verifierPacked?.pack,
      ),
    );
    if (fastUpstream && verifierCanaryError) {
      await writeFastLaneArtifacts({
        artifactDir: verifierDir,
        runId: verifierRunId,
        attemptId: attempt.attemptId,
        provider: fastProvider,
        model: verifierLaneModel,
        finalText: "",
        wallSeconds: verifierCanary?.seconds ?? 0,
        error: verifierCanaryError,
      });
    }
    // The packed verifier calls the provider from this process, so its window
    // is the reservation the cold path would have been given.
    verifierWindowSeconds = laneTimeoutSeconds(laneWindow("verifier"));
    let exitCode = fastUpstream
      ? verifierCanaryError
        ? 1
        : await (async () => {
            const startedLane = Date.now();
            const laneModel = verifierLaneModel;
            try {
              const answer = await completeOnce({
                baseUrl: fastUpstream.baseUrl,
                bearer: fastUpstream.bearer,
                model: laneModel,
                prompt: await readFile(verifierPromptPath, "utf8"),
                timeoutMs: laneDeadlineMs("verifier"),
                signal: controller.signal,
                reasoning: options.fastReasoning,
              });
              verifierFinishReason = answer.finishReason;
              await writeFastLaneArtifacts({
                artifactDir: verifierDir,
                runId: verifierRunId,
                attemptId: attempt.attemptId,
                provider: fastProvider,
                model: laneModel,
                finalText: answer.content,
                usage: answer.usage,
                wallSeconds: Math.round((Date.now() - startedLane) / 1000),
              });
              return 0;
            } catch (error) {
              await writeFastLaneArtifacts({
                artifactDir: verifierDir,
                runId: verifierRunId,
                attemptId: attempt.attemptId,
                provider: fastProvider,
                model: laneModel,
                finalText: "",
                wallSeconds: Math.round((Date.now() - startedLane) / 1000),
                error: error instanceof Error ? error.message : String(error),
              });
              return 1;
            }
          })()
      : warmVerifier
        ? await (async () => {
            await writeBrief(verifierBriefPath, {
              prompt: await readFile(verifierPromptPath, "utf8"),
              candidateIds: deduped.map((candidate) => candidate.id),
            });
            return warmVerifier;
          })()
        : await (async () => {
            verifierWindowSeconds = laneTimeoutSeconds(laneWindow("verifier"));
            return startLane(
              { laneId: "verifier", role: "verifier", runId: verifierRunId },
              laneArguments(
                options,
                verifierRunId,
                suiteDir,
                verifierPromptPath,
                head,
                base,
                verifierWindowSeconds,
                verifierLaneConfig,
                {
                  role: "verifier",
                  laneId: "verifier",
                  candidateIds: deduped.map((candidate) => candidate.id),
                },
                attempt.attemptId,
              ),
              laneSignal(verifierWindowSeconds),
            );
          })();
    verifierReceipt = await laneReceipt(verifierDir);
    // The verifier is the run's single point of failure: reviewers can lose one
    // lane and still be adjudicated, but a dead verifier leaves every candidate
    // unruled. So it is relaunched on the same terms - only while its container
    // died before reaching the model, and only into a window that can still
    // host a verdict.
    for (
      let relaunch = 1;
      !fastUpstream &&
      relaunch <= LANE_RELAUNCHES &&
      !controller.signal.aborted &&
      neverReachedModel(verifierReceipt);
      relaunch += 1
    ) {
      if (verifierSession) {
        await sessions.finish(verifierSession.sessionId, {
          status: "relaunched",
          exitCode,
          outcome: verifierReceipt?.outcome ?? null,
          usage: null,
        });
      }
      await delay(RELAUNCH_BACKOFF_MS * relaunch, controller.signal);
      if (controller.signal.aborted) break;
      verifierRelaunchRefused = relaunchRefusal(
        options,
        elapsedSeconds(),
        "verifier",
      );
      if (verifierRelaunchRefused) break;
      verifierRelaunchAttempts += 1;
      verifierRunId = assertRunId(
        `${options.swarmId}-verifier-r${relaunch + 1}`,
      );
      verifierDir = join(suiteDir, verifierRunId);
      verifierSession = await sessions.start({
        laneId: "verifier",
        role: "verifier",
        runId: verifierRunId,
        provider: verifierLaneConfig.provider ?? options.provider,
        model: verifierLaneConfig.model ?? options.model,
      });
      verifierWindowSeconds = laneTimeoutSeconds(laneWindow("verifier"));
      exitCode = await startLane(
        { laneId: "verifier", role: "verifier", runId: verifierRunId },
        laneArguments(
          options,
          verifierRunId,
          suiteDir,
          verifierPromptPath,
          head,
          base,
          verifierWindowSeconds,
          verifierLaneConfig,
          {
            role: "verifier",
            laneId: "verifier",
            candidateIds: deduped.map((candidate) => candidate.id),
          },
          attempt.attemptId,
        ),
        laneSignal(verifierWindowSeconds),
      );
      verifierReceipt = await laneReceipt(verifierDir);
    }
    verifierReport = await laneReport(verifierDir);
    if (abortReason || verifierReceipt?.outcome === "interrupted") {
      verifierStatus = "cancelled";
    } else if (verifierCanaryError) {
      // No lab answered the canary, so no candidate was ever ruled on. That is
      // the verifier being blocked, not the verifier clearing the change.
      verifierStatus = "blocked";
      verifierContractError = verifierCanaryError;
    } else if (verifierReport?.partial) {
      // The verifier's own report says it was cut, so its verdicts cover less
      // than the candidate set however they parse.
      verifierStatus = "blocked";
      verifierContractError =
        verifierReport.partialReason ??
        "the verifier was cut before it ruled on every candidate";
    } else if (exitCode !== 0 || verifierReceipt?.outcome !== "completed") {
      verifierStatus = "failed";
    } else {
      const parsed = parseVerdicts(
        verifierReport?.finalText ?? "",
        deduped.map((entry) => entry.id),
      );
      // A verdict list the provider cut is not an adjudication, however well
      // the surviving prefix parses: the candidates it never reached would be
      // published as verified by a decision nobody made.
      // The verifier's pack is the source behind the candidates it judges, so a
      // candidate whose file did not fit is one it confirmed or rejected
      // without ever reading the code the claim is about.
      const unseenCandidateFiles = verifierPacked?.droppedFiles ?? [];
      const verifierGap =
        verifierPacked?.truncated ||
        unseenCandidateFiles.length > 0 ||
        verifierFinishReason === "length";
      verifierContractError =
        parsed.error ??
        (verifierGap
          ? `verifier evidence or answer was truncated${unseenCandidateFiles.length > 0 ? `: ${unseenCandidateFiles.join(", ")}` : ""}`
          : null);
      if (verifierContractError) verifierStatus = "malformed";
      else {
        verdicts = withVerbatimDeclarations(
          parsed.verdicts,
          pullRequest?.body ?? null,
        );
        verifierStatus = "completed";
      }
    }
    await sessions.finish(verifierSession.sessionId, {
      status: verifierStatus,
      exitCode,
      outcome: verifierReceipt?.outcome ?? null,
      usage: verifierReceipt?.usage ?? null,
    });
  } else if (verifierPoolLanes === 0 && abortReason) {
    verifierStatus = "cancelled";
  } else if (verifierPoolLanes === 0) {
    // Nothing was sent to the verifier, so it decided nothing. Recording that
    // as a pass would turn "the reviewers found nothing" into "the verifier
    // cleared the change", which it never saw.
    verifierStatus = "not_run";
  }

  // Every lane has settled: the run's wall is theirs now, not a timer's.
  clearTimeout(swarmDeadline);
  if (verifierPoolLanes === 0) {
    lanes.push({
      laneId: "verifier",
      role: "verifier",
      status: verifierStatus,
    });
    laneRows.push({
      laneId: "verifier",
      role: "verifier",
      runId: verifierRunId,
      status: verifierStatus,
      warmStart: warmVerifier !== null,
      candidatesSent: deduped.length,
      promptPath: verifierRan ? verifierPromptPath : null,
      artifactDir: verifierRan ? verifierDir : null,
      contractError: verifierContractError,
      canary: verifierCanary,
      finishReason: verifierFinishReason,
      image: options.image,
      reportCompletion: verifierReport
        ? verifierReport.partial
          ? "partial"
          : "complete"
        : null,
      finalize: verifierRan ? await laneFinalize(verifierDir) : null,
      relaunch: {
        attempts: verifierRelaunchAttempts,
        refusedReason: verifierRelaunchRefused,
      },
      provider:
        verifierReceipt?.provider ??
        verifierLaneConfig.provider ??
        options.provider ??
        null,
      model:
        verifierReceipt?.model ??
        verifierLaneConfig.model ??
        options.model ??
        null,
      thinking:
        verifierLaneConfig.thinking ??
        options.thinking ??
        (options.fast ? "low" : "high"),
      usage: verifierReceipt?.usage ?? null,
      wallSeconds: verifierReceipt?.wallSeconds ?? null,
      teardownSeconds: verifierReceipt?.teardownSeconds ?? null,
      truncatedArtifacts: verifierReceipt?.truncatedArtifacts ?? [],
      error: verifierReceipt?.error ?? null,
      orcaTerminal: laneTerminalFor("verifier"),
      cleanup: laneCleanupFor("verifier"),
      piSessionId: verifierSession?.sessionId ?? null,
      piSessionAttempt: verifierSession?.attemptNumber ?? null,
      laneWindowSeconds: verifierWindowSeconds,
    });
  }

  const coveredFiles = laneRows.flatMap((row) =>
    row["role"] === "reviewer" && row["status"] === "completed"
      ? (row["assignedFiles"] as string[])
      : [],
  );
  const uncoveredFiles = changedFiles.filter(
    (file) => !coveredFiles.includes(file),
  );
  const { findings, duplicates } = applyVerdicts(deduped, verdicts);
  // The ids no verdict covered. They are already unverified findings in the
  // receipt; this is the same set as a list, so a reader does not have to walk
  // the findings to see that the review left something unruled.
  const unverified = unadjudicated(deduped, verdicts);
  const verdictLatency = Object.fromEntries(
    poolSettlements.flatMap((settlement) =>
      candidateReadyAtMs === null || settlement.status !== "completed"
        ? []
        : settlement.candidateIds.map((id) => [
            id,
            Math.round((settlement.settledAtMs - candidateReadyAtMs) / 1000),
          ]),
    ),
  ) as Record<string, number>;
  const teardownSeconds = laneRows.reduce(
    (total, row) =>
      total +
      (typeof row["teardownSeconds"] === "number" ? row["teardownSeconds"] : 0),
    0,
  );

  const receipt = {
    ...identity,
    status: swarmStatus(lanes, uncoveredFiles, findings, {
      verifierRequired: verifierRan,
    }),
    // An interrupted run reached no outcome of its own; saying it raised no
    // candidates would read as a clean sweep of a review that never finished.
    outcome: abortReason
      ? ("cancelled" as const)
      : verifierRan
        ? ("adjudicated" as const)
        : ("no_candidates" as const),
    abortReason,
    // The requested revisions are replaced by the exact ones every lane saw.
    requested: { head, base, pullRequest: options.pullRequest ?? null },
    concurrencyCap: reviewerConcurrency,
    quota: "unknown",
    // A reservation is what was held, usage is what was spent, and they are
    // never merged: an unknown price cannot clear an economic comparison.
    reservation,
    billing: "unknown",
    piSessions: sessions.sessions,
    // What each lab answered when asked for one word, before any pack was
    // built: a lane whose model never answered is in here with its reason.
    canaries,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - startedAt) / 1000),
    reportedTeardownSeconds: teardownSeconds,
    coverage: {
      changedFiles,
      assignments: Object.fromEntries(
        assignments.map((assignment, index) => [
          `reviewer-${index + 1}`,
          { files: assignment.files, focus: assignment.focus },
        ]),
      ),
      sharedAssignment: assignments[0]?.shared ?? false,
      uncoveredFiles,
    },
    lanes: laneRows,
    candidates: deduped,
    unverified,
    findings,
    duplicates,
    // How the candidates were adjudicated, and how long that took: the
    // candidate-ready instant is the moment the reviewer set froze, so the
    // latency below is claim-to-verdict rather than reviewer-to-verdict.
    verification: {
      mode: verifierPoolLanes
        ? ("pool" as const)
        : fastUpstream
          ? ("packed" as const)
          : ("sandbox" as const),
      poolLanes: verifierPoolLanes,
      waves: poolWaves,
      candidateReadyAt:
        candidateReadyAtMs === null
          ? null
          : new Date(candidateReadyAtMs).toISOString(),
      unverified,
      waveRefusal: poolRefusal,
      // What the declared-intent question was answered against: the change's
      // own text when the host could read it, and nothing when it could not.
      pullRequest: pullRequest
        ? { number: pullRequest.number, title: pullRequest.title }
        : null,
      verdictLatency: {
        perCandidate: verdictLatency,
        p95Seconds: percentile(Object.values(verdictLatency), 0.95),
      },
    },
    qualityAdjudication:
      "verifier-only; identical candidates are collapsed lexically before it runs, every other duplicate is the verifier's call, and reviewer agreement is provenance, not proof",
  };
  const receiptPath = await writeTerminalReceipt(suiteDir, receipt);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  console.log(`swarm receipt: ${receiptPath}`);
  if (receipt.status !== "completed") process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
