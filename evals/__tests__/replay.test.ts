import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReplayIsolated,
  git,
  prepareReplay,
  replayManifest,
  replaysAgree,
} from "../replay";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-pi-replay-"));
  temporary.push(dir);
  return dir;
};

const run = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const commit = (repo: string, message: string) =>
  run(repo, [
    "-c",
    "user.name=replay-test",
    "-c",
    "user.email=replay@test",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);

/** base -> head (the case) -> fix (the later correction the target must not see). */
const historyRepo = async () => {
  const repo = await scratch();
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  await writeFile(join(repo, "app.ts"), "export const timeout = 30;\n");
  run(repo, ["add", "."]);
  commit(repo, "base");
  const base = run(repo, ["rev-parse", "HEAD"]).trim();
  await writeFile(join(repo, "app.ts"), "export const timeout = 0;\n");
  run(repo, ["add", "."]);
  commit(repo, "head: the defect under review");
  const head = run(repo, ["rev-parse", "HEAD"]).trim();
  await writeFile(join(repo, "app.ts"), "export const timeout = 30;\n");
  run(repo, ["add", "."]);
  commit(repo, "fix: restore the timeout");
  const fix = run(repo, ["rev-parse", "HEAD"]).trim();
  run(repo, ["tag", "v1.0.0"]);
  run(repo, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  return { repo, base, head, fix };
};

describe("prepareReplay", () => {
  it("exposes the case history and nothing after it", async () => {
    const { repo, base, head } = await historyRepo();
    const target = join(await scratch(), "replay");
    const manifest = await prepareReplay({
      sourceRepo: repo,
      head,
      base,
      targetDir: target,
    });

    expect(manifest.head).toBe(head);
    expect(manifest.refs).toEqual([`refs/heads/base ${base}`]);
    expect(manifest.remotes).toEqual([]);
    expect(await git(["-C", target, "rev-parse", "HEAD"])).toContain(head);
    await expect(git(["-C", target, "rev-parse", "v1.0.0"])).rejects.toThrow();
    expect(await git(["-C", target, "remote"])).toBe("");
    expect(manifest.depth).toBe(1);
  });

  it("does not carry the later fix as a readable object", async () => {
    const { repo, base, head, fix } = await historyRepo();
    const target = join(await scratch(), "replay");
    await prepareReplay({ sourceRepo: repo, head, base, targetDir: target });

    // A ref-clean replay whose object store still holds the fix leaks it to
    // anything in the target that knows the sha.
    await expect(git(["-C", target, "cat-file", "-e", fix])).rejects.toThrow();
    await expect(git(["-C", target, "cat-file", "-p", fix])).rejects.toThrow();
  });

  it("reproduces the source tree and diff hashes", async () => {
    const { repo, base, head } = await historyRepo();
    const target = join(await scratch(), "replay");
    const manifest = await prepareReplay({
      sourceRepo: repo,
      head,
      base,
      targetDir: target,
    });

    const sourceDiff = run(repo, [
      "--no-pager",
      "diff",
      "--no-color",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      `${base}..${head}`,
    ]);
    expect(manifest.diffSha256).toBe(
      createHash("sha256").update(sourceDiff).digest("hex"),
    );
    expect(manifest.headTree).toBe(
      run(repo, ["rev-parse", `${head}^{tree}`]).trim(),
    );
    expect(manifest.baseTree).toBe(
      run(repo, ["rev-parse", `${base}^{tree}`]).trim(),
    );
    expect(manifest.changedFiles).toEqual(["app.ts"]);
  });

  it("agrees with a second replay of the same case", async () => {
    const { repo, base, head } = await historyRepo();
    const first = await prepareReplay({
      sourceRepo: repo,
      head,
      base,
      targetDir: join(await scratch(), "a"),
    });
    const second = await prepareReplay({
      sourceRepo: repo,
      head,
      base,
      targetDir: join(await scratch(), "b"),
    });
    expect(replaysAgree(first, second)).toBe(true);
  });

  it("rejects a checkout that gained a later ref", async () => {
    const { repo, base, head, fix } = await historyRepo();
    const target = join(await scratch(), "replay");
    await prepareReplay({ sourceRepo: repo, head, base, targetDir: target });

    await git([
      "-C",
      target,
      "fetch",
      "--no-tags",
      "--quiet",
      "--upload-pack",
      "git -c uploadpack.allowAnySHA1InWant=true upload-pack",
      repo,
      `${fix}:refs/heads/later`,
    ]);
    await expect(assertReplayIsolated(target, head, base)).rejects.toThrow(
      /leaks ref refs\/heads\/later/,
    );
  });

  it("rejects a checkout that regained a remote", async () => {
    const { repo, base, head } = await historyRepo();
    const target = join(await scratch(), "replay");
    await prepareReplay({ sourceRepo: repo, head, base, targetDir: target });
    await git(["-C", target, "remote", "add", "origin", repo]);
    await expect(assertReplayIsolated(target, head, base)).rejects.toThrow(
      /leaks remotes/,
    );
  });

  it("refuses an abbreviated revision", async () => {
    const { repo, base, head } = await historyRepo();
    await expect(
      prepareReplay({
        sourceRepo: repo,
        head: head.slice(0, 8),
        base,
        targetDir: join(await scratch(), "replay"),
      }),
    ).rejects.toThrow(/not a full commit sha/);
  });

  it("manifests an existing replay without rebuilding it", async () => {
    const { repo, base, head } = await historyRepo();
    const target = join(await scratch(), "replay");
    const built = await prepareReplay({
      sourceRepo: repo,
      head,
      base,
      targetDir: target,
    });
    const { depth, ...manifest } = built;
    expect(depth).toBe(1);
    expect(await replayManifest(target, head, base)).toEqual(manifest);
  });
});
