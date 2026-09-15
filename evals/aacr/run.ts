/**
 * Runs swarm-review over AACR-Bench cases and writes the result files the
 * benchmark's own eval stage scores.
 *
 * The benchmark never sees the swarm's receipt. It sees OCR-shaped result
 * files, one directory holding every reviewer claim and one holding what a
 * pull request review would have carried. Each case is cloned from its own
 * repository, reviewed at its own base and head, and recorded in a sidecar
 * whether it finished or not: a case that failed is a failed case with a
 * reason, never an empty review, and its result files are removed so a stale
 * success cannot be scored as this run's output.
 *
 * The swarm is driven as a subprocess, never through its internals, so what
 * these numbers measure is the product that runs, not a reconstruction of it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { RUN_ID_MAX_LENGTH, RUN_ID_PATTERN } from "../../src/isolation";
import {
  LANE_RELAUNCHES,
  MAX_REVIEWER_LANES,
  reviewerLaneId,
} from "../../src/swarm";
import { swarmScriptPath } from "../swarm";
import type { AacrCase } from "./dataset";
import { parseDataset } from "./dataset";
import type { AacrCaseSidecar, CaseStatus, SwarmRunReceipt } from "./result";
import {
  buildResultFile,
  commentFrom,
  installSkipEvidence,
  MIN_SEVERITY,
  parseSwarmReceipt,
  publishedFindings,
  readCaseSidecar,
  safeResultId,
  sumUsage,
} from "./result";

export const USAGE = `Usage: bun run evals/aacr/run.ts --dataset <jsonl> --out <dir> --max-cost-usd <usd> [--limit <n>] [--instance <id>]...

Runs swarm-review on AACR-Bench cases and writes the result files the
benchmark's eval stage scores: <out>/candidates holds every reviewer claim and
<out>/confirmed holds what a pull request review would post.

  --dataset <path>      AACR-Bench dataset in its standard JSONL format
  --out <dir>           run root: result files, git cache, per-case sidecars
  --max-cost-usd <usd>  per-case provider sub-cap, passed as --remaining-subcap
  --limit <n>           run at most the first n cases in file order
  --instance <id>       run only this instance; repeatable
  --help                print this message

Result files are named <instance_id with "/" replaced by "__">.json and are
evaluated with:

  python -m pipeline run --stage eval --reviewer ocr \\
    --results-dir <out>/confirmed --run-id <id> --dataset data/aacr_bench.jsonl

A case whose sidecar records a failure and that passes in a later --instance
run is reported as flaky in that run's report.`;

export type AacrOptions = {
  dataset: string;
  out: string;
  maxCostUsd: number;
  limit?: number;
  instances?: readonly string[];
};

const flag = (argv: readonly string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
};

const repeatable = (argv: readonly string[], name: string) => {
  const values: string[] = [];
  for (const [index, entry] of argv.entries()) {
    if (entry !== `--${name}`) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value`);
    }
    values.push(value);
  }
  return values;
};

/** Validates the command line; every flag the help names is read here. */
export const parseAacrArgs = (argv: readonly string[]): AacrOptions => {
  const dataset = flag(argv, "dataset");
  if (!dataset) throw new Error("--dataset is required");
  const out = flag(argv, "out");
  if (!out) throw new Error("--out is required");
  const maxCostUsd = Number(flag(argv, "max-cost-usd"));
  if (!(maxCostUsd > 0)) {
    throw new Error("--max-cost-usd must be a positive number of dollars");
  }
  const limitRaw = flag(argv, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive whole number");
  }
  const instances = repeatable(argv, "instance");
  const known = new Set([
    "dataset",
    "out",
    "max-cost-usd",
    "limit",
    "instance",
    "help",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index] ?? "";
    if (!entry.startsWith("--")) {
      throw new Error(`unexpected argument ${entry}`);
    }
    const name = entry.slice(2);
    if (!known.has(name)) throw new Error(`unknown flag ${entry}`);
    if (name === "help") continue;
    if (argv[index + 1] === undefined) {
      throw new Error(`--${name} needs a value`);
    }
    index += 1;
  }
  return {
    dataset,
    out,
    maxCostUsd,
    ...(limit === undefined ? {} : { limit }),
    ...(instances.length === 0 ? {} : { instances }),
  };
};

/**
 * The cases this invocation reviews.
 *
 * An `--instance` that names nothing in the dataset is an error rather than an
 * empty run: a typo must not read as a corpus that produced no findings.
 */
export const selectCases = (
  cases: readonly AacrCase[],
  options: Pick<AacrOptions, "limit" | "instances">,
) => {
  const wanted = options.instances ?? [];
  if (wanted.length > 0) {
    const known = new Set(cases.map((entry) => entry.instanceId));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`--instance names no case: ${missing.join(", ")}`);
    }
  }
  const selected =
    wanted.length > 0
      ? cases.filter((entry) => wanted.includes(entry.instanceId))
      : cases;
  const limited =
    options.limit === undefined ? selected : selected.slice(0, options.limit);
  if (limited.length === 0) throw new Error("no case selected");
  return limited;
};

export type GitInvocation = { args: string[]; cwd?: string };
export type GitRunner = (invocation: GitInvocation) => Promise<number>;
export type SwarmRunner = (args: readonly string[]) => Promise<number>;

/**
 * The swarm derives every lane's run id from the swarm id: the reviewer and
 * verifier ids are asserted at startup and the relaunch id when a lane is
 * relaunched. The longest is a relaunched reviewer lane, so bounding the
 * swarm id by that suffix covers every one of them.
 */
const LONGEST_LANE_SUFFIX = `-${reviewerLaneId(MAX_REVIEWER_LANES - 1)}-r${LANE_RELAUNCHES + 1}`;
export const SWARM_ID_MAX_LENGTH =
  RUN_ID_MAX_LENGTH - LONGEST_LANE_SUFFIX.length;

export const swarmIdFor = (instanceId: string) => {
  const cleaned = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length <= SWARM_ID_MAX_LENGTH && RUN_ID_PATTERN.test(cleaned)) {
    return cleaned;
  }
  return `aacr-${createHash("sha256").update(instanceId).digest("hex").slice(0, 16)}`;
};

/** The swarm invocation one case is driven through. */
export const swarmRunArguments = (input: {
  swarmId: string;
  out: string;
  repo: string;
  source: string;
  head: string;
  base: string;
  maxCostUsd: number;
}) => [
  "--swarm-id",
  input.swarmId,
  "--out",
  input.out,
  "--repo",
  input.repo,
  "--source",
  input.source,
  "--head",
  input.head,
  "--base",
  input.base,
  "--remaining-subcap",
  String(input.maxCostUsd),
];

const spawnGit: GitRunner = (invocation) =>
  new Promise((resolvePromise) => {
    const child = spawn("git", invocation.args, {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    });
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

const spawnSwarm: SwarmRunner = (args) =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [swarmScriptPath(), ...args], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", () => resolvePromise(1));
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

const isClone = async (dir: string) => {
  try {
    await access(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

/**
 * Clones a case's repository once and keeps both commits in it.
 *
 * The cache is shared by every case on the same repository, so a second case
 * only fetches what is missing rather than cloning again. Both revisions must
 * be in the object store before the swarm is spawned: a lane that can only see
 * one of them would review a diff nobody asked for.
 */
export async function prepareCheckout(
  cacheDir: string,
  revisions: { cloneUrl: string; head: string; base: string },
  runGit: GitRunner,
) {
  if (!(await isClone(cacheDir))) {
    await rm(cacheDir, { recursive: true, force: true });
    const cloned = await runGit({
      args: ["clone", "--quiet", revisions.cloneUrl, cacheDir],
    });
    if (cloned !== 0) {
      throw new Error(`git clone ${revisions.cloneUrl} failed`);
    }
  }
  const present = async (sha: string) =>
    (await runGit({
      args: ["-C", cacheDir, "cat-file", "-e", `${sha}^{commit}`],
    })) === 0;
  if (!(await present(revisions.head)) || !(await present(revisions.base))) {
    const fetched = await runGit({
      args: [
        "-C",
        cacheDir,
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        revisions.head,
        revisions.base,
      ],
    });
    if (
      fetched !== 0 ||
      !(await present(revisions.head)) ||
      !(await present(revisions.base))
    ) {
      throw new Error(
        `checkout is missing ${revisions.head} or ${revisions.base}`,
      );
    }
  }
  const checkedOut = await runGit({
    args: ["-C", cacheDir, "checkout", "--quiet", "--detach", revisions.head],
  });
  if (checkedOut !== 0) {
    throw new Error(`git checkout ${revisions.head} failed`);
  }
}

export type AacrRunOptions = {
  out: string;
  runId: string;
  maxCostUsd: number;
  targeted: boolean;
  minSeverity?: string;
  now?: () => Date;
};

export type AacrCaseDeps = {
  runGit?: GitRunner;
  runSwarm?: SwarmRunner;
  readReceipt?: (path: string) => Promise<string>;
};

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const casePaths = (out: string, instanceId: string) => {
  const safeId = safeResultId(instanceId);
  return {
    candidates: join(out, "candidates", `${safeId}.json`),
    confirmed: join(out, "confirmed", `${safeId}.json`),
    sidecar: join(out, "cases", `${safeId}.json`),
  };
};

/**
 * Runs one case and always leaves a record of it.
 *
 * A failed case keeps no result files: an absent file is counted as missing by
 * the benchmark, while an empty review would be counted as a review that found
 * nothing, which is the one thing a failure is not.
 */
export async function runAacrCase(
  entry: AacrCase,
  options: AacrRunOptions,
  deps: AacrCaseDeps = {},
): Promise<AacrCaseSidecar> {
  const runGit = deps.runGit ?? spawnGit;
  const runSwarm = deps.runSwarm ?? spawnSwarm;
  const readReceipt =
    deps.readReceipt ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? (() => new Date());
  const minSeverity = options.minSeverity ?? MIN_SEVERITY;
  const paths = casePaths(options.out, entry.instanceId);
  const swarmId = swarmIdFor(entry.instanceId);
  const checkoutDir = join(options.out, "repos", safeResultId(entry.repo));
  const swarmOut = join(options.out, "swarms", options.runId);
  const receiptPath = join(swarmOut, swarmId, "swarm-receipt.json");
  const startedAt = now().toISOString();

  let previous: ReturnType<typeof readCaseSidecar> | null = null;
  try {
    previous = readCaseSidecar(await readFile(paths.sidecar, "utf8"));
  } catch {
    previous = null;
  }

  const fail = async (reason: string): Promise<AacrCaseSidecar> => {
    await Promise.all([
      rm(paths.candidates, { force: true }),
      rm(paths.confirmed, { force: true }),
    ]);
    const sidecar: AacrCaseSidecar = {
      instanceId: entry.instanceId,
      repo: entry.repo,
      baseCommit: entry.baseCommit,
      headCommit: entry.headCommit,
      runId: options.runId,
      swarmId,
      status: "failed",
      reason,
      outcome: null,
      wallSeconds: null,
      usage: null,
      installSkipped: null,
      installSkipReason: null,
      candidates: 0,
      confirmed: 0,
      flaky: false,
      previousFailure: null,
      startedAt,
      finishedAt: now().toISOString(),
    };
    await writeJson(paths.sidecar, sidecar);
    return sidecar;
  };

  let receipt: SwarmRunReceipt;
  try {
    await prepareCheckout(
      checkoutDir,
      {
        cloneUrl: entry.cloneUrl,
        head: entry.headCommit,
        base: entry.baseCommit,
      },
      runGit,
    );
    const exitCode = await runSwarm(
      swarmRunArguments({
        swarmId,
        out: swarmOut,
        repo: entry.repo,
        source: checkoutDir,
        head: entry.headCommit,
        base: entry.baseCommit,
        maxCostUsd: options.maxCostUsd,
      }),
    );
    // A partial run exits non-zero but carries confirmed findings, so the
    // receipt decides whether there is a review, not the exit code alone.
    try {
      receipt = parseSwarmReceipt(
        JSON.parse(await readReceipt(receiptPath)) as unknown,
      );
    } catch (error) {
      return await fail(
        `swarm exited ${exitCode} with no readable receipt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }

  if (receipt.status !== "completed" && receipt.status !== "partial") {
    return await fail(
      `swarm status ${receipt.status}${receipt.abortReason ? `: ${receipt.abortReason}` : ""}`,
    );
  }
  if (
    receipt.requested.head !== entry.headCommit ||
    receipt.requested.base !== entry.baseCommit
  ) {
    return await fail(
      `receipt is for ${receipt.requested.head}/${receipt.requested.base}, not this case`,
    );
  }

  const usage = sumUsage(receipt.lanes);
  const skipped = installSkipEvidence(receipt);
  const candidates = receipt.candidates.map(commentFrom);
  const confirmed = publishedFindings(receipt.findings, minSeverity).map(
    commentFrom,
  );
  const envelope = {
    entry,
    startedAt,
    wallSeconds: receipt.wallSeconds ?? null,
    usage,
  };
  await Promise.all([
    writeJson(
      paths.candidates,
      buildResultFile({ ...envelope, comments: candidates }),
    ),
    writeJson(
      paths.confirmed,
      buildResultFile({ ...envelope, comments: confirmed }),
    ),
  ]);

  const flaky = options.targeted && previous?.status === "failed";
  const sidecar: AacrCaseSidecar = {
    instanceId: entry.instanceId,
    repo: entry.repo,
    baseCommit: entry.baseCommit,
    headCommit: entry.headCommit,
    runId: options.runId,
    swarmId,
    status: receipt.status as CaseStatus,
    reason: receipt.abortReason,
    outcome: receipt.outcome,
    wallSeconds: receipt.wallSeconds ?? null,
    usage,
    installSkipped: skipped.skipped,
    installSkipReason: skipped.reason,
    candidates: candidates.length,
    confirmed: confirmed.length,
    flaky,
    previousFailure:
      flaky && previous
        ? {
            runId: previous.runId,
            status: previous.status,
            reason: previous.reason,
          }
        : null,
    startedAt,
    finishedAt: now().toISOString(),
  };
  await writeJson(paths.sidecar, sidecar);
  return sidecar;
}

export type AacrRunReport = {
  runId: string;
  dataset: string;
  out: string;
  maxCostUsd: number;
  targeted: boolean;
  startedAt: string;
  finishedAt: string;
  summary: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    flaky: number;
  };
  cases: {
    instanceId: string;
    status: CaseStatus;
    reason: string | null;
    flaky: boolean;
    wallSeconds: number | null;
    candidates: number;
    confirmed: number;
  }[];
};

export type AacrSuiteDeps = AacrCaseDeps & {
  now?: () => Date;
  runId?: string;
};

/** Runs every selected case, then writes the run report beside them. */
export async function runAacrSuite(
  options: AacrOptions,
  deps: AacrSuiteDeps = {},
): Promise<AacrRunReport> {
  const now = deps.now ?? (() => new Date());
  const cases = selectCases(
    parseDataset(await readFile(options.dataset, "utf8")),
    options,
  );
  const runId = deps.runId ?? `aacr-${Date.now().toString(36)}`;
  const out = resolve(options.out);
  await mkdir(out, { recursive: true });
  const targeted = (options.instances ?? []).length > 0;
  const startedAt = now().toISOString();
  const sidecars: AacrCaseSidecar[] = [];
  const caseDeps: AacrCaseDeps = {
    ...(deps.runGit ? { runGit: deps.runGit } : {}),
    ...(deps.runSwarm ? { runSwarm: deps.runSwarm } : {}),
    ...(deps.readReceipt ? { readReceipt: deps.readReceipt } : {}),
  };
  for (const entry of cases) {
    console.log(`case ${entry.instanceId} (${entry.repo})`);
    sidecars.push(
      await runAacrCase(
        entry,
        {
          out,
          runId,
          maxCostUsd: options.maxCostUsd,
          targeted,
          now,
        },
        caseDeps,
      ),
    );
  }
  const report: AacrRunReport = {
    runId,
    dataset: resolve(options.dataset),
    out,
    maxCostUsd: options.maxCostUsd,
    targeted,
    startedAt,
    finishedAt: now().toISOString(),
    summary: {
      total: sidecars.length,
      completed: sidecars.filter((row) => row.status === "completed").length,
      partial: sidecars.filter((row) => row.status === "partial").length,
      failed: sidecars.filter((row) => row.status === "failed").length,
      flaky: sidecars.filter((row) => row.flaky).length,
    },
    cases: sidecars.map((row) => ({
      instanceId: row.instanceId,
      status: row.status,
      reason: row.reason,
      flaky: row.flaky,
      wallSeconds: row.wallSeconds,
      candidates: row.candidates,
      confirmed: row.confirmed,
    })),
  };
  await writeJson(join(out, "runs", `${runId}.json`), report);
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  let options: AacrOptions;
  try {
    options = parseAacrArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const report = await runAacrSuite(options);
  console.log(
    `aacr run ${report.runId}: ${report.summary.completed} completed, ${report.summary.partial} partial, ${report.summary.failed} failed, ${report.summary.flaky} flaky`,
  );
  console.log(
    `results: ${join(report.out, "candidates")} and ${join(report.out, "confirmed")}`,
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
