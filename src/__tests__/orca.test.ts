import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatActivityEvent } from "../local";
import {
  laneCommandLine,
  laneExitPath,
  laneScriptPath,
  laneTerminalLedger,
  orcaResult,
  readLaneExit,
  startLaneCommand,
  terminalIdentity,
} from "../orca";

const directories: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-lane-"));
  directories.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const runShell = (command: string) =>
  new Promise<number>((resolvePromise) => {
    const child = spawn("sh", ["-c", command], { stdio: "ignore" });
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });

describe("lane exit receipts", () => {
  it("reads back the wrapper's own status", async () => {
    const dir = await scratch();
    const exitPath = laneExitPath(dir, "lane-1");
    await runShell(laneCommandLine("-e", ["process.exit(7)"], exitPath));
    expect(await readLaneExit(exitPath)).toBe(7);
  });

  it("treats an empty or partial receipt as no answer, not as success", async () => {
    const dir = await scratch();
    const exitPath = laneExitPath(dir, "lane-1");
    expect(await readLaneExit(exitPath)).toBeNull();
    await writeFile(exitPath, "");
    expect(await readLaneExit(exitPath)).toBeNull();
    await writeFile(exitPath, "  \n");
    expect(await readLaneExit(exitPath)).toBeNull();
    await writeFile(exitPath, "not-a-code");
    expect(await readLaneExit(exitPath)).toBeNull();
    await writeFile(exitPath, "300");
    expect(await readLaneExit(exitPath)).toBeNull();
    await writeFile(exitPath, "0\n");
    expect(await readLaneExit(exitPath)).toBe(0);
  });

  it("renames the receipt into place so a reader never sees half of it", async () => {
    const dir = await scratch();
    const exitPath = laneExitPath(dir, "lane-1");
    const line = laneCommandLine("-e", [""], exitPath);
    expect(line).toContain(`${exitPath}.partial`);
    expect(line).toContain(`mv '${exitPath}.partial' '${exitPath}'`);
    expect(line.endsWith("exit $code")).toBe(true);
  });

  it("quotes every argument it hands the shell", () => {
    const line = laneCommandLine("/tmp/local.ts", ["--out", "a b'c"], "/tmp/e");
    expect(line).toContain(`'a b'\\''c'`);
  });
});

describe("orca envelopes", () => {
  it("refuses an envelope that is not ok", () => {
    expect(() =>
      orcaResult(JSON.stringify({ ok: false, error: "no" })),
    ).toThrow(/reported failure/);
    expect(() => orcaResult("not json")).toThrow(/non-JSON/);
    expect(() => orcaResult(JSON.stringify({ ok: true }))).toThrow(/no result/);
  });

  it("keeps the identity Orca assigned the terminal", () => {
    const identity = terminalIdentity({
      terminal: {
        handle: "term_1",
        tabId: "tab_1",
        ptyId: "pty_1",
        worktreeId: "repo::/path",
        title: "swarm reviewer-1",
      },
    });
    expect(identity.handle).toBe("term_1");
    expect(identity.ptyId).toBe("pty_1");
    expect(() => terminalIdentity({ terminal: { tabId: "t" } })).toThrow(
      /no handle/,
    );
  });
});

describe("what crosses the pty", () => {
  it("sends a short bash line whose length does not grow with the run", async () => {
    const dir = await scratch();
    const sentPath = join(dir, "sent.txt");
    const orcaStub = join(dir, "orca-stub.sh");
    await writeFile(
      orcaStub,
      `#!/bin/bash\nprev=""\nfor arg in "$@"; do\n  if [[ "$prev" == "--text" ]]; then printf '%s\\n' "$arg" >> ${sentPath}; fi\n  prev="$arg"\ndone\necho '{"ok":true,"result":{"sent":true}}'\n`,
    );
    await chmod(orcaStub, 0o755);
    const scriptPath = laneScriptPath(dir, "swarm-reviewer-1");
    const command = laneCommandLine(
      "/very/long/path/to/agents/review-pi/src/local.ts",
      [
        "--run-id",
        "swarm-reviewer-1",
        "--head",
        "562627e75f15f80e452dd68b14fdad8a51ec38bd",
        "--base",
        "748a0369ce5c0a71ee7ec18288d0eba17130f8f1",
        "--prompt",
        `/a/${"long".repeat(200)}/prompt.txt`,
      ],
      laneExitPath(dir, "swarm-reviewer-1"),
    );
    process.env["ORCA_CLI_COMMAND"] = orcaStub;

    await startLaneCommand("term_1", command, scriptPath);
    const typed = (await readFile(sentPath, "utf8")).trim();
    const onDisk = await readFile(scriptPath, "utf8");

    // A canonical-mode pty truncates a long line, and a truncated shell line
    // leaves an unterminated quote rather than an error.
    expect(command.length).toBeGreaterThan(1024);
    expect(typed.length).toBeLessThan(512);
    expect(typed).toBe(`bash ${scriptPath}`);
    expect(onDisk.trimEnd()).toBe(command);
  });
});

describe("lane ledger", () => {
  it("persists a terminal the moment it exists", async () => {
    const dir = await scratch();
    const ledger = laneTerminalLedger(dir);
    await ledger.record({
      laneId: "reviewer-1",
      role: "reviewer",
      runId: "swarm-reviewer-1",
      exitPath: laneExitPath(dir, "swarm-reviewer-1"),
      terminal: {
        handle: "term_1",
        tabId: null,
        ptyId: null,
        worktreeId: null,
        title: null,
      },
    });
    const written = JSON.parse(await readFile(ledger.path, "utf8")) as {
      laneId: string;
      terminal: { handle: string };
    }[];
    expect(written).toHaveLength(1);
    expect(written[0]?.terminal.handle).toBe("term_1");
    expect(ledger.entries[0]?.["laneId"]).toBe("reviewer-1");
  });

  it("folds teardown uncertainty into the lane that owns it", async () => {
    const dir = await scratch();
    const ledger = laneTerminalLedger(dir);
    await ledger.record({
      laneId: "reviewer-1",
      role: "reviewer",
      runId: "swarm-reviewer-1",
      exitPath: laneExitPath(dir, "swarm-reviewer-1"),
      terminal: {
        handle: "term_1",
        tabId: null,
        ptyId: null,
        worktreeId: null,
        title: null,
      },
    });
    await ledger.recordCleanup({
      laneId: "reviewer-1",
      runId: "swarm-reviewer-1",
      lost: true,
      cleanupError: "terminal term_1 could not be confirmed closed",
      reclaimError: "reclaim of swarm-reviewer-1 exited 1",
    });

    const written = JSON.parse(await readFile(ledger.path, "utf8")) as Record<
      string,
      unknown
    >[];
    const cleanup = written[0]?.["cleanup"] as Record<string, unknown>;

    // One row, not two: what is unknown about a lane belongs to that lane.
    expect(written).toHaveLength(1);
    expect(cleanup["lost"]).toBe(true);
    expect(cleanup["cleanupError"]).toMatch(/could not be confirmed closed/);
    expect(cleanup["reclaimError"]).toMatch(/exited 1/);
  });
});

describe("live activity", () => {
  it("names the tool and its status without echoing its payload", () => {
    expect(
      formatActivityEvent(
        JSON.stringify({
          type: "tool_execution_start",
          toolName: "bash",
          args: { command: "curl -H 'Authorization: Bearer sk-secret'" },
        }),
      ),
    ).toBe("tool bash start");
    expect(
      formatActivityEvent(
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "read",
          isError: true,
          resultBytes: 12,
        }),
      ),
    ).toBe("tool read error 12b");
    expect(
      formatActivityEvent(
        JSON.stringify({
          type: "turn_end",
          message: { stopReason: "end_turn", usage: { input: 10, output: 2 } },
        }),
      ),
    ).toBe("turn end_turn in=10 out=2");
  });

  it("strips control sequences out of model-written fields", () => {
    expect(
      formatActivityEvent(
        JSON.stringify({
          type: "tool_execution_start",
          toolName: "b\u001b[2Jash",
        }),
      ),
    ).toBe("tool b[2Jash start");
  });

  it("ignores per-token noise and unparsable lines", () => {
    expect(formatActivityEvent('{"type":"text_delta","text":"a"}')).toBeNull();
    expect(formatActivityEvent("half a line")).toBeNull();
  });
});

describe("a lane that cannot start", () => {
  it("aborts the swarm, settles the running sibling and keeps the failure", async () => {
    const dir = await scratch();
    const orca = await import("../orca");
    const created: string[] = [];
    let sibling: () => void = () => {};
    // The second lane fails only once the first is actually being supervised,
    // which is the case that matters: a running sibling has to be settled.
    const supervising = new Promise<void>((resolvePromise) => {
      sibling = resolvePromise;
    });
    const createSpy = vi
      .spyOn(orca, "createLaneTerminal")
      .mockImplementation(async (title: string) => {
        created.push(title);
        if (created.length === 2) {
          await supervising;
          throw new Error("orca terminal create exited 1");
        }
        return {
          handle: `term_${created.length}`,
          tabId: null,
          ptyId: null,
          worktreeId: null,
          title,
        };
      });
    // The sibling is a real supervision contract: it only settles when the
    // coordinator's own abort reaches it.
    const superviseSpy = vi
      .spyOn(orca, "superviseLaneTerminal")
      .mockImplementation(
        (_handle: string, _exitPath: string, signal: AbortSignal) =>
          new Promise((resolvePromise) => {
            sibling();
            const settle = () =>
              resolvePromise({ code: 130, cleanupError: null, lost: false });
            if (signal.aborted) settle();
            else signal.addEventListener("abort", settle, { once: true });
          }),
      );
    const startSpy = vi
      .spyOn(orca, "startLaneCommand")
      .mockResolvedValue({} as Record<string, unknown>);
    const reclaimSpy = vi
      .spyOn(orca, "reclaimLostLane")
      .mockResolvedValue(null);

    const { orcaRunner } = await import("../swarm");
    const ledger = orca.laneTerminalLedger(dir);
    const controller = new AbortController();
    const run = orcaRunner("swarm", dir, "id:repo::/w", ledger, (error) =>
      controller.abort(error),
    );
    const lane = (laneId: string) =>
      run(
        { laneId, role: "reviewer" as const, runId: `swarm-${laneId}` },
        ["--out", dir],
        controller.signal,
      );

    const [first, second] = await Promise.all([
      lane("reviewer-1"),
      lane("reviewer-2"),
    ]);

    expect(second).toBe(1);
    expect(first).toBe(130);
    expect(controller.signal.aborted).toBe(true);
    expect(reclaimSpy).not.toHaveBeenCalled();
    const ledgerRows = JSON.parse(await readFile(ledger.path, "utf8")) as {
      laneId: string;
      error?: string;
    }[];
    expect(
      ledgerRows.find((row) => row.laneId === "reviewer-2")?.error,
    ).toMatch(/create exited 1/);
    createSpy.mockRestore();
    startSpy.mockRestore();
    superviseSpy.mockRestore();
    reclaimSpy.mockRestore();
  });
});

describe("a lane whose siblings failed first", () => {
  it("closes its terminal instead of launching a driver into it", async () => {
    const dir = await scratch();
    const orca = await import("../orca");
    const closed: string[] = [];
    const createSpy = vi.spyOn(orca, "createLaneTerminal").mockResolvedValue({
      handle: "term_late",
      tabId: null,
      ptyId: null,
      worktreeId: null,
      title: "late",
    });
    const startSpy = vi.spyOn(orca, "startLaneCommand");
    const closeSpy = vi
      .spyOn(orca, "closeTerminal")
      .mockImplementation(async (handle: string) => {
        closed.push(handle);
        return {};
      });

    const { orcaRunner } = await import("../swarm");
    const ledger = orca.laneTerminalLedger(dir);
    const controller = new AbortController();
    controller.abort(new Error("a sibling could not start"));
    const code = await orcaRunner(
      "swarm",
      dir,
      "id:repo::/w",
      ledger,
      () => {},
    )(
      { laneId: "verifier", role: "verifier", runId: "swarm-verifier" },
      ["--out", dir],
      controller.signal,
    );

    expect(code).toBe(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(closed).toEqual(["term_late"]);
    createSpy.mockRestore();
    startSpy.mockRestore();
    closeSpy.mockRestore();
  });
});
