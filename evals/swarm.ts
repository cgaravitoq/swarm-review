/**
 * T1b transport: the real swarm command, driven and then proven.
 *
 * T1b measures reviewer-to-verifier recall, which only exists if reviewer
 * lanes, candidate assembly and the verifier all actually ran. A harness that
 * called the pieces itself, or one that accepted a receipt describing a run
 * that never happened, would measure its own plumbing, so this executes
 * `swarm.ts` as a subprocess and then reads its terminal receipt back through
 * a check that rejects a trace missing any of those stages.
 *
 * A swarm that assembled no candidates never asked the verifier anything. That
 * is recorded as `not_run`, never as a verifier that found nothing wrong.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SWARM_IMAGE } from "../src/swarm";

export const swarmScriptPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "swarm.ts");

export type T1bConfiguration = {
  /** Preregistered configuration name, e.g. S2, S3, W2, W3. */
  name: string;
  reviewerLanes: number;
  provider?: string;
  model?: string;
  thinking?: string;
  image?: string;
  checkCommand?: string;
  totalTimeoutSeconds: number;
  verifierReserveSeconds: number;
};

export const swarmArguments = (
  configuration: T1bConfiguration,
  trial: {
    swarmId: string;
    outDir: string;
    head: string;
    base: string;
    attemptId: string;
    trialKind?: "t1a" | "t1b";
  },
) => [
  "--swarm-id",
  trial.swarmId,
  "--out",
  trial.outDir,
  "--head",
  trial.head,
  "--base",
  trial.base,
  "--attempt-id",
  trial.attemptId,
  "--trial-kind",
  trial.trialKind ?? "t1b",
  "--sandbox",
  "--image",
  configuration.image ?? DEFAULT_SWARM_IMAGE,
  "--reviewers",
  String(configuration.reviewerLanes),
  "--total-timeout",
  String(configuration.totalTimeoutSeconds),
  "--verifier-reserve",
  String(configuration.verifierReserveSeconds),
  ...(configuration.provider ? ["--provider", configuration.provider] : []),
  ...(configuration.model ? ["--model", configuration.model] : []),
  ...(configuration.thinking ? ["--thinking", configuration.thinking] : []),
  ...(configuration.checkCommand
    ? ["--check", configuration.checkCommand]
    : []),
];

const array = (value: unknown, where: string) => {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value as readonly unknown[];
};

const record = (value: unknown, where: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

/**
 * Rejects any receipt that does not prove a whole swarm ran.
 *
 * The stages checked are the ones T1b's numbers depend on: the reviewer lanes
 * that produce candidates, the assembled candidate list, and the verifier lane
 * that rules on them. Their absence is a broken transport, not a clean review.
 */
export function assertRealSwarmTrace(
  raw: unknown,
  expected: {
    swarmId: string;
    head: string;
    base: string;
    reviewerLanes: number;
  },
) {
  const receipt = record(raw, "swarm-receipt.json");
  if (receipt["swarmId"] !== expected.swarmId) {
    throw new Error(`swarm receipt is for ${String(receipt["swarmId"])}`);
  }
  const requested = record(receipt["requested"], "requested");
  if (
    requested["head"] !== expected.head ||
    requested["base"] !== expected.base
  ) {
    throw new Error("swarm receipt replayed a different checkout");
  }
  const lanes = array(receipt["lanes"], "lanes").map((lane, index) =>
    record(lane, `lanes[${index}]`),
  );
  const reviewers = lanes.filter((lane) => lane["role"] === "reviewer");
  if (reviewers.length !== expected.reviewerLanes) {
    throw new Error(
      `swarm ran ${reviewers.length} reviewer lanes, not ${expected.reviewerLanes}`,
    );
  }
  if (reviewers.every((lane) => lane["artifactDir"] === null)) {
    throw new Error("no reviewer lane produced a container run");
  }
  const verifier = lanes.find((lane) => lane["role"] === "verifier");
  if (!verifier) throw new Error("swarm receipt has no verifier lane");
  const candidates = array(receipt["candidates"], "candidates");
  const verifierRan = verifier["artifactDir"] !== null;
  if (candidates.length > 0 && !verifierRan) {
    throw new Error("candidates were assembled but the verifier never ran");
  }
  array(receipt["findings"], "findings");
  const status = receipt["status"];
  if (typeof status !== "string")
    throw new Error("swarm receipt has no status");
  return {
    status,
    abortReason: receipt["abortReason"] ?? null,
    reviewerLanes: reviewers.length,
    candidateCount: candidates.length,
    verifierStatus: verifierRan ? String(verifier["status"]) : "not_run",
    findings: array(receipt["findings"], "findings").map((finding, index) => {
      const entry = record(finding, `findings[${index}]`);
      return {
        id: String(entry["id"]),
        status: String(entry["status"]),
        severity: String(entry["severity"]),
        file: String(entry["file"]),
        line: Number(entry["line"]),
        mechanism: String(entry["mechanism"]),
        reportedBy: array(entry["reportedBy"] ?? [], "reportedBy").map(String),
      };
    }),
    lanes: lanes.map((lane) => ({
      laneId: String(lane["laneId"]),
      role: String(lane["role"]),
      status: String(lane["status"]),
      provider: lane["provider"] === null ? null : String(lane["provider"]),
      model: lane["model"] === null ? null : String(lane["model"]),
      usage: lane["usage"] ?? null,
      wallSeconds:
        typeof lane["wallSeconds"] === "number" ? lane["wallSeconds"] : null,
      ran: lane["artifactDir"] !== null,
    })),
    wallSeconds:
      typeof receipt["wallSeconds"] === "number"
        ? receipt["wallSeconds"]
        : null,
    billing: receipt["billing"] ?? "unknown",
    quota: receipt["quota"] ?? "unknown",
  };
}

export type SwarmTrace = ReturnType<typeof assertRealSwarmTrace>;

const spawnSwarm = (args: readonly string[]) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, [swarmScriptPath(), ...args], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

/**
 * Runs one T1b top-level swarm trial.
 *
 * The attempt identity exists before the swarm is spawned, so a trial whose
 * receipt never arrives is still a scheduled trial with a terminal outcome
 * rather than a gap in the denominator.
 */
export async function runT1bTrial(
  trial: {
    caseId: string;
    swarmId: string;
    outDir: string;
    head: string;
    base: string;
  },
  configuration: T1bConfiguration,
  deps: {
    run?: (args: readonly string[]) => Promise<number>;
    readReceipt?: (path: string) => Promise<string>;
  } = {},
) {
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const run = deps.run ?? spawnSwarm;
  const read = deps.readReceipt ?? ((path: string) => readFile(path, "utf8"));
  const receiptPath = join(trial.outDir, trial.swarmId, "swarm-receipt.json");
  const exitCode = await run(
    swarmArguments(configuration, { ...trial, attemptId, trialKind: "t1b" }),
  );
  const row = {
    attemptId,
    caseId: trial.caseId,
    swarmId: trial.swarmId,
    configuration: configuration.name,
    reviewerLanes: configuration.reviewerLanes,
    head: trial.head,
    base: trial.base,
    transport: "real-swarm" as const,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    outcome: "failed" as "completed" | "partial" | "failed",
    trace: null as SwarmTrace | null,
    error: null as string | null,
    receiptPath,
  };
  try {
    const trace = assertRealSwarmTrace(JSON.parse(await read(receiptPath)), {
      swarmId: trial.swarmId,
      head: trial.head,
      base: trial.base,
      reviewerLanes: configuration.reviewerLanes,
    });
    row.trace = trace;
    row.outcome =
      trace.status === "completed"
        ? "completed"
        : trace.status === "partial"
          ? "partial"
          : "failed";
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  }
  row.finishedAt = new Date().toISOString();
  return row;
}

export type T1bTrial = Awaited<ReturnType<typeof runT1bTrial>>;
