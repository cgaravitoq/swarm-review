import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach } from "vitest";

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

afterEach(async () => {
  await Promise.all(
    [...groups].map(async (pid) => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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
