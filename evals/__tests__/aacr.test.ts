import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRunId } from "../../src/local";
import { buildReview } from "../../src/publish";
import {
  LANE_RELAUNCHES,
  MAX_REVIEWER_LANES,
  parseSwarmOptions,
  reviewerLaneId,
} from "../../src/swarm";
import { parseDataset } from "../aacr/dataset";
import {
  commentFrom,
  parseSwarmReceipt,
  publishedFindings,
  safeResultId,
} from "../aacr/result";
import {
  casePaths,
  type GitInvocation,
  parseAacrArgs,
  prepareCheckout,
  runAacrCase,
  runAacrSuite,
  SWARM_ID_MAX_LENGTH,
  swarmIdFor,
  swarmRunArguments,
  USAGE,
} from "../aacr/run";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-pi-aacr-"));
  temporary.push(dir);
  return dir;
};

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);

const ENTRY = {
  instanceId: "acme__demo-1@abc1234",
  repo: "acme/demo",
  baseCommit: BASE,
  headCommit: HEAD,
  cloneUrl: "https://github.com/acme/demo.git",
};

const candidate = (overrides: Record<string, unknown>) => ({
  id: "c1",
  laneId: "reviewer-1",
  severity: "P1",
  file: "src/a.ts",
  line: 12,
  mechanism: "the loop reads one past the buffer",
  evidence: "",
  affectedBehavior: "the last byte is read from the next page",
  reportedBy: ["reviewer-1"],
  ...overrides,
});

const finding = (overrides: Record<string, unknown>) => ({
  id: "c1",
  status: "confirmed",
  severity: "P1",
  file: "src/a.ts",
  line: 12,
  mechanism: "the loop reads one past the buffer",
  evidence: "static read",
  affectedBehavior: "the last byte is read from the next page",
  evidenceStrength: "static",
  reportedBy: ["reviewer-1"],
  verifierReason: "the index is never clamped",
  verifierCommand: null,
  verifierExitStatus: null,
  diffRelation: "added",
  declaredIntent: null,
  ...overrides,
});

/** Six claims, one per publication deciding: only c1 is a posting. */
const CANDIDATES = [
  candidate({ id: "c1" }),
  candidate({
    id: "c2",
    laneId: "reviewer-2",
    file: "src/b.ts",
    line: 30,
    mechanism: "the config default is inverted",
    reportedBy: ["reviewer-2"],
  }),
  candidate({
    id: "c3",
    file: "src/c.ts",
    line: 7,
    mechanism: "the lock is released too early",
  }),
  candidate({
    id: "c4",
    laneId: "reviewer-3",
    severity: "P3",
    file: "src/d.ts",
    line: 99,
    mechanism: "the sql string is concatenated",
    reportedBy: ["reviewer-3"],
  }),
  candidate({
    id: "c5",
    laneId: "reviewer-2",
    file: "src/e.ts",
    line: 5,
    mechanism: "the branch is dead",
    reportedBy: ["reviewer-2"],
  }),
  candidate({
    id: "c6",
    laneId: "reviewer-3",
    file: "src/f.ts",
    line: 1,
    mechanism: "the bound may be off by one",
    reportedBy: ["reviewer-3"],
  }),
];

const FINDINGS = [
  finding({ id: "c1" }),
  finding({
    id: "c2",
    file: "src/b.ts",
    line: 30,
    mechanism: "the config default is inverted",
    declaredIntent: "the default is intentionally inverted for the new mode",
    reportedBy: ["reviewer-2"],
  }),
  finding({
    id: "c3",
    file: "src/c.ts",
    line: 7,
    mechanism: "the lock is released too early",
    diffRelation: "untouched",
  }),
  finding({
    id: "c4",
    severity: "P3",
    file: "src/d.ts",
    line: 99,
    mechanism: "the sql string is concatenated",
    reportedBy: ["reviewer-3"],
  }),
  finding({
    id: "c5",
    status: "rejected",
    file: "src/e.ts",
    line: 5,
    mechanism: "the branch is dead",
    diffRelation: null,
    reportedBy: ["reviewer-2"],
  }),
  finding({
    id: "c6",
    status: "unverified",
    file: "src/f.ts",
    line: 1,
    mechanism: "the bound may be off by one",
    diffRelation: null,
    evidenceStrength: "reviewer-only",
    reportedBy: ["reviewer-3"],
  }),
];

const lane = (
  laneId: string,
  role: string,
  usage: Record<string, number> | null,
  install: Record<string, unknown> = {},
) => ({
  laneId,
  role,
  status: "completed",
  usage,
  ...install,
});

const receipt = (overrides: Record<string, unknown> = {}) => ({
  swarmId: "swarm-1",
  status: "completed",
  outcome: "adjudicated",
  abortReason: null,
  wallSeconds: 900,
  requested: { head: HEAD, base: BASE, pullRequest: null },
  lanes: [
    lane("reviewer-1", "reviewer", { input: 100, output: 10 }),
    lane("reviewer-2", "reviewer", { input: 200, output: 20 }),
    lane("verifier", "verifier", { input: 300, output: 30 }),
  ],
  candidates: CANDIDATES,
  findings: FINDINGS,
  ...overrides,
});

const gitRecorder = (
  overrides: (
    invocation: GitInvocation,
    index: number,
  ) => number | undefined = () => undefined,
) => {
  const calls: GitInvocation[] = [];
  const runGit = async (invocation: GitInvocation) => {
    const index = calls.length;
    calls.push(invocation);
    return overrides(invocation, index) ?? 0;
  };
  return { calls, runGit };
};

/** Writes the receipt where the production swarm would, from its own argv. */
const writingSwarm = (swarmReceipt: unknown, exitCode = 0) => {
  const calls: string[][] = [];
  const runSwarm = async (args: readonly string[]) => {
    calls.push([...args]);
    const parsed = parseSwarmOptions([...args]);
    const dir = join(parsed.outDir, parsed.swarmId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "swarm-receipt.json"),
      JSON.stringify(swarmReceipt),
    );
    return exitCode;
  };
  return { calls, runSwarm };
};

describe("parseDataset", () => {
  it("reads the fields a run needs and derives the clone URL", () => {
    const [entry] = parseDataset(
      `${JSON.stringify({
        instance_id: ENTRY.instanceId,
        repo: ENTRY.repo,
        base_commit: BASE,
        head_commit: HEAD,
        reference_comments: [
          { path: "src/a.ts", start_line: 1, end_line: 1, text: "secret" },
        ],
      })}\n`,
    );

    expect(entry).toEqual(ENTRY);
  });

  it("keeps a clone_url the dataset names", () => {
    const [entry] = parseDataset(
      `${JSON.stringify({
        instance_id: "a__b@c",
        repo: "a/b",
        base_commit: BASE,
        head_commit: HEAD,
        clone_url: "git@github.com:a/b.git",
      })}\n`,
    );

    expect(entry?.cloneUrl).toBe("git@github.com:a/b.git");
  });

  it("rejects a line that names no instance", () => {
    expect(() => parseDataset('{"repo":"a/b"}\n')).toThrow(
      /instance_id is required/,
    );
  });

  it("rejects a repeated instance", () => {
    const line = JSON.stringify({
      instance_id: "a__b@c",
      repo: "a/b",
      base_commit: BASE,
      head_commit: HEAD,
    });
    expect(() => parseDataset(`${line}\n${line}\n`)).toThrow(/duplicate/);
  });

  it("rejects a repo that is not owner/name", () => {
    expect(() =>
      parseDataset(
        `${JSON.stringify({
          instance_id: "a__b@c",
          repo: "b",
          base_commit: BASE,
          head_commit: HEAD,
        })}\n`,
      ),
    ).toThrow(/owner\/name/);
  });
});

describe("swarmRunArguments", () => {
  it("is accepted by the production swarm parser", () => {
    const args = swarmRunArguments({
      swarmId: swarmIdFor(ENTRY.instanceId),
      out: "/out/swarms/run-1",
      repo: ENTRY.repo,
      source: "/out/repos/acme__demo",
      head: HEAD,
      base: BASE,
      maxCostUsd: 25,
    });
    const parsed = parseSwarmOptions(args);

    expect(parsed.repo).toBe("acme/demo");
    expect(parsed.source).toBe("/out/repos/acme__demo");
    expect(parsed.head).toBe(HEAD);
    expect(parsed.base).toBe(BASE);
    expect(parsed.remainingSubCapUsd).toBe(25);
    expect(parsed.outDir).toBe("/out/swarms/run-1");
  });

  it("names a swarm id every lane id the swarm derives from it still fits", () => {
    for (const instanceId of [
      ENTRY.instanceId,
      "kubernetes/kubernetes@ABCDEF1",
      "a/b",
      "kubernetes__kubernetes-123456@abcdef1234567",
      "x".repeat(48),
      "x".repeat(120),
    ]) {
      const swarmId = swarmIdFor(instanceId);
      expect(swarmId.length).toBeLessThanOrEqual(SWARM_ID_MAX_LENGTH);
      expect(assertRunId(swarmId)).toBe(swarmId);
      expect(assertRunId(`${swarmId}-reviewer-1`)).toBeDefined();
      expect(assertRunId(`${swarmId}-verifier`)).toBeDefined();
      expect(
        assertRunId(
          `${swarmId}-${reviewerLaneId(MAX_REVIEWER_LANES - 1)}-r${LANE_RELAUNCHES + 1}`,
        ),
      ).toBeDefined();
    }
  });

  it("gives two instances of one repository different swarm ids", () => {
    expect(swarmIdFor("acme/demo@one")).not.toBe(swarmIdFor("acme/demo@two"));
  });
});

describe("publishedFindings", () => {
  const permissive = (entries: { file: string; line: number }[]) => {
    const map = new Map<string, Set<number>>();
    for (const entry of entries) {
      if (!map.has(entry.file)) map.set(entry.file, new Set());
      map.get(entry.file)?.add(entry.line);
    }
    return map;
  };

  it("holds exactly what buildReview posts, advisories and out-of-diff aside", () => {
    const raw = parseSwarmReceipt(receipt());
    const review = buildReview(raw, permissive(FINDINGS), ENTRY.repo, "P2");

    expect(
      publishedFindings(raw.findings, "P2").map((entry) => entry.id),
    ).toEqual(["c1"]);
    expect(review.comments.map((comment) => comment.path)).toEqual([
      "src/a.ts",
    ]);
    // The advisory and the out-of-diff defect are still read by a human in the
    // body; the below-floor, rejected and unverified ones are not posted.
    expect(review.body).toContain("src/b.ts");
    expect(review.body).toContain("src/c.ts");
    expect(review.body).not.toContain("src/d.ts");
    expect(review.body).not.toContain("src/e.ts");
  });

  it("keeps a finding the diff cannot anchor, unlike inline comments", () => {
    const raw = parseSwarmReceipt(receipt());
    const review = buildReview(raw, new Map(), ENTRY.repo, "P2");

    expect(review.comments).toEqual([]);
    expect(review.body).toContain("outside the three-dot diff");
    expect(
      publishedFindings(raw.findings, "P2").map((entry) => entry.id),
    ).toEqual(["c1"]);
  });
});

describe("prepareCheckout", () => {
  it("clones a case's repository and checks out its head", async () => {
    const out = await scratch();
    const cacheDir = join(out, "repos", "acme__demo");
    const { calls, runGit } = gitRecorder();

    await prepareCheckout(
      cacheDir,
      { cloneUrl: ENTRY.cloneUrl, head: HEAD, base: BASE },
      runGit,
    );

    expect(calls[0]?.args).toEqual([
      "clone",
      "--quiet",
      ENTRY.cloneUrl,
      cacheDir,
    ]);
    expect(calls.at(-1)?.args).toEqual([
      "-C",
      cacheDir,
      "checkout",
      "--quiet",
      "--detach",
      HEAD,
    ]);
  });

  it("fetches only what a warm cache is missing", async () => {
    const out = await scratch();
    const cacheDir = join(out, "repos", "acme__demo");
    await mkdir(join(cacheDir, ".git"), { recursive: true });
    const { calls, runGit } = gitRecorder((invocation) => {
      if (!invocation.args.includes("cat-file")) return 0;
      return calls.filter((call) => call.args.includes("cat-file")).length <= 1
        ? 1
        : 0;
    });

    await prepareCheckout(
      cacheDir,
      { cloneUrl: ENTRY.cloneUrl, head: HEAD, base: BASE },
      runGit,
    );

    expect(calls.some((call) => call.args[0] === "clone")).toBe(false);
    const fetch = calls.find((call) => call.args.includes("fetch"));
    expect(fetch?.args).toEqual([
      "-C",
      cacheDir,
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      HEAD,
      BASE,
    ]);
  });

  it("refuses a cache that still lacks a revision", async () => {
    const out = await scratch();
    const cacheDir = join(out, "repos", "acme__demo");
    await mkdir(join(cacheDir, ".git"), { recursive: true });
    const { runGit } = gitRecorder((invocation) =>
      invocation.args.includes("cat-file") ? 1 : 0,
    );

    await expect(
      prepareCheckout(
        cacheDir,
        { cloneUrl: ENTRY.cloneUrl, head: HEAD, base: BASE },
        runGit,
      ),
    ).rejects.toThrow(/missing/);
  });
});

describe("runAacrCase", () => {
  it("writes both result shapes and the sidecar from one receipt", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const { runSwarm } = writingSwarm(receipt());
    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.status).toBe("completed");
    expect(sidecar.candidates).toBe(CANDIDATES.length);
    expect(sidecar.confirmed).toBe(1);
    // Lanes plus the verifier, which is a lane too.
    expect(sidecar.usage).toEqual({ input: 600, output: 60 });
    expect(sidecar.wallSeconds).toBe(900);

    const paths = casePaths(out, ENTRY.instanceId);
    const candidates = JSON.parse(await readFile(paths.candidates, "utf8"));
    expect(candidates.instance_id).toBe(ENTRY.instanceId);
    expect(candidates.reviewer).toBe("swarm-review");
    expect(candidates.review.comments).toHaveLength(CANDIDATES.length);
    // `content = mechanism + affectedBehavior`, `start_line = end_line = line`.
    expect(candidates.review.comments).toEqual(CANDIDATES.map(commentFrom));
    expect(candidates.review.comments[0]).toEqual({
      path: "src/a.ts",
      content:
        "the loop reads one past the buffer\n\nthe last byte is read from the next page",
      start_line: 12,
      end_line: 12,
    });
    expect(candidates.review.summary).toEqual({
      input_tokens: 600,
      output_tokens: 60,
    });
    expect(candidates.duration_seconds).toBe(900);

    const confirmed = JSON.parse(await readFile(paths.confirmed, "utf8"));
    const raw = parseSwarmReceipt(receipt());
    const permissive = new Map<string, Set<number>>();
    for (const entry of FINDINGS) {
      if (!permissive.has(entry.file)) permissive.set(entry.file, new Set());
      permissive.get(entry.file)?.add(entry.line);
    }
    const review = buildReview(raw, permissive, ENTRY.repo, "P2");
    expect(
      confirmed.review.comments.map(
        (comment: { path: string; start_line: number; end_line: number }) => [
          comment.path,
          comment.start_line,
          comment.end_line,
        ],
      ),
    ).toEqual(
      review.comments.map((comment) => [
        comment.path,
        comment.line,
        comment.line,
      ]),
    );
    expect(confirmed.review.comments).toEqual(
      publishedFindings(raw.findings, "P2").map(commentFrom),
    );
  });

  it("records a skipped install the receipt carries", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const { runSwarm } = writingSwarm(
      receipt({
        lanes: [
          lane(
            "reviewer-1",
            "reviewer",
            { input: 1, output: 1 },
            {
              installSkipped: true,
              installSkippedReason: "no Bun manifest at the checkout root",
            },
          ),
        ],
      }),
    );

    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.installSkipped).toBe(true);
    expect(sidecar.installSkipReason).toMatch(/no Bun manifest/);
  });

  it("records an unobservable install as null, never as a passing false", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const { runSwarm } = writingSwarm(receipt());

    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.installSkipped).toBeNull();
    expect(sidecar.installSkipReason).toBeNull();
  });

  it("keeps a partial run's findings instead of calling it a failure", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const { runSwarm } = writingSwarm(receipt({ status: "partial" }), 1);

    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.status).toBe("partial");
    const paths = casePaths(out, ENTRY.instanceId);
    const confirmed = JSON.parse(await readFile(paths.confirmed, "utf8"));
    expect(confirmed.review.comments).toHaveLength(1);
  });

  it("records a failed run with its reason and no result files", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const runSwarm = async () => 1;
    const paths = casePaths(out, ENTRY.instanceId);
    await mkdir(join(out, "candidates"), { recursive: true });
    await mkdir(join(out, "confirmed"), { recursive: true });
    await writeFile(paths.candidates, '{"stale":true}\n');
    await writeFile(paths.confirmed, '{"stale":true}\n');

    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.status).toBe("failed");
    expect(sidecar.reason).toMatch(/no readable receipt/);
    expect(sidecar.confirmed).toBe(0);
    await expect(readFile(paths.candidates, "utf8")).rejects.toThrow();
    await expect(readFile(paths.confirmed, "utf8")).rejects.toThrow();
    // The failure is still a record: the sidecar is there.
    expect(JSON.parse(await readFile(paths.sidecar, "utf8")).status).toBe(
      "failed",
    );
  });

  it("refuses a receipt replayed from another checkout", async () => {
    const out = await scratch();
    const { runGit } = gitRecorder();
    const { runSwarm } = writingSwarm(
      receipt({
        requested: { head: "9".repeat(40), base: BASE, pullRequest: null },
      }),
    );

    const sidecar = await runAacrCase(
      ENTRY,
      { out, runId: "run-1", maxCostUsd: 25, targeted: false },
      { runGit, runSwarm },
    );

    expect(sidecar.status).toBe("failed");
    expect(sidecar.reason).toMatch(/not this case/);
  });
});

describe("runAacrSuite", () => {
  const datasetFile = async (dir: string) => {
    const path = join(dir, "aacr_bench.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        instance_id: ENTRY.instanceId,
        repo: ENTRY.repo,
        base_commit: BASE,
        head_commit: HEAD,
      })}\n`,
    );
    return path;
  };

  it("reports a full-run failure that passes alone under --instance as flaky", async () => {
    const root = await scratch();
    const dataset = await datasetFile(root);
    const out = join(root, "out");
    const { runGit } = gitRecorder();
    const failing = async () => 1;
    const first = await runAacrSuite(
      { dataset, out, maxCostUsd: 25 },
      { runGit, runSwarm: failing, runId: "run-full" },
    );

    expect(first.summary.failed).toBe(1);
    expect(first.cases[0]?.flaky).toBe(false);

    const { runSwarm } = writingSwarm(receipt());
    const second = await runAacrSuite(
      {
        dataset,
        out,
        maxCostUsd: 25,
        instances: [ENTRY.instanceId],
      },
      { runGit, runSwarm, runId: "run-alone" },
    );

    expect(second.targeted).toBe(true);
    expect(second.summary.completed).toBe(1);
    expect(second.summary.flaky).toBe(1);
    expect(second.cases[0]?.flaky).toBe(true);

    const sidecar = JSON.parse(
      await readFile(
        join(out, "cases", `${safeResultId(ENTRY.instanceId)}.json`),
        "utf8",
      ),
    );
    expect(sidecar.flaky).toBe(true);
    expect(sidecar.previousFailure).toEqual({
      runId: "run-full",
      status: "failed",
      reason: expect.stringMatching(/no readable receipt/),
    });
    const report = JSON.parse(
      await readFile(join(out, "runs", "run-alone.json"), "utf8"),
    );
    expect(report.summary.flaky).toBe(1);
  });

  it("refuses an --instance the dataset does not hold", async () => {
    const root = await scratch();
    const dataset = await datasetFile(root);
    await expect(
      runAacrSuite(
        {
          dataset,
          out: join(root, "out"),
          maxCostUsd: 25,
          instances: ["nope"],
        },
        { runGit: gitRecorder().runGit },
      ),
    ).rejects.toThrow(/names no case: nope/);
  });
});

describe("parseAacrArgs", () => {
  it("reads the documented flags", () => {
    expect(
      parseAacrArgs([
        "--dataset",
        "data/aacr_bench.jsonl",
        "--out",
        "out/aacr",
        "--max-cost-usd",
        "25",
        "--limit",
        "5",
        "--instance",
        "a__b@c",
        "--instance",
        "d__e@f",
      ]),
    ).toEqual({
      dataset: "data/aacr_bench.jsonl",
      out: "out/aacr",
      maxCostUsd: 25,
      limit: 5,
      instances: ["a__b@c", "d__e@f"],
    });
  });

  it("requires the corpus, the output directory and the cap", () => {
    expect(() => parseAacrArgs([])).toThrow(/--dataset is required/);
    expect(() => parseAacrArgs(["--dataset", "d"])).toThrow(
      /--out is required/,
    );
    expect(() =>
      parseAacrArgs(["--dataset", "d", "--out", "o", "--max-cost-usd", "0"]),
    ).toThrow(/--max-cost-usd/);
  });

  it("refuses a flag nobody documented", () => {
    expect(() =>
      parseAacrArgs([
        "--dataset",
        "d",
        "--out",
        "o",
        "--max-cost-usd",
        "1",
        "--pace",
        "2",
      ]),
    ).toThrow(/unknown flag --pace/);
  });

  it("documents every flag it reads", () => {
    for (const name of [
      "--dataset",
      "--out",
      "--max-cost-usd",
      "--limit",
      "--instance",
      "--help",
    ]) {
      expect(USAGE).toContain(name);
    }
  });
});
