import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSwarmOptions } from "../../src/swarm";
import {
  assertRealSwarmTrace,
  runT1bTrial,
  swarmArguments,
  swarmScriptPath,
  type T1bConfiguration,
} from "../swarm";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-pi-t1b-"));
  temporary.push(dir);
  return dir;
};

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);

const S3: T1bConfiguration = {
  name: "S3",
  reviewerLanes: 3,
  provider: "pi-subscription",
  model: "deepseek-v4-flash",
  thinking: "high",
  totalTimeoutSeconds: 1800,
  verifierReserveSeconds: 400,
};

const laneRow = (laneId: string, role: string, ran: boolean) => ({
  laneId,
  role,
  runId: `swarm-1-${laneId}`,
  status: ran ? "completed" : "failed",
  artifactDir: ran ? `/out/swarm-1/${laneId}` : null,
  provider: "pi-subscription",
  model: "deepseek-v4-flash",
  usage: { inputTokens: 900 },
  wallSeconds: 120,
});

const receipt = (overrides: Record<string, unknown> = {}) => ({
  swarmId: "swarm-1",
  status: "completed",
  abortReason: null,
  requested: { head: HEAD, base: BASE, pullRequest: null },
  wallSeconds: 900,
  billing: "unknown",
  quota: "unknown",
  lanes: [
    laneRow("reviewer-1", "reviewer", true),
    laneRow("reviewer-2", "reviewer", true),
    laneRow("reviewer-3", "reviewer", true),
    laneRow("verifier", "verifier", true),
  ],
  candidates: [{ id: "c1" }],
  findings: [
    {
      id: "c1",
      status: "confirmed",
      severity: "P1",
      file: "src/a.ts",
      line: 12,
      mechanism: "off-by-one",
      reportedBy: ["reviewer-1"],
    },
  ],
  ...overrides,
});

describe("swarmArguments", () => {
  it("is accepted by the production swarm parser", () => {
    const args = swarmArguments(S3, {
      swarmId: "swarm-1",
      outDir: "/out",
      head: HEAD,
      base: BASE,
      attemptId: "attempt-1",
    });
    const parsed = parseSwarmOptions(args);

    expect(parsed.swarmId).toBe("swarm-1");
    expect(parsed.reviewerLanes).toBe(3);
    expect(parsed.head).toBe(HEAD);
    expect(parsed.base).toBe(BASE);
    expect(parsed.totalTimeoutSeconds).toBe(1800);
    expect(parsed.verifierReserveSeconds).toBe(400);
    expect(parsed.provider).toBe("pi-subscription");
    expect(parsed.attemptId).toBe("attempt-1");
    expect(parsed.trialKind).toBe("t1b");
    expect(parsed.fast).toBe(false);
    expect(args).toContain("--sandbox");
  });

  it("targets the real swarm entry point", async () => {
    expect(swarmScriptPath()).toMatch(/src\/swarm\.ts$/);
    await expect(access(swarmScriptPath())).resolves.toBeUndefined();
  });
});

describe("assertRealSwarmTrace", () => {
  const expected = {
    swarmId: "swarm-1",
    head: HEAD,
    base: BASE,
    reviewerLanes: 3,
  };

  it("reads a whole swarm's stages", () => {
    const trace = assertRealSwarmTrace(receipt(), expected);

    expect(trace.reviewerLanes).toBe(3);
    expect(trace.verifierStatus).toBe("completed");
    expect(trace.candidateCount).toBe(1);
    expect(trace.findings[0]?.reportedBy).toEqual(["reviewer-1"]);
    expect(trace.billing).toBe("unknown");
  });

  it("rejects a receipt with no verifier lane", () => {
    expect(() =>
      assertRealSwarmTrace(
        receipt({
          lanes: [
            laneRow("reviewer-1", "reviewer", true),
            laneRow("reviewer-2", "reviewer", true),
            laneRow("reviewer-3", "reviewer", true),
          ],
        }),
        expected,
      ),
    ).toThrow(/no verifier lane/);
  });

  it("rejects candidates that no verifier ever saw", () => {
    expect(() =>
      assertRealSwarmTrace(
        receipt({
          lanes: [
            laneRow("reviewer-1", "reviewer", true),
            laneRow("reviewer-2", "reviewer", true),
            laneRow("reviewer-3", "reviewer", true),
            laneRow("verifier", "verifier", false),
          ],
        }),
        expected,
      ),
    ).toThrow(/candidates were assembled but the verifier never ran/);
  });

  it("reports an unasked verifier as not_run rather than a pass", () => {
    const trace = assertRealSwarmTrace(
      receipt({
        candidates: [],
        findings: [],
        lanes: [
          laneRow("reviewer-1", "reviewer", true),
          laneRow("reviewer-2", "reviewer", true),
          laneRow("reviewer-3", "reviewer", true),
          laneRow("verifier", "verifier", false),
        ],
      }),
      expected,
    );

    expect(trace.verifierStatus).toBe("not_run");
  });

  it("rejects a receipt from another checkout", () => {
    expect(() =>
      assertRealSwarmTrace(
        receipt({ requested: { head: "3".repeat(40), base: BASE } }),
        expected,
      ),
    ).toThrow(/different checkout/);
  });

  it("rejects a lane count the configuration did not ask for", () => {
    expect(() =>
      assertRealSwarmTrace(receipt(), { ...expected, reviewerLanes: 2 }),
    ).toThrow(/ran 3 reviewer lanes, not 2/);
  });
});

describe("runT1bTrial", () => {
  it("drives the swarm command and keeps its terminal trace", async () => {
    const outDir = await scratch();
    const row = await runT1bTrial(
      {
        caseId: "case-6563",
        swarmId: "swarm-1",
        outDir,
        head: HEAD,
        base: BASE,
      },
      S3,
      {
        run: async (args) => {
          const parsed = parseSwarmOptions([...args]);
          const dir = join(outDir, parsed.swarmId);
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, "swarm-receipt.json"),
            JSON.stringify(receipt({ swarmId: parsed.swarmId })),
          );
          return 0;
        },
      },
    );

    expect(row.outcome).toBe("completed");
    expect(row.transport).toBe("real-swarm");
    expect(row.configuration).toBe("S3");
    expect(row.trace?.reviewerLanes).toBe(3);
    expect(row.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a swarm that left no receipt as a failed scheduled trial", async () => {
    const outDir = await scratch();
    const row = await runT1bTrial(
      {
        caseId: "case-6563",
        swarmId: "swarm-2",
        outDir,
        head: HEAD,
        base: BASE,
      },
      S3,
      { run: async () => 1 },
    );

    expect(row.outcome).toBe("failed");
    expect(row.trace).toBeNull();
    expect(row.error).toMatch(/ENOENT|no such file/);
    expect(row.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
