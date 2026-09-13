/**
 * The harness reaps what a test starts, with no opt-in.
 *
 * This file imports nothing from the reaping seam on purpose: what it proves is
 * the mechanism `vitest.config.ts` and `setup.ts` install for every test file,
 * so a test that never heard of it is covered anyway.
 */
import childProcess, {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The process group a running pid belongs to, as the kernel reports it. */
const processGroup = (pid: number) =>
  Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(),
  );

/**
 * A parent that outlives its own descendant until killed, so the group can be
 * read while both are running: the shell backgrounds a `sleep` that holds the
 * pipe the shell wrote its pid to, and then waits.
 */
const escape = async (start = spawn) => {
  const child = start("sh", ["-c", "sleep 300 & echo $!; sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const leader = child.pid ?? 0;
  const descendant = await new Promise<number>((resolvePromise) => {
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
      if (text.trim()) resolvePromise(Number(text.trim()));
    });
  });
  const group = processGroup(leader);
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
  return { leader, group, descendant };
};

const escapes: { leader: number; descendant: number }[] = [];

/**
 * A file's own cleanup runs after the harness's, so a group this file abandoned
 * is already gone by the time a hook here runs. Reversed, this fails: the same
 * ordering is what keeps a test file's scratch removal behind the reaping.
 */
afterEach(() => {
  for (const { descendant } of escapes) expect(alive(descendant)).toBe(false);
});

describe("process groups the harness owns", () => {
  it("owns a child of a test as its own group, not as a child handle", async () => {
    const { leader, group, descendant } = await escape();
    escapes.push({ leader, descendant });

    // The child leads a group of its own, and the descendant that outlives it
    // is in that same group: the group, not the child handle, is what a reaper
    // has to own to reach a process whose parent already exited.
    expect(group).toBe(leader);
    expect(processGroup(descendant)).toBe(leader);
    expect(alive(descendant)).toBe(true);
  });

  it("still owns a spawn made after mock restoration", async () => {
    // A file that restores mocks after every test must not be able to restore
    // the harness's ownership with them.
    const kill = vi.spyOn(process, "kill");
    expect(vi.isMockFunction(process.kill)).toBe(true);
    vi.restoreAllMocks();
    expect(vi.isMockFunction(process.kill)).toBe(false);
    expect(vi.isMockFunction(kill)).toBe(true);

    const { leader, group, descendant } = await escape();
    escapes.push({ leader, descendant });

    expect(group).toBe(leader);
    expect(alive(descendant)).toBe(true);
  });

  it.each([
    ["default import", childProcess.spawn],
    [
      "CommonJS import",
      (
        createRequire(import.meta.url)(
          "node:child_process",
        ) as typeof childProcess
      ).spawn,
    ],
    ["execFile", execFile as typeof spawn],
  ] as const)("owns descendants through %s", async (_name, start) => {
    const { leader, group, descendant } = await escape(start);
    escapes.push({ leader, descendant });
    expect(group).toBe(leader);
    expect(processGroup(descendant)).toBe(leader);
  });

  it("owns descendants of a synchronous spawn after its leader exits", () => {
    const child = spawnSync(
      "sh",
      ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"],
      {
        encoding: "utf8",
      },
    );
    const descendant = Number(child.stdout.trim());
    escapes.push({ leader: child.pid, descendant });
    expect(child.status).toBe(0);
    expect(processGroup(descendant)).toBe(child.pid);
  });

  it("reaped every group the earlier tests left behind", () => {
    expect(escapes).toHaveLength(6);
    for (const { leader, descendant } of escapes) {
      expect(alive(descendant)).toBe(false);
      expect(groupAlive(leader)).toBe(false);
    }
  });
});
