import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { laneCaps, SESSION_CAPS } from "../provider-budget";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * The file the fixture patch was cut from. `git apply` matches the hunk's
 * context lines, so the lines above them are all the patch needs.
 */
const fixturePreimage = `/** Collapse repeated whitespace into single spaces and trim the result. */
// biome-ignore lint/complexity/useRegexLiterals: literal form trips noControlCharactersInRegex.
const CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw\`[\\u0000-\\u001F\\u007F]\`,
  "g",
);
const COPY_NAME_PATTERN = /^Copy(?: (?<number>\\d+))?(?: (?<name>.*))?$/u;

function replaceControlCharactersWithSpaces(text: string) {
  return text.replace(CONTROL_CHARACTER_PATTERN, " ");
}

export function normalizeWhitespace(text: string) {
  return replaceControlCharactersWithSpaces(text).replace(/\\s+/g, " ").trim();
}

/** Normalize whitespace and truncate text with a plain ASCII ellipsis. */
export function truncateNormalizedText(text: string, maxLength: number) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  return \`\${normalized.slice(0, maxLength - 3)}...\`;
}

/** Create the next duplicate name without exceeding the database name limit. */
export function getDuplicateName(name: string) {
  const match = name.match(COPY_NAME_PATTERN);
  const number = match ? Number(match.groups?.["number"] ?? 1) + 1 : null;
  const prefix = number === null ? "Copy" : \`Copy \${number}\`;
  const sourceName = match?.groups?.["name"] ?? name;

  return \`\${prefix}\${sourceName ? \` \${sourceName}\` : ""}\`.slice(0, 255);
}

/** Return the first non-empty string after whitespace normalization. */
`;

describe("fixture transport", () => {
  it("preserves the job patch bytes through the real clone and git apply path", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-runner-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const remote = join(root, "origin.git");
    const run = join(root, "run");
    const trackedPath = "packages/utils/src/lib/string.ts";
    await mkdir(join(source, "packages/utils/src/lib"), { recursive: true });
    await mkdir(run);
    await writeFile(join(source, trackedPath), fixturePreimage);
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-C", source, "add", trackedPath]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=review-pi-test",
      "-c",
      "user.email=review-pi-test@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    execFileSync("git", ["clone", "-q", "--bare", source, remote]);
    const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const fixture = await readFile(
      fileURLToPath(
        new URL("../../fixtures/duplicate-name-length.patch", import.meta.url),
      ),
      "utf8",
    );
    await writeFile(
      join(run, "job.json"),
      JSON.stringify({
        runId: "fixture-transport",
        gitRemote: remote,
        head: { sha },
        base: { sha },
        fixturePatch: fixture,
      }),
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_clone', "runner-test", runner, run],
      { encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(await readFile(join(run, "work/fixture.patch"), "utf8")).toBe(
      fixture,
    );
    expect(
      execFileSync(
        "git",
        ["-C", join(run, "work/repo"), "diff", "--name-only", "base..HEAD"],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe(trackedPath);
  });
});

describe("Pi event boundary", () => {
  const prepareReportRun = async (runId: string) => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    const repo = join(root, "work/repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=review-pi-test",
      "-c",
      "user.email=review-pi-test@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    execFileSync("git", ["-C", repo, "branch", "base"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({
        runId,
        head: { sha },
        base: { sha },
        fixturePatch: "",
        provider: "opencode",
        model: "deepseek-v3.2",
      }),
    );
    await writeFile(join(root, "pi.stderr"), "");
    await writeFile(join(root, "diff.stat"), "");
    await writeFile(join(root, "check.log"), "check passed\n");
    return root;
  };

  it("creates a report only for a complete non-empty assistant result", async () => {
    const root = await prepareReportRun("complete-result");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "stop",
          usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0 } },
        },
      })}\n${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "clean" }] },
        ],
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const report = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );

    expect(result.status).toBe(0);
    expect(report.finalText).toBe("clean");
    expect(report.completion).toBe("complete");
    expect(report.partialReason).toBeNull();
    expect(report.usage).toMatchObject({ turns: 1, totalTokens: 5 });
  });

  it("marks the report partial when the lane was cut before it finished", async () => {
    const root = await prepareReportRun("cut-lane");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "error",
          errorMessage:
            'review_pi_broker: 429 {"error":{"reason":"max_requests"}}',
          usage: { input: 9, output: 9, totalTokens: 18 },
        },
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const refused = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    await expect(readFile(join(root, "report.json"), "utf8")).rejects.toThrow();

    const partial = spawnSync(
      "bash",
      [
        "-c",
        'source "$1" "$2"; do_partial_report; printf "%s" "$(cat "$REPORT" | jq -r .completion)"',
        "runner-test",
        runner,
        root,
      ],
      { encoding: "utf8" },
    );
    const report = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );

    // A lane cut by its request cap leaves a report, and the report says it was
    // cut: the same file marked `complete` would read as a lane that looked at
    // the change and found nothing.
    expect(partial.status).toBe(0);
    expect(report.completion).toBe("partial");
    expect(report.partialReason).toMatch(/request cap/);
    expect(report.checkout.commitIdentityPreserved).toBe(true);
    expect(report.usage).toMatchObject({ turns: 1, totalTokens: 18 });
  });

  it("writes the partial report and its report step when the window is spent", async () => {
    const root = await prepareReportRun("window-spent");
    await writeFile(join(root, "pi-raw.jsonl"), "");
    await writeFile(join(root, "steps.jsonl"), "");
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; on_window_spent', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const report = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );
    const steps = (await readFile(join(root, "steps.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const status = JSON.parse(
      await readFile(join(root, "status.json"), "utf8"),
    );

    // The handler is what the container's own `timeout` triggers, so the lane
    // still ends with a report and the step the driver reads as completion.
    expect(result.status).toBe(0);
    expect(report.completion).toBe("partial");
    expect(report.partialReason).toMatch(/cut/);
    expect(steps).toContainEqual(
      expect.objectContaining({ step: "report", exit: 0 }),
    );
    expect(status).toMatchObject({ phase: "finished", state: "done" });
  });

  it("keeps the report it already wrote when the window expires behind it", async () => {
    const root = await prepareReportRun("already-reported");
    await writeFile(
      join(root, "report.json"),
      JSON.stringify({ completion: "complete", runId: "already-reported" }),
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; on_window_spent', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const report = JSON.parse(
      await readFile(join(root, "report.json"), "utf8"),
    );

    expect(result.status).toBe(0);
    expect(report.completion).toBe("complete");
  });

  it("keeps how the review ended in the runner's last word, from main or the window", async () => {
    // The bridge writes a review it never handed back as an answer and exits;
    // whichever of the runner's two last words comes after it, it must not
    // say the lane completed.
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );
    const endings = [
      ["failed", "model_error"],
      ["failed", "process_spawn_error"],
      ["failed", "stdin_error"],
      ["failed", "process_exit"],
      ["blocked", "auth_blocked"],
      ["blocked", "quota_blocked"],
      ["blocked", "budget_exhausted"],
      ["cancelled", "no_candidates"],
    ] as const;
    for (const lastWord of ["on_window_spent", "write_final_status"]) {
      for (const [state, reason] of endings) {
        const root = await prepareReportRun(`${state}-${reason}`);
        await writeFile(join(root, "pi-raw.jsonl"), "");
        await writeFile(join(root, "steps.jsonl"), "");
        // Main speaks after the review step recorded its exit; the window
        // handler can cut the step before it does.
        if (lastWord === "write_final_status") {
          await writeFile(join(root, "review.exit"), "1\n");
        }
        await writeFile(
          join(root, "status.json"),
          JSON.stringify({ phase: "review", state, terminalReason: reason }),
        );

        const result = spawnSync(
          "bash",
          ["-c", `source "$1" "$2"; ${lastWord}`, "runner-test", runner, root],
          { encoding: "utf8", env: { ...process.env, SUPERVISED: "1" } },
        );
        const status = JSON.parse(
          await readFile(join(root, "status.json"), "utf8"),
        );

        expect(result.status, `${lastWord} ${reason}`).toBe(0);
        expect(status, `${lastWord} ${reason}`).toMatchObject({
          phase: "finished",
          state,
          terminalReason: reason,
          process: { alive: false },
        });
      }
    }
  });

  it("fails a review step that ended without a word from the bridge", async () => {
    // A bridge that dies without writing leaves the step's own running status
    // behind; its exit code is the only witness, and it is not a success.
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );
    const cases = [
      [null, "exit 137"],
      [{ reason: "auth_blocked" }, "auth_blocked"],
    ] as const;
    for (const [reviewError, reason] of cases) {
      const root = await prepareReportRun("bridge-died");
      await writeFile(join(root, "review.exit"), "137\n");
      await writeFile(
        join(root, "status.json"),
        JSON.stringify({ phase: "review", state: "running" }),
      );
      if (reviewError) {
        await writeFile(
          join(root, "review-error.json"),
          JSON.stringify(reviewError),
        );
      }

      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1" "$2"; write_final_status',
          "runner-test",
          runner,
          root,
        ],
        { encoding: "utf8", env: { ...process.env, SUPERVISED: "1" } },
      );
      const status = JSON.parse(
        await readFile(join(root, "status.json"), "utf8"),
      );

      expect(result.status).toBe(0);
      expect(status).toMatchObject({
        phase: "finished",
        state: "failed",
        terminalReason: reason,
      });
    }
  });

  it("rejects a JSON-mode model error and preserves bounded evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({ runId: "model-error" }),
    );
    await writeFile(join(root, "pi.stderr"), "provider stderr");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "error",
          errorMessage: `Cannot continue: ${"x".repeat(5000)}`,
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "model_error",
      piExit: 0,
      stopReason: "error",
      stderrTail: "provider stderr",
    });
    expect(evidence.errorMessage).toHaveLength(4000);
  });

  it("rejects a non-empty partial response with an incomplete terminal reason", async () => {
    const root = await prepareReportRun("length-result");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "length",
          errorMessage: "Maximum output length reached",
          usage: { input: 2, output: 100, totalTokens: 102 },
        },
      })}\n${JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial but non-empty" }],
          },
        ],
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "incomplete_result",
      piExit: 0,
      stopReason: "length",
      errorMessage: "Maximum output length reached",
    });
  });

  it("rejects a completed turn without a non-empty agent result", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({ runId: "empty-result" }),
    );
    await writeFile(join(root, "pi.stderr"), "");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: { stopReason: "stop", usage: { input: 1, output: 0 } },
      })}\n${JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "  " }] },
        ],
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "empty_result",
      piExit: 0,
      stopReason: "stop",
    });
  });

  it("rejects a non-empty response without terminal turn evidence", async () => {
    const root = await prepareReportRun("missing-terminal");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "non-empty without completion" }],
          },
        ],
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "incomplete_result",
      piExit: 0,
      stopReason: "",
    });
  });

  it("identifies provider 401 as auth_blocked error", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({ runId: "auth-blocked" }),
    );
    await writeFile(join(root, "pi.stderr"), "401 Unauthorized: token expired");
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "error",
          errorMessage: "401 Unauthorized: token expired",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "auth_blocked",
      piExit: 0,
      stopReason: "error",
      errorMessage: "401 Unauthorized: token expired",
    });
  });

  it("identifies provider 429 as quota_blocked error", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({ runId: "quota-blocked" }),
    );
    await writeFile(
      join(root, "pi.stderr"),
      "429 Too Many Requests: quota exceeded",
    );
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "error",
          errorMessage: "Rate limit reached: insufficient_quota",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "quota_blocked",
      piExit: 0,
      stopReason: "error",
      errorMessage: "Rate limit reached: insufficient_quota",
    });
  });

  it("names the broker's own 429 as the run's budget, not the provider's quota", async () => {
    // The real confusion: a lane cut at its cumulative token cap was reported
    // as quota_blocked, and read as an account out of credit.
    const root = await mkdtemp(join(tmpdir(), "review-pi-events-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "job.json"),
      JSON.stringify({ runId: "budget-exhausted" }),
    );
    await writeFile(join(root, "pi.stderr"), "");
    const errorMessage =
      '429 {"type":"review_pi_broker","reason":"max_input_tokens"}';
    await writeFile(
      join(root, "pi-raw.jsonl"),
      `${JSON.stringify({
        type: "turn_end",
        message: {
          stopReason: "error",
          errorMessage,
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      })}\n`,
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
      { encoding: "utf8" },
    );
    const evidence = JSON.parse(
      await readFile(join(root, "review-error.json"), "utf8"),
    );

    expect(result.status).toBe(1);
    expect(evidence).toMatchObject({
      reason: "budget_exhausted",
      stopReason: "error",
      errorMessage,
    });
  });
});

describe("install across manifests", () => {
  const runnerScript = fileURLToPath(
    new URL("../../container/review-run.sh", import.meta.url),
  );

  /**
   * A real checkout behind a real remote, plus a fake `pi` that answers one
   * complete review turn and logs the argv it was given. The run is the
   * runner's own `main`, so the install step is the one the product takes.
   */
  const prepareRun = async (runId: string, files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-install-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const run = join(root, "run");
    const source = join(root, "source");
    const remote = join(root, "origin.git");
    for (const directory of [bin, run, source]) {
      await mkdir(directory, { recursive: true });
    }
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(source, name), content);
    }
    execFileSync("git", ["init", "-q", source]);
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "user.name=review-pi-test",
      "-c",
      "user.email=review-pi-test@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    execFileSync("git", ["clone", "-q", "--bare", source, remote]);
    const sha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      join(run, "job.json"),
      JSON.stringify({
        runId,
        gitRemote: remote,
        head: { sha },
        base: { sha },
        fixturePatch: "",
        prompt: "review this change",
        provider: "opencode",
        model: "deepseek-v3.2",
        thinking: "high",
        checkCommand: "true",
        installTimeoutSeconds: 60,
        piTimeoutSeconds: 60,
      }),
    );
    const piArgv = join(root, "pi-argv");
    await writeFile(
      join(bin, "pi"),
      `#!/bin/bash
printf '%s\\n' "$*" >> ${piArgv}
cat <<'PI_EVENTS'
{"type":"turn_end","message":{"stopReason":"stop","usage":{"input":4,"output":5,"totalTokens":9,"cost":{"total":0}}}}
{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"VERDICT: clean."}]}]}
PI_EVENTS
`,
    );
    await chmod(join(bin, "pi"), 0o755);
    const bunArgv = join(root, "bun-argv");
    // The real image's Bun refuses a checkout with no package.json, and the run
    // has to survive that refusal without ever asking it.
    await writeFile(
      join(bin, "bun"),
      `#!/bin/bash
printf '%s\\n' "$*" >> ${bunArgv}
if [ "$1" = "--version" ]; then printf '1.4.0\\n'; exit 0; fi
if [ ! -f package.json ]; then
  printf 'error: Bun could not find a package.json file to install from\\n' >&2
  exit 1
fi
if [ -f node_modules/.template-marker ]; then
  printf 'present\\n' > ${join(root, "template-seen")}
fi
if [ "\${FAKE_BUN_NO_CHANGES:-}" = "1" ]; then
  printf 'Checked 10 installs across 20 packages (no changes)\\n' >&2
fi
exit "\${FAKE_BUN_INSTALL_EXIT:-0}"
`,
    );
    await chmod(join(bin, "bun"), 0o755);
    // The runner bounds the install, the check and Pi with the image's
    // coreutils `timeout`, which macOS does not carry. Without it every one of
    // those steps exits 127 on this host, so the double stands in for that one
    // host tool: it takes the option shape the runner uses, cuts the child's
    // own process group at the limit, and reports the statuses coreutils
    // reports: the child's own, 128 plus the signal that killed it, 124 for a
    // cut child, and 137 for one the -k KILL had to end.
    await writeFile(
      join(bin, "timeout"),
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { signals } = require("node:os").constants;

const argv = process.argv.slice(2);
let killAfter = null;
if (argv[0] === "-k") {
  killAfter = Number(argv[1]);
  argv.splice(0, 2);
}
const limit = Number(argv[0]);
if (!Number.isFinite(limit) || !argv[1]) {
  process.stderr.write("timeout: expected a duration and a command\\n");
  process.exit(125);
}
const child = spawn(argv[1], argv.slice(2), {
  stdio: "inherit",
  detached: true,
});
let expired = false;
const limitTimer = setTimeout(() => {
  expired = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  if (killAfter !== null) {
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, killAfter * 1000);
  }
}, limit * 1000);
child.on("exit", (code, signal) => {
  clearTimeout(limitTimer);
  if (expired) process.exit(signal === "SIGKILL" ? 128 + signals.SIGKILL : 124);
  process.exit(signal ? 128 + signals[signal] : code);
});
`,
    );
    await chmod(join(bin, "timeout"), 0o755);
    // GNU cp's --reflink, which the image's template copy uses, is not an
    // option macOS cp accepts, so the double drops it and copies with the
    // host's own cp.
    await writeFile(
      join(bin, "cp"),
      `#!/bin/bash
args=()
for argument in "$@"; do
  [ "$argument" = "--reflink=auto" ] || args+=("$argument")
done
sleep "\${FAKE_CP_SECONDS:-0}"
exec /bin/cp "\${args[@]}"
`,
    );
    await chmod(join(bin, "cp"), 0o755);
    return {
      root,
      run,
      piArgv,
      bunArgv,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        // A host that happens to carry /opt/review must not decide what a
        // test without a staged template records.
        REVIEW_TEMPLATE_ROOT: join(root, "no-template"),
      },
    };
  };

  const readSteps = async (run: string) =>
    (await readFile(join(run, "steps.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("installs nothing and still reaches the model when the checkout is not a Bun project", async () => {
    const prepared = await prepareRun("non-bun", {
      "main.go": "package main\n\nfunc main() {}\n",
    });

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: prepared.env,
    });
    const steps = await readSteps(prepared.run);
    const report = JSON.parse(
      await readFile(join(prepared.run, "report.json"), "utf8"),
    );
    const install = steps.findIndex((step) => step["step"] === "install");
    const review = steps.findIndex((step) => step["step"] === "review");

    expect(result.status).toBe(0);
    // The step that used to end the lane now says what it did instead.
    expect(steps[install]).toMatchObject({
      step: "install",
      exit: 0,
      detail: "skipped: the checkout root has no package.json",
    });
    expect(review).toBeGreaterThan(install);
    expect(steps[review]?.["exit"]).toBe(0);
    expect(report.install).toEqual({
      status: "skipped",
      manifest: null,
      reason: "the checkout root has no package.json",
      seconds: null,
      nothingToDo: null,
      template: null,
    });
    // Reaching the review step is only half of it: the reviewer has to have
    // been handed a prompt, and the install must never have been attempted.
    expect(await readFile(prepared.piArgv, "utf8")).toContain("--mode json");
    expect(await readFile(prepared.piArgv, "utf8")).toContain(
      "-- review this change",
    );
    expect(await readFile(prepared.bunArgv, "utf8")).not.toContain(
      "install --frozen-lockfile",
    );
  });

  it("installs with bun when the checkout root carries a Bun manifest", async () => {
    const prepared = await prepareRun("bun-project", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      "index.ts": "export const demo = true;\n",
    });

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: prepared.env,
    });
    const steps = await readSteps(prepared.run);
    const report = JSON.parse(
      await readFile(join(prepared.run, "report.json"), "utf8"),
    );

    expect(result.status).toBe(0);
    expect(await readFile(prepared.bunArgv, "utf8")).toContain(
      "install --frozen-lockfile",
    );
    expect(steps.find((step) => step["step"] === "install")).toMatchObject({
      exit: 0,
      detail: "installed with bun.lock",
    });
    expect(report.install).toEqual({
      status: "installed",
      manifest: "bun.lock",
      reason: null,
      seconds: expect.any(Number),
      nothingToDo: false,
      template: "absent",
    });
    expect(
      JSON.parse(await readFile(join(prepared.run, "status.json"), "utf8")),
    ).toMatchObject({
      install: {
        status: "installed",
        seconds: expect.any(Number),
        nothingToDo: false,
      },
    });
    expect(steps.find((step) => step["step"] === "review")?.["exit"]).toBe(0);
    expect(await readFile(prepared.piArgv, "utf8")).toContain(
      "-- review this change",
    );
  });

  it("ends the lane with the install's own exit when bun refuses the lockfile", async () => {
    const prepared = await prepareRun("bun-install-refused", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
    });

    // An exit no wrapper would invent, so the lane can only end with it if
    // every hop between bun and the runner's status passed it through.
    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: { ...prepared.env, FAKE_BUN_INSTALL_EXIT: "3" },
    });
    const steps = await readSteps(prepared.run);

    expect(result.status).toBe(3);
    expect(steps.find((step) => step["step"] === "install")).toMatchObject({
      exit: 3,
    });
    expect(steps.some((step) => step["step"] === "review")).toBe(false);
  });

  it("records Bun's no-changes result in status.json", async () => {
    const prepared = await prepareRun("bun-no-changes", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
    });
    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: { ...prepared.env, FAKE_BUN_NO_CHANGES: "1" },
    });
    const status = JSON.parse(
      await readFile(join(prepared.run, "status.json"), "utf8"),
    );
    expect(result.status).toBe(0);
    expect(status.install).toMatchObject({
      status: "installed",
      nothingToDo: true,
      seconds: expect.any(Number),
    });
  });

  const stageTemplate = async (root: string, lockfile: string) => {
    const template = join(root, "template");
    await mkdir(join(template, "node_modules-template"), { recursive: true });
    await writeFile(join(template, "template-bun.lock"), lockfile);
    await writeFile(
      join(template, "node_modules-template/.template-marker"),
      "baked\n",
    );
    return template;
  };

  it("places the baked template under the clone before bun installs a matching lockfile", async () => {
    const lockfile = '{"lockfileVersion":1}\n';
    const prepared = await prepareRun("template-match", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": lockfile,
    });
    const template = await stageTemplate(prepared.root, lockfile);

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: {
        ...prepared.env,
        REVIEW_TEMPLATE_ROOT: template,
        FAKE_CP_SECONDS: "2",
      },
    });
    const status = JSON.parse(
      await readFile(join(prepared.run, "status.json"), "utf8"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(prepared.root, "template-seen"), "utf8")).toBe(
      "present\n",
    );
    // The copy took two seconds of its own, and none of them are the install's.
    expect(status.install).toMatchObject({
      status: "installed",
      template: "copied",
      seconds: expect.any(Number),
    });
    expect(status.install.seconds).toBeLessThan(2);
    expect(await readFile(prepared.bunArgv, "utf8")).toContain(
      "install --frozen-lockfile",
    );
  });

  it("copies nothing and still installs when the lockfile differs from the template's", async () => {
    const prepared = await prepareRun("template-mismatch", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
    });
    const template = await stageTemplate(
      prepared.root,
      '{"lockfileVersion":1,"other":true}\n',
    );

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: { ...prepared.env, REVIEW_TEMPLATE_ROOT: template },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(join(prepared.run, "status.json"), "utf8"))
        .install,
    ).toMatchObject({
      status: "installed",
      template: "mismatch",
      seconds: expect.any(Number),
    });
    expect(existsSync(join(prepared.root, "template-seen"))).toBe(false);
    expect(existsSync(join(prepared.run, "work/repo/node_modules"))).toBe(
      false,
    );
    expect(await readFile(prepared.bunArgv, "utf8")).toContain(
      "install --frozen-lockfile",
    );
  });

  it("records a failed template copy as the install's failure", async () => {
    const lockfile = '{"lockfileVersion":1}\n';
    const prepared = await prepareRun("template-copy-failure", {
      "package.json": '{"name":"demo"}\n',
      "bun.lock": lockfile,
      node_modules: "a regular file where the template goes\n",
    });
    const template = await stageTemplate(prepared.root, lockfile);

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: { ...prepared.env, REVIEW_TEMPLATE_ROOT: template },
    });
    const failed = {
      status: "failed",
      manifest: "bun.lock",
      reason: "template copy: exit 1",
      seconds: null,
      nothingToDo: null,
      template: null,
    };

    expect(result.status).not.toBe(0);
    expect(
      JSON.parse(await readFile(join(prepared.run, "install.json"), "utf8")),
    ).toEqual(failed);
    expect(
      JSON.parse(await readFile(join(prepared.run, "status.json"), "utf8"))
        .install,
    ).toEqual(failed);
    expect(existsSync(prepared.bunArgv)).toBe(false);
  });

  it.each([
    ["matches", '{"lockfileVersion":1}\n'],
    ["differs from", '{"lockfileVersion":1,"other":true}\n'],
  ])(
    "records an image without a template as absent when the lockfile %s the bake's",
    async (_, bakedLockfile) => {
      const lockfile = '{"lockfileVersion":1}\n';
      const prepared = await prepareRun("template-absent", {
        "package.json": '{"name":"demo"}\n',
        "bun.lock": lockfile,
      });
      // The lockfile survived the bake and the tree did not, which is a broken
      // image rather than a target whose lockfile moved.
      const template = await stageTemplate(prepared.root, bakedLockfile);
      await rm(join(template, "node_modules-template"), { recursive: true });

      const result = spawnSync("bash", [runnerScript, prepared.run], {
        encoding: "utf8",
        env: { ...prepared.env, REVIEW_TEMPLATE_ROOT: template },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(await readFile(join(prepared.run, "status.json"), "utf8"))
          .install,
      ).toMatchObject({
        status: "installed",
        template: "absent",
        seconds: expect.any(Number),
      });
      expect(existsSync(join(prepared.run, "work/repo/node_modules"))).toBe(
        false,
      );
      expect(await readFile(prepared.bunArgv, "utf8")).toContain(
        "install --frozen-lockfile",
      );
    },
  );

  it("installs with bun when the checkout root carries the binary lockfile", async () => {
    const prepared = await prepareRun("bun-lockb-project", {
      "package.json": '{"name":"demo"}\n',
      "bun.lockb": "binary lockfile\n",
      "index.ts": "export const demo = true;\n",
    });

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: prepared.env,
    });
    const steps = await readSteps(prepared.run);
    const report = JSON.parse(
      await readFile(join(prepared.run, "report.json"), "utf8"),
    );

    expect(result.status).toBe(0);
    expect(await readFile(prepared.bunArgv, "utf8")).toContain(
      "install --frozen-lockfile",
    );
    expect(steps.find((step) => step["step"] === "install")).toMatchObject({
      exit: 0,
      detail: "installed with bun.lockb",
    });
    expect(report.install).toEqual({
      status: "installed",
      manifest: "bun.lockb",
      reason: null,
      seconds: expect.any(Number),
      nothingToDo: false,
      template: "absent",
    });
    expect(steps.find((step) => step["step"] === "review")?.["exit"]).toBe(0);
    expect(await readFile(prepared.piArgv, "utf8")).toContain(
      "-- review this change",
    );
  });

  it("names the resolver it could not follow instead of installing a foreign tree", async () => {
    const prepared = await prepareRun("npm-project", {
      "package.json": '{"name":"demo"}\n',
      "package-lock.json": '{"lockfileVersion":3}\n',
      "index.js": "module.exports = true;\n",
    });

    const result = spawnSync("bash", [runnerScript, prepared.run], {
      encoding: "utf8",
      env: prepared.env,
    });
    const steps = await readSteps(prepared.run);
    const report = JSON.parse(
      await readFile(join(prepared.run, "report.json"), "utf8"),
    );

    expect(result.status).toBe(0);
    expect(report.install).toEqual({
      status: "skipped",
      manifest: null,
      reason:
        "the checkout root has a package.json and no bun lockfile (found package-lock.json)",
      seconds: null,
      nothingToDo: null,
      template: null,
    });
    expect(await readFile(prepared.bunArgv, "utf8")).not.toContain(
      "install --frozen-lockfile",
    );
    expect(steps.find((step) => step["step"] === "review")?.["exit"]).toBe(0);
    expect(await readFile(prepared.piArgv, "utf8")).toContain(
      "-- review this change",
    );
  });
});

/**
 * The suite spawns eighteen supervised runners beside twenty other files that
 * each spawn real processes, so a wait on one of them competes with all of
 * them. These budgets are the point at which a state that is never coming is
 * declared absent, not a performance assertion: a turn that normally takes
 * 400ms gets room to take twenty seconds on a loaded machine, and still fails
 * loudly when the state does not arrive at all.
 */
const SUPERVISED_WAIT_MS = 20_000;

describe("supervised native Pi RPC lifecycle", { timeout: 120_000 }, () => {
  const objectValue = (value: unknown) => {
    if (!value || typeof value !== "object") {
      throw new Error("Expected object value");
    }
    return value as Record<string, unknown>;
  };

  /** The drained output of every supervised runner this suite spawned. */
  const runnerOutput = new WeakMap<
    ReturnType<typeof spawn>,
    { stdout: string; stderr: string }
  >();

  const prepareSupervisedRun = async (
    runId: string,
    initialPrompt: string | null = "standby",
    provider = "openai-codex",
    jobExtra: Record<string, unknown> = {},
    piEnv: Record<string, string> = {},
    entry: "bridge" | "main" = "bridge",
    startedSecondsEarly = 0,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-supervised-"));
    temporaryDirectories.push(root);
    // The runner's own main clones its checkout, so it is handed a remote
    // instead of a checkout already in place.
    const repo = join(root, entry === "main" ? "source" : "work/repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=review-pi-test",
      "-c",
      "user.email=review-pi-test@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    execFileSync("git", ["-C", repo, "branch", "base"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const remote = join(root, "origin.git");
    if (entry === "main") {
      execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    }

    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    const fakePiPath = join(binDir, "pi");

    const fakePiSource = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.85.0");
  process.exit(0);
}

const validFlags = new Set([
  "--provider", "--model", "--thinking", "--mode",
  "--session-dir", "--session-id", "--session", "--continue",
  "--approve", "--no-extensions", "--no-skills", "--no-prompt-templates"
]);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    if (!validFlags.has(arg)) {
      process.stderr.write("fake-pi error: invalid CLI flag " + arg + "\\n");
      process.exit(2);
    }
    if (["--provider", "--model", "--thinking", "--mode", "--session-dir", "--session-id", "--session"].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        process.stderr.write("fake-pi error: flag " + arg + " missing argument\\n");
        process.exit(2);
      }
      i++;
    }
  }
}

const sessionFlags = ["--session-dir", "--session-id", "--session", "--continue"].filter((flag) => args.includes(flag));
if (args.includes("--session") && sessionFlags.length !== 1) {
  process.stderr.write("fake-pi error: --session cannot be combined with another session flag\\n");
  process.exit(2);
}
if (!args.includes("--session") && (!args.includes("--session-dir") || !args.includes("--session-id"))) {
  process.stderr.write("fake-pi error: new session requires --session-dir and --session-id\\n");
  process.exit(2);
}

const sessionDirIdx = args.indexOf("--session-dir");
const sessionDir = sessionDirIdx !== -1 ? args[sessionDirIdx + 1] : "/tmp";
const sessionIdIdx = args.indexOf("--session-id");
const savedSessionIdx = args.indexOf("--session");
const sessionFile = savedSessionIdx !== -1 ? args[savedSessionIdx + 1] : sessionDir + "/" + args[sessionIdIdx + 1] + ".jsonl";
const sessionId = sessionIdIdx !== -1 ? args[sessionIdIdx + 1] : path.basename(sessionFile, ".jsonl");
if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
  process.stderr.write("fake-pi error: invalid session id " + sessionId + "\\n");
  process.exit(2);
}
let stateAnswers = 0;
let steeredToolOpen = false;
if (process.env.PI_ARGS_LOG) {
  fs.appendFileSync(process.env.PI_ARGS_LOG, JSON.stringify(args) + "\\n");
}

try { fs.appendFileSync(sessionFile, ""); } catch {}

const allowedKeys = {
  prompt: new Set(["id", "type", "message", "streamingBehavior", "images"]),
  steer: new Set(["id", "type", "message", "images"]),
  get_state: new Set(["id", "type"]),
  abort: new Set(["id", "type"]),
};

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    const clean = line.replace(/\\r$/, "");
    if (!clean.trim()) continue;

    let cmd;
    try {
      cmd = JSON.parse(clean);
    } catch {
      process.stderr.write("fake-pi error: invalid JSON input\\n");
      process.exit(2);
    }

    if (!allowedKeys[cmd.type]) {
      process.stderr.write("fake-pi error: invalid command type " + cmd.type + "\\n");
      process.exit(2);
    }
    for (const key of Object.keys(cmd)) {
      if (!allowedKeys[cmd.type].has(key)) {
        process.stderr.write("fake-pi error: command " + cmd.type + " contains non-native property " + key + "\\n");
        process.exit(2);
      }
    }

    if (cmd.type === "prompt") {
      if (typeof cmd.message !== "string" || !cmd.message) {
        process.stderr.write("fake-pi error: prompt missing message string\\n");
        process.exit(2);
      }
    } else if (cmd.type === "steer") {
      if (typeof cmd.message !== "string" || !cmd.message) {
        process.stderr.write("fake-pi error: steer missing message string\\n");
        process.exit(2);
      }
    }

    const cmdId = cmd.id;
    if (process.env.PI_CLOCK_LOG) {
      fs.appendFileSync(process.env.PI_CLOCK_LOG, JSON.stringify({ type: cmd.type, at: Date.now() }) + "\\n");
    }

    if (cmd.type === "get_state") {
      const first = stateAnswers === 0;
      const delay = first ? Number(process.env.PI_STATE_DELAY_MS || 0) : 0;
      const gate = first ? process.env.PI_STATE_GATE : undefined;
      stateAnswers += 1;
      const answer = () => process.stdout.write(JSON.stringify({
        id: cmdId,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId,
          sessionFile,
          isStreaming: false,
          messageCount: 0,
        },
      }) + "\\n");
      const answerOnceOpen = () =>
        !gate || fs.existsSync(gate) ? answer() : setTimeout(answerOnceOpen, 20);
      setTimeout(answerOnceOpen, delay);
    } else if (cmd.type === "steer") {
      if (process.env.PI_STEER_LOG) {
        fs.appendFileSync(process.env.PI_STEER_LOG, cmd.message + "\\n");
      }
      process.stdout.write(JSON.stringify({
        id: cmdId,
        type: "response",
        command: "steer",
        success: true,
      }) + "\\n");
      if (steeredToolOpen) {
        steeredToolOpen = false;
        process.stdout.write(JSON.stringify({
          type: "turn_end",
          message: { stopReason: "stop", usage: { input: 10, output: 10, totalTokens: 20 } },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Steered review finished" }] }],
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      }
    } else if (cmd.type === "abort") {
      process.stdout.write(JSON.stringify({
        id: cmdId,
        type: "response",
        command: "abort",
        success: true,
      }) + "\\n");
    } else if (cmd.type === "prompt") {
      if (process.env.PI_PROMPT_LOG) {
        fs.appendFileSync(process.env.PI_PROMPT_LOG, cmd.message + "\\n---\\n");
      }
      if (cmd.message.includes("reject prompt")) {
        process.stdout.write(JSON.stringify({
          id: cmdId,
          type: "response",
          command: "prompt",
          success: false,
          error: "native_prompt_rejected",
        }) + "\\n");
        continue;
      }
      const promptResponse = JSON.stringify({
        id: cmdId,
        type: "response",
        command: "prompt",
        success: true,
      });

      if (cmd.message.includes("rapid final")) {
        process.stdout.write([
          promptResponse,
          JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 2, output: 3, totalTokens: 5 } },
          }),
          JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "RAPID_FINAL" }] }],
          }),
          JSON.stringify({ type: "agent_settled" }),
        ].join("\\n") + "\\n");
        continue;
      }

      process.stdout.write(promptResponse + "\\n");

      if (cmd.message.includes("split unicode")) {
        const event = Buffer.from(JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "café 🧪" },
        }) + "\\n");
        const splitAt = event.indexOf(Buffer.from("🧪")) + 2;
        process.stdout.write(event.subarray(0, splitAt));
        setTimeout(() => {
          process.stdout.write(event.subarray(splitAt));
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "UNICODE_FINAL" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 20);
        continue;
      }

      if (cmd.message.includes("steered tool")) {
        // A real turn stays open between a tool's result and the request
        // that follows it; this one stays open until the runner steers it.
        process.stdout.write(JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "call_steered_1",
          toolName: "bash",
          args: { command: "check.sh" },
        }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "call_steered_1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "tool completed" }] },
          }) + "\\n");
          steeredToolOpen = true;
        }, 80);
      } else if (cmd.message.includes("silent tool")) {
        process.stdout.write(JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "call_tool_1",
          toolName: "bash",
          args: { command: "check.sh" },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "tool_execution_update",
          toolCallId: "call_tool_1",
          toolName: "bash",
          args: { command: "check.sh" },
          partialResult: { content: [{ type: "text", text: "partial output" }] },
        }) + "\\n");

        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "call_tool_1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "tool completed" }] },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 10, output: 10, totalTokens: 20 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "Tool review finished" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 80);
      } else if (cmd.message.includes("token heavy turn")) {
        // One turn whose own context is past the ceiling the lane was given:
        // pi reports the whole call, cached or not, as the broker counts it.
        process.stdout.write(JSON.stringify({
          type: "turn_end",
          message: { stopReason: "stop", usage: { input: Number(process.env.PI_INPUT_USAGE || 0), output: 1, totalTokens: 1 } },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "token heavy turn done" }] }],
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      } else if (cmd.message.includes("crash now")) {
        process.stderr.write("fatal model failure in pi child\\n");
        setTimeout(() => {
          process.exit(1);
        }, 30);
      } else if (cmd.message.includes("simulate auth blocked")) {
        process.stderr.write("401 Unauthorized: token expired\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "error", errorMessage: "401 Unauthorized: token expired" },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          setTimeout(() => process.exit(1), 10);
        }, 30);
      } else if (cmd.message.includes("simulate quota blocked")) {
        process.stderr.write("429 insufficient_quota\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "error", errorMessage: "429 insufficient_quota" },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          setTimeout(() => process.exit(1), 10);
        }, 30);
      } else if (cmd.message.includes("simulate budget exhausted")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "error", errorMessage: '429 {"type":"review_pi_broker","reason":"max_input_tokens"}' },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          setTimeout(() => process.exit(1), 10);
        }, 30);
      } else if (cmd.message.includes("simulate oauth 403")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: {
              stopReason: "error",
              errorMessage: 'OpenAI API error (403): 403 "The OAuth2 access token could not be validated."',
            },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 30);
      } else if (cmd.message.includes("model error then exit")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "error", errorMessage: "provider model error" },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          setTimeout(() => process.exit(1), Number(process.env.PI_EXIT_DELAY_MS || 10));
        }, 30);
      } else if (cmd.message.includes("active descendant")) {
        const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        fs.writeFileSync(process.env.PI_DESCENDANT_PID, String(descendant.pid));
        process.stdout.write(JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "call_descendant",
          toolName: "bash",
          args: { command: "long-running-command" },
        }) + "\\n");
      } else if (cmd.message.includes("candidate then model error")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 3, output: 3, totalTokens: 6 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "candidate before the error" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "error", errorMessage: "provider model error" },
          }) + "\\n");
        }, 30);
      } else if (cmd.message.includes("candidate then continue")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "candidate partial review" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 30);
      } else if (cmd.message.includes("provide final conclusion")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 10, output: 15, totalTokens: 25 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "ACCEPTED_FINAL_CONCLUSION" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 30);
      } else if (cmd.message.includes("documented events")) {
        setTimeout(() => {
          for (const event of [
            { type: "agent_start" },
            { type: "turn_start" },
            { type: "queue_update", steering: [], followUp: [] },
            { type: "message_start" },
            { type: "message_update" },
            { type: "bash_execution_update", id: "req-1", delta: "total 0" },
            { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "429 rate_limit_error" },
            { type: "auto_retry_end", success: true, attempt: 1 },
            { type: "extension_error", extensionPath: "/opt/review/extensions/claude-code-provider.js", event: "tool_call", error: "401 unauthorized" },
            { type: "message_end" },
            {
              type: "turn_end",
              message: { stopReason: "stop", usage: { input: 2, output: 2, totalTokens: 4 } },
            },
            {
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "DOCUMENTED_FINAL" }] }],
              willRetry: false,
            },
            { type: "compaction_start", reason: "threshold" },
            { type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "terminated" },
            { type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" },
            { type: "summarization_retry_finished" },
            { type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false },
          ]) {
            process.stdout.write(JSON.stringify(event) + "\\n");
          }
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          }, 750);
        }, 30);
      } else if (cmd.message.includes("settle later")) {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 4, output: 4, totalTokens: 8 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "SETTLE_LATER" }] }],
          }) + "\\n");
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
          }, 750);
        }, 30);
      } else {
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "message_start" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "message_update" }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "message_end" }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "turn_end",
            message: { stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } },
          }) + "\\n");
          process.stdout.write(JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "standby ready" }] }],
          }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 30);
      }
    }
  }
});
`;
    await writeFile(fakePiPath, fakePiSource);
    await chmod(fakePiPath, 0o755);

    await writeFile(
      join(root, "job.json"),
      JSON.stringify({
        runId,
        supervised: true,
        head: { sha },
        base: { sha },
        fixturePatch: "",
        provider,
        model: "gpt-5.6-sol",
        ...(initialPrompt === null ? {} : { prompt: initialPrompt }),
        checkCommand: "git --no-pager diff --stat base..HEAD",
        ...(entry === "main" ? { gitRemote: remote } : {}),
        ...jobExtra,
      }),
    );
    if (initialPrompt !== null) {
      await writeFile(join(root, "prompt.txt"), initialPrompt);
    }
    await writeFile(join(root, "pi.stderr"), "");
    await writeFile(join(root, "diff.stat"), "");
    await writeFile(join(root, "check.log"), "check passed\n");

    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );

    // A lane's window counts down from the whole second the runner's
    // `date +%s` read, which no test can observe, so the test names that
    // second itself: the one it starts the runner in, or an earlier one for a
    // lane whose clock started before its bridge, as it does after a clone.
    // That lane starts at the top of a second, so the seconds its clock has
    // already run are whole too. Only that first read is the test's: every
    // later one is the runner timing its own steps.
    if (startedSecondsEarly > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 - (Date.now() % 1000)),
      );
    }
    const startedAt =
      (Math.floor(Date.now() / 1000) - startedSecondsEarly) * 1000;
    await writeFile(
      join(binDir, "date"),
      `#!/bin/sh
if [ "$1" = "+%s" ] && mkdir "${join(binDir, "date-started")}" 2>/dev/null; then
  echo ${startedAt / 1000}
  exit 0
fi
exec /bin/date "$@"
`,
    );
    await chmod(join(binDir, "date"), 0o755);
    const argv = entry === "main" ? [runner, root] : [runner, root, "--bridge"];
    const runnerProc = spawn("bash", argv, {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"]}`,
        PI_BIN: fakePiPath,
        PI_ARGS_LOG: join(root, "pi-args.jsonl"),
        PI_STEER_LOG: join(root, "pi-steer.log"),
        PI_PROMPT_LOG: join(root, "pi-prompt.log"),
        PI_CLOCK_LOG: join(root, "pi-clock.jsonl"),
        PI_DESCENDANT_PID: join(root, "descendant.pid"),
        ...piEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // A piped child nobody reads blocks on write the moment the pipe buffer
    // fills, and then never exits. The wait for its exit would hang until the
    // test timeout and report nothing about why, so every supervised run drains
    // its own output and keeps the tail for the failure message.
    const captured = { stdout: "", stderr: "" };
    runnerOutput.set(runnerProc, captured);
    runnerProc.stdout?.setEncoding("utf8");
    runnerProc.stderr?.setEncoding("utf8");
    runnerProc.stdout?.on("data", (chunk: string) => {
      captured.stdout += chunk;
    });
    runnerProc.stderr?.on("data", (chunk: string) => {
      captured.stderr += chunk;
    });

    const sockPath = join(root, "rpc.sock");
    // Main clones and checks before the socket exists, and a lane that fails
    // its first turn closes it again before a poll could see it.
    if (entry === "bridge") await waitForSocket(sockPath);

    return { root, sockPath, runnerProc, startedAt };
  };

  /** The arguments of the first Pi this run spawned, as it logged them. */
  const firstInvocation = async (root: string) => {
    const path = join(root, "pi-args.jsonl");
    const start = Date.now();
    while (Date.now() - start < SUPERVISED_WAIT_MS) {
      try {
        const line = (await readFile(path, "utf8")).trim().split("\n")[0];
        if (line) return JSON.parse(line) as string[];
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Pi was never invoked");
  };

  const waitForSocket = async (
    sockPath: string,
    timeoutMs = SUPERVISED_WAIT_MS,
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const st = statSync(sockPath);
        if (st.isSocket()) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Socket ${sockPath} not ready after ${timeoutMs}ms`);
  };

  const sendCommand = (
    sockPath: string,
    cmd: Record<string, unknown>,
    timeoutMs = SUPERVISED_WAIT_MS,
    splitCharacter?: string,
  ): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const client = createConnection(sockPath, () => {
        const payload = Buffer.from(`${JSON.stringify(cmd)}\n`);
        if (splitCharacter) {
          const splitAt = payload.indexOf(Buffer.from(splitCharacter)) + 2;
          client.write(payload.subarray(0, splitAt));
          client.write(payload.subarray(splitAt));
        } else {
          client.write(payload);
        }
      });

      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`Timeout waiting for response to ${cmd["type"]}`));
      }, timeoutMs);

      let buffer = "";
      client.setEncoding("utf8");
      client.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        if (lines.length > 1) {
          clearTimeout(timer);
          client.end();
          try {
            resolve(JSON.parse(lines[0] ?? ""));
          } catch (err) {
            reject(err);
          }
        }
      });

      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  };

  const waitForStatus = async (
    statusPath: string,
    predicate: (status: Record<string, unknown>) => boolean,
    timeoutMs = SUPERVISED_WAIT_MS,
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const content = await readFile(statusPath, "utf8");
        const parsed = objectValue(JSON.parse(content));
        if (predicate(parsed)) return parsed;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Predicate on ${statusPath} not met after ${timeoutMs}ms`);
  };

  /**
   * The runner settled after its standby prompt.
   *
   * `state === "idle"` alone is ambiguous: the bridge writes it once when the
   * child reports idle before any prompt, and again when the standby prompt
   * finishes. A wait that accepts the first write returns while the standby
   * turn is still streaming, and the inspect that follows reads `running` with
   * `isStreaming: true` - which is how this suite failed one run in ten.
   */
  const waitForStandbySettled = (statusPath: string) =>
    waitForStatus(
      statusPath,
      (s) =>
        s["state"] === "idle" &&
        s["childIdle"] === true &&
        s["isStreaming"] === false &&
        s["lastCandidateResult"] === "standby ready" &&
        objectValue(s["process"])["alive"] === true,
    );

  /**
   * The trace line a test is waiting for.
   *
   * A status wait is satisfied by the previous turn's terminal state as soon as
   * the prompt's own events are still in flight, so a test that reads the trace
   * waits for the trace itself rather than for a status another turn already
   * wrote.
   */
  const waitForTrace = async (
    tracePath: string,
    predicate: (line: Record<string, unknown>) => boolean,
    timeoutMs = SUPERVISED_WAIT_MS,
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const lines = (await readFile(tracePath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        if (lines.some(predicate)) return lines;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Predicate on ${tracePath} not met after ${timeoutMs}ms`);
  };

  /** A log the fake Pi appends to, once it holds what the test waits for. */
  const waitForLog = async (
    path: string,
    predicate: (log: string) => boolean,
    timeoutMs = SUPERVISED_WAIT_MS,
  ) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const log = await readFile(path, "utf8");
        if (predicate(log)) return log;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Predicate on ${path} not met after ${timeoutMs}ms`);
  };

  /** When Pi read the bridge's nth command of a type, by Pi's own clock. */
  const piReadAt = async (root: string, type: string, nth = 0) => {
    const read = (await readFile(join(root, "pi-clock.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; at: number })
      .filter((line) => line.type === type)[nth];
    if (!read) throw new Error(`Pi read no ${type} #${nth}`);
    return read.at;
  };

  /**
   * The windows the bridge can have printed at a briefing.
   *
   * It prints `total` less the whole seconds since the start the test pinned,
   * reading its own clock once, after `earliest` and before `latest`. Both are
   * instants this test saw, so the two ends meet on one value unless that span
   * crosses a whole second, and a loaded host moves them with it.
   */
  const windowBetween = (
    total: number,
    startedAt: number,
    earliest: number,
    latest: number,
  ) => ({
    most: Math.max(0, total - Math.floor((earliest - startedAt) / 1000)),
    least: Math.max(0, total - Math.floor((latest - startedAt) / 1000)),
  });

  /** The window the runner appended to the first prompt it sent. */
  const promptWindow = (prompt: string) => {
    const match =
      /Budget for this lane: (\d+) model requests and (\d+) seconds\./.exec(
        prompt,
      );
    if (!match) throw new Error(`no budget note in the prompt: ${prompt}`);
    return { requests: Number(match[1]), seconds: Number(match[2]) };
  };

  /** The seconds notice the runner sent at a tool boundary, as the model read it. */
  const secondsNotice = (steers: string) => {
    const match =
      /Budget notice from the runner: (\d+) of (\d+) seconds spent\./.exec(
        steers,
      );
    if (!match) throw new Error(`no seconds notice in the steers: ${steers}`);
    return { spent: Number(match[1]), cap: Number(match[2]) };
  };

  const waitForExit = (
    proc: ReturnType<typeof spawn>,
    timeoutMs = 10_000,
  ): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode);
      const onClose = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      // Bounded on purpose: an unbounded wait here surfaces as the suite's own
      // test timeout, which names the test and nothing about what stalled.
      const timer = setTimeout(() => {
        proc.off("close", onClose);
        const captured = runnerOutput.get(proc);
        const tail = captured?.stderr.trim().slice(-2000);
        reject(
          new Error(
            `runner ${String(proc.pid)} did not exit within ${timeoutMs}ms${tail ? `; stderr tail:\n${tail}` : "; it wrote nothing to stderr"}`,
          ),
        );
      }, timeoutMs);
      proc.on("close", onClose);
    });
  };

  const runPublicSend = (
    runner: string,
    root: string,
    argv: string[],
    label: string,
  ) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn("bash", [runner, root, ...argv], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${label} timed out`));
        }, SUPERVISED_WAIT_MS);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );

  /** A command line for the in-container RPC bridge, as the CLI encodes it. */
  type BridgeCommand = { type: string } & Record<string, unknown>;

  const runPublicCommand = (
    runner: string,
    root: string,
    command: BridgeCommand,
  ) =>
    runPublicSend(
      runner,
      root,
      ["--send", JSON.stringify(command)],
      "public --send command",
    );

  it("maintains persistent child process and session across observer disconnect and reconnect", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "disconnect-reconnect",
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);

      const inspect1 = await sendCommand(sockPath, {
        id: "obs1-inspect",
        type: "inspect",
      });
      expect(inspect1).toMatchObject({
        type: "response",
        command: "inspect",
        success: true,
        data: {
          runId: "disconnect-reconnect",
          process: { alive: true },
          childIdle: true,
          isStreaming: false,
        },
      });
      const inspect1Data = objectValue(inspect1["data"]);
      const pid1 = objectValue(inspect1Data["process"])["pid"];
      const sessionId1 = objectValue(inspect1Data["session"])["sessionId"];
      expect(pid1).toBeGreaterThan(0);
      expect(sessionId1).toBe("disconnect-reconnect");

      const state2 = await sendCommand(sockPath, {
        id: "obs2-state",
        type: "get_state",
      });
      expect(state2).toMatchObject({
        id: "obs2-state",
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: sessionId1,
        },
      });

      const inspect2 = await sendCommand(sockPath, {
        id: "obs2-inspect",
        type: "inspect",
      });
      const inspect2Process = objectValue(
        objectValue(inspect2["data"])["process"],
      );
      expect(inspect2Process["pid"]).toBe(pid1);
      expect(inspect2Process["alive"]).toBe(true);

      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("names the subscription provider's extension for a claude-code lane and no extension for a built-in one", async () => {
    const subscription = await prepareSupervisedRun(
      "claude-code-lane",
      "standby",
      "claude-code",
    );
    try {
      await waitForStandbySettled(join(subscription.root, "status.json"));
      const invocation = await firstInvocation(subscription.root);
      const flag = invocation.indexOf("-e");
      expect(flag).toBeGreaterThan(-1);
      expect(invocation[flag + 1]).toBe(
        "/opt/review/extensions/claude-code-provider.js",
      );
      // Named explicitly while discovery stays off: the checkout is untrusted
      // input, and `--approve` is what would let it contribute an extension of
      // its own to the process reviewing it.
      expect(invocation).toContain("--no-extensions");
      expect(invocation).toContain("--approve");
      await sendCommand(subscription.sockPath, { type: "accept" });
      await waitForExit(subscription.runnerProc);
    } finally {
      subscription.runnerProc.kill();
    }

    const builtin = await prepareSupervisedRun("builtin-provider-lane");
    try {
      await waitForStandbySettled(join(builtin.root, "status.json"));
      const invocation = await firstInvocation(builtin.root);
      expect(invocation).toContain("--provider");
      expect(invocation[invocation.indexOf("--provider") + 1]).toBe(
        "openai-codex",
      );
      expect(invocation).not.toContain("-e");
      await sendCommand(builtin.sockPath, { type: "accept" });
      await waitForExit(builtin.runnerProc);
    } finally {
      builtin.runnerProc.kill();
    }
  });

  it("records exactly one start and end event for an active tool without silent timeout cancellation", async () => {
    const { root, sockPath, runnerProc } =
      await prepareSupervisedRun("silent-tool");
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);

      const promptRes = await sendCommand(sockPath, {
        id: "tool-req",
        type: "prompt",
        message: "run silent tool",
      });
      expect(promptRes).toMatchObject({
        id: "tool-req",
        type: "response",
        command: "prompt",
        success: true,
      });

      // The tool's own end first, so the status wait below cannot be satisfied
      // by the standby turn this run already wrote to its own status file.
      await waitForTrace(
        join(root, "trace.jsonl"),
        (line) => line["type"] === "tool_execution_end",
      );
      await waitForStatus(
        statusPath,
        (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
      );

      const traceContent = await readFile(join(root, "trace.jsonl"), "utf8");
      const traceLines = traceContent
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      const starts = traceLines.filter(
        (l) => l.type === "tool_execution_start",
      );
      const ends = traceLines.filter((l) => l.type === "tool_execution_end");

      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        type: "tool_execution_start",
        toolCallId: "call_tool_1",
        toolName: "bash",
      });
      expect(ends[0]).toMatchObject({
        type: "tool_execution_end",
        toolCallId: "call_tool_1",
        toolName: "bash",
        isError: false,
      });
      // A partial tool result is an event pi documents; recording it as a
      // protocol error would leave a healthy lane's receipt saying the
      // stream broke when it did not.
      const toolStatus = JSON.parse(
        await readFile(statusPath, "utf8"),
      ) as Record<string, unknown>;
      expect(toolStatus["detail"]).toBe("");
      expect(toolStatus["lastEvent"]).toBe("agent_settled");

      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("tells the model to finish at three quarters of its request budget, at a tool boundary", async () => {
    // A lane that reaches a cap is cut without an answer. The notice is what
    // turns "budget spent" into "answer with what you have", so it must reach
    // Pi as a steer at a tool boundary before the request that would cross it.
    const { root, sockPath, runnerProc, startedAt } =
      await prepareSupervisedRun("budget-requests", "standby", "openai-codex", {
        budget: { requests: 4, inputTokens: 1_000_000 },
        totalTimeoutSeconds: 100_000,
      });
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      const firstPrompt = await readFile(join(root, "pi-prompt.log"), "utf8");
      const window = promptWindow(firstPrompt);
      expect(window.requests).toBe(4);
      // The bridge briefs the lane once Pi has answered its first state, so
      // the window it is told is what was left between Pi reading that state
      // request and Pi reading the prompt: never a list of the numbers a
      // loaded host can print.
      const briefed = windowBetween(
        100_000,
        startedAt,
        await piReadAt(root, "get_state"),
        await piReadAt(root, "prompt"),
      );
      expect(window.seconds).toBeLessThanOrEqual(briefed.most);
      expect(window.seconds).toBeGreaterThanOrEqual(briefed.least);

      // The standby turn was request 1. Two tool turns more: the notice fires
      // at the end of the third turn's tool, when 3 of 4 have been spent, and
      // that turn only ends once the notice has reached Pi, so a notice sent
      // anywhere after the tool boundary never arrives.
      for (const [id, tool] of [
        ["tool-1", "silent tool"],
        ["tool-2", "steered tool"],
      ]) {
        await sendCommand(sockPath, {
          id,
          type: "prompt",
          message: `run ${tool} ${id}`,
        });
        await waitForStatus(
          statusPath,
          (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
        );
      }
      await waitForTrace(
        join(root, "trace.jsonl"),
        (line) => line["type"] === "budget_notice",
      );
      const steers = await readFile(join(root, "pi-steer.log"), "utf8");
      expect(steers.trim().split("\n")).toHaveLength(1);
      expect(steers).toContain(
        "Budget notice from the runner: 3 of 4 requests spent.",
      );
      expect(steers).toContain("write your final answer");
      // The line the second prompt carries is the model's, not the runner's:
      // the note is appended once, to the first prompt only.
      const prompts = await readFile(join(root, "pi-prompt.log"), "utf8");
      expect(prompts.split("Budget for this lane").length).toBe(2);
      const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace.filter((line) => line["type"] === "budget_notice")).toEqual([
        expect.objectContaining({ name: "requests", used: 3, cap: 4 }),
      ]);

      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("fires the input budget notice at three quarters of the ceiling the lane was given", async () => {
    // The notice is the model's only warning before the broker cuts the lane,
    // so it has to be measured against the ceiling in force: a lane told the
    // trial's would be cut with its answer still unwritten. The budget below is
    // the one the local driver writes into the job for `--lane-input-cap`.
    const cap = 4_000_000;
    const spent = 3_100_000;
    expect(laneCaps("t1b", String(cap)).maxCumulativeInputTokens).toBe(cap);
    // Past three quarters of the lane's own ceiling, and nowhere near three
    // quarters of the trial's: only the ceiling in force can explain the
    // notice this test waits for.
    expect(spent).toBeGreaterThanOrEqual(Math.ceil(cap * 0.75));
    expect(spent).toBeLessThan(
      Math.ceil(SESSION_CAPS.t1b.maxCumulativeInputTokens * 0.75),
    );
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "budget-input-tokens",
      "standby",
      "openai-codex",
      {
        budget: { requests: 1_000, inputTokens: cap },
        totalTimeoutSeconds: 100_000,
      },
      { PI_INPUT_USAGE: String(spent) },
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      await sendCommand(sockPath, {
        id: "turn-1",
        type: "prompt",
        message: "run token heavy turn",
      });
      await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" &&
          s["lastCandidateResult"] === "token heavy turn done",
      );
      // The next model call is certain at a tool boundary, so that is where the
      // steer has to arrive.
      await sendCommand(sockPath, {
        id: "tool-1",
        type: "prompt",
        message: "run silent tool",
      });
      await waitForTrace(
        join(root, "trace.jsonl"),
        (line) =>
          line["type"] === "budget_notice" && line["name"] === "input tokens",
      );
      const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace.filter((line) => line["type"] === "budget_notice")).toEqual([
        // The standby turn's own single input token is counted too.
        expect.objectContaining({ name: "input tokens", used: spent + 1, cap }),
      ]);
      const steers = await readFile(join(root, "pi-steer.log"), "utf8");
      expect(steers).toContain(
        `Budget notice from the runner: ${spent + 1} of ${cap} input tokens spent.`,
      );

      await waitForStatus(
        statusPath,
        (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
      );
      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("tells the model to finish when three quarters of its window are gone", async () => {
    // The runner's clock started a second before its bridge, so the lane is
    // told nineteen of its twenty seconds, or less on a slower startup, and the
    // notice is measured against the window it was told rather than the one it
    // started with. A loaded host's startup has spent five seconds before
    // the briefing, so the window leaves it room to brief the lane in time.
    const { root, sockPath, runnerProc, startedAt } =
      await prepareSupervisedRun(
        "budget-seconds",
        "standby",
        "openai-codex",
        {
          budget: { requests: 1_000, inputTokens: 1_000_000 },
          totalTimeoutSeconds: 20,
        },
        {},
        "bridge",
        1,
      );
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      const window = promptWindow(
        await readFile(join(root, "pi-prompt.log"), "utf8"),
      );
      const briefedAfter = await piReadAt(root, "get_state");
      const briefedBefore = await piReadAt(root, "prompt");
      const briefed = windowBetween(20, startedAt, briefedAfter, briefedBefore);
      expect(window.seconds).toBeLessThanOrEqual(briefed.most);
      expect(window.seconds).toBeGreaterThanOrEqual(briefed.least);
      // A startup that spent the whole window leaves no notice to send.
      expect(window.seconds).toBeGreaterThan(0);
      // The tool turn starts once three quarters of that window are gone by
      // Pi's clock, which is late enough for the notice and, for a window of
      // four seconds or more, too early for one that waited for all of it.
      const threeQuarters =
        briefedBefore + Math.ceil(window.seconds * 0.75) * 1000 + 100;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, threeQuarters - Date.now())),
      );
      await sendCommand(sockPath, {
        id: "tool-1",
        type: "prompt",
        message: "run silent tool",
      });
      await waitForTrace(
        join(root, "trace.jsonl"),
        (line) =>
          line["type"] === "budget_notice" && line["name"] === "seconds",
      );
      // The bridge traces the notice before it sends it, and Pi logs its
      // clock read before the steer, so the steer's own line orders both.
      const steers = await waitForLog(join(root, "pi-steer.log"), (log) =>
        log.includes("seconds spent."),
      );
      const notice = secondsNotice(steers);
      expect(notice.cap).toBe(window.seconds);
      // What the notice says was spent is the time from the briefing to the
      // tool boundary it fired at, bracketed by what Pi read on either side.
      const toolPromptedAt = await piReadAt(root, "prompt", 1);
      const steeredAt = await piReadAt(root, "steer");
      expect(notice.spent).toBeGreaterThanOrEqual(
        Math.floor((toolPromptedAt - briefedBefore) / 1000),
      );
      expect(notice.spent).toBeLessThanOrEqual(
        Math.floor((steeredAt - briefedAfter) / 1000),
      );

      await waitForStatus(
        statusPath,
        (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
      );
      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("settles a promptless lane idle when the child's first state answer outlives the init wait", async () => {
    // The bridge waits five seconds for Pi's first state and a lane with no
    // prompt has nothing else to move it: the 2026-09-15 sandbox verifier
    // stayed "running" with an idle child for the whole run and was never
    // briefed. The answer settles the state whenever it arrives.
    const gateDir = await mkdtemp(join(tmpdir(), "review-pi-state-gate-"));
    temporaryDirectories.push(gateDir);
    const gate = join(gateDir, "open");
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "late-first-state",
      null,
      "openai-codex",
      {},
      { PI_STATE_DELAY_MS: "6000", PI_STATE_GATE: gate },
    );
    try {
      const statusPath = join(root, "status.json");
      // Pi holds its first answer until the gate opens, so the state read
      // before it is the one the lane has with no answer at all, however late
      // a loaded host lets this test read it.
      const early = await waitForStatus(
        statusPath,
        (s) => objectValue(s["process"])["alive"] === true,
      );
      expect(early["state"]).toBe("running");
      await writeFile(gate, "");
      const settled = await waitForStatus(
        statusPath,
        (s) => s["childIdle"] === true,
        10_000,
      );
      expect(settled["state"]).toBe("idle");
      // The bridge had stopped waiting: an answer inside the init wait would
      // have resolved that wait instead of arriving unmatched.
      expect(await readFile(join(root, "pi.stderr"), "utf8")).toContain(
        "unmatched response from pi",
      );

      await sendCommand(sockPath, {
        id: "brief",
        type: "prompt",
        message: "standby",
      });
      await waitForStandbySettled(statusPath);
      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("tells a lane the window it has left, not the one it started with", async () => {
    // Clone and install come out of the lane's window before the model sees a
    // prompt, and a briefed lane idles for most of the run before it has one.
    // The 2026-09-15 sandbox lanes were told 355 s of a 508 s window after a
    // 308 s install, so the notice keyed to it never came.
    const { root, sockPath, runnerProc, startedAt } =
      await prepareSupervisedRun("budget-window-left", null, "openai-codex", {
        budget: { requests: 1_000, inputTokens: 1_000_000 },
        totalTimeoutSeconds: 5,
      });
    try {
      const statusPath = join(root, "status.json");
      await waitForStatus(statusPath, (s) => s["childIdle"] === true);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const briefedAfter = Date.now();
      await sendCommand(sockPath, {
        id: "brief",
        type: "prompt",
        message: "standby",
      });
      await waitForStandbySettled(statusPath);
      const prompt = await readFile(join(root, "pi-prompt.log"), "utf8");
      const window = promptWindow(prompt);
      expect(window.requests).toBe(1_000);
      // The lane idled past half of its 5 s window before it was briefed, and
      // the bridge read its clock between this test sending the brief and Pi
      // reading it, so the window it is told is what was left then: at most
      // three seconds, never the five it started with.
      const briefed = windowBetween(
        5,
        startedAt,
        briefedAfter,
        await piReadAt(root, "prompt"),
      );
      expect(window.seconds).toBeLessThanOrEqual(briefed.most);
      expect(window.seconds).toBeGreaterThanOrEqual(briefed.least);

      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("forwards commands with exact native wire shape and correlated acknowledgements", async () => {
    const { root, sockPath, runnerProc } =
      await prepareSupervisedRun("wire-shapes");
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);

      const stateRes = await sendCommand(sockPath, {
        id: "req-state",
        type: "get_state",
      });
      expect(stateRes).toMatchObject({
        id: "req-state",
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "wire-shapes" },
      });

      const steerRes = await sendCommand(sockPath, {
        id: "req-steer",
        type: "steer",
        message: "steer direction",
      });
      expect(steerRes).toMatchObject({
        id: "req-steer",
        type: "response",
        command: "steer",
        success: true,
      });

      const abortRes = await sendCommand(sockPath, {
        id: "req-abort",
        type: "abort",
      });
      expect(abortRes).toMatchObject({
        id: "req-abort",
        type: "response",
        command: "abort",
        success: true,
      });

      const badPromptRes = await sendCommand(sockPath, {
        id: "req-bad",
        type: "prompt",
        message: 12345,
      });
      expect(badPromptRes["success"]).toBe(false);

      const badImagesRes = await sendCommand(sockPath, {
        id: "req-bad-images",
        type: "prompt",
        message: "invalid images",
        images: [1],
      });
      expect(badImagesRes["success"]).toBe(false);

      await sendCommand(sockPath, { type: "accept" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("ends the review where pi settled, not at its last spoken event", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "settle-gate",
      "settle later",
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStatus(
        statusPath,
        (s) =>
          s["lastEvent"] === "agent_end" &&
          s["lastCandidateResult"] === "SETTLE_LATER",
      );
      const premature = await sendCommand(sockPath, { type: "accept" });
      expect(premature["success"]).toBe(false);
      expect(String(premature["error"])).toContain("not idle");

      await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" &&
          s["lastEvent"] === "agent_settled" &&
          s["childIdle"] === true,
      );
      const accepted = await sendCommand(sockPath, { type: "accept" });
      expect(accepted["success"]).toBe(true);
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("admits every event pi documents and still ends the review where pi settled", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "documented-events",
      "documented events",
    );
    try {
      const statusPath = join(root, "status.json");
      // The table in pi 0.87.1's own docs/json.md: a retry, a compaction and an
      // extension error are what a healthy lane can see, not a broken stream.
      // The retry and the extension error name a 429 and a 401 before the
      // turn ends, so a runner that read their text into the stderr it
      // classifies a turn by would block this lane instead of idling it.
      const unsettled = await waitForStatus(
        statusPath,
        (s) =>
          s["lastEvent"] === "compaction_end" &&
          s["lastCandidateResult"] === "DOCUMENTED_FINAL",
      );
      expect(unsettled["detail"]).toBe("");
      expect(unsettled["childIdle"]).toBe(false);
      const premature = await sendCommand(sockPath, { type: "accept" });
      expect(premature["success"]).toBe(false);

      const settled = await waitForStatus(
        statusPath,
        (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
      );
      expect(settled["detail"]).toBe("");
      const stderr = await readFile(join(root, "pi.stderr"), "utf8");
      expect(stderr).not.toContain("unknown event type");
      const accepted = await sendCommand(sockPath, { type: "accept" });
      expect(accepted["success"]).toBe(true);
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("records pi's settled event instead of calling it a protocol error", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "settled-quiet",
      "standby",
    );
    try {
      const statusPath = join(root, "status.json");
      const settled = await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" &&
          s["lastEvent"] === "agent_settled" &&
          s["lastCandidateResult"] === "standby ready",
      );
      expect(settled["detail"]).toBe("");
      const stderr = await readFile(join(root, "pi.stderr"), "utf8");
      expect(stderr).not.toContain("unknown event type");
      await sendCommand(sockPath, { type: "accept" });
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("distinguishes explicit cancellation from process failure with distinct terminal reasons", async () => {
    const cancelSetup = await prepareSupervisedRun("cancel-run");
    try {
      const statusPath = join(cancelSetup.root, "status.json");
      await waitForStandbySettled(statusPath);

      const cancelRes = await sendCommand(cancelSetup.sockPath, {
        id: "cancel-cmd",
        type: "cancel",
        reason: "cancelled_by_conductor",
      });
      expect(cancelRes).toMatchObject({
        id: "cancel-cmd",
        type: "response",
        command: "cancel",
        success: true,
        data: { cancelled: true },
      });

      await waitForExit(cancelSetup.runnerProc);
      const cancelStatus = JSON.parse(
        await readFile(join(cancelSetup.root, "status.json"), "utf8"),
      );
      expect(cancelStatus).toMatchObject({
        state: "cancelled",
        terminalReason: "cancelled_by_conductor",
        process: { alive: false },
      });
    } finally {
      cancelSetup.runnerProc.kill();
    }

    const errorSetup = await prepareSupervisedRun("crash-run", "crash now");
    try {
      await waitForExit(errorSetup.runnerProc);
      const errorStatus = JSON.parse(
        await readFile(join(errorSetup.root, "status.json"), "utf8"),
      );
      expect(errorStatus).toMatchObject({
        state: "failed",
        terminalReason: "process_exit",
        process: { alive: false },
      });

      const errorEvidence = JSON.parse(
        await readFile(join(errorSetup.root, "review-error.json"), "utf8"),
      );
      expect(errorEvidence).toMatchObject({
        reason: "process_exit",
      });
      expect(errorEvidence.stderrTail).toContain("fatal model failure");
    } finally {
      errorSetup.runnerProc.kill();
    }
  });

  it("allows recovering from an incomplete candidate result via continuation in the same session", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "recoverable-continuation",
      "candidate then continue",
    );
    try {
      const statusPath = join(root, "status.json");

      await waitForStatus(
        statusPath,
        (s) => s["state"] === "idle" && s["lastEvent"] === "agent_settled",
      );
      const inspect1 = await sendCommand(sockPath, { type: "inspect" });
      const inspect1Data = objectValue(inspect1["data"]);
      expect(inspect1Data["lastCandidateResult"]).toBe(
        "candidate partial review",
      );
      expect(objectValue(inspect1Data["process"])["alive"]).toBe(true);

      const contRes = await sendCommand(sockPath, {
        id: "cont-1",
        type: "prompt",
        message: "provide final conclusion",
      });
      expect(contRes).toMatchObject({
        id: "cont-1",
        type: "response",
        command: "prompt",
        success: true,
      });

      await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" &&
          s["lastEvent"] === "agent_settled" &&
          !s["inFlightTool"],
      );
      const inspect2 = await sendCommand(sockPath, { type: "inspect" });
      expect(objectValue(inspect2["data"])["lastCandidateResult"]).toBe(
        "ACCEPTED_FINAL_CONCLUSION",
      );

      const acceptRes = await sendCommand(sockPath, {
        id: "acc-1",
        type: "accept",
      });
      expect(acceptRes).toMatchObject({
        id: "acc-1",
        type: "response",
        command: "accept",
        success: true,
      });

      await waitForExit(runnerProc);

      const runner = fileURLToPath(
        new URL("../../container/review-run.sh", import.meta.url),
      );
      const reportResult = spawnSync(
        "bash",
        ["-c", 'source "$1" "$2"; do_report', "runner-test", runner, root],
        { encoding: "utf8" },
      );
      expect(reportResult.status).toBe(0);

      const report = JSON.parse(
        await readFile(join(root, "report.json"), "utf8"),
      );
      expect(report.finalText).toBe("ACCEPTED_FINAL_CONCLUSION");
      expect(report.usage.turns).toBe(2);
      expect(report.usage.totalTokens).toBe(35);
    } finally {
      runnerProc.kill();
    }
  });

  it("supports restarting an idle auth-blocked child process with preserved session while rejecting active tool restart", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "auth-restart",
      "simulate auth blocked",
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "blocked" &&
          s["terminalReason"] === "auth_blocked" &&
          s["childIdle"] === true &&
          objectValue(s["process"])["alive"] === false,
      );

      const inspectBlocked = await sendCommand(sockPath, { type: "inspect" });
      const blockedData = objectValue(inspectBlocked["data"]);
      const oldPid = objectValue(blockedData["process"])["pid"];
      expect(blockedData["terminalReason"]).toBe("auth_blocked");
      expect(blockedData["childIdle"]).toBe(true);

      const restartRes = await sendCommand(sockPath, {
        id: "restart-1",
        type: "restart_process",
      });
      expect(restartRes).toMatchObject({
        id: "restart-1",
        type: "response",
        command: "restart_process",
        success: true,
      });
      const newPid = objectValue(restartRes["data"])["pid"];
      expect(newPid).toBeDefined();
      expect(newPid).not.toBe(oldPid);

      const inspectNew = await sendCommand(sockPath, { type: "inspect" });
      const inspectNewData = objectValue(inspectNew["data"]);
      expect(objectValue(inspectNewData["process"])["pid"]).toBe(newPid);
      expect(objectValue(inspectNewData["process"])["alive"]).toBe(true);
      expect(objectValue(inspectNewData["session"])["sessionId"]).toBe(
        "auth-restart",
      );
      expect(inspectNewData["terminalReason"]).toBe(null);

      for (let attempt = 0; attempt < 100; attempt++) {
        const lines = (await readFile(join(root, "pi-args.jsonl"), "utf8"))
          .trim()
          .split("\n");
        if (lines.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const invocations = (await readFile(join(root, "pi-args.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toContain("--session-id");
      expect(invocations[0]).not.toContain("--session");
      expect(invocations[1]).toContain("--session");
      expect(invocations[1]).not.toContain("--session-id");
      expect(invocations[1]).not.toContain("--session-dir");

      await sendCommand(sockPath, {
        type: "prompt",
        message: "active descendant",
      });
      await waitForStatus(
        statusPath,
        (status) => status["inFlightTool"] === "call_descendant",
      );
      const activeRestart = await sendCommand(sockPath, {
        type: "restart_process",
      });
      expect(activeRestart).toMatchObject({
        command: "restart_process",
        success: false,
      });

      await sendCommand(sockPath, { type: "cancel" });
      await waitForExit(runnerProc);
    } finally {
      runnerProc.kill();
    }
  });

  it("keeps a lane the broker cut at its cap blocked as budget_exhausted", async () => {
    const lane = await prepareSupervisedRun(
      "budget-exhausted",
      "simulate budget exhausted",
    );
    try {
      const status = await waitForStatus(
        join(lane.root, "status.json"),
        (status) =>
          status["state"] === "blocked" &&
          objectValue(status["process"])["alive"] === false,
      );
      expect(status["terminalReason"]).toBe("budget_exhausted");
      const evidence = JSON.parse(
        await readFile(join(lane.root, "review-error.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(evidence["reason"]).toBe("budget_exhausted");
      await sendCommand(lane.sockPath, { type: "cancel" });
      await waitForExit(lane.runnerProc);
    } finally {
      lane.runnerProc.kill();
    }
  });

  it("preserves quota and model errors through agent end and process exit", async () => {
    const quota = await prepareSupervisedRun(
      "quota-blocked",
      "simulate quota blocked",
    );
    try {
      const quotaStatusPath = join(quota.root, "status.json");
      const quotaStatus = await waitForStatus(
        quotaStatusPath,
        (status) =>
          status["state"] === "blocked" &&
          status["terminalReason"] === "quota_blocked" &&
          objectValue(status["process"])["alive"] === false,
      );
      expect(quotaStatus).toMatchObject({
        childIdle: true,
        isStreaming: false,
      });
      const restart = await sendCommand(quota.sockPath, {
        type: "restart_process",
      });
      expect(restart).toMatchObject({ success: false });
      await sendCommand(quota.sockPath, { type: "cancel" });
      expect(await waitForExit(quota.runnerProc)).toBe(130);
    } finally {
      quota.runnerProc.kill();
    }

    // pi exits 10 ms after its error turn, or a second after it. The bridge
    // exits 100 ms after it decides to, so the slow child is the order in
    // which a bridge that did not wait for it left alive: true behind; the
    // margin keeps that order under a loaded event loop.
    for (const exitDelay of ["10", "1000"]) {
      const modelError = await prepareSupervisedRun(
        "model-error-exit",
        "model error then exit",
        "openai-codex",
        {},
        { PI_EXIT_DELAY_MS: exitDelay },
      );
      try {
        expect(await waitForExit(modelError.runnerProc)).toBe(1);
        const status = JSON.parse(
          await readFile(join(modelError.root, "status.json"), "utf8"),
        );
        expect(status, `pi exits after ${exitDelay} ms`).toMatchObject({
          state: "failed",
          terminalReason: "model_error",
          process: { alive: false },
        });
        const evidence = JSON.parse(
          await readFile(join(modelError.root, "review-error.json"), "utf8"),
        );
        expect(evidence).toMatchObject({
          reason: "model_error",
          errorMessage: "provider model error",
        });
      } finally {
        modelError.runnerProc.kill();
      }
    }
  });

  it("keeps a failed or blocked review's ending through the cancel that ends it", async () => {
    // A driver cancels a review the provider already refused so the runner
    // writes its evidence and stops; the cancel is not why the review ended.
    const cases = [
      ["simulate quota blocked", "blocked", "quota_blocked"],
      ["candidate then model error", "failed", "model_error"],
    ] as const;
    for (const [prompt, state, reason] of cases) {
      const lane = await prepareSupervisedRun(`cancel-after-${reason}`, prompt);
      try {
        const statusPath = join(lane.root, "status.json");
        await waitForStatus(
          statusPath,
          (status) =>
            status["state"] === state && status["terminalReason"] === reason,
        );
        await sendCommand(lane.sockPath, {
          type: "cancel",
          reason: "cancelled_by_conductor",
        });
        expect(await waitForExit(lane.runnerProc)).toBe(130);
        expect(
          JSON.parse(await readFile(statusPath, "utf8")),
          prompt,
        ).toMatchObject({
          state,
          terminalReason: reason,
          process: { alive: false },
        });
      } finally {
        lane.runnerProc.kill();
      }
    }
  });

  it("leaves a review that ended in error failed in the runner's last status", async () => {
    // The real lane: pi's first turn ended 402, the bridge wrote model_error
    // and exited, and the steps after it left finished/done/completed, which
    // no driver believes and none could end on.
    const lane = await prepareSupervisedRun(
      "model-error-main",
      "model error then exit",
      "openai-codex",
      {},
      {},
      "main",
    );
    try {
      expect(await waitForExit(lane.runnerProc, SUPERVISED_WAIT_MS)).toBe(0);
      const steps = (await readFile(join(lane.root, "steps.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(steps.map((step) => step["step"])).toEqual([
        "clone",
        "install",
        "check",
        "review",
        "checkout_delta",
        "trace",
        "report",
      ]);
      expect(steps[3]).toMatchObject({ step: "review", exit: 1 });
      const report = JSON.parse(
        await readFile(join(lane.root, "report.json"), "utf8"),
      );
      expect(report).toMatchObject({ completion: "partial" });
      expect(report.partialReason).toContain("model_error");
      const status = JSON.parse(
        await readFile(join(lane.root, "status.json"), "utf8"),
      );
      expect(status).toMatchObject({
        phase: "finished",
        state: "failed",
        terminalReason: "model_error",
        process: { alive: false },
      });
    } finally {
      lane.runnerProc.kill();
    }
  });

  it("leaves a blocked review blocked in the runner's last status after the cancel that ends it", async () => {
    // The cloud driver cancels a lane the provider refused. The bridge exits
    // 130 on that cancel, and the review is blocked, not failed on an exit.
    const lane = await prepareSupervisedRun(
      "quota-blocked-main",
      "simulate quota blocked",
      "openai-codex",
      {},
      {},
      "main",
    );
    try {
      const statusPath = join(lane.root, "status.json");
      await waitForSocket(lane.sockPath);
      await waitForStatus(
        statusPath,
        (status) =>
          status["state"] === "blocked" &&
          status["terminalReason"] === "quota_blocked",
      );
      await sendCommand(lane.sockPath, {
        type: "cancel",
        reason: "cancelled_by_conductor",
      });
      expect(await waitForExit(lane.runnerProc, SUPERVISED_WAIT_MS)).toBe(0);
      const steps = (await readFile(join(lane.root, "steps.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(steps.find((step) => step["step"] === "review")).toMatchObject({
        exit: 130,
      });
      expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
        phase: "finished",
        state: "blocked",
        terminalReason: "quota_blocked",
        process: { alive: false },
      });
    } finally {
      lane.runnerProc.kill();
    }
  });

  const runnerScript = fileURLToPath(
    new URL("../../container/review-run.sh", import.meta.url),
  );

  /** Sources the runner without running it, then calls one of its functions. */
  const callRunnerFunction = async (
    job: Record<string, unknown>,
    script: string,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-fn-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "work/repo"), { recursive: true });
    await writeFile(join(root, "job.json"), JSON.stringify(job));
    const output = execFileSync(
      "bash",
      ["-c", `source ${runnerScript} ${root} >/dev/null 2>&1; ${script}`],
      { encoding: "utf8" },
    );
    return { root, output };
  };

  it("gives the reviewer a role-appropriate context file instead of the contributor guide", async () => {
    // Pi loads the first context file in the checkout root, and the repo's own
    // AGENTS.md tells a contributor to run the repository-wide baseline.
    const { root } = await callRunnerFunction(
      {
        runId: "context-override",
        supervised: true,
        reviewerContext:
          "# Repository context for a review lane\nYou do not commit.",
      },
      "write_reviewer_context",
    );

    const override = await readFile(
      join(root, "work/repo/AGENTS.override.md"),
      "utf8",
    );
    expect(override).toContain("Repository context for a review lane");
    expect(override).not.toContain("bun typecheck && bun format");
  });

  it("writes no override when the job carries no reviewer context", async () => {
    const { root } = await callRunnerFunction(
      { runId: "no-context", supervised: true },
      "write_reviewer_context",
    );

    await expect(
      readFile(join(root, "work/repo/AGENTS.override.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("leaves its own context override out of what the reviewer introduced", async () => {
    // The counter answers "what did the reviewer add". Counting the file the
    // runner wrote would read 1 on every clean run until nobody looked at it.
    const { root } = await callRunnerFunction(
      {
        runId: "override-count",
        supervised: true,
        reviewerContext: "# context\nno commits",
      },
      "write_reviewer_context",
    );
    const repo = join(root, "work/repo");
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "tracked.txt"), "a\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    const delta = `source ${runnerScript} ${root} >/dev/null 2>&1; do_checkout_delta`;

    execFileSync("bash", ["-c", delta]);
    expect(
      (await readFile(join(root, "checkout-untracked.txt"), "utf8")).trim(),
    ).toBe("");
    expect(
      (await readFile(join(root, "checkout-status.txt"), "utf8")).trim(),
    ).toBe("");

    await writeFile(join(repo, "reproduction.test.ts"), "// repro\n");
    execFileSync("bash", ["-c", delta]);
    expect(await readFile(join(root, "checkout-untracked.txt"), "utf8")).toBe(
      "reproduction.test.ts\n",
    );

    // A reviewer that writes its own file at that path is counted again.
    await writeFile(join(repo, "AGENTS.override.md"), "reviewer wrote this\n");
    execFileSync("bash", ["-c", delta]);
    expect(
      await readFile(join(root, "checkout-untracked.txt"), "utf8"),
    ).toContain("AGENTS.override.md");
  });

  it("writes steps.jsonl as one JSON object per line", async () => {
    const { root } = await callRunnerFunction(
      { runId: "steps-shape", supervised: true },
      "record clone 0 1; record install 1 2",
    );

    const lines = (await readFile(join(root, "steps.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { step: "clone", exit: 0 },
      { step: "install", exit: 1 },
    ]);
  });

  it("records a failing scoped check without ending the run", async () => {
    // The check runs before Pi. Aborting on its exit would kill the reviewer at
    // the moment the regression it was sent to find had just been shown.
    const { root, output } = await callRunnerFunction(
      { runId: "soft-check", supervised: true },
      'step_soft check false; echo "continued=$?"',
    );

    expect(output).toContain("continued=0");
    expect((await readFile(join(root, "check.exit"), "utf8")).trim()).toBe("1");
    const steps = (await readFile(join(root, "steps.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(steps.at(-1)).toMatchObject({ step: "check", exit: 1 });
  });

  it("records what the reviewer changed in its own checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-fn-"));
    temporaryDirectories.push(root);
    const repo = join(root, "work/repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(root, "job.json"), JSON.stringify({ runId: "delta" }));
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "source.ts"), "export const a = 1;\n");
    execFileSync("git", ["-C", repo, "add", "source.ts"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@invalid",
      "commit",
      "-q",
      "-m",
      "base",
    ]);
    await writeFile(join(repo, "reproduction.test.ts"), "// repro\n");
    await writeFile(join(repo, "source.ts"), "export const a = 2;\n");

    execFileSync("bash", [
      "-c",
      `source ${runnerScript} ${root} >/dev/null 2>&1; do_checkout_delta`,
    ]);

    expect(
      await readFile(join(root, "checkout-delta.patch"), "utf8"),
    ).toContain("export const a = 2;");
    expect(
      await readFile(join(root, "checkout-untracked.txt"), "utf8"),
    ).toContain("reproduction.test.ts");
  });

  it("classifies an OAuth 403 as auth blocked so the renewal path can run", async () => {
    // The real failure: a 403 whose body names OAuth, matched by no pattern in
    // the old alternation, so it fell through to model_error and the renewal
    // built for exactly this case never ran.
    const { root, runnerProc } = await prepareSupervisedRun(
      "oauth-403",
      "simulate oauth 403",
    );
    try {
      const status = await waitForStatus(
        join(root, "status.json"),
        (current) => current["state"] === "blocked",
      );
      expect(status["terminalReason"]).toBe("auth_blocked");
      const evidence = JSON.parse(
        await readFile(join(root, "review-error.json"), "utf8"),
      );
      expect(evidence["reason"]).toBe("auth_blocked");
    } finally {
      runnerProc.kill();
    }
  });

  it("restores idle candidate state when native Pi rejects a continuation", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "rejected-continuation",
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      const rejected = await sendCommand(sockPath, {
        type: "prompt",
        message: "reject prompt",
      });
      expect(rejected).toMatchObject({
        command: "prompt",
        success: false,
        error: "native_prompt_rejected",
      });
      const inspect = await sendCommand(sockPath, { type: "inspect" });
      expect(inspect).toMatchObject({
        data: {
          state: "idle",
          childIdle: true,
          isStreaming: false,
          lastCandidateResult: "standby ready",
        },
      });
      await sendCommand(sockPath, { type: "accept" });
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("keeps the final state when a response and terminal events share one stdout chunk", async () => {
    const { root, sockPath, runnerProc } =
      await prepareSupervisedRun("rapid-events");
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);

      const response = await sendCommand(sockPath, {
        id: "rapid-1",
        type: "prompt",
        message: "rapid final",
      });
      expect(response).toMatchObject({ success: true, command: "prompt" });
      const status = await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" && s["lastCandidateResult"] === "RAPID_FINAL",
      );
      expect(status).toMatchObject({
        state: "idle",
        childIdle: true,
        isStreaming: false,
        terminalReason: null,
      });

      await sendCommand(sockPath, { type: "accept" });
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("uses a valid persistent native session id for accepted run ids", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun("run.");
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      const stateResponse = await sendCommand(sockPath, { type: "get_state" });
      expect(objectValue(stateResponse["data"])["sessionId"]).toBe("run");
      await sendCommand(sockPath, { type: "accept" });
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("reports the native child idle before the first prompt", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "idle-before-prompt",
      null,
    );
    try {
      const status = await waitForStatus(
        join(root, "status.json"),
        (candidate) =>
          candidate["state"] === "idle" &&
          candidate["childIdle"] === true &&
          candidate["isStreaming"] === false,
      );
      expect(status).toMatchObject({
        process: { alive: true },
      });
      const response = await sendCommand(sockPath, { type: "inspect" });
      expect(response).toMatchObject({
        data: {
          state: "idle",
          childIdle: true,
          isStreaming: false,
          process: { alive: true },
        },
      });
      await sendCommand(sockPath, { type: "cancel" });
      expect(await waitForExit(runnerProc)).toBe(130);
    } finally {
      runnerProc.kill();
    }
  });

  it("accepts native lifecycle events and preserves split UTF-8 framing", async () => {
    const { root, sockPath, runnerProc } =
      await prepareSupervisedRun("native-events");
    try {
      const statusPath = join(root, "status.json");
      await waitForStandbySettled(statusPath);
      const initial = await sendCommand(sockPath, { type: "inspect" });
      expect(objectValue(initial["data"])["detail"]).toBe("");

      await sendCommand(
        sockPath,
        {
          type: "prompt",
          message: "split unicode 🧪",
        },
        5000,
        "🧪",
      );
      await waitForStatus(
        statusPath,
        (s) =>
          s["state"] === "idle" && s["lastCandidateResult"] === "UNICODE_FINAL",
      );
      const raw = await readFile(join(root, "pi-raw.jsonl"), "utf8");
      expect(raw).toContain("café 🧪");
      expect(await readFile(join(root, "pi.stderr"), "utf8")).not.toContain(
        "malformed event JSON",
      );

      await sendCommand(sockPath, { type: "accept" });
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("waits for the exact process group to stop on explicit cancellation", async () => {
    const { root, sockPath, runnerProc } = await prepareSupervisedRun(
      "cancel-descendant",
      "active descendant",
    );
    try {
      const statusPath = join(root, "status.json");
      await waitForStatus(
        statusPath,
        (s) =>
          s["inFlightTool"] === "call_descendant" &&
          objectValue(s["process"])["alive"] === true,
      );
      const descendantPid = Number(
        await readFile(join(root, "descendant.pid"), "utf8"),
      );
      await sendCommand(sockPath, { type: "cancel" });
      expect(await waitForExit(runnerProc)).toBe(130);
      expect(() => process.kill(descendantPid, 0)).toThrow();
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      expect(status).toMatchObject({
        state: "cancelled",
        process: { alive: false },
      });
    } finally {
      runnerProc.kill();
    }
  });

  it("preserves step evidence when controls use the public send entrypoint", async () => {
    const { root, runnerProc } = await prepareSupervisedRun("public-send");
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );
    try {
      await waitForStandbySettled(join(root, "status.json"));
      const stepsPath = join(root, "steps.jsonl");
      await writeFile(stepsPath, '{"step":"check","exit":0}\n');
      const result = await runPublicCommand(runner, root, {
        type: "inspect",
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "inspect",
        success: true,
      });
      expect(await readFile(stepsPath, "utf8")).toBe(
        '{"step":"check","exit":0}\n',
      );

      const accept = await sendCommand(join(root, "rpc.sock"), {
        type: "accept",
      });
      expect(accept).toMatchObject({ command: "accept", success: true });
      await waitForStatus(
        join(root, "status.json"),
        (status) =>
          status["state"] === "done" &&
          objectValue(status["process"])["alive"] === false,
      );
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });

  it("carries a file command to the socket and removes the file", async () => {
    const { root, runnerProc } = await prepareSupervisedRun("public-send-file");
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );
    try {
      await waitForStandbySettled(join(root, "status.json"));
      const commandPath = join(root, "command-1.json");
      const command = { type: "inspect" };
      await writeFile(commandPath, JSON.stringify(command));
      const result = await runPublicSend(
        runner,
        root,
        ["--send-file", commandPath],
        "public --send-file command",
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "inspect",
        success: true,
      });
      await expect(readFile(commandPath, "utf8")).rejects.toThrow();

      await sendCommand(join(root, "rpc.sock"), { type: "accept" });
      await waitForStatus(
        join(root, "status.json"),
        (status) => status["state"] === "done",
      );
      expect(await waitForExit(runnerProc)).toBe(0);
    } finally {
      runnerProc.kill();
    }
  });
});
