/**
 * Exact historical replay for evaluation cases.
 *
 * A reviewer scored against a past change must see that change and nothing
 * else. A plain clone of the working repository would hand it the branch that
 * fixed the defect, the tags around it, the remote it could fetch more from and
 * the review that named the answer, so a replay built that way measures memory
 * rather than review.
 *
 * The replay is therefore a fresh shallow repository holding the two requested
 * commits and nothing else: detached at `head`, a `base` branch for the
 * container's own `base..HEAD` check, no remotes, no tags, no other refs. The
 * shallow depth is what keeps the objects out too - a full fetch of two bare
 * shas makes the server give up on reachability and ship the entire repository,
 * later branches included, where any target that knows a sha can read them.
 *
 * The manifest records tree and diff hashes so a later run can prove it
 * replayed the same bytes.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Refs a replay is allowed to hold, and what each must point at. */
export const REPLAY_REFS = ["refs/heads/base"] as const;

const SHA1 = /^[0-9a-f]{40}$/;

export const assertSha = (value: string, what: string) => {
  if (!SHA1.test(value)) throw new Error(`${what}: not a full commit sha`);
  return value;
};

export function git(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0]} exceeded its deadline`));
    }, options.timeoutMs ?? 120_000);
    deadline.unref();
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolvePromise(out);
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${err}`));
    });
  });
}

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/**
 * Fetches two exact commits out of a local repository.
 *
 * The source is addressed as a `file://` URL rather than a path on purpose. A
 * path lets git take its local shortcut and hardlink the whole object store in,
 * which leaves every later commit sitting in the replay for anything that knows
 * a sha to read - refs would look clean and the fix would still be there.
 *
 * Fetching a bare sha needs the serving side to allow it, and the source
 * repository's configuration is not ours to change, so the permission is
 * handed to the `upload-pack` this fetch spawns and dies with it.
 */
const fetchExact = (
  target: string,
  sourceRepo: string,
  revisions: readonly string[],
  timeoutMs: number,
  depth: number,
) =>
  git(
    [
      "-C",
      target,
      "fetch",
      "--no-tags",
      "--quiet",
      `--depth=${depth}`,
      "--upload-pack",
      "git -c uploadpack.allowAnySHA1InWant=true -c uploadpack.allowReachableSHA1InWant=true upload-pack",
      sourceRepo.startsWith("file://") ? sourceRepo : `file://${sourceRepo}`,
      ...revisions,
    ],
    { timeoutMs },
  );

/** Builds the replay checkout and returns its manifest. */
export async function prepareReplay(options: {
  sourceRepo: string;
  head: string;
  base: string;
  targetDir: string;
  timeoutMs?: number;
  /** Commits of history behind each requested revision; one is the tightest. */
  depth?: number;
}) {
  const head = assertSha(options.head, "head");
  const base = assertSha(options.base, "base");
  const timeoutMs = options.timeoutMs ?? 300_000;
  const target = options.targetDir;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await git(["init", "--quiet", target], { timeoutMs });
  const depth = options.depth ?? 1;
  await fetchExact(target, options.sourceRepo, [head, base], timeoutMs, depth);
  await git(["-C", target, "checkout", "--quiet", "--detach", head], {
    timeoutMs,
  });
  await git(["-C", target, "branch", "-q", "-f", "base", base], { timeoutMs });
  // FETCH_HEAD names the source path; leaving it behind hands the target a
  // route back to the full repository the replay exists to hide.
  await rm(join(target, ".git", "FETCH_HEAD"), { force: true });
  await assertReplayIsolated(target, head, base);
  return { ...(await replayManifest(target, head, base, timeoutMs)), depth };
}

const refLines = async (dir: string) => {
  const raw = await git([
    "-C",
    dir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

/**
 * Rejects a replay that can still reach anything but the two requested commits.
 *
 * Refs and remotes are the whole leak surface: an object nothing points at is
 * unreachable to the target, so checking every ref exhaustively is what proves
 * the future is absent. Walking ancestry would add nothing and would fail
 * outright against a shallow source, which the working checkout is.
 */
export async function assertReplayIsolated(
  dir: string,
  head: string,
  base: string,
) {
  const remotes = (await git(["-C", dir, "remote"]))
    .split("\n")
    .filter(Boolean);
  if (remotes.length > 0) {
    throw new Error(`replay leaks remotes: ${remotes.join(", ")}`);
  }
  const refs = await refLines(dir);
  const allowed = new Map<string, string>([["refs/heads/base", base]]);
  for (const line of refs) {
    const [name, sha] = line.split(" ");
    if (!name || !sha) throw new Error(`replay ref is unreadable: ${line}`);
    const expected = allowed.get(name);
    if (!expected) throw new Error(`replay leaks ref ${name}`);
    if (expected !== sha) {
      throw new Error(`replay ref ${name} points at ${sha}, not ${expected}`);
    }
  }
  const actualHead = (await git(["-C", dir, "rev-parse", "HEAD"])).trim();
  if (actualHead !== head) {
    throw new Error(`replay HEAD is ${actualHead}, not ${head}`);
  }
  const notes = await readdir(join(dir, ".git", "refs")).catch(() => []);
  const unexpected = notes.filter(
    (entry) => entry !== "heads" && entry !== "tags",
  );
  if (unexpected.length > 0) {
    throw new Error(`replay leaks ref namespaces: ${unexpected.join(", ")}`);
  }
}

/** Tree and diff identity of one replay, for freezing and later comparison. */
export async function replayManifest(
  dir: string,
  head: string,
  base: string,
  timeoutMs = 120_000,
) {
  const rev = async (spec: string) =>
    (await git(["-C", dir, "rev-parse", spec], { timeoutMs })).trim();
  const diff = await git(
    [
      "-C",
      dir,
      "--no-pager",
      "diff",
      "--no-color",
      // Abbreviated blob hashes are sized from how many objects the repository
      // holds, so the same change renders differently in a shallow replay than
      // in the full source. Pinning both the index lines and rename detection
      // is what makes the diff hash a property of the change.
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      `${base}..${head}`,
    ],
    { timeoutMs },
  );
  const changedFiles = (
    await git(["-C", dir, "diff", "--name-only", `${base}..${head}`], {
      timeoutMs,
    })
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    dir,
    head,
    base,
    headTree: await rev(`${head}^{tree}`),
    baseTree: await rev(`${base}^{tree}`),
    diffSha256: sha256(diff),
    diffBytes: Buffer.byteLength(diff),
    changedFiles,
    refs: await refLines(dir),
    remotes: [] as string[],
  };
}

export type ReplayManifest = Awaited<ReturnType<typeof replayManifest>>;

/** Two replays of the same case must be byte-identical or the baseline moved. */
export const replaysAgree = (a: ReplayManifest, b: ReplayManifest) =>
  a.head === b.head &&
  a.base === b.base &&
  a.headTree === b.headTree &&
  a.baseTree === b.baseTree &&
  a.diffSha256 === b.diffSha256;
