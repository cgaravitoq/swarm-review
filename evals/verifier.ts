/**
 * T1a transport: keyed candidates straight into the production verifier.
 *
 * T1a asks one question - does the verifier rule correctly on a candidate whose
 * answer is known - and reviewer lanes only add noise to it. So this drives the
 * same verifier the swarm drives: the same prompt file, the same candidate
 * projection, the same `--role verifier` local session and the same
 * `parseVerdicts` contract, with the reviewer stage removed rather than
 * reimplemented.
 *
 * The key never reaches the prompt. Only the seven fields a reviewer would have
 * produced are rendered, so the verifier sees a candidate, not an exam answer.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalReceipt } from "../src/local";
import { DEFAULT_SWARM_IMAGE, parseVerdicts } from "../src/swarm";

const localScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "local.ts",
);

export const defaultVerifierPromptPath = () =>
  fileURLToPath(
    new URL("../prompts/review-prompt-swarm-verifier.txt", import.meta.url)
      .href,
  );

/** Exactly what a reviewer hands the verifier, plus the sealed key beside it. */
export type KeyedCandidate = {
  id: string;
  severity: "P0" | "P1" | "P2";
  file: string;
  line: number;
  mechanism: string;
  evidence: string;
  affectedBehavior: string;
  expected: "confirmed" | "rejected";
  family: string;
  incident: string;
};

export type T1aBatch = {
  batchId: string;
  caseId: string;
  head: string;
  base: string;
  candidates: readonly KeyedCandidate[];
};

/**
 * The production verifier sees one checkout, so a batch that mixes them would
 * ask it to rule on files that are not in front of it.
 */
export function assertSingleCheckout(batch: T1aBatch) {
  if (batch.candidates.length === 0) {
    throw new Error(`batch ${batch.batchId}: no candidates`);
  }
  const ids = new Set(batch.candidates.map((entry) => entry.id));
  if (ids.size !== batch.candidates.length) {
    throw new Error(`batch ${batch.batchId}: candidate ids must be unique`);
  }
  if (!batch.head || !batch.base || batch.head === batch.base) {
    throw new Error(`batch ${batch.batchId}: needs a distinct head and base`);
  }
  return batch;
}

/** The candidate projection the swarm sends; the key is deliberately absent. */
export const verifierCandidatePayload = (
  candidates: readonly KeyedCandidate[],
) =>
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

export function renderVerifierPrompt(
  template: string,
  candidates: readonly KeyedCandidate[],
) {
  if (!template.includes("{{CANDIDATES}}")) {
    throw new Error("verifier prompt has no {{CANDIDATES}} placeholder");
  }
  const rendered = template.replace(
    "{{CANDIDATES}}",
    JSON.stringify(verifierCandidatePayload(candidates), null, 2),
  );
  for (const candidate of candidates) {
    if (rendered.includes(`"expected": "${candidate.expected}"`)) {
      throw new Error("verifier prompt leaks an answer key");
    }
  }
  return rendered;
}

export const verifierArguments = (options: {
  runId: string;
  attemptId: string;
  outDir: string;
  promptPath: string;
  head: string;
  base: string;
  image?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  checkCommand?: string;
  totalTimeoutSeconds: number;
  candidateIds: readonly string[];
  trialKind?: "t1a" | "t1b";
}) => [
  "--run-id",
  options.runId,
  "--attempt-id",
  options.attemptId,
  "--out",
  options.outDir,
  "--prompt",
  options.promptPath,
  "--head",
  options.head,
  "--base",
  options.base,
  "--image",
  options.image ?? DEFAULT_SWARM_IMAGE,
  "--total-timeout",
  String(Math.max(60, Math.floor(options.totalTimeoutSeconds))),
  "--pi-timeout",
  String(Math.max(30, Math.floor(options.totalTimeoutSeconds * 0.7))),
  ...(options.provider ? ["--provider", options.provider] : []),
  ...(options.model ? ["--model", options.model] : []),
  ...(options.thinking ? ["--thinking", options.thinking] : []),
  ...(options.checkCommand ? ["--check", options.checkCommand] : []),
  "--role",
  "verifier",
  "--lane-id",
  "verifier",
  "--candidate-ids",
  JSON.stringify([...options.candidateIds]),
  "--trial-kind",
  options.trialKind ?? "t1b",
];

const spawnLocal = (args: readonly string[]) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, [localScript, ...args], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

const finalText = async (artifactDir: string) => {
  const raw = await readFile(join(artifactDir, "report.json"), "utf8").catch(
    () => null,
  );
  if (!raw) return null;
  try {
    const report: unknown = JSON.parse(raw);
    const value =
      typeof report === "object" && report !== null
        ? (report as Record<string, unknown>)["finalText"]
        : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

/**
 * Runs one T1a top-level trial.
 *
 * The attempt identity is allocated before the prompt is written and before any
 * model call, so a trial that dies during preparation still has a receipt and
 * still occupies its denominator. A trial that produces no usable verdict list
 * is `invalid`, never a silent pass: every candidate it was given is recorded
 * as an undecided opportunity.
 */
export async function runT1aTrial(
  batch: T1aBatch,
  options: {
    outDir: string;
    runId: string;
    promptTemplatePath?: string;
    image?: string;
    provider?: string;
    model?: string;
    thinking?: string;
    checkCommand?: string;
    totalTimeoutSeconds?: number;
  },
  deps: {
    run?: (args: readonly string[]) => Promise<number>;
    readFinalText?: (dir: string) => Promise<string | null>;
    readReceipt?: (
      dir: string,
    ) => Promise<Awaited<ReturnType<typeof readLocalReceipt>> | null>;
  } = {},
) {
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  assertSingleCheckout(batch);
  const candidateIds = batch.candidates.map((entry) => entry.id);
  const artifactDir = join(options.outDir, options.runId);
  const promptPath = join(options.outDir, `${options.runId}-verifier.txt`);
  const run = deps.run ?? spawnLocal;
  const readText = deps.readFinalText ?? finalText;
  const readReceipt =
    deps.readReceipt ??
    ((dir: string) => readLocalReceipt(dir).catch(() => null));

  const row = {
    attemptId,
    batchId: batch.batchId,
    caseId: batch.caseId,
    runId: options.runId,
    head: batch.head,
    base: batch.base,
    startedAt,
    finishedAt: startedAt,
    transport: "direct-verifier" as const,
    provider: options.provider ?? null,
    model: options.model ?? null,
    thinking: options.thinking ?? null,
    image: options.image ?? DEFAULT_SWARM_IMAGE,
    candidateIds,
    outcome: "preparation-failed" as
      | "completed"
      | "invalid"
      | "failed"
      | "preparation-failed",
    contractError: null as string | null,
    decisions: [] as {
      candidateId: string;
      status: "confirmed" | "rejected" | "duplicate" | null;
      evidenceStrength: string | null;
    }[],
    usage: null as Record<string, number> | null,
    wallSeconds: null as number | null,
    error: null as string | null,
    artifactDir,
    promptPath,
  };

  try {
    const template = await readFile(
      options.promptTemplatePath ?? defaultVerifierPromptPath(),
      "utf8",
    );
    await writeFile(
      promptPath,
      renderVerifierPrompt(template, batch.candidates),
    );
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.finishedAt = new Date().toISOString();
    return row;
  }

  const exitCode = await run(
    verifierArguments({
      runId: options.runId,
      attemptId,
      outDir: options.outDir,
      promptPath,
      head: batch.head,
      base: batch.base,
      trialKind: "t1a",
      ...(options.image ? { image: options.image } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
      ...(options.checkCommand ? { checkCommand: options.checkCommand } : {}),
      totalTimeoutSeconds: options.totalTimeoutSeconds ?? 360,
      candidateIds,
    }),
  );
  const receipt = await readReceipt(artifactDir);
  row.usage = receipt?.usage ?? null;
  row.wallSeconds = receipt?.wallSeconds ?? null;
  row.provider = receipt?.provider ?? row.provider;
  row.model = receipt?.model ?? row.model;
  row.error = receipt?.error ?? null;
  row.finishedAt = new Date().toISOString();

  if (exitCode !== 0 || receipt?.outcome !== "completed") {
    row.outcome = "failed";
    row.error ??= `verifier session exited ${exitCode}`;
    return row;
  }
  const parsed = parseVerdicts(
    (await readText(artifactDir)) ?? "",
    candidateIds,
  );
  if (parsed.error) {
    row.outcome = "invalid";
    row.contractError = parsed.error;
    return row;
  }
  row.outcome = "completed";
  row.decisions = parsed.verdicts.map((verdict) => ({
    candidateId: verdict.id,
    status: verdict.status,
    evidenceStrength: verdict.evidenceStrength,
  }));
  return row;
}

export type T1aTrial = Awaited<ReturnType<typeof runT1aTrial>>;
