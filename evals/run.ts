/**
 * Evaluation manifest runner for the local review driver.
 *
 * It runs the same public local command once per case and records what the run
 * actually produced: status, stop reason, model identity, usage, duration and
 * the artifact directory. It does not score, label or compare reviews - a
 * defect judgement needs an answer key this file deliberately does not hold, so
 * P3 adjudicates the recorded reports rather than trusting a count of comments.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRunId, readLocalReceipt } from "../src/local";

const object = (value: unknown, source: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const optionalString = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
) => {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(`${where}: ${key} must be a string`);
  return value;
};

const optionalNumber = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
) => {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number")
    throw new Error(`${where}: ${key} must be a number`);
  return value;
};

const parseCase = (value: unknown, index: number) => {
  const where = `cases[${index}]`;
  const entry = object(value, where);
  const id = optionalString(entry, "id", where);
  if (!id) throw new Error(`${where}: id is required`);
  const head = optionalString(entry, "head", where);
  const base = optionalString(entry, "base", where);
  const pr = optionalNumber(entry, "pr", where);
  if (!pr && !(head && base)) {
    throw new Error(`case ${id}: needs pr, or head and base`);
  }
  return {
    id,
    pr,
    head,
    base,
    prompt: optionalString(entry, "prompt", where),
    context: optionalString(entry, "context", where),
    fixture: optionalString(entry, "fixture", where),
    check: optionalString(entry, "check", where),
  };
};

const parseDefaults = (value: unknown) => {
  const defaults = object(value ?? {}, "defaults");
  return {
    image: optionalString(defaults, "image", "defaults"),
    provider: optionalString(defaults, "provider", "defaults"),
    model: optionalString(defaults, "model", "defaults"),
    thinking: optionalString(defaults, "thinking", "defaults"),
    prompt: optionalString(defaults, "prompt", "defaults"),
    context: optionalString(defaults, "context", "defaults"),
    check: optionalString(defaults, "check", "defaults"),
    installTimeoutSeconds: optionalNumber(
      defaults,
      "installTimeoutSeconds",
      "defaults",
    ),
    piTimeoutSeconds: optionalNumber(defaults, "piTimeoutSeconds", "defaults"),
    totalTimeoutSeconds: optionalNumber(
      defaults,
      "totalTimeoutSeconds",
      "defaults",
    ),
  };
};

/** Validates a manifest at the file boundary; every later type follows it. */
export function parseManifest(raw: string) {
  const manifest = object(JSON.parse(raw), "manifest");
  if (manifest["version"] !== 1) throw new Error("manifest: version must be 1");
  const cases = manifest["cases"];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("manifest: cases must be a non-empty array");
  }
  const parsedCases = cases.map(parseCase);
  const ids = new Set(parsedCases.map((entry) => entry.id));
  if (ids.size !== parsedCases.length) {
    throw new Error("manifest: case ids must be unique");
  }
  return {
    version: 1 as const,
    defaults: parseDefaults(manifest["defaults"]),
    cases: parsedCases,
  };
}

export type EvalManifest = ReturnType<typeof parseManifest>;
export type EvalCase = EvalManifest["cases"][number];

/** Case arguments with manifest defaults applied; a case always wins. */
export function caseArguments(
  manifest: EvalManifest,
  entry: EvalCase,
  runId: string,
  outDir: string,
  attemptId?: string,
) {
  const { defaults } = manifest;
  const prompt = entry.prompt ?? defaults.prompt;
  if (!prompt) throw new Error(`case ${entry.id}: no prompt`);
  const check = entry.check ?? defaults.check;
  const context = entry.context ?? defaults.context;
  return [
    "--run-id",
    runId,
    "--out",
    outDir,
    ...(attemptId ? ["--attempt-id", attemptId] : []),
    "--prompt",
    prompt,
    ...(context ? ["--context", context] : []),
    ...(entry.pr ? ["--pr", String(entry.pr)] : []),
    ...(entry.head ? ["--head", entry.head] : []),
    ...(entry.base ? ["--base", entry.base] : []),
    ...(entry.fixture ? ["--fixture", entry.fixture] : []),
    ...(check ? ["--check", check] : []),
    ...(defaults.image ? ["--image", defaults.image] : []),
    ...(defaults.provider ? ["--provider", defaults.provider] : []),
    ...(defaults.model ? ["--model", defaults.model] : []),
    ...(defaults.thinking ? ["--thinking", defaults.thinking] : []),
    ...(defaults.installTimeoutSeconds
      ? ["--install-timeout", String(defaults.installTimeoutSeconds)]
      : []),
    ...(defaults.piTimeoutSeconds
      ? ["--pi-timeout", String(defaults.piTimeoutSeconds)]
      : []),
    ...(defaults.totalTimeoutSeconds
      ? ["--total-timeout", String(defaults.totalTimeoutSeconds)]
      : []),
  ];
}

const lastStopReason = (trace: string) =>
  trace
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      const stopReason =
        typeof event === "object" && event !== null
          ? (event as Readonly<Record<string, unknown>>)["stopReason"]
          : undefined;
      return typeof stopReason === "string" ? [stopReason] : [];
    })
    .at(-1) ?? null;

/** Reads one finished run's receipt and trace into a comparable case row. */
export async function caseResult(
  entry: Pick<EvalCase, "id">,
  runId: string,
  artifactDir: string,
  attemptId: string,
  childExitCode: number,
) {
  let receiptError: string | null = null;
  const receipt = await readLocalReceipt(artifactDir).catch((error) => {
    receiptError = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  const trace = await readFile(join(artifactDir, "trace.jsonl"), "utf8").catch(
    () => "",
  );
  let stopReason: string | null = null;
  let traceError: string | null = null;
  try {
    stopReason = lastStopReason(trace);
  } catch (error) {
    traceError = `trace.jsonl: ${error instanceof Error ? error.message : String(error)}`;
  }
  const receiptMatches =
    receipt?.runId === runId && receipt.attemptId === attemptId;
  const childMatches =
    receipt &&
    (childExitCode === 0
      ? receipt.outcome === "completed"
      : receipt.outcome !== "completed");
  const validReceipt =
    receiptMatches &&
    childMatches &&
    !(receipt.outcome === "completed" && traceError);
  const driverError = !validReceipt
    ? [
        `local driver exited ${childExitCode}`,
        !receiptMatches ? "receipt does not match this attempt" : null,
        !childMatches ? "receipt outcome contradicts child exit" : null,
        traceError,
        receiptError,
      ]
        .filter(Boolean)
        .join("; ")
    : null;
  return {
    id: entry.id,
    runId,
    attemptId,
    outcome: validReceipt ? receipt.outcome : ("driver-error" as const),
    stopReason: receiptMatches ? stopReason : null,
    provider: receiptMatches ? receipt.provider : null,
    model: receiptMatches ? receipt.model : null,
    wallSeconds: receiptMatches ? receipt.wallSeconds : null,
    teardownSeconds: receiptMatches ? receipt.teardownSeconds : null,
    usage: receiptMatches ? receipt.usage : null,
    artifactDir,
    error:
      driverError ??
      (receiptMatches
        ? [receipt.error, traceError].filter(Boolean).join("; ") || null
        : null),
  };
}

export type CaseResult = Awaited<ReturnType<typeof caseResult>>;

export const summarize = (results: CaseResult[]) => ({
  total: results.length,
  completed: results.filter((row) => row.outcome === "completed").length,
  failed: results.filter((row) => row.outcome !== "completed").length,
});

/**
 * Hashes the exact source that will run, file by file.
 *
 * The evaluation code is uncommitted while it is being built, so there is no
 * commit to name and claiming one would be a lie a later reader cannot detect.
 * The tree hash is the identity instead: it changes the moment any input to the
 * measurement changes, which is the property a baseline actually needs.
 */
export async function sourceTreeHash(files: readonly string[]) {
  const entries: { path: string; sha256: string }[] = [];
  for (const path of [...files].sort()) {
    entries.push({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  }
  return {
    files: entries,
    treeSha256: createHash("sha256")
      .update(
        entries.map((entry) => `${entry.path} ${entry.sha256}`).join("\n"),
      )
      .digest("hex"),
  };
}

/**
 * Freezes one evaluation baseline.
 *
 * Every field is supplied by the caller and none is defaulted: a fabricated
 * provider rate or a silently zeroed token cap would make the resulting numbers
 * look admissible while being unenforceable, so an absent input is an error.
 */
export function buildBaselineLock(input: {
  tree: Awaited<ReturnType<typeof sourceTreeHash>>;
  worktree: { commit: string | null; dirty: boolean };
  imageDigest: string;
  corpusHash: string;
  keysetHash: string;
  promptHashes: Readonly<Record<string, string>>;
  providers: readonly {
    name: string;
    model: string;
    maxProviderRequests: number;
    maxHttpRetriesPerRequest: number;
    maxInputTokensPerRequest: number;
    maxOutputTokensPerRequest: number;
    maxInputTokensPerSession: number;
    maxOutputTokensPerSession: number;
    billingBasis: "paid" | "subscription" | "unknown";
  }[];
  timeoutsSeconds: Readonly<Record<string, number>>;
  toolchain: Readonly<Record<string, string>>;
}) {
  if (input.providers.length === 0) {
    throw new Error("baseline lock: at least one provider configuration");
  }
  for (const provider of input.providers) {
    for (const [key, value] of Object.entries(provider)) {
      if (typeof value === "number" && !(value > 0)) {
        throw new Error(
          `baseline lock: ${provider.name}.${key} must be positive`,
        );
      }
    }
  }
  if (Object.keys(input.promptHashes).length === 0) {
    throw new Error("baseline lock: prompt hashes are required");
  }
  const body = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    source: input.tree,
    worktree: input.worktree,
    imageDigest: input.imageDigest,
    corpusHash: input.corpusHash,
    keysetHash: input.keysetHash,
    promptHashes: input.promptHashes,
    providers: input.providers,
    timeoutsSeconds: input.timeoutsSeconds,
    toolchain: input.toolchain,
  };
  return {
    ...body,
    baselineId: createHash("sha256")
      .update(JSON.stringify(body.source.treeSha256))
      .update(JSON.stringify({ ...body, createdAt: null }))
      .digest("hex")
      .slice(0, 32),
  };
}

export type BaselineLock = ReturnType<typeof buildBaselineLock>;

/**
 * Refuses a baseline whose transports were never exercised for real.
 *
 * A simulated receipt proves the scorer can read JSON, not that the verifier
 * ruled on anything, so both transports must present a trace whose stages
 * actually ran before any pilot call is made under this baseline.
 */
export function certifyTransports(input: {
  t1a: { transport: string; outcome: string; decisions: readonly unknown[] };
  t1b: {
    transport: string;
    trace: { reviewerLanes: number; verifierStatus: string } | null;
  };
}) {
  const problems: string[] = [];
  if (input.t1a.transport !== "direct-verifier") {
    problems.push(`t1a transport is ${input.t1a.transport}`);
  }
  if (input.t1a.outcome !== "completed" || input.t1a.decisions.length === 0) {
    problems.push("t1a certification trace produced no verifier decision");
  }
  if (input.t1b.transport !== "real-swarm") {
    problems.push(`t1b transport is ${input.t1b.transport}`);
  }
  if (!input.t1b.trace || input.t1b.trace.reviewerLanes < 1) {
    problems.push("t1b certification trace ran no reviewer lane");
  }
  if (input.t1b.trace && input.t1b.trace.verifierStatus === "not_run") {
    problems.push("t1b certification trace never reached the verifier");
  }
  if (problems.length > 0) {
    throw new Error(`transport certification failed: ${problems.join("; ")}`);
  }
  return true;
}

const runLocal = (args: string[]) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(dirname(fileURLToPath(import.meta.url)), "..", "src", "local.ts"),
        ...args,
      ],
      { stdio: "inherit" },
    );
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

async function main() {
  const argv = process.argv.slice(2);
  const at = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const manifestPath = at("manifest");
  const outRoot = at("out");
  if (!manifestPath || !outRoot) {
    throw new Error("--manifest and --out are required");
  }
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const suiteId = assertRunId(
    at("suite-id") ?? `eval-${Date.now().toString(36)}`,
  );
  const suiteDir = resolve(outRoot, suiteId);
  await mkdir(outRoot, { recursive: true });
  await mkdir(suiteDir);

  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  for (const entry of manifest.cases) {
    const runId = assertRunId(`${suiteId}-${entry.id}`);
    const attemptId = randomUUID();
    console.log(`case ${entry.id} -> ${runId}`);
    const childExitCode = await runLocal(
      caseArguments(manifest, entry, runId, suiteDir, attemptId),
    );
    results.push(
      await caseResult(
        entry,
        runId,
        join(suiteDir, runId),
        attemptId,
        childExitCode,
      ),
    );
  }

  const report = {
    suiteId,
    manifest: resolve(manifestPath),
    startedAt,
    finishedAt: new Date().toISOString(),
    qualityAdjudication: "not-performed",
    summary: summarize(results),
    cases: results,
  };
  await writeFile(
    join(suiteDir, "eval-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`eval results: ${join(suiteDir, "eval-result.json")}`);
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
