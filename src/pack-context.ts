/**
 * Host-side context pack for a fast review lane.
 *
 * The checkout already has the tree at `head`. This is the index: the assigned
 * diff plus git-grep hits for symbols the diff introduced, capped so one model
 * call can hold it.
 */

import { execFileSync } from "node:child_process";
import { SESSION_CAPS } from "./provider-budget";

const GREP_HITS = 20;

/**
 * Chars per token, low enough to stay conservative on the worst input.
 *
 * Measured over real packs: prose and source run near 3.8, minified locale
 * JSON as low as 3.37. Overestimating the ratio buys a pack the provider
 * refuses outright, so the budget is derived from the floor, not the average.
 */
const CHARS_PER_TOKEN = 3;

/** Room left for the instructions the pack is appended to. */
const PROMPT_RESERVE_TOKENS = 2_000;

/**
 * The prompt ceiling each model enforces, in tokens.
 *
 * A request over it is refused whole, so this is a hard bound on the pack, not
 * a preference. Unknown models get the smallest ceiling worth assuming.
 *
 * The gateway's `/compat` route does not publish a context window, so each
 * entry is the number the request is bounded by, never the largest the model
 * would take: too low drops a file the lane could have read, too high fails the
 * whole request. The Workers AI and OpenAI figures are the ones the provider
 * publishes; the rest are held to the family's own documented floor.
 *
 * The one remaining entry carries the measurement behind it. Sonnet 5 answered
 * a 400k-token prompt through the gateway on 2026-09-10, and a pack at its
 * ceiling below reaches the model as roughly 208k tokens (Claude tokenizes this
 * repository's code near 2.6 chars per token, denser than the estimate
 * `packBudgetChars` makes), so the family's 200k floor is what the pack is held
 * to, not the model's own window.
 */
const MODEL_PROMPT_TOKENS = new Map<string, number>([
  ["grok-4.6", 500_000],
  ["anthropic/claude-sonnet-5", 200_000],
  ["anthropic/claude-opus-5", 200_000],
  // 1,048,576 is also the t1b per-request cap, so the trial binds first.
  ["openai/gpt-5.6-luna", 1_050_000],
  ["workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", 1_048_576],
]);

const UNKNOWN_MODEL_PROMPT_TOKENS = 128_000;

/**
 * How much source one lane may pack.
 *
 * The ceiling is whichever binds first: the per-request input cap the trial
 * declares, or the prompt length the model accepts. A pack derived from the
 * larger of the two is a request the provider rejects after the run has
 * already committed to it.
 */
export const packBudgetChars = (
  trialKind: keyof typeof SESSION_CAPS,
  model: string,
) =>
  (Math.min(
    SESSION_CAPS[trialKind].maxInputTokensPerRequest,
    MODEL_PROMPT_TOKENS.get(model) ?? UNKNOWN_MODEL_PROMPT_TOKENS,
  ) -
    PROMPT_RESERVE_TOKENS) *
  CHARS_PER_TOKEN;

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    // Wide enough that the pack budget is what limits a pack, not the pipe: a
    // diff larger than the buffer fails with a broken pipe nobody can read as
    // "this change is too big".
    maxBuffer: SESSION_CAPS.t1b.maxRequestBytes,
  });

export function symbolsFromDiff(diff: string) {
  const found = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const match =
      /^\+\s*export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
        line,
      ) ?? /^\+\s*(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (match?.[1]) found.add(match[1]);
  }
  return [...found];
}

const rangeDiff = (
  input: { repo: string; head: string; base: string },
  args: readonly string[],
  files: readonly string[],
) => {
  const fileArgs = files.length > 0 ? ["--", ...files] : [];
  try {
    return git(input.repo, [
      "diff",
      ...args,
      `${input.base}...${input.head}`,
      ...fileArgs,
    ]);
  } catch {
    return git(input.repo, [
      "diff",
      ...args,
      `${input.base}..${input.head}`,
      ...fileArgs,
    ]);
  }
};

const changeDiff = (
  input: { repo: string; head: string; base: string },
  files: readonly string[],
) => rangeDiff(input, [], files);

// `--numstat` prints `-` for both counts of a file git could not diff as text.
const isBinaryChange = (
  input: { repo: string; head: string; base: string },
  file: string,
) => rangeDiff(input, ["--numstat"], [file]).startsWith("-\t-\t");

const bytesAtHead = (input: { repo: string; head: string }, file: string) => {
  try {
    return Number(git(input.repo, ["cat-file", "-s", `${input.head}:${file}`]));
  } catch {
    return 0;
  }
};

export function packLaneContext(input: {
  repo: string;
  head: string;
  base: string;
  files: readonly string[];
  budget: number;
}) {
  const diff = changeDiff(input, input.files);
  const symbols = symbolsFromDiff(diff);
  const grepLines: string[] = [];
  for (const symbol of symbols) {
    try {
      const hits = git(input.repo, [
        "grep",
        "-n",
        "-I",
        "-F",
        symbol,
        input.head,
        "--",
        "*.ts",
        "*.tsx",
      ]);
      grepLines.push(...hits.split("\n").filter(Boolean));
    } catch {
      continue;
    }
    if (grepLines.length >= GREP_HITS) break;
  }
  const extraFiles = [
    ...new Set(
      grepLines.slice(0, GREP_HITS).flatMap((line) => {
        // `git grep <rev>` prefixes every hit with that same revision, so the
        // path is what follows it. Matching the revision by shape instead
        // would read the revision itself as a path for any head that is not a
        // full sha, and every file it named would silently fail to pack.
        const hit = line.startsWith(`${input.head}:`)
          ? line.slice(input.head.length + 1)
          : line;
        const path = hit.split(":")[0] ?? "";
        return path && !input.files.includes(path) ? [path] : [];
      }),
    ),
  ].slice(0, 8);

  // Files enter whole or not at all, and what did not fit is named. A pack cut
  // mid-file would leave the model reviewing half a source it believes it has,
  // and the caller could not tell that lane apart from one that read
  // everything.
  const diffSection = `# Diff\n${diff}`;
  const truncated = diffSection.length > input.budget;
  const parts: string[] = [
    truncated ? diffSection.slice(0, input.budget) : diffSection,
  ];
  let used = parts[0]?.length ?? 0;
  const filesPacked: string[] = [];
  const droppedFiles: string[] = [];
  const missingAtHead: string[] = [];
  for (const file of [...input.files, ...extraFiles]) {
    let body = "";
    try {
      body = git(input.repo, ["show", `${input.head}:${file}`]);
    } catch {
      // A file the change deletes has no source at head, and the diff is the
      // whole evidence for it. Recorded rather than blocking, because the
      // alternative reads every deletion as an unreviewed file.
      missingAtHead.push(file);
      continue;
    }
    const section = `# ${file}\n${body}`;
    if (used + section.length + 2 > input.budget) {
      droppedFiles.push(file);
      continue;
    }
    parts.push(section);
    filesPacked.push(file);
    used += section.length + 2;
  }
  const callSites = `# Call sites\n${grepLines.slice(0, GREP_HITS).join("\n")}`;
  if (grepLines.length > 0 && used + callSites.length + 2 <= input.budget) {
    parts.push(callSites);
  }
  const pack = parts.join("\n\n");
  return {
    pack,
    filesPacked,
    droppedFiles,
    missingAtHead,
    symbols,
    bytes: pack.length,
    truncated,
  };
}

/**
 * The changed files no lane could pack: a binary, which no model reads as
 * text, and a file whose diff and source at head together take more than half
 * a lane's budget, since the lane it landed in would drop the source, block on
 * it and review nothing else. A font or a lockfile of that size is named as
 * not reviewed instead of costing the change its review.
 */
export function unpackableFiles(input: {
  repo: string;
  head: string;
  base: string;
  files: readonly string[];
  budget: number;
}) {
  const unpackable: {
    file: string;
    diffBytes: number;
    headBytes: number;
    binary: boolean;
  }[] = [];
  for (const file of input.files) {
    const diffBytes = changeDiff(input, [file]).length;
    const headBytes = bytesAtHead(input, file);
    const binary = isBinaryChange(input, file);
    if (binary || diffBytes + headBytes > input.budget / 2) {
      unpackable.push({ file, diffBytes, headBytes, binary });
    }
  }
  return unpackable;
}

export const wholeChangePack = (input: {
  repo: string;
  head: string;
  base: string;
  files: readonly string[];
}) => packLaneContext({ ...input, budget: Number.POSITIVE_INFINITY });

export const wholeChangeFits = (input: {
  repo: string;
  head: string;
  base: string;
  files: readonly string[];
  budget: number;
}) => wholeChangePack(input).bytes <= input.budget;
