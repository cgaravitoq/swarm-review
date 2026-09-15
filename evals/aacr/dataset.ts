/**
 * The AACR-Bench instance, as its own dataset defines it.
 *
 * One JSONL line is one case, and only the four fields a run needs are read.
 * `reference_comments` is the benchmark's answer key: the harness never looks
 * at it, so it cannot leak into a prompt or into a result file.
 */

const object = (value: unknown, source: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const requiredString = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
) => {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: ${key} is required`);
  }
  return value.trim();
};

const optionalString = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
) => {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: ${key} must be a non-empty string`);
  }
  return value.trim();
};

export type AacrCase = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  headCommit: string;
  cloneUrl: string;
};

/** GitHub's own URL for an `owner/name` pair, when the line names none. */
const derivedCloneUrl = (repo: string) => `https://github.com/${repo}.git`;

export function parseDataset(raw: string) {
  const cases: AacrCase[] = [];
  const seen = new Set<string>();
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    const where = `line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${where}: not JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const entry = object(parsed, where);
    const instanceId = requiredString(entry, "instance_id", where);
    if (seen.has(instanceId)) {
      throw new Error(`${where}: duplicate instance_id ${instanceId}`);
    }
    seen.add(instanceId);
    const repo = requiredString(entry, "repo", where);
    if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
      throw new Error(`${where}: repo must be owner/name, not ${repo}`);
    }
    cases.push({
      instanceId,
      repo,
      baseCommit: requiredString(entry, "base_commit", where),
      headCommit: requiredString(entry, "head_commit", where),
      cloneUrl:
        optionalString(entry, "clone_url", where) ?? derivedCloneUrl(repo),
    });
  }
  if (cases.length === 0) throw new Error("dataset holds no case");
  return cases;
}
