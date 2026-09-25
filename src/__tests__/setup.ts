import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { afterAll, afterEach } from "vitest";

const engine = fileURLToPath(
  new URL("../../container/context/swarm.js", import.meta.url),
);
const staged = `${engine}.${randomUUID()}`;
mkdirSync(dirname(engine), { recursive: true });
writeFileSync(staged, "test engine bundle");
try {
  linkSync(staged, engine);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
} finally {
  unlinkSync(staged);
}

const groups = new Set<number>();
const prototype = childProcess.ChildProcess.prototype as ChildProcess & {
  spawn(options: Record<string, unknown>): number;
};
const spawn = prototype.spawn;
const spawnSync = childProcess.spawnSync;

// exec/execFile discard detached options before calling this shared boundary.
Reflect.set(
  prototype,
  "spawn",
  function (this: ChildProcess, options: Record<string, unknown>) {
    const result = spawn.call(this, { ...options, detached: true });
    if (this.pid !== undefined) groups.add(this.pid);
    return result;
  },
);

childProcess.spawnSync = new Proxy(spawnSync, {
  apply(target, _receiver, args) {
    const index = Array.isArray(args[1]) || args[2] !== undefined ? 2 : 1;
    const options = args[index] as Record<string, unknown> | undefined;
    args[index] = { ...options, detached: true };
    const result = target(...(args as Parameters<typeof spawnSync>));
    if (result.pid > 0) groups.add(result.pid);
    return result;
  },
});
syncBuiltinESMExports();

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
};

// A group still alive when its test failed is the only witness of what hung;
// the reaper reads it before it kills it.
const groupTree = (pid: number) =>
  spawnSync("ps", ["-eo", "pid,pgid,ppid,stat,etime,command"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter((line) => {
      const [, pgid, ppid] = line.trim().split(/\s+/);
      return pgid === String(pid) || ppid === String(pid);
    })
    .join("\n");

afterEach(async (context) => {
  const failed = context.task.result?.state === "fail";
  await Promise.all(
    [...groups].map(async (pid) => {
      if (failed && groupAlive(pid)) {
        console.error(
          `process group ${pid} alive when "${context.task.name}" failed\n${groupTree(pid)}`,
        );
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        // Darwin answers EPERM for a group whose members have all exited but
        // are not reaped yet; the wait below still fails one that stays alive.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
      const deadline = Date.now() + 5_000;
      while (groupAlive(pid)) {
        if (Date.now() >= deadline) {
          throw new Error(`Test process group ${pid} survived cleanup`);
        }
        await sleep(20);
      }
      groups.delete(pid);
    }),
  );
});

afterAll(() => {
  Reflect.set(prototype, "spawn", spawn);
  childProcess.spawnSync = spawnSync;
  syncBuiltinESMExports();
});
