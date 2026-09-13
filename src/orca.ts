/**
 * Runs swarm lanes as live Orca terminals.
 *
 * The default lane is a detached child of the coordinator with inherited
 * stdio: nothing about it is addressable while it runs, so the only thing a
 * human can look at is the exported session after the container is gone. Here
 * the terminal *is* the lane - Orca opens the pty, the pty runs the same local
 * driver, and that driver owns the container. There is no second model, no
 * tail of a finished log, and closing the terminal ends the real run.
 *
 * What Orca reports about a pty's exit is not trustworthy (`exitCode` comes
 * back 0 with `host_status_unavailable` even for an interrupted command), so
 * the lane's own exit status is written by the wrapper to a file the
 * coordinator reads. A lane with no such receipt is a failure, never a pass.
 */

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Interval between exit-receipt polls while a lane terminal runs. */
const LANE_POLL_MS = 1000;

/** Ctrl-C, the only way to reach the process group inside someone else's pty. */
const INTERRUPT = "\u0003";

const orcaCommand = () => process.env["ORCA_CLI_COMMAND"] ?? "orca";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The line the lane terminal runs.
 *
 * It ends by writing its own status and exiting the shell, so the pty dies
 * with the lane instead of dropping to an idle prompt that reads as a live
 * lane forever.
 */
export const laneCommandLine = (
  script: string,
  args: readonly string[],
  exitPath: string,
) =>
  `${[process.execPath, script, ...args].map(shellQuote).join(" ")}; ` +
  `code=$?; printf '%s' "$code" > ${shellQuote(`${exitPath}.partial`)} && ` +
  `mv ${shellQuote(`${exitPath}.partial`)} ${shellQuote(exitPath)}; exit $code`;

export const laneExitPath = (suiteDir: string, runId: string) =>
  join(suiteDir, `${runId}.orca-exit`);

/**
 * The wrapper's own exit status, or null while the lane is still running.
 *
 * The receipt is renamed into place, so a readable file is a complete one -
 * but an empty or unparsable body still reads as "no answer yet" rather than
 * as the zero `Number("")` would hand back.
 */
export async function readLaneExit(exitPath: string) {
  const raw = await readFile(exitPath, "utf8").catch(() => null);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const code = Number(trimmed);
  return code <= 255 ? code : null;
}

/** No single CLI call may outlive this; an unresponsive Orca cannot pin a lane. */
const ORCA_CALL_TIMEOUT_MS = 30_000;

const runOrca = (args: readonly string[], timeoutMs = ORCA_CALL_TIMEOUT_MS) =>
  new Promise<string>((resolvePromise, reject) => {
    const child = spawn(orcaCommand(), [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`orca ${args.join(" ")} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    deadline.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolvePromise(stdout);
      else
        reject(new Error(`orca ${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });

/** Parses one `--json` CLI envelope, failing on the CLI's own error shape. */
export function orcaResult(stdout: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`orca returned non-JSON output: ${stdout.slice(0, 400)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("orca returned a non-object envelope");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope["ok"] !== true) {
    throw new Error(`orca reported failure: ${JSON.stringify(envelope)}`);
  }
  const result = envelope["result"];
  if (typeof result !== "object" || result === null) {
    throw new Error("orca envelope carries no result");
  }
  return result as Record<string, unknown>;
}

const orcaJson = async (args: readonly string[]) =>
  orcaResult(await runOrca([...args, "--json"]));

/** The identity of a live lane terminal, as Orca itself names it. */
export function terminalIdentity(result: Record<string, unknown>) {
  const terminal = result["terminal"];
  if (typeof terminal !== "object" || terminal === null) {
    throw new Error("orca terminal payload has no terminal");
  }
  const record = terminal as Record<string, unknown>;
  const handle = record["handle"];
  if (typeof handle !== "string" || !handle) {
    throw new Error("orca terminal payload has no handle");
  }
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  return {
    handle,
    tabId: text("tabId"),
    ptyId: text("ptyId"),
    worktreeId: text("worktreeId"),
    title: text("title"),
  };
}

export type LaneTerminal = ReturnType<typeof terminalIdentity>;

/**
 * Fails the whole run when Orca cannot own the lanes.
 *
 * Explicit Orca mode has no quiet fallback: a swarm that silently went back to
 * detached children would be exactly the invisible run the mode exists to
 * replace.
 */
export async function assertOrcaAvailable() {
  const result = await orcaJson(["status"]).catch((error: unknown) => {
    throw new Error(
      `--orca requires a running Orca CLI: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const runtime = result["runtime"];
  const reachable =
    typeof runtime === "object" &&
    runtime !== null &&
    (runtime as Record<string, unknown>)["reachable"] === true;
  if (!reachable) throw new Error("--orca requires a reachable Orca runtime");
}

/**
 * The concrete worktree the coordinator is running in.
 *
 * `active` is whatever the user last clicked on, so a swarm that used it could
 * open its lanes in someone else's workspace mid-run. Resolving the id once
 * pins every lane terminal to this checkout.
 */
export async function resolveWorktreeSelector() {
  const result = await orcaJson(["worktree", "current"]);
  const worktree = result["worktree"];
  const id =
    typeof worktree === "object" && worktree !== null
      ? (worktree as Record<string, unknown>)["id"]
      : undefined;
  if (typeof id !== "string" || !id) {
    throw new Error("--orca must run inside an Orca-managed worktree");
  }
  return `id:${id}`;
}

/**
 * Opens the lane's terminal empty, before anything runs in it.
 *
 * The driver is sent separately, once the handle is durably recorded: if the
 * create response is lost after Orca acted on it, what is left behind is an
 * idle shell, not a review whose container nobody can name.
 */
export const createLaneTerminal = async (title: string, worktree: string) =>
  terminalIdentity(
    await orcaJson([
      "terminal",
      "create",
      "--worktree",
      worktree,
      "--title",
      title,
    ]),
  );

/** Starts the driver in a terminal whose identity is already on disk. */
export const laneScriptPath = (suiteDir: string, runId: string) =>
  join(suiteDir, `${runId}.lane.sh`);

/**
 * Hands the terminal its command as a file, not as typed text.
 *
 * A pty in canonical mode drops what a line does not fit, and the lane command
 * is long: an exact SHA pair, absolute prompt and fixture paths, the image, the
 * caps and the per-lane model all on one line. A truncated line does not fail
 * loudly - it leaves the shell sitting at `quote>` with an unterminated string,
 * which reads from outside as a lane that started and then did nothing. So the
 * command is written to disk and what crosses the pty is one short `bash` line
 * whose length does not grow with the run.
 */
export async function startLaneCommand(
  handle: string,
  command: string,
  scriptPath: string,
) {
  await writeFile(`${scriptPath}.partial`, `${command}\n`);
  await rename(`${scriptPath}.partial`, scriptPath);
  return orcaJson([
    "terminal",
    "send",
    "--terminal",
    handle,
    "--text",
    `bash ${scriptPath.replaceAll("'", `'\\''`)}`,
    "--enter",
  ]);
}

/**
 * Whether the pty behind a handle is still connected.
 *
 * A transport failure is `unknown`, never `gone`: treating an unanswered query
 * as termination would let the coordinator settle a lane whose container is
 * still running.
 */
export async function terminalLiveness(handle: string) {
  const result = await orcaJson([
    "terminal",
    "show",
    "--terminal",
    handle,
  ]).catch((error: unknown) => {
    // A handle Orca no longer knows is a terminal that ended, not a
    // transport that failed: waiting on it would never return.
    const message = error instanceof Error ? error.message : String(error);
    return /terminal_handle_stale|terminal_not_found|not found/i.test(message)
      ? "gone"
      : null;
  });
  if (result === "gone") return "gone" as const;
  if (!result) return "unknown" as const;
  const terminal = result["terminal"];
  if (typeof terminal !== "object" || terminal === null)
    return "unknown" as const;
  const connected = (terminal as Record<string, unknown>)["connected"];
  if (connected === false) return "gone" as const;
  if (connected === true) return "alive" as const;
  return "unknown" as const;
}

const interrupt = (handle: string) =>
  orcaJson(["terminal", "send", "--terminal", handle, "--text", INTERRUPT]);

export const closeTerminal = (handle: string) =>
  orcaJson(["terminal", "close", "--terminal", handle]);

/**
 * Waits for one lane terminal, cancelling it through the pty.
 *
 * Cancellation types Ctrl-C into the terminal so the driver's own interrupt
 * path runs and takes its container down; the terminal is closed once the
 * grace is spent, so an ignored interrupt still leaves nothing running. A lane
 * whose terminal disappeared without a receipt exits non-zero, and a close
 * Orca could not confirm is reported as `cleanupError` rather than as a lane
 * that stopped.
 */
export async function superviseLaneTerminal(
  handle: string,
  exitPath: string,
  signal: AbortSignal,
  graceMs: number,
  pollMs = LANE_POLL_MS,
) {
  let interruptedAt: number | null = null;
  const stop = () => {
    interruptedAt ??= Date.now();
    void interrupt(handle).catch(() => {});
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  const settle = (
    code: number,
    { cleanupError = null as string | null, lost = false } = {},
  ) => ({ code, cleanupError, lost });
  try {
    for (;;) {
      const code = await readLaneExit(exitPath);
      if (code !== null) return settle(code);
      if (interruptedAt !== null && Date.now() - interruptedAt >= graceMs) {
        const cleanupError = await closeTerminal(handle).then(
          () => null,
          (error: unknown) =>
            `terminal ${handle} could not be confirmed closed: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
        const code = await readLaneExit(exitPath);
        return settle(code ?? 130, { cleanupError, lost: code === null });
      }
      if ((await terminalLiveness(handle)) === "gone") {
        // Give the wrapper's rename a chance to land before calling it lost.
        await sleep(pollMs);
        const code = await readLaneExit(exitPath);
        return settle(code ?? 1, { lost: code === null });
      }
      await sleep(pollMs);
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * Records lane terminal identities the moment they exist.
 *
 * The swarm receipt is written at the end, and a run that is killed halfway
 * would take every handle with it. This file is rewritten on each creation so
 * an interrupted swarm still names the terminals it opened.
 */
export function laneTerminalLedger(suiteDir: string) {
  const entries: Record<string, unknown>[] = [];
  const path = join(suiteDir, "orca-lanes.json");
  // Reviewers run concurrently and write the same file. Each write waits for
  // the one before it and lands by rename, so no reader and no crash can see a
  // half-written ledger, and no lane's identity is lost to a racing write.
  let queue: Promise<void> = Promise.resolve();
  const flush = () => {
    queue = queue.then(async () => {
      const snapshot = JSON.stringify(entries, null, 2);
      await writeFile(`${path}.partial`, snapshot);
      await rename(`${path}.partial`, path);
    });
    return queue;
  };
  return {
    path,
    entries,
    record: async (entry: {
      laneId: string;
      role: string;
      runId: string;
      exitPath: string;
      terminal: LaneTerminal;
    }) => {
      entries.push({ ...entry, openedAt: new Date().toISOString() });
      await flush();
    },
    /**
     * What is still unknown about a lane's teardown once it stopped.
     *
     * A terminal that vanished without a receipt, a close Orca would not
     * confirm and a reclaim that failed are each a process nobody proved gone.
     * They are folded into the lane's own ledger entry so the swarm receipt
     * reports the uncertainty instead of the run reading as tidy.
     */
    recordCleanup: async (entry: {
      laneId: string;
      runId: string;
      lost: boolean;
      cleanupError: string | null;
      reclaimError: string | null;
    }) => {
      const existing = entries.find(
        (row) => row["laneId"] === entry.laneId && row["runId"] === entry.runId,
      );
      const cleanup = {
        lost: entry.lost,
        cleanupError: entry.cleanupError,
        reclaimError: entry.reclaimError,
        closedAt: new Date().toISOString(),
      };
      if (existing) existing["cleanup"] = cleanup;
      else entries.push({ ...entry, cleanup });
      await flush().catch(() => {});
    },
    /** A lane that never became a supervised terminal, kept with the rest. */
    recordFailure: async (entry: {
      laneId: string;
      runId: string;
      error: string;
      reclaimError?: string | null;
    }) => {
      entries.push({ ...entry, failedAt: new Date().toISOString() });
      await flush().catch(() => {});
    },
  };
}

/**
 * Recovers a lane whose terminal disappeared without a receipt.
 *
 * Closing the tab can take the driver down before it tore its container down,
 * so the coordinator runs the driver's own ownership-checked `--cancel` against
 * the run's persisted metadata. It is the same path a human cancel uses, and it
 * is a no-op when the run already ended.
 */
export function reclaimLostLane(
  localScript: string,
  runId: string,
  suiteDir: string,
  timeoutMs = 120_000,
) {
  return new Promise<string | null>((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [localScript, "--cancel", "--run-id", runId, "--out", suiteDir],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(`reclaim of ${runId} exceeded ${timeoutMs}ms`);
    }, timeoutMs);
    deadline.unref();
    const finish = (error: string | null) => {
      clearTimeout(deadline);
      resolvePromise(error);
    };
    child.once("error", (error) => finish(error.message));
    child.once("exit", (code) =>
      finish(
        code === 0
          ? null
          : `reclaim of ${runId} exited ${code}: ${stderr.trim().slice(0, 400)}`,
      ),
    );
  });
}
