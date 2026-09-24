/**
 * One swarm receipt as the result files AACR-Bench scores.
 *
 * The benchmark's eval stage reads OCR-shaped files: `review.comments[]` with
 * `path`, `content`, `start_line` and `end_line`, and the right side is implied.
 * Two sets are written per case. `candidates` is every claim a reviewer lane
 * made, which is the ceiling recall could reach. `confirmed` is what a pull
 * request review would actually carry, which is what publication would have
 * posted, and it is derived here through the same disposition rule the
 * publisher applies rather than through a second opinion about severity.
 *
 * A comment's location is the finding's own line on both ends: the swarm
 * reports a mechanism at one line, so a range would claim a span nobody read.
 */

import type { SwarmReceipt } from "../../src/publish";
import { publicationDisposition } from "../../src/publish";
import { sumIsShort } from "../score";
import type { AacrCase } from "./dataset";

/** The floor `src/publish.ts` defaults to; `bun run src/publish.ts` posts P2 up. */
export const MIN_SEVERITY = "P2";

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

/**
 * The severity floor of `buildReview`, kept in step with it by the differential
 * test in `evals/__tests__/aacr.test.ts` rather than by a second opinion here.
 */
const severityAtLeast = (severity: string, minimum: string) => {
  const rank = SEVERITY_ORDER.indexOf(
    severity as (typeof SEVERITY_ORDER)[number],
  );
  const floor = SEVERITY_ORDER.indexOf(
    minimum as (typeof SEVERITY_ORDER)[number],
  );
  return rank !== -1 && floor !== -1 && rank <= floor;
};

export type ReceiptFinding = SwarmReceipt["findings"][number];

export type ReceiptCandidate = {
  id: string;
  file: string;
  line: number;
  mechanism: string;
  affectedBehavior: string;
  severity: string;
  reportedBy: string[];
};

export type ReceiptLane = {
  laneId: string;
  role: string;
  status: string;
  model: string | null;
  usage: Record<string, number | null> | null;
  installSkipped: boolean | null;
  installSkippedReason: string | null;
};

export type SwarmRunReceipt = {
  swarmId: string;
  status: string;
  requested: { head: string; base: string; pullRequest: number | null };
  findings: ReceiptFinding[];
  outcome: string | null;
  abortReason: string | null;
  /** Absent rather than null: the publisher's reader declares `wallSeconds?: number`. */
  wallSeconds?: number;
  installSkipped: boolean | null;
  installSkippedReason: string | null;
  lanes: ReceiptLane[];
  candidates: ReceiptCandidate[];
};

const record = (value: unknown, where: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const array = (value: unknown, where: string) => {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value as readonly unknown[];
};

const string = (value: unknown, where: string) => {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  return value;
};

const optionalString = (value: unknown, where: string) => {
  if (value === undefined || value === null) return null;
  return string(value, where);
};

const number = (value: unknown, where: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where}: expected a number`);
  }
  return value;
};

const optionalNumber = (value: unknown, where: string) => {
  if (value === undefined || value === null) return null;
  return number(value, where);
};

const optionalBoolean = (value: unknown, where: string) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new Error(`${where}: expected a boolean`);
  }
  return value;
};

/** Numeric fields, keeping the null a lane recorded for a count nobody observed. */
const numberRecord = (value: unknown, where: string) => {
  if (value === undefined || value === null) return null;
  const source = record(value, where);
  const totals: Record<string, number | null> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== "number" && entry !== null) {
      throw new Error(`${where}.${key}: expected a number or null`);
    }
    totals[key] = entry;
  }
  return totals;
};

const DIFF_RELATIONS = ["added", "touched", "untouched"] as const;

const optionalDiffRelation = (value: unknown, where: string) => {
  const relation = optionalString(value, where);
  if (relation === null) return null;
  const known = DIFF_RELATIONS.find((entry) => entry === relation);
  if (!known) throw new Error(`${where}: unknown diff relation`);
  return known;
};

const findingFrom = (value: unknown, where: string): ReceiptFinding => {
  const entry = record(value, where);
  return {
    id: string(entry["id"], `${where}.id`),
    severity: string(entry["severity"], `${where}.severity`),
    file: string(entry["file"], `${where}.file`),
    line: number(entry["line"], `${where}.line`),
    mechanism: string(entry["mechanism"], `${where}.mechanism`),
    evidence: string(entry["evidence"] ?? "", `${where}.evidence`),
    affectedBehavior: string(
      entry["affectedBehavior"] ?? "",
      `${where}.affectedBehavior`,
    ),
    status: string(entry["status"], `${where}.status`),
    evidenceStrength: string(
      entry["evidenceStrength"] ?? "",
      `${where}.evidenceStrength`,
    ),
    reportedBy: array(entry["reportedBy"] ?? [], `${where}.reportedBy`).map(
      (lane, index) => string(lane, `${where}.reportedBy[${index}]`),
    ),
    verifierReason: optionalString(
      entry["verifierReason"],
      `${where}.verifierReason`,
    ),
    verifierCommand: optionalString(
      entry["verifierCommand"],
      `${where}.verifierCommand`,
    ),
    verifierExitStatus: optionalNumber(
      entry["verifierExitStatus"],
      `${where}.verifierExitStatus`,
    ),
    diffRelation: optionalDiffRelation(
      entry["diffRelation"],
      `${where}.diffRelation`,
    ),
    declaredIntent: optionalString(
      entry["declaredIntent"],
      `${where}.declaredIntent`,
    ),
  };
};

const candidateFrom = (value: unknown, where: string): ReceiptCandidate => {
  const entry = record(value, where);
  return {
    id: string(entry["id"], `${where}.id`),
    file: string(entry["file"], `${where}.file`),
    line: number(entry["line"], `${where}.line`),
    mechanism: string(entry["mechanism"], `${where}.mechanism`),
    affectedBehavior: string(
      entry["affectedBehavior"] ?? "",
      `${where}.affectedBehavior`,
    ),
    severity: string(entry["severity"], `${where}.severity`),
    reportedBy: array(entry["reportedBy"] ?? [], `${where}.reportedBy`).map(
      (lane, index) => string(lane, `${where}.reportedBy[${index}]`),
    ),
  };
};

const laneFrom = (value: unknown, where: string): ReceiptLane => {
  const entry = record(value, where);
  return {
    laneId: string(entry["laneId"], `${where}.laneId`),
    role: string(entry["role"], `${where}.role`),
    status: string(entry["status"], `${where}.status`),
    model: optionalString(entry["model"], `${where}.model`),
    usage: numberRecord(entry["usage"], `${where}.usage`),
    installSkipped: optionalBoolean(
      entry["installSkipped"],
      `${where}.installSkipped`,
    ),
    installSkippedReason: optionalString(
      entry["installSkippedReason"],
      `${where}.installSkippedReason`,
    ),
  };
};

/** Validates a swarm receipt at the process boundary; every reader follows it. */
export function parseSwarmReceipt(raw: unknown): SwarmRunReceipt {
  const receipt = record(raw, "swarm-receipt.json");
  const requested = record(receipt["requested"], "requested");
  const wallSeconds = optionalNumber(receipt["wallSeconds"], "wallSeconds");
  return {
    swarmId: string(receipt["swarmId"], "swarmId"),
    status: string(receipt["status"], "status"),
    requested: {
      head: string(requested["head"], "requested.head"),
      base: string(requested["base"], "requested.base"),
      pullRequest: optionalNumber(
        requested["pullRequest"],
        "requested.pullRequest",
      ),
    },
    findings: array(receipt["findings"], "findings").map((finding, index) =>
      findingFrom(finding, `findings[${index}]`),
    ),
    outcome: optionalString(receipt["outcome"], "outcome"),
    abortReason: optionalString(receipt["abortReason"], "abortReason"),
    ...(wallSeconds === null ? {} : { wallSeconds }),
    installSkipped: optionalBoolean(
      receipt["installSkipped"],
      "installSkipped",
    ),
    installSkippedReason: optionalString(
      receipt["installSkippedReason"],
      "installSkippedReason",
    ),
    lanes: array(receipt["lanes"] ?? [], "lanes").map((lane, index) =>
      laneFrom(lane, `lanes[${index}]`),
    ),
    candidates: array(receipt["candidates"], "candidates").map(
      (candidate, index) => candidateFrom(candidate, `candidates[${index}]`),
    ),
  };
}

/**
 * The findings a review would post: confirmed, publishable, at or above the
 * floor. Anchoring is a GitHub placement question, not a publication one, so a
 * finding the diff cannot hold inline is still carried here.
 */
export const publishedFindings = (
  findings: readonly ReceiptFinding[],
  minSeverity = MIN_SEVERITY,
) =>
  findings.filter(
    (finding) =>
      finding.status === "confirmed" &&
      publicationDisposition(finding) === "publishable" &&
      severityAtLeast(finding.severity, minSeverity),
  );

/**
 * Sums every lane's usage, the verifier's included: it is a lane too. A count
 * one lane recorded as unobserved leaves that total unobserved.
 */
export const sumUsage = (lanes: readonly ReceiptLane[]) => {
  const totals: Record<string, number | null> = {};
  let observed = false;
  for (const lane of lanes) {
    if (!lane.usage) continue;
    for (const [key, value] of Object.entries(lane.usage)) {
      const sum = totals[key];
      totals[key] = sum === null || value === null ? null : (sum ?? 0) + value;
      observed = true;
    }
  }
  return observed ? totals : null;
};

/**
 * What the receipt says about a skipped install.
 *
 * The field is new to the runner, so an older receipt that never carried it
 * records `null`, never `false`: a run nobody measured must not read as one
 * whose install happened.
 */
export const installSkipEvidence = (receipt: SwarmRunReceipt) => {
  const skipped = [
    receipt.installSkipped,
    ...receipt.lanes.map((lane) => lane.installSkipped),
  ].filter((value): value is boolean => typeof value === "boolean");
  if (skipped.length === 0) return { skipped: null, reason: null };
  const reasons = [
    receipt.installSkippedReason,
    ...receipt.lanes.map((lane) => lane.installSkippedReason),
  ].filter((value): value is string => value !== null && value !== "");
  return { skipped: skipped.includes(true), reason: reasons[0] ?? null };
};

export type AacrResultComment = {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
};

export type AacrResultFile = {
  instance_id: string;
  repo: string;
  base_commit: string;
  head_commit: string;
  reviewer: "swarm-review";
  started_at: string;
  duration_seconds?: number;
  review: {
    comments: AacrResultComment[];
    summary: Record<string, number>;
  };
};

/** `instance_id.replace("/", "__") + ".json"`, the benchmark's own naming. */
export const safeResultId = (instanceId: string) =>
  instanceId.replace(/\//g, "__");

export const commentFrom = (entry: {
  file: string;
  line: number;
  mechanism: string;
  affectedBehavior: string;
}): AacrResultComment => ({
  path: entry.file,
  content: [entry.mechanism, entry.affectedBehavior]
    .filter((part) => part !== "")
    .join("\n\n"),
  start_line: entry.line,
  end_line: entry.line,
});

/**
 * A token total, or nothing when the usage never observed it: a sum its own
 * counts say is short is left out rather than published as whole.
 */
const tokenTotal = (
  usage: Readonly<Record<string, number | null>> | null,
  keys: readonly string[],
  side: "input" | "output",
) => {
  if (!usage || sumIsShort(usage, side)) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number") return value;
  }
  return undefined;
};

const usageSummary = (
  usage: Readonly<Record<string, number | null>> | null,
) => {
  const summary: Record<string, number> = {};
  const input = tokenTotal(
    usage,
    ["input_tokens", "inputTokens", "input"],
    "input",
  );
  const output = tokenTotal(
    usage,
    ["output_tokens", "outputTokens", "output"],
    "output",
  );
  if (input !== undefined) summary["input_tokens"] = input;
  if (output !== undefined) summary["output_tokens"] = output;
  return summary;
};

export const buildResultFile = (input: {
  entry: AacrCase;
  startedAt: string;
  wallSeconds: number | null;
  usage: Readonly<Record<string, number | null>> | null;
  comments: AacrResultComment[];
}): AacrResultFile => ({
  instance_id: input.entry.instanceId,
  repo: input.entry.repo,
  base_commit: input.entry.baseCommit,
  head_commit: input.entry.headCommit,
  reviewer: "swarm-review",
  started_at: input.startedAt,
  ...(input.wallSeconds === null
    ? {}
    : { duration_seconds: input.wallSeconds }),
  review: {
    comments: input.comments,
    summary: usageSummary(input.usage),
  },
});

export type CaseStatus = "completed" | "partial" | "failed";

export type AacrCaseSidecar = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  headCommit: string;
  runId: string;
  swarmId: string;
  status: CaseStatus;
  reason: string | null;
  outcome: string | null;
  wallSeconds: number | null;
  usage: Record<string, number | null> | null;
  installSkipped: boolean | null;
  installSkipReason: string | null;
  candidates: number;
  confirmed: number;
  flaky: boolean;
  previousFailure: {
    runId: string;
    status: string;
    reason: string | null;
  } | null;
  startedAt: string;
  finishedAt: string;
};

/** Reads what a previous invocation recorded for this case, if anything. */
export const readCaseSidecar = (raw: string) => {
  const sidecar = record(JSON.parse(raw), "case sidecar");
  return {
    runId: string(sidecar["runId"], "runId"),
    status: string(sidecar["status"], "status"),
    reason: optionalString(sidecar["reason"], "reason"),
  };
};
