import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOptions } from "../../src/local";
import {
  assertSingleCheckout,
  defaultVerifierPromptPath,
  type KeyedCandidate,
  renderVerifierPrompt,
  runT1aTrial,
  type T1aBatch,
  verifierArguments,
  verifierCandidatePayload,
} from "../verifier";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-pi-t1a-"));
  temporary.push(dir);
  return dir;
};

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const candidate = (
  id: string,
  expected: KeyedCandidate["expected"],
): KeyedCandidate => ({
  id,
  severity: "P1",
  file: "packages/analytics/src/logger.ts",
  line: 230,
  mechanism: `mechanism for ${id}`,
  evidence: `evidence for ${id}`,
  affectedBehavior: `behavior for ${id}`,
  expected,
  family: "observability",
  incident: "pr-6537",
});

const batch = (): T1aBatch => ({
  batchId: "batch-1",
  caseId: "case-6537",
  head: HEAD,
  base: BASE,
  candidates: [candidate("c1", "confirmed"), candidate("c2", "rejected")],
});

describe("renderVerifierPrompt", () => {
  it("renders the production prompt with only the reviewer-visible fields", async () => {
    const template = await readFile(defaultVerifierPromptPath(), "utf8");
    const rendered = renderVerifierPrompt(template, batch().candidates);

    expect(rendered).not.toContain("{{CANDIDATES}}");
    expect(rendered).not.toContain('"expected"');
    expect(rendered).not.toContain("observability");
    expect(rendered).not.toContain("pr-6537");
    expect(rendered).toContain('"affectedBehavior": "behavior for c1"');
    expect(verifierCandidatePayload(batch().candidates)[0]).toEqual({
      id: "c1",
      severity: "P1",
      file: "packages/analytics/src/logger.ts",
      line: 230,
      mechanism: "mechanism for c1",
      evidence: "evidence for c1",
      affectedBehavior: "behavior for c1",
    });
  });

  it("refuses a template with no candidate slot", () => {
    expect(() => renderVerifierPrompt("no slot", batch().candidates)).toThrow(
      /no \{\{CANDIDATES\}\}/,
    );
  });
});

describe("assertSingleCheckout", () => {
  it("refuses a batch with duplicate candidate ids", () => {
    expect(() =>
      assertSingleCheckout({
        ...batch(),
        candidates: [candidate("c1", "confirmed"), candidate("c1", "rejected")],
      }),
    ).toThrow(/unique/);
  });

  it("refuses a batch whose head and base are the same checkout", () => {
    expect(() => assertSingleCheckout({ ...batch(), base: HEAD })).toThrow(
      /distinct head and base/,
    );
  });
});

describe("verifierArguments", () => {
  it("is accepted by the production local parser as a verifier lane", () => {
    const args = verifierArguments({
      runId: "t1a-1",
      attemptId: "attempt-1",
      outDir: "/tmp/out",
      promptPath: "/tmp/out/verifier.txt",
      head: HEAD,
      base: BASE,
      provider: "pi-subscription",
      model: "gpt-5.6",
      thinking: "high",
      totalTimeoutSeconds: 360,
      candidateIds: ["c1", "c2"],
    });
    const parsed = parseOptions(args);

    expect(parsed.role).toBe("verifier");
    expect(parsed.laneId).toBe("verifier");
    expect(parsed.candidateIds).toEqual(["c1", "c2"]);
    expect(parsed.head).toBe(HEAD);
    expect(parsed.base).toBe(BASE);
    expect(parsed.attemptId).toBe("attempt-1");
    expect(parsed.trialKind).toBe("t1b");
    expect(parsed.piTimeoutSeconds).toBe(251);
  });

  it("pins T1a caps when the trial asks for t1a", () => {
    const args = verifierArguments({
      runId: "t1a-1",
      attemptId: "attempt-1",
      outDir: "/tmp/out",
      promptPath: "/tmp/out/verifier.txt",
      head: HEAD,
      base: BASE,
      totalTimeoutSeconds: 360,
      candidateIds: ["c1"],
      trialKind: "t1a",
    });
    expect(parseOptions(args).trialKind).toBe("t1a");
  });
});

/**
 * A subprocess double that answers only argv the production parser accepts.
 *
 * Its ledger seals the answer the model gave; `reported` is what report.json
 * claims instead, as the target could rewrite it.
 */
const localDouble =
  (
    outDir: string,
    respond: (runId: string) => {
      finalText: string;
      outcome: string;
      reported?: string;
    },
  ) =>
  async (args: readonly string[]) => {
    const parsed = parseOptions([...args]);
    if (parsed.role !== "verifier") throw new Error("not a verifier lane");
    if (!parsed.candidateIds?.length) throw new Error("no candidate ids");
    const dir = join(outDir, parsed.runId);
    await mkdir(dir, { recursive: true });
    const answer = respond(parsed.runId);
    await writeFile(
      join(dir, "report.json"),
      JSON.stringify({ finalText: answer.reported ?? answer.finalText }),
    );
    await writeFile(
      join(dir, "provider-usage.jsonl"),
      `${JSON.stringify({
        event: "provider_request",
        seal: createHash("sha256")
          .update(answer.finalText, "utf8")
          .digest("hex"),
      })}\n`,
    );
    await writeFile(
      join(dir, "local-receipt.json"),
      JSON.stringify({
        runId: parsed.runId,
        attemptId: parsed.attemptId,
        outcome: answer.outcome,
        provider: parsed.provider,
        model: parsed.model,
        wallSeconds: 42,
        teardownSeconds: 3,
        usage: { inputTokens: 1200, outputTokens: 300 },
        shutdown: { truncatedArtifacts: [] },
      }),
    );
    return answer.outcome === "completed" ? 0 : 1;
  };

const verdictBlock = (verdicts: unknown) =>
  `Done.\n\n\`\`\`json\n${JSON.stringify({ verdicts }, null, 2)}\n\`\`\`\n`;

describe("runT1aTrial", () => {
  it("carries verifier decisions back through the production parser", async () => {
    const outDir = await scratch();
    const row = await runT1aTrial(
      batch(),
      { outDir, runId: "t1a-run-1", provider: "pi", model: "gpt-5.6" },
      {
        run: localDouble(outDir, () => ({
          outcome: "completed",
          finalText: verdictBlock([
            {
              id: "c1",
              status: "confirmed",
              evidenceStrength: "executable",
              reason: "reproduced",
              command: "bun test",
              exitStatus: 1,
            },
            {
              id: "c2",
              status: "rejected",
              evidenceStrength: "static",
              reason: "the branch is unreachable",
            },
          ]),
        })),
      },
    );

    expect(row.outcome).toBe("completed");
    expect(row.transport).toBe("direct-verifier");
    expect(row.decisions).toEqual([
      {
        candidateId: "c1",
        status: "confirmed",
        evidenceStrength: "executable",
      },
      { candidateId: "c2", status: "rejected", evidenceStrength: "static" },
    ]);
    expect(row.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(row.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(row.promptPath, "utf8")).toContain('"id": "c1"');
  });

  it("keeps a contract failure as invalid rather than a silent pass", async () => {
    const outDir = await scratch();
    const row = await runT1aTrial(
      batch(),
      { outDir, runId: "t1a-run-2" },
      {
        run: localDouble(outDir, () => ({
          outcome: "completed",
          finalText: verdictBlock([
            {
              id: "c1",
              status: "confirmed",
              evidenceStrength: "static",
              reason: "only ruled on one",
            },
          ]),
        })),
      },
    );

    expect(row.outcome).toBe("invalid");
    expect(row.contractError).toBe("no verdict for c2");
    expect(row.decisions).toEqual([]);
  });

  it("rules nothing from an answer the model channel never sealed", async () => {
    const outDir = await scratch();
    const confirmed = verdictBlock(
      ["c1", "c2"].map((id) => ({
        id,
        status: "confirmed",
        evidenceStrength: "static",
        reason: "the source matches",
      })),
    );
    const row = await runT1aTrial(
      batch(),
      { outDir, runId: "t1a-run-forged" },
      {
        run: localDouble(outDir, () => ({
          outcome: "completed",
          finalText: confirmed,
          reported: confirmed.replaceAll("confirmed", "rejected"),
        })),
      },
    );

    expect(row.outcome).toBe("invalid");
    expect(row.contractError).toMatch(
      /^the answer's seal [0-9a-f]{64} matches none of the 1 responses the control side sealed$/,
    );
    expect(row.decisions).toEqual([]);
  });

  it("keeps a failed session as a scheduled trial with its own identity", async () => {
    const outDir = await scratch();
    const row = await runT1aTrial(
      batch(),
      { outDir, runId: "t1a-run-3" },
      {
        run: localDouble(outDir, () => ({ outcome: "failed", finalText: "" })),
      },
    );

    expect(row.outcome).toBe("failed");
    expect(row.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.candidateIds).toEqual(["c1", "c2"]);
  });

  it("keeps a preparation failure before any model call", async () => {
    const outDir = await scratch();
    let spawned = 0;
    const row = await runT1aTrial(
      batch(),
      {
        outDir,
        runId: "t1a-run-4",
        promptTemplatePath: join(outDir, "missing-prompt.txt"),
      },
      {
        run: async () => {
          spawned += 1;
          return 0;
        },
      },
    );

    expect(spawned).toBe(0);
    expect(row.outcome).toBe("preparation-failed");
    expect(row.error).toMatch(/missing-prompt/);
    expect(row.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
