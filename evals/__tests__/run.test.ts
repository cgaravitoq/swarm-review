import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBaselineLock,
  caseArguments,
  caseResult,
  certifyTransports,
  parseManifest,
  sourceTreeHash,
  summarize,
} from "../run";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-pi-eval-"));
  temporary.push(dir);
  return dir;
};

const lockInput = (tree: Awaited<ReturnType<typeof sourceTreeHash>>) => ({
  tree,
  worktree: { commit: null, dirty: true },
  imageDigest: "sha256:abc",
  corpusHash: "c".repeat(64),
  keysetHash: "k".repeat(64),
  promptHashes: { verifier: "v".repeat(64) },
  providers: [
    {
      name: "pi-subscription",
      model: "deepseek-v4-flash",
      maxProviderRequests: 8,
      maxHttpRetriesPerRequest: 1,
      maxInputTokensPerRequest: 131072,
      maxOutputTokensPerRequest: 8192,
      maxInputTokensPerSession: 250000,
      maxOutputTokensPerSession: 16000,
      billingBasis: "subscription" as const,
    },
  ],
  timeoutsSeconds: { t1aTrial: 360, t1bSwarm: 1800 },
  toolchain: { bun: "1.2.0", rust: "1.90.0" },
});

describe("sourceTreeHash", () => {
  it("changes the moment any measured input changes", async () => {
    const dir = await scratch();
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await writeFile(a, "export const x = 1;\n");
    await writeFile(b, "export const y = 2;\n");

    const first = await sourceTreeHash([b, a]);
    expect(first.files.map((entry) => entry.path)).toEqual([a, b]);
    expect(first.treeSha256).toMatch(/^[0-9a-f]{64}$/);

    await writeFile(b, "export const y = 3;\n");
    expect((await sourceTreeHash([a, b])).treeSha256).not.toBe(
      first.treeSha256,
    );
  });
});

describe("buildBaselineLock", () => {
  it("names an uncommitted worktree rather than inventing a commit", async () => {
    const dir = await scratch();
    const file = join(dir, "eval.ts");
    await writeFile(file, "export const version = 1;\n");
    const lock = buildBaselineLock(lockInput(await sourceTreeHash([file])));

    expect(lock.worktree).toEqual({ commit: null, dirty: true });
    expect(lock.baselineId).toMatch(/^[0-9a-f]{32}$/);
    expect(lock.providers[0]?.maxInputTokensPerSession).toBe(250000);
  });

  it("gives a changed source tree a different baseline identity", async () => {
    const dir = await scratch();
    const file = join(dir, "eval.ts");
    await writeFile(file, "export const version = 1;\n");
    const first = buildBaselineLock(lockInput(await sourceTreeHash([file])));
    await writeFile(file, "export const version = 2;\n");
    const second = buildBaselineLock(lockInput(await sourceTreeHash([file])));

    expect(second.baselineId).not.toBe(first.baselineId);
  });

  it("refuses a silently zeroed token cap", async () => {
    const dir = await scratch();
    const file = join(dir, "eval.ts");
    await writeFile(file, "export const version = 1;\n");
    const input = lockInput(await sourceTreeHash([file]));
    const provider = input.providers[0];
    expect(() =>
      buildBaselineLock({
        ...input,
        providers: [
          { ...provider, maxOutputTokensPerSession: 0 },
        ] as typeof input.providers,
      }),
    ).toThrow(/maxOutputTokensPerSession must be positive/);
  });

  it("refuses a lock with no prompt hash", async () => {
    const dir = await scratch();
    const file = join(dir, "eval.ts");
    await writeFile(file, "export const version = 1;\n");
    const input = lockInput(await sourceTreeHash([file]));
    expect(() => buildBaselineLock({ ...input, promptHashes: {} })).toThrow(
      /prompt hashes are required/,
    );
  });
});

describe("certifyTransports", () => {
  const t1a = {
    transport: "direct-verifier",
    outcome: "completed",
    decisions: [{ candidateId: "c1" }],
  };
  const t1b = {
    transport: "real-swarm",
    trace: { reviewerLanes: 2, verifierStatus: "completed" },
  };

  it("accepts two traces that actually ran", () => {
    expect(certifyTransports({ t1a, t1b })).toBe(true);
  });

  it("refuses a T1a trace that produced no decision", () => {
    expect(() =>
      certifyTransports({ t1a: { ...t1a, decisions: [] }, t1b }),
    ).toThrow(/no verifier decision/);
  });

  it("refuses a T1b trace that never reached the verifier", () => {
    expect(() =>
      certifyTransports({
        t1a,
        t1b: { ...t1b, trace: { reviewerLanes: 2, verifierStatus: "not_run" } },
      }),
    ).toThrow(/never reached the verifier/);
  });

  it("refuses a transport that was not the production path", () => {
    expect(() =>
      certifyTransports({ t1a: { ...t1a, transport: "simulated" }, t1b }),
    ).toThrow(/t1a transport is simulated/);
  });
});

describe("parseManifest", () => {
  it("still drives the existing local manifest runner", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        defaults: { prompt: "/prompt.txt", provider: "pi" },
        cases: [{ id: "one", pr: 6515 }],
      }),
    );
    expect(
      caseArguments(
        manifest,
        manifest.cases[0] as never,
        "run-1",
        "/out",
        "att-1",
      ),
    ).toContain("--attempt-id");
    expect(summarize([])).toEqual({ total: 0, completed: 0, failed: 0 });
  });

  it("carries a per-case context into the run it drives", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        defaults: { prompt: "/prompt.txt", context: "/briefs/default.md" },
        cases: [
          { id: "inherits", pr: 6515 },
          { id: "overrides", pr: 6516, context: "/briefs/other.md" },
        ],
      }),
    );
    const [inherits, overrides] = manifest.cases.map((entry) =>
      caseArguments(manifest, entry, `run-${entry.id}`, "/out"),
    );

    expect(inherits).toEqual(
      expect.arrayContaining(["--context", "/briefs/default.md"]),
    );
    expect(overrides).toEqual(
      expect.arrayContaining(["--context", "/briefs/other.md"]),
    );
    expect(overrides).not.toContain("/briefs/default.md");

    // A manifest that names none leaves the driver's own brief in place rather
    // than passing an empty path.
    const bare = parseManifest(
      JSON.stringify({
        version: 1,
        defaults: { prompt: "/p.txt" },
        cases: [{ id: "b", pr: 1 }],
      }),
    );
    expect(
      caseArguments(bare, bare.cases[0] as never, "run-b", "/out"),
    ).not.toContain("--context");
  });
});

describe("evaluation manifest", () => {
  const manifest = parseManifest(
    JSON.stringify({
      version: 1,
      defaults: {
        prompt: "/prompts/review.txt",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        totalTimeoutSeconds: 600,
      },
      cases: [
        { id: "pr-case", pr: 6458 },
        {
          id: "fixture-case",
          head: "a".repeat(40),
          base: "b".repeat(40),
          fixture: "/fixtures/one.patch",
          prompt: "/prompts/other.txt",
        },
      ],
    }),
  );

  it("applies defaults without letting them override a case", () => {
    const [pr, fixture] = manifest.cases.map((entry) =>
      caseArguments(manifest, entry, `run-${entry.id}`, "/out"),
    );

    expect(pr).toEqual([
      "--run-id",
      "run-pr-case",
      "--out",
      "/out",
      "--prompt",
      "/prompts/review.txt",
      "--pr",
      "6458",
      "--model",
      "@cf/deepseek-ai/deepseek-v4-flash-0731",
      "--total-timeout",
      "600",
    ]);
    expect(fixture).toContain("/prompts/other.txt");
    expect(fixture).not.toContain("/prompts/review.txt");
    expect(fixture).toContain("--fixture");
  });

  it("rejects a manifest case without exact revisions", () => {
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, cases: [{ id: "loose" }] })),
    ).toThrow(/needs pr, or head and base/);
  });

  it("rejects a manifest whose case fields are the wrong type", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ version: 1, cases: [{ id: "typed", pr: "6458" }] }),
      ),
    ).toThrow(/pr must be a number/);
  });

  it("rejects duplicate case ids", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          version: 1,
          cases: [
            { id: "same", pr: 1 },
            { id: "same", pr: 2 },
          ],
        }),
      ),
    ).toThrow(/case ids must be unique/);
  });

  it("records the observed run outcome without judging review quality", async () => {
    const root = await scratch();
    await writeFile(
      join(root, "local-receipt.json"),
      JSON.stringify({
        runId: "run-pr-case",
        attemptId: "attempt-pr-case",
        outcome: "completed",
        provider: "cloudflare-workers-ai",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        wallSeconds: 412,
        teardownSeconds: 3,
        usage: { totalTokens: 90 },
        error: null,
      }),
    );
    await writeFile(
      join(root, "trace.jsonl"),
      `${JSON.stringify({ type: "turn_end", stopReason: "stop" })}\n`,
    );

    const row = await caseResult(
      { id: "pr-case" },
      "run-pr-case",
      root,
      "attempt-pr-case",
      0,
    );

    expect(row).toMatchObject({
      id: "pr-case",
      outcome: "completed",
      stopReason: "stop",
      model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      wallSeconds: 412,
    });
    expect(row).not.toHaveProperty("score");
    expect(summarize([row])).toEqual({ total: 1, completed: 1, failed: 0 });
  });

  it("reports a missing receipt as a driver error rather than a pass", async () => {
    const root = await scratch();

    const row = await caseResult(
      { id: "lost" },
      "run-lost",
      root,
      "attempt-lost",
      1,
    );

    expect(row.outcome).toBe("driver-error");
    expect(summarize([row])).toEqual({ total: 1, completed: 0, failed: 1 });
  });

  it("does not count a stale completed receipt after the child fails", async () => {
    const root = await scratch();
    await writeFile(
      join(root, "local-receipt.json"),
      JSON.stringify({
        runId: "run-pr-case",
        attemptId: "stale-attempt",
        outcome: "completed",
        provider: "stale-provider",
        model: "stale-model",
        wallSeconds: 1,
        teardownSeconds: 1,
        usage: null,
        error: null,
      }),
    );

    const row = await caseResult(
      { id: "pr-case" },
      "run-pr-case",
      root,
      "current-attempt",
      1,
    );

    expect(row.outcome).toBe("driver-error");
    expect(row.error).toMatch(/receipt does not match this attempt/);
    expect(summarize([row])).toEqual({ total: 1, completed: 0, failed: 1 });
  });

  it("reports a malformed trailing trace event without aborting a failed case", async () => {
    const root = await scratch();
    await writeFile(
      join(root, "local-receipt.json"),
      JSON.stringify({
        runId: "run-partial",
        attemptId: "attempt-partial",
        outcome: "failed",
        provider: "cloudflare-workers-ai",
        model: "model",
        wallSeconds: 2,
        teardownSeconds: 1,
        usage: null,
        error: "review failed",
      }),
    );
    await writeFile(
      join(root, "trace.jsonl"),
      '{"type":"turn_end","stopReason":"toolUse"}\n{"type":',
    );

    const row = await caseResult(
      { id: "partial" },
      "run-partial",
      root,
      "attempt-partial",
      1,
    );

    expect(row.outcome).toBe("failed");
    expect(row.stopReason).toBeNull();
    expect(row.error).toMatch(/review failed; trace\.jsonl:/);
  });
});
