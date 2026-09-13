/**
 * Durable identity and terminal accounting for one top-level swarm attempt.
 *
 * The swarm receipt is written at the very end, so until now everything that
 * failed before it - a revision that would not resolve, a host clone missing
 * the head, an empty diff, an Orca that was not there - left no record at all.
 * A trial that vanishes is a trial that silently leaves the denominator, which
 * is exactly how a measured recall becomes an overestimate.
 *
 * So the identity is allocated and persisted here before any revision
 * resolution, preparation, admission or model call, every nested Pi session is
 * named after it, and every top-level exit writes one terminal receipt against
 * that same id.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where an attempt died, when it died before producing lane rows. */
export const PREPARATION_STAGES = [
  "orca-admission",
  "budget-reservation",
  "revision-resolution",
  "object-fetch",
  "changed-files",
  "lane-preparation",
  "receipt",
] as const;

export type PreparationStage = (typeof PREPARATION_STAGES)[number];

const writeAtomic = async (path: string, body: string) => {
  await writeFile(`${path}.partial`, body);
  await rename(`${path}.partial`, path);
};

/**
 * Allocates and persists the top-level identity.
 *
 * It lands on disk before the caller does anything else, so a coordinator that
 * is killed one line later still leaves an attempt whose id, inputs and start
 * time can be read back and counted.
 */
export async function openAttempt(
  suiteDir: string,
  requested: Record<string, unknown>,
  presetId?: string,
) {
  const attemptId = presetId ?? randomUUID();
  const startedAt = Date.now();
  const path = join(suiteDir, "attempt.json");
  await writeAtomic(
    path,
    JSON.stringify(
      {
        attemptId,
        startedAt: new Date(startedAt).toISOString(),
        requested,
      },
      null,
      2,
    ),
  );
  return { attemptId, startedAt, path };
}

export type Attempt = Awaited<ReturnType<typeof openAttempt>>;

/**
 * The identity of one nested Pi session under this attempt.
 *
 * The run id alone is reused by a retry of the same lane, so the session that
 * produced a given transcript would be ambiguous. The attempt, the lane and
 * the attempt number together are not.
 */
export const piSessionId = (
  attemptId: string,
  laneId: string,
  attemptNumber: number,
) => `${attemptId}/${laneId}#${attemptNumber}`;

/**
 * Every nested Pi session this attempt started, in order.
 *
 * A second start for a lane is a retry and is recorded as one, with its own
 * session id and its own row; it never replaces the first. Starting the same
 * session id twice is refused outright, which is what makes "no hidden
 * restarts" a property of the code rather than a claim about it.
 */
export function sessionLedger(attemptId: string, suiteDir: string) {
  const sessions: Record<string, unknown>[] = [];
  const path = join(suiteDir, "pi-sessions.json");
  let queue: Promise<void> = Promise.resolve();
  const flush = () => {
    queue = queue.then(() =>
      writeAtomic(path, JSON.stringify(sessions, null, 2)),
    );
    return queue;
  };
  return {
    path,
    sessions,
    /** Claims the next session for a lane and returns its linked identity. */
    start: async (lane: {
      laneId: string;
      role: string;
      runId: string;
      provider?: string | undefined;
      model?: string | undefined;
    }) => {
      const previous = sessions.filter(
        (entry) => entry["laneId"] === lane.laneId,
      );
      const attemptNumber = previous.length + 1;
      const sessionId = piSessionId(attemptId, lane.laneId, attemptNumber);
      if (sessions.some((entry) => entry["sessionId"] === sessionId)) {
        throw new Error(`pi session ${sessionId} was already started`);
      }
      sessions.push({
        sessionId,
        attemptId,
        laneId: lane.laneId,
        role: lane.role,
        runId: lane.runId,
        attemptNumber,
        retryOf: previous.at(-1)?.["sessionId"] ?? null,
        provider: lane.provider ?? null,
        model: lane.model ?? null,
        startedAt: new Date().toISOString(),
      });
      await flush();
      return { sessionId, attemptNumber };
    },
    finish: async (sessionId: string, outcome: Record<string, unknown>) => {
      const entry = sessions.find((row) => row["sessionId"] === sessionId);
      if (!entry) throw new Error(`unknown pi session ${sessionId}`);
      Object.assign(entry, {
        ...outcome,
        finishedAt: new Date().toISOString(),
      });
      await flush();
    },
    forLane: (laneId: string) =>
      sessions.filter((entry) => entry["laneId"] === laneId),
  };
}

/**
 * Every nested Pi session this trial is allowed to open, named in advance.
 *
 * The reservation is the whole trial's, not one session's: a swarm that starts
 * with room for two reviewers and discovers at the verifier that it cannot pay
 * has already spent the reviewers' money. So the session identities are the
 * same ones the lanes will claim, and the retry each lane is permitted is
 * priced here rather than discovered later.
 */
export const planTrialReservation = (plan: {
  attemptId: string;
  reviewerLanes: number;
  retriesPerLane?: number;
}) => {
  const lanes = [
    ...Array.from({ length: plan.reviewerLanes }, (_, index) => ({
      laneId: `reviewer-${index + 1}`,
      role: "reviewer" as const,
    })),
    { laneId: "verifier", role: "verifier" as const },
  ];
  return lanes.flatMap((lane) =>
    Array.from({ length: 1 + (plan.retriesPerLane ?? 0) }, (_, attempt) => ({
      sessionId: piSessionId(plan.attemptId, lane.laneId, attempt + 1),
      laneId: lane.laneId,
      role: lane.role,
      isRetry: attempt > 0,
    })),
  );
};

export type TrialReservationSessions = ReturnType<typeof planTrialReservation>;

/** One `bun run provider-budget.ts reserve '<json>'` call, or an explanation. */
const runBroker = (
  script: string,
  subcommand: string,
  request: unknown,
  timeoutMs = 60_000,
) =>
  new Promise<{ stdout: string | null; error: string | null }>(
    (resolvePromise) => {
      const child = spawn(
        process.execPath,
        [script, subcommand, JSON.stringify(request)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise({
          stdout: null,
          error: `provider budget ${subcommand} exceeded ${timeoutMs}ms`,
        });
      }, timeoutMs);
      deadline.unref();
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        resolvePromise({ stdout: null, error: error.message });
      });
      child.once("exit", (code) => {
        clearTimeout(deadline);
        resolvePromise(
          code === 0
            ? { stdout, error: null }
            : {
                stdout: null,
                error: `provider budget ${subcommand} exited ${code}: ${stderr
                  .trim()
                  .slice(0, 400)}`,
              },
        );
      });
    },
  );

/**
 * Holds the whole trial's worst case before its first nested session opens.
 *
 * The authority that can price a request lives with the credentials, not with
 * the coordinator, so it is reached as its own process and its answer is taken
 * verbatim. Three outcomes, and only one of them may start lanes:
 *
 * - `unavailable`: no rates were supplied, so nothing was priced. Billing
 *   stays `unknown`, never zero, and an unknown price can never clear a
 *   ceiling later.
 * - `denied`: the authority refused. No lane starts.
 * - `reserved`: the hold exists, and it is kept separate from actual usage for
 *   the life of the receipt.
 */
export async function reserveWholeTrial(
  request: {
    trialId: string;
    provider: string | null;
    trialKind: string;
    sessions: TrialReservationSessions;
    ratesPath: string | null;
    remainingSubCapUsd: number | null;
  },
  broker: { script: string; rates: unknown } | null,
) {
  if (!broker) {
    return {
      status: "unavailable" as const,
      reason:
        request.ratesPath === null
          ? "no --rates was supplied, so no provider request was priced"
          : "no provider-budget authority was reachable",
      request: { ...request, sessions: request.sessions.length },
    };
  }
  const wire = {
    trialId: request.trialId,
    provider: request.provider,
    trialKind: request.trialKind,
    sessions: request.sessions.map(({ sessionId }) => ({ sessionId })),
    rates: broker.rates,
    remainingSubCapUsd: request.remainingSubCapUsd,
  };
  const { stdout, error } = await runBroker(broker.script, "reserve", wire);
  if (error !== null || stdout === null) {
    return { status: "denied" as const, reason: error ?? "no answer" };
  }
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return {
      status: "denied" as const,
      reason: `provider budget returned non-JSON: ${stdout.slice(0, 200)}`,
    };
  }
  const envelope = (answer ?? {}) as Record<string, unknown>;
  if (envelope["admitted"] !== true) {
    return {
      status: "denied" as const,
      reason:
        typeof envelope["reason"] === "string"
          ? envelope["reason"]
          : "the provider budget refused without a reason",
    };
  }
  return {
    status: "reserved" as const,
    sessions: request.sessions.length,
    reservation: envelope["reservation"] ?? null,
  };
}

export const writeTerminalReceipt = async (
  suiteDir: string,
  receipt: Record<string, unknown>,
) => {
  const path = join(suiteDir, "swarm-receipt.json");
  await writeAtomic(path, JSON.stringify(receipt, null, 2));
  return path;
};

/**
 * The terminal receipt of an attempt that never reached its lanes.
 *
 * It carries the same identity, the same requested revisions and the same
 * shape as a full one so a failed preparation is still one countable trial
 * rather than a hole in the record.
 */
export const preparationFailureReceipt = (
  attempt: Attempt,
  stage: PreparationStage,
  error: unknown,
  fields: Record<string, unknown>,
) => ({
  attemptId: attempt.attemptId,
  status: "failed" as const,
  outcome: "preparation-failed" as const,
  failure: {
    stage,
    message: error instanceof Error ? error.message : String(error),
  },
  lanes: [],
  candidates: [],
  findings: [],
  duplicates: [],
  piSessions: [],
  startedAt: new Date(attempt.startedAt).toISOString(),
  finishedAt: new Date().toISOString(),
  wallSeconds: Math.round((Date.now() - attempt.startedAt) / 1000),
  ...fields,
});
