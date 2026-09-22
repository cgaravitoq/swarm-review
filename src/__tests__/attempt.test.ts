import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openAttempt,
  piSessionId,
  planTrialReservation,
  preparationFailureReceipt,
  reserveWholeTrial,
  sessionLedger,
  writeAtomic,
} from "../attempt";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const suite = async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-pi-attempt-"));
  temporaryDirectories.push(directory);
  return directory;
};

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

describe("top-level attempt identity", () => {
  it("persists the identity and the requested revisions before anything else runs", async () => {
    const suiteDir = await suite();
    const attempt = await openAttempt(suiteDir, {
      swarmId: "swarm-x",
      head: "aaa",
      base: "bbb",
    });

    const written = (await readJson(attempt.path)) as Record<string, unknown>;

    expect(attempt.path).toBe(join(suiteDir, "attempt.json"));
    expect(written["attemptId"]).toBe(attempt.attemptId);
    expect(written["requested"]).toEqual({
      swarmId: "swarm-x",
      head: "aaa",
      base: "bbb",
    });
    expect(typeof written["startedAt"]).toBe("string");
  });

  it("gives two attempts of the same swarm different identities", async () => {
    const first = await openAttempt(await suite(), {});
    const second = await openAttempt(await suite(), {});

    expect(first.attemptId).not.toBe(second.attemptId);
  });
});

describe("nested pi session identities", () => {
  it("links every session to the attempt and records a second start as a retry", async () => {
    const suiteDir = await suite();
    const sessions = sessionLedger("attempt-1", suiteDir);

    const first = await sessions.start({
      laneId: "reviewer-1",
      role: "reviewer",
      runId: "s-reviewer-1",
      provider: "openai-codex",
      model: "gpt-5",
    });
    await sessions.finish(first.sessionId, { status: "failed" });
    const retry = await sessions.start({
      laneId: "reviewer-1",
      role: "reviewer",
      runId: "s-reviewer-1",
    });

    const persisted = (await readJson(sessions.path)) as Record<
      string,
      unknown
    >[];

    expect(first.sessionId).toBe(piSessionId("attempt-1", "reviewer-1", 1));
    expect(retry.sessionId).toBe(piSessionId("attempt-1", "reviewer-1", 2));
    // The failed session is kept, not replaced: a retry adds a row.
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.["status"]).toBe("failed");
    expect(persisted[0]?.["retryOf"]).toBeNull();
    expect(persisted[1]?.["retryOf"]).toBe(first.sessionId);
    expect(persisted[1]?.["attemptId"]).toBe("attempt-1");
    expect(sessions.forLane("reviewer-1")).toHaveLength(2);
  });

  it("refuses to finish a session it never started", async () => {
    const sessions = sessionLedger("attempt-1", await suite());

    await expect(sessions.finish("nope", {})).rejects.toThrow(
      /unknown pi session/,
    );
  });
});

describe("whole-trial budget reservation", () => {
  it("names every session the trial may open, including each permitted retry", () => {
    expect(
      planTrialReservation({
        attemptId: "a1",
        reviewerLanes: 2,
        retriesPerLane: 1,
      }).map((session) => [session.sessionId, session.isRetry]),
    ).toEqual([
      ["a1/reviewer-1#1", false],
      ["a1/reviewer-1#2", true],
      ["a1/reviewer-2#1", false],
      ["a1/reviewer-2#2", true],
      ["a1/verifier#1", false],
      ["a1/verifier#2", true],
    ]);
  });

  it("reports an unpriced trial rather than a free one when no rates were given", async () => {
    const reservation = await reserveWholeTrial(
      {
        trialId: "a1",
        provider: null,
        trialKind: "t1b",
        sessions: planTrialReservation({ attemptId: "a1", reviewerLanes: 2 }),
        ratesPath: null,
        remainingSubCapUsd: null,
      },
      null,
    );

    expect(reservation.status).toBe("unavailable");
    expect(reservation).not.toHaveProperty("reservation");
    expect(reservation.reason).toMatch(/no --rates/);
  });

  it("sends the authority every session id at once and keeps its hold", async () => {
    const directory = await suite();
    const script = join(directory, "broker.ts");
    const seen = join(directory, "seen.json");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";
const [subcommand, payload] = process.argv.slice(2);
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ subcommand, request: JSON.parse(payload) }));
process.stdout.write(JSON.stringify({ admitted: true, reservation: { worstCaseUsd: 4.2 } }));
`,
    );

    const reservation = await reserveWholeTrial(
      {
        trialId: "a1",
        provider: "openai-codex",
        trialKind: "t1a",
        sessions: planTrialReservation({ attemptId: "a1", reviewerLanes: 2 }),
        ratesPath: "/rates.json",
        remainingSubCapUsd: 5,
      },
      { script, rates: { billing: "paid", inputUsdPerMillionTokens: 1 } },
    );
    const call = JSON.parse(await readFile(seen, "utf8")) as {
      subcommand: string;
      request: Record<string, unknown>;
    };

    expect(call.subcommand).toBe("reserve");
    // Every nested session is priced before the first one opens.
    expect(call.request["sessions"]).toEqual([
      { sessionId: "a1/reviewer-1#1" },
      { sessionId: "a1/reviewer-2#1" },
      { sessionId: "a1/verifier#1" },
    ]);
    expect(call.request["rates"]).toEqual({
      billing: "paid",
      inputUsdPerMillionTokens: 1,
    });
    expect(call.request["remainingSubCapUsd"]).toBe(5);
    expect(call.request["trialKind"]).toBe("t1a");
    expect(reservation).toMatchObject({
      status: "reserved",
      reservation: { worstCaseUsd: 4.2 },
    });
  });

  it("refuses the trial when the authority does not admit it", async () => {
    const directory = await suite();
    const script = join(directory, "broker.ts");
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ admitted: false, reason: "rates are unknown" }));\n`,
    );

    const reservation = await reserveWholeTrial(
      {
        trialId: "a1",
        provider: null,
        trialKind: "t1b",
        sessions: planTrialReservation({ attemptId: "a1", reviewerLanes: 1 }),
        ratesPath: "/rates.json",
        remainingSubCapUsd: null,
      },
      { script, rates: { billing: "unknown" } },
    );

    expect(reservation).toEqual({
      status: "denied",
      reason: "rates are unknown",
    });
  });

  it("treats an authority it cannot reach as a refusal, never as a pass", async () => {
    const reservation = await reserveWholeTrial(
      {
        trialId: "a1",
        provider: null,
        trialKind: "t1b",
        sessions: planTrialReservation({ attemptId: "a1", reviewerLanes: 1 }),
        ratesPath: "/rates.json",
        remainingSubCapUsd: null,
      },
      { script: join(await suite(), "absent.ts"), rates: {} },
    );

    expect(reservation.status).toBe("denied");
  });
});

describe("preparation failure receipt", () => {
  it("keeps the attempt countable when it died before any lane existed", async () => {
    const suiteDir = await suite();
    const attempt = await openAttempt(suiteDir, { swarmId: "swarm-x" });

    const receipt = preparationFailureReceipt(
      attempt,
      "object-fetch",
      new Error("host clone is missing the head"),
      { swarmId: "swarm-x" },
    );

    expect(receipt.attemptId).toBe(attempt.attemptId);
    expect(receipt.status).toBe("failed");
    expect(receipt.outcome).toBe("preparation-failed");
    expect(receipt.failure).toEqual({
      stage: "object-fetch",
      message: "host clone is missing the head",
    });
    expect(receipt.lanes).toEqual([]);
    expect(receipt.findings).toEqual([]);
  });
});

describe("writeAtomic", () => {
  it("never lets a reader observe a partial file", async () => {
    const directory = await suite();
    const path = join(directory, "receipt.json");
    const body = JSON.stringify(
      { runId: "run-1", probe: "x".repeat(8 * 1024 * 1024) },
      null,
      2,
    );
    const state = { writing: true, absent: false, torn: false };
    const readers = Array.from({ length: 4 }, () =>
      (async () => {
        while (state.writing) {
          const raw = await readFile(path, "utf8").catch(() => null);
          if (raw === null) state.absent = true;
          else if (raw !== body) state.torn = true;
        }
      })(),
    );
    try {
      await writeAtomic(path, body);
    } finally {
      state.writing = false;
    }
    await Promise.all(readers);

    // Correct final bytes prove nothing on their own: what makes this atomic
    // is that every read during the write saw absence, never a prefix.
    expect(state.absent).toBe(true);
    expect(state.torn).toBe(false);
    expect(await readFile(path, "utf8")).toBe(body);
  });
});
