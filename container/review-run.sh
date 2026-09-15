#!/usr/bin/env bash
# One review run, start to finish, inside the container.
#
# Everything expensive stays here: the clone, node_modules and the raw Pi event
# stream, one event per streamed token. What leaves is
# status.json, steps.jsonl, report.json, review-error.json and a filtered
# trace.jsonl, all of them small by construction.
#
# Repository access is a real `git clone` against the Worker's read-only proxy,
# so the checkout holds the PR's own commit objects and `git rev-parse HEAD` is
# the PR head SHA rather than a rebuilt lookalike. The clone step asserts that
# equality and fails the run if it does not hold; the container never sees a
# GitHub credential.
set -uo pipefail

RUN_DIR="${1:?run directory required}"
JOB="$RUN_DIR/job.json"
STEPS="$RUN_DIR/steps.jsonl"
STATUS="$RUN_DIR/status.json"
REPORT="$RUN_DIR/report.json"
TRACE="$RUN_DIR/trace.jsonl"
RAW="$RUN_DIR/pi-raw.jsonl"
REVIEW_ERROR="$RUN_DIR/review-error.json"
WORK="$RUN_DIR/work"
REPO="$WORK/repo"
CLAUDE_CODE_PROVIDER=/opt/review/extensions/claude-code-provider.js

START=$(date +%s)

job() { jq -r "$1" "$JOB"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
elapsed() { echo $(($(date +%s) - START)); }

RUN_ID=$(job .runId)
FAIL_STEP=$(job '.failStep // ""')

is_supervised() {
  [ "$(job '.supervised // false')" = "true" ] || [ "${SUPERVISED:-0}" = "1" ]
}

write_status() {
  local phase="$1" state="$2" detail="${3:-}" in_flight="${4:-}" last_event="${5:-}" term_reason="${6:-}" child_pid="${7:-}"
  if ! is_supervised; then
    jq -n --arg runId "$RUN_ID" --arg phase "$phase" --arg state "$state" --arg at "$(now)" \
      --arg detail "$detail" --argjson elapsedSeconds "$(elapsed)" \
      '{runId:$runId, phase:$phase, state:$state, at:$at, elapsedSeconds:$elapsedSeconds, detail:$detail}' \
      > "$STATUS.tmp"
    mv "$STATUS.tmp" "$STATUS"
    return
  fi
  local proc_pid="${child_pid:-$$}"
  jq -n --arg runId "$RUN_ID" --arg phase "$phase" --arg state "$state" --arg at "$(now)" \
    --arg detail "$detail" --arg inFlightTool "$in_flight" --arg lastEvent "$last_event" \
    --arg terminalReason "$term_reason" --argjson elapsedSeconds "$(elapsed)" \
    --argjson pid "$proc_pid" \
    '{runId:$runId, phase:$phase, state:$state, at:$at, elapsedSeconds:$elapsedSeconds,
      detail:$detail, inFlightTool:(if $inFlightTool == "" then null else $inFlightTool end),
      lastEvent:(if $lastEvent == "" then null else $lastEvent end),
      terminalReason:(if $terminalReason == "" then null else $terminalReason end),
      process:{alive:(if $state == "done" or $state == "cancelled" or $state == "failed" then false else true end), pid:$pid}}' \
    > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

record() {
  jq -cn --arg step "$1" --argjson exit "$2" --argjson seconds "$3" --arg at "$(now)" \
    --arg detail "${4:-}" '{step:$step, exit:$exit, seconds:$seconds, at:$at, detail:$detail}' >> "$STEPS"
}

# Runs one named step, records its exit and stops the run on failure. A step
# named by `failStep` is replaced by a failing command on purpose: the lifecycle
# has to be provable on the unhappy path too.
# A step whose failure is evidence rather than an ending. The supervised check
# runs before Pi, so aborting on its exit would kill the reviewer at exactly the
# moment the change it was sent to find had broken something.
step_soft() {
  local name="$1"; shift
  write_status "$name" running
  local began; began=$(date +%s)
  ( "$@" )
  local code=$?
  record "$name" "$code" "$(($(date +%s) - began))"
  echo "$code" > "$RUN_DIR/$name.exit"
  return 0
}

step() {
  local name="$1"; shift
  write_status "$name" running
  local began; began=$(date +%s)
  if [ "$name" = "$FAIL_STEP" ]; then
    ( exit 97 )
  else
    ( "$@" )
  fi
  local code=$?
  record "$name" "$code" "$(($(date +%s) - began))"
  if [ "$code" -ne 0 ]; then
    local cur_state
    cur_state=$(jq -r '.state // "failed"' "$STATUS" 2>/dev/null || echo "failed")
    if [ "$cur_state" != "blocked" ] && [ "$cur_state" != "cancelled" ]; then
      write_status "$name" failed "exit $code" "" "" "exit $code"
    fi
    exit "$code"
  fi
}

# Clones through the Worker proxy and refuses to continue unless git agrees the
# checkout is exactly the requested commits. `--no-tags` and a single branch keep
# the transfer to what the review needs; the PR ref is fetched separately because
# a head commit is not always reachable from the default branch.
do_clone() {
  local remote head base pr
  remote=$(job .gitRemote); head=$(job .head.sha); base=$(job .base.sha); pr=$(job '.pullRequest // ""')
  mkdir -p "$WORK"
  git -c "http.extraHeader=x-review-run: $RUN_ID" \
    clone --no-tags --no-checkout --quiet "$remote" "$REPO" || return 1
  git -C "$REPO" config --add "http.extraHeader" "x-review-run: $RUN_ID"
  if [ -n "$pr" ]; then
    git -C "$REPO" fetch --quiet --no-tags origin "refs/pull/$pr/head" || return 1
  fi
  git -C "$REPO" cat-file -e "$head^{commit}" || return 1
  git -C "$REPO" cat-file -e "$base^{commit}" || return 1
  git -C "$REPO" checkout --quiet --detach "$head" || return 1
  git -C "$REPO" branch -q -f base "$base" || return 1
  local actual; actual=$(git -C "$REPO" rev-parse HEAD)
  if [ "$actual" != "$head" ]; then
    echo "checkout mismatch: expected $head, got $actual" >&2
    return 1
  fi
  # The proxy is only needed for the clone. Dropping the remote afterwards means
  # nothing the reviewer runs can reach back out through it.
  git -C "$REPO" remote remove origin || return 1
  jq --raw-output --join-output '.fixturePatch // ""' "$JOB" > "$WORK/fixture.patch"
  if [ -s "$WORK/fixture.patch" ]; then
    git -C "$REPO" branch -q -f base HEAD || return 1
    git -C "$REPO" apply --index --whitespace=nowarn "$WORK/fixture.patch" || return 1
    git -C "$REPO" -c user.name=review-pi -c user.email=review-pi@invalid \
      commit -q -m "proposed change" || return 1
  fi
  git -C "$REPO" --no-pager diff --stat base..HEAD > "$RUN_DIR/diff.stat"
}

do_install() {
  cd "$REPO" || return 1
  if is_supervised; then
    bun install --frozen-lockfile
  else
    timeout -k 15 "$(job .installTimeoutSeconds)" bun install --frozen-lockfile
  fi
}

do_check() {
  cd "$REPO" || return 1
  local command; command=$(job .checkCommand)
  if is_supervised; then
    bash -lc "$command" > "$RUN_DIR/check.log" 2>&1
  else
    timeout -k 15 600 bash -lc "$command" > "$RUN_DIR/check.log" 2>&1
  fi
}

run_rpc_bridge() {
  local run_dir="$1"
  if [ ! -f "$run_dir/prompt.txt" ]; then
    job '.prompt // ""' > "$run_dir/prompt.txt" 2>/dev/null || true
  fi
  local node_bin
  node_bin=$(command -v node 2>/dev/null || command -v bun 2>/dev/null)
  RUN_DIR="$run_dir" "$node_bin" - << 'EOF_RPC_BRIDGE'
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const runDir = process.env.RUN_DIR;
const jobPath = path.join(runDir, "job.json");
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
// The same path the shell runner passes for an unsupervised run. This bridge is
// a quoted heredoc, so it cannot read that variable.
const CLAUDE_CODE_PROVIDER = "/opt/review/extensions/claude-code-provider.js";
const runId = job.runId;
const nativeSessionId = runId
  .replace(/[^A-Za-z0-9._-]/g, "-")
  .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "review";
const statusPath = path.join(runDir, "status.json");
const rawPath = path.join(runDir, "pi-raw.jsonl");
const tracePath = path.join(runDir, "trace.jsonl");
const errorPath = path.join(runDir, "review-error.json");
const stderrPath = path.join(runDir, "pi.stderr");
const attemptStderrPath = path.join(runDir, "pi.attempt.stderr");
const sockPath = path.join(runDir, "rpc.sock");
const repoDir = path.join(runDir, "work/repo");
const sessionDir = path.join(runDir, "sessions");
const promptPath = path.join(runDir, "prompt.txt");

try { fs.mkdirSync(sessionDir, { recursive: true }); } catch {}

const startTime = Date.now();
// The broker's caps and the lane's window, as the driver passed them. A lane
// that reaches a cap is cut without an answer, so the model is told once, at
// three quarters of whichever cap is nearest, to stop and write what it has.
const budget = job.budget || null;
let turnsEnded = 0;
let inputTokensUsed = 0;
let budgetNoticeSent = false;
let budgetNoted = false;
let inFlightTool = null;
let inFlightToolName = "";
let lastEvent = null;
let state = "running";
let detail = "";
let terminalReason = null;
let childPid = null;
let alive = false;
let childIdle = false;
let isStreaming = true;
let sessionInfo = { sessionId: nativeSessionId, sessionFile: null };
let lastCandidateResult = null;
let currentAttemptStderr = "";
let attemptSeq = 0;
let activeAttempt = 0;
let terminalAttempt = 0;

const pendingRequests = new Map();
const controlledExits = new WeakSet();
let requestSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

// The one line the model reads before it plans: the same numbers the notice
// below is measured against, appended to the first prompt this lane is given.
function withBudgetNote(message) {
  if (!budget || budgetNoted) return message;
  budgetNoted = true;
  return message + "\n\nBudget for this lane: " + budget.requests + " model requests and " + budget.seconds + " seconds. The runner will tell you when three quarters are spent; finish with your final answer before it runs out, because a lane cut at its budget delivers nothing.";
}

function budgetPressure() {
  if (!budget) return null;
  const spent = [
    ["requests", turnsEnded + 1, budget.requests],
    ["input tokens", inputTokensUsed, budget.inputTokens],
    ["seconds", Math.floor((Date.now() - startTime) / 1000), budget.seconds],
  ];
  for (const [name, used, cap] of spent) {
    if (typeof cap === "number" && cap > 0 && used >= Math.ceil(cap * 0.75)) {
      return { name, used, cap };
    }
  }
  return null;
}

// Sent at a tool boundary: the next model call is certain there, so a steer
// is read before it rather than queued behind an answer already finished.
function noticeBudget() {
  if (budgetNoticeSent) return;
  const pressure = budgetPressure();
  if (!pressure) return;
  budgetNoticeSent = true;
  appendTrace({ type: "budget_notice", ...pressure });
  const message = "Budget notice from the runner: " + pressure.used + " of " + pressure.cap + " " + pressure.name + " spent. Stop investigating now and write your final answer in the required format with what you have; a lane that runs out of budget delivers nothing.";
  sendCommandToPi({ type: "steer", message }).catch((err) => {
    appendStderr("budget notice error: " + err.message + "\n");
  });
}

function writeStatus() {
  const payload = {
    runId,
    phase: "review",
    state,
    at: nowIso(),
    elapsedSeconds: Math.floor((Date.now() - startTime) / 1000),
    detail: detail || "",
    inFlightTool,
    inFlightToolName: inFlightToolName || null,
    lastEvent,
    terminalReason,
    childIdle,
    isStreaming,
    lastCandidateResult,
    process: {
      alive,
      pid: childPid,
    },
    session: sessionInfo,
  };
  const tmp = statusPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, statusPath);
}

function writeReviewError(reason, stopReason, errorMessage) {
  const tail = currentAttemptStderr.slice(-4000);
  const payload = {
    reason,
    piExit: alive ? 0 : 1,
    stopReason: stopReason || "",
    errorMessage: (errorMessage || "").slice(0, 4000),
    stderrTail: tail,
  };
  fs.writeFileSync(errorPath, JSON.stringify(payload, null, 2) + "\n");
}

const rawFd = fs.openSync(rawPath, "a");
const traceFd = fs.openSync(tracePath, "a");
const stderrFd = fs.openSync(stderrPath, "a");

function appendRaw(line) {
  fs.writeSync(rawFd, line + "\n");
}

function appendTrace(obj) {
  fs.writeSync(traceFd, JSON.stringify(obj) + "\n");
}

function appendStderr(str) {
  fs.writeSync(stderrFd, str);
  currentAttemptStderr += str;
  writeAttemptStderr();
}

/** History stays in pi.stderr; finalization judges only the current attempt. */
function writeAttemptStderr() {
  try { fs.writeFileSync(attemptStderrPath, currentAttemptStderr); } catch {}
}

let piChild = null;

function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function stopExactChild(child, closeStdin = false) {
  controlledExits.add(child);
  return new Promise((resolve) => {
    let termTimer;
    let killTimer;
    let controlTimer;
    const finish = (verified) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(controlTimer);
      child.off("close", onClose);
      resolve(verified);
    };
    const onClose = () => finish(true);
    child.once("close", onClose);

    if (closeStdin) {
      child.stdin.end();
      termTimer = setTimeout(() => signalChild(child, "SIGTERM"), 1000);
      killTimer = setTimeout(() => signalChild(child, "SIGKILL"), 3000);
    } else {
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => signalChild(child, "SIGKILL"), 2000);
    }
    controlTimer = setTimeout(() => {
      finish(false);
    }, closeStdin ? 5000 : 4000);
  });
}

function rejectPendingRequests(message) {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  pendingRequests.clear();
}

function beginAttempt() {
  activeAttempt = ++attemptSeq;
  state = "running";
  terminalReason = null;
  childIdle = false;
  isStreaming = true;
  currentAttemptStderr = "";
  writeAttemptStderr();
  lastCandidateResult = null;
  detail = "";
  try { fs.unlinkSync(errorPath); } catch {}
  writeStatus();
  return activeAttempt;
}

function spawnPiChild(isContinue = false) {
  const provider = job.provider || "openai";
  const model = job.model || "gpt-5.6-sol";
  const thinking = job.thinking || "high";
  let args = [
    "--provider", provider,
    "--model", model,
    "--thinking", thinking,
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
  ];

  // A subscription provider is an extension and every other provider is built
  // into pi, so this lane names the one extension it needs. Discovery stays
  // off: the checkout is untrusted input and `--approve` would otherwise let it
  // contribute an extension of its own to the process that reviews it.
  if (provider === "claude-code") {
    args.push("-e", CLAUDE_CODE_PROVIDER);
  }

  if (isContinue && sessionInfo.sessionFile && fs.existsSync(sessionInfo.sessionFile)) {
    args.push("--session", sessionInfo.sessionFile);
  } else {
    args.push("--session-dir", sessionDir, "--session-id", nativeSessionId);
  }

  const piBin = process.env.PI_BIN || "pi";
  const child = spawn(piBin, args, {
    cwd: fs.existsSync(repoDir) ? repoDir : runDir,
    env: process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  piChild = child;
  childPid = child.pid;
  alive = true;
  childIdle = false;
  isStreaming = true;
  writeStatus();

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (child !== piChild) return;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      const clean = line.replace(/\r$/, "");
      if (!clean.trim()) continue;
      appendRaw(clean);
      handlePiEvent(child, clean);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (child !== piChild) return;
    appendStderr(chunk);
    checkStderrForBlockers(child, chunk);
  });

  child.on("error", (err) => {
    if (child !== piChild) return;
    alive = false;
    childIdle = true;
    isStreaming = false;
    state = "failed";
    terminalReason = "process_spawn_error";
    writeReviewError("process_spawn_error", "", err.message);
    writeStatus();
    shutdownBridge(1);
  });

  child.stdin.on("error", (err) => {
    if (child !== piChild) return;
    appendStderr(`child stdin error: ${err.message}\n`);
    if (state !== "done" && state !== "cancelled") {
      state = "failed";
      terminalReason = "stdin_error";
      writeReviewError("stdin_error", "", err.message);
      writeStatus();
    }
  });

  child.on("close", (code, signal) => {
    if (child !== piChild) return;
    alive = false;
    childIdle = true;
    isStreaming = false;
    rejectPendingRequests(`Pi process exited with code ${code}, signal ${signal}`);
    if (controlledExits.has(child)) {
      writeStatus();
    } else if (terminalReason === "auth_blocked" || terminalReason === "quota_blocked") {
      state = "blocked";
      writeStatus();
    } else if (["model_error", "process_spawn_error", "stdin_error"].includes(terminalReason)) {
      state = "failed";
      writeStatus();
      shutdownBridge(code || 1);
    } else {
      state = "failed";
      terminalReason = "process_exit";
      writeReviewError("process_exit", "", `Child exited with code ${code}, signal ${signal}`);
      writeStatus();
      shutdownBridge(code || 1);
    }
  });

  return child;
}

function checkStderrForBlockers(child, text) {
  if (child !== piChild) return;
  if (/401|403|unauthorized|oauth|invalid_token|expired_token|invalid_api_key|token_expired|authentication_error|jwt expired/i.test(text)) {
    state = "blocked";
    terminalReason = "auth_blocked";
    writeReviewError("auth_blocked", "error", text);
    writeStatus();
  } else if (/429|rate_limit|rate limit|insufficient_quota|resource_exhausted|exceeded your current quota/i.test(text)) {
    state = "blocked";
    terminalReason = "quota_blocked";
    writeReviewError("quota_blocked", "error", text);
    writeStatus();
  }
}

function handlePiEvent(child, rawLine) {
  if (child !== piChild) return;
  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    appendStderr("malformed event JSON from pi: " + rawLine + "\n");
    lastEvent = "protocol_error";
    detail = "malformed event JSON from pi";
    writeStatus();
    return;
  }

  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    appendStderr("invalid event shape from pi\n");
    lastEvent = "protocol_error";
    detail = "invalid event shape from pi";
    writeStatus();
    return;
  }

  if (event.type === "response") {
    if (event.command === "get_state") {
      if (
        event.success &&
        event.data &&
        typeof event.data.sessionId === "string" &&
        event.data.sessionId.length > 0 &&
        (event.data.sessionFile == null || typeof event.data.sessionFile === "string")
      ) {
        sessionInfo = {
          sessionId: event.data.sessionId,
          sessionFile: event.data.sessionFile || sessionInfo.sessionFile,
        };
        isStreaming = event.data.isStreaming === true;
        childIdle = !isStreaming;
        writeStatus();
      } else {
        appendStderr("get_state reported failure or invalid data\n");
        event = {
          id: event.id,
          type: "response",
          command: "get_state",
          success: false,
          error: "invalid_native_state",
        };
        lastEvent = "protocol_error";
        detail = "get_state reported failure or invalid data";
        writeStatus();
      }
    }
    if (event.id && pendingRequests.has(event.id)) {
      const pending = pendingRequests.get(event.id);
      pendingRequests.delete(event.id);
      clearTimeout(pending.timer);
      pending.resolve(event);
    } else {
      appendStderr("unmatched response from pi\n");
    }
    return;
  }

  if (["agent_start", "turn_start", "message_start", "message_update", "message_end"].includes(event.type)) {
    lastEvent = event.type;
    childIdle = false;
    isStreaming = true;
    writeStatus();
    return;
  }

  if (event.type === "tool_execution_start") {
    inFlightTool = event.toolCallId || event.id || "tool";
    inFlightToolName = event.toolName || "";
    lastEvent = "tool_execution_start";
    isStreaming = true;
    childIdle = false;
    appendTrace({
      type: "tool_execution_start",
      toolCallId: inFlightTool,
      toolName: event.toolName,
      args: event.args,
    });
    writeStatus();
    return;
  }

  if (event.type === "tool_execution_end") {
    inFlightTool = null;
    inFlightToolName = "";
    lastEvent = "tool_execution_end";
    let text = "";
    if (event.result && Array.isArray(event.result.content)) {
      text = event.result.content.map(c => c.text || "").join("");
    }
    appendTrace({
      type: "tool_execution_end",
      toolCallId: event.toolCallId || event.id,
      toolName: event.toolName,
      isError: !!event.isError,
      resultBytes: text.length,
      result: text.slice(0, 400),
      resultTail: text.length > 400 ? text.slice(-400) : "",
    });
    noticeBudget();
    writeStatus();
    return;
  }

  if (event.type === "turn_end") {
    terminalAttempt = activeAttempt;
    lastEvent = "turn_end";
    isStreaming = false;
    turnsEnded += 1;
    const usage = event.message?.usage;
    if (usage) {
      // Whole context per call, cached or not: the broker counts it that way.
      inputTokensUsed += (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
    }
    const stopReason = event.message?.stopReason || "";
    const errorMessage = event.message?.errorMessage || "";
    appendTrace({
      type: "turn_end",
      usage: event.message?.usage,
      stopReason,
      errorMessage: errorMessage.slice(0, 4000),
    });

    const combinedErr = errorMessage + " " + currentAttemptStderr;
    if (/401|403|unauthorized|oauth|invalid_token|expired_token|invalid_api_key|token_expired|authentication_error|jwt expired/i.test(combinedErr)) {
      state = "blocked";
      terminalReason = "auth_blocked";
      writeReviewError("auth_blocked", stopReason, errorMessage);
    } else if (/429|rate_limit|rate limit|insufficient_quota|resource_exhausted|exceeded your current quota/i.test(combinedErr)) {
      state = "blocked";
      terminalReason = "quota_blocked";
      writeReviewError("quota_blocked", stopReason, errorMessage);
    } else if (stopReason === "error") {
      state = "failed";
      terminalReason = "model_error";
      writeReviewError("model_error", stopReason, errorMessage);
      writeStatus();
      if (!lastCandidateResult) shutdownBridge(1);
      return;
    }
    writeStatus();
    return;
  }

  if (event.type === "agent_end") {
    terminalAttempt = activeAttempt;
    lastEvent = "agent_end";
    inFlightTool = null;
    inFlightToolName = "";
    childIdle = true;
    isStreaming = false;
    let candidateText = "";
    if (Array.isArray(event.messages)) {
      const assistantMsgs = event.messages.filter(m => m.role === "assistant");
      if (assistantMsgs.length > 0) {
        const lastMsg = assistantMsgs[assistantMsgs.length - 1];
        if (Array.isArray(lastMsg.content)) {
          candidateText = lastMsg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
        }
      }
    }
    lastCandidateResult = candidateText;
    if (state === "running") {
      state = "idle";
    }
    writeStatus();
    return;
  }

  appendStderr(`unknown event type from pi: ${event.type}\n`);
  lastEvent = "protocol_error";
  detail = `unknown event type from pi: ${event.type}`;
  writeStatus();
}

function sendCommandToPi(cmdObj, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!alive || !piChild) {
      return reject(new Error("Pi process is not alive"));
    }
    const id = cmdObj.id || `cmd-${++requestSeq}`;
    cmdObj.id = id;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Command ${cmdObj.type} timed out waiting for Pi response`));
      }
    }, timeoutMs) : null;
    pendingRequests.set(id, { resolve, reject, timer });
    try {
      piChild.stdin.write(JSON.stringify(cmdObj) + "\n", (error) => {
        if (!error || !pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    } catch (error) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

try { fs.unlinkSync(sockPath); } catch {}

const server = net.createServer((socket) => {
  let sockBuf = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", async (chunk) => {
    sockBuf += chunk;
    const lines = sockBuf.split("\n");
    sockBuf = lines.pop();
    for (const line of lines) {
      const clean = line.replace(/\r$/, "");
      if (!clean.trim()) continue;
      let req;
      try {
        req = JSON.parse(clean);
      } catch (err) {
        socket.write(JSON.stringify({ success: false, error: "invalid_json" }) + "\n");
        continue;
      }

      if (req.id !== undefined && typeof req.id !== "string") {
        socket.write(JSON.stringify({ type: "response", success: false, error: "missing_or_invalid_id" }) + "\n");
        continue;
      }
      const reqId = req.id || `req-${++requestSeq}`;
      if (req.type === "prompt") {
        if (
          typeof req.message !== "string" ||
          !req.message ||
          (req.streamingBehavior !== undefined && typeof req.streamingBehavior !== "string") ||
          (req.images !== undefined && (!Array.isArray(req.images) || req.images.some(image => typeof image !== "string")))
        ) {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "prompt", success: false, error: "missing_or_invalid_message" }) + "\n");
          continue;
        }

        const prevStatus = { state, terminalReason, childIdle, isStreaming, detail, lastCandidateResult };
        const nativePrompt = { id: reqId, type: "prompt", message: withBudgetNote(req.message) };
        if (req.streamingBehavior) nativePrompt.streamingBehavior = req.streamingBehavior;
        if (req.images) nativePrompt.images = req.images;
        const attempt = beginAttempt();

        try {
          const res = await sendCommandToPi(nativePrompt, 10000);
          if (res && res.success) {
            socket.write(JSON.stringify(res) + "\n");
          } else {
            if (terminalAttempt !== attempt) {
              ({ state, terminalReason, childIdle, isStreaming, detail, lastCandidateResult } = prevStatus);
              writeStatus();
            }
            socket.write(JSON.stringify(res || { id: reqId, type: "response", command: "prompt", success: false, error: "prompt_rejected" }) + "\n");
          }
        } catch (err) {
          if (terminalAttempt !== attempt) {
            ({ state, terminalReason, childIdle, isStreaming, detail, lastCandidateResult } = prevStatus);
            writeStatus();
          }
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "prompt", success: false, error: err.message }) + "\n");
        }
      } else if (req.type === "steer") {
        if (
          typeof req.message !== "string" ||
          !req.message ||
          (req.images !== undefined && (!Array.isArray(req.images) || req.images.some(image => typeof image !== "string")))
        ) {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "steer", success: false, error: "missing_or_invalid_message" }) + "\n");
          continue;
        }
        const nativeSteer = { id: reqId, type: "steer", message: req.message };
        if (req.images) nativeSteer.images = req.images;
        try {
          const res = await sendCommandToPi(nativeSteer);
          socket.write(JSON.stringify(res) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "steer", success: false, error: err.message }) + "\n");
        }
      } else if (req.type === "abort") {
        try {
          const res = await sendCommandToPi({ id: reqId, type: "abort" });
          socket.write(JSON.stringify(res) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "abort", success: false, error: err.message }) + "\n");
        }
      } else if (req.type === "get_state") {
        try {
          const res = await sendCommandToPi({ id: reqId, type: "get_state" });
          socket.write(JSON.stringify(res) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "get_state", success: false, error: err.message }) + "\n");
        }
      } else if (req.type === "inspect") {
        socket.write(JSON.stringify({
          id: reqId,
          type: "response",
          command: "inspect",
          success: true,
          data: {
            runId,
            phase: "review",
            state,
            detail,
            inFlightTool,
            inFlightToolName: inFlightToolName || null,
            lastEvent,
            terminalReason,
            childIdle,
            isStreaming,
            lastCandidateResult,
            process: { alive, pid: childPid },
            session: sessionInfo,
          },
        }) + "\n");
      } else if (req.type === "cancel") {
        if (req.reason !== undefined && typeof req.reason !== "string") {
          socket.write(JSON.stringify({ id: reqId, type: "response", command: "cancel", success: false, error: "missing_or_invalid_reason" }) + "\n");
          continue;
        }
        state = "cancelled";
        terminalReason = req.reason || "cancelled";
        socket.write(JSON.stringify({
          id: reqId,
          type: "response",
          command: "cancel",
          success: true,
          data: { cancelled: true },
        }) + "\n");
        let verified = true;
        if (alive && piChild) {
          const dyingChild = piChild;
          verified = await stopExactChild(dyingChild);
          if (verified && piChild === dyingChild) piChild = null;
        }
        if (verified) {
          alive = false;
          childIdle = true;
          isStreaming = false;
        } else {
          detail = "child process-group termination unverified";
        }
        writeStatus();
        shutdownBridge(130);
      } else if (req.type === "accept" || req.type === "finalize") {
        if (
          (state !== "idle" && state !== "failed" && state !== "blocked") ||
          !childIdle ||
          !lastCandidateResult ||
          inFlightTool ||
          isStreaming
        ) {
          socket.write(JSON.stringify({
            id: reqId,
            type: "response",
            command: req.type,
            success: false,
            error: "cannot accept: agent is not idle with candidate result",
          }) + "\n");
          return;
        }
        state = "done";
        terminalReason = "completed";
        socket.write(JSON.stringify({
          id: reqId,
          type: "response",
          command: req.type,
          success: true,
        }) + "\n");
        if (alive && piChild) {
          const closingChild = piChild;
          const verified = await stopExactChild(closingChild, true);
          if (!verified) {
            state = "failed";
            terminalReason = "process_exit";
            detail = "child acceptance teardown unverified";
            writeStatus();
            shutdownBridge(1);
            return;
          }
          if (piChild === closingChild) piChild = null;
        }
        alive = false;
        childIdle = true;
        isStreaming = false;
        writeStatus();
        shutdownBridge(0);
      } else if (req.type === "restart_process" || req.type === "resume") {
        if (terminalReason !== "auth_blocked" || !childIdle || isStreaming || inFlightTool) {
          socket.write(JSON.stringify({
            id: reqId,
            type: "response",
            command: req.type,
            success: false,
            error: "cannot restart process unless idle and auth-blocked",
          }) + "\n");
          return;
        }
        if (alive && piChild) {
          const oldChild = piChild;
          const verified = await stopExactChild(oldChild);
          if (!verified) {
            detail = "old child termination unverified";
            writeStatus();
            socket.write(JSON.stringify({
              id: reqId,
              type: "response",
              command: req.type,
              success: false,
              error: "cannot restart: old child termination unverified",
            }) + "\n");
            return;
          }
          if (piChild === oldChild) piChild = null;
        }
        if (!sessionInfo.sessionFile || !fs.existsSync(sessionInfo.sessionFile)) {
          socket.write(JSON.stringify({
            id: reqId,
            type: "response",
            command: req.type,
            success: false,
            error: "cannot restart: native session file unavailable",
          }) + "\n");
          return;
        }
        currentAttemptStderr = "";
        try { fs.unlinkSync(errorPath); } catch {}
        terminalReason = null;
        state = "running";
        spawnPiChild(true);
        const nativeState = await sendCommandToPi({ id: `restart-state-${++requestSeq}`, type: "get_state" }, 5000);
        if (!nativeState.success) {
          state = "failed";
          terminalReason = "process_exit";
          detail = "restarted child state unavailable";
          writeStatus();
          socket.write(JSON.stringify({
            id: reqId,
            type: "response",
            command: req.type,
            success: false,
            error: "cannot restart: native state unavailable",
          }) + "\n");
          return;
        }
        state = childIdle ? "idle" : "running";
        writeStatus();
        socket.write(JSON.stringify({
          id: reqId,
          type: "response",
          command: req.type,
          success: true,
          data: { pid: childPid },
        }) + "\n");
      } else {
        socket.write(JSON.stringify({ id: reqId, type: "response", success: false, error: `unknown_command: ${req.type}` }) + "\n");
      }
    }
  });
});

let isShuttingDown = false;
function shutdownBridge(exitCode) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try { server.close(); } catch {}
  try { fs.unlinkSync(sockPath); } catch {}
  setTimeout(() => {
    try { fs.closeSync(rawFd); } catch {}
    try { fs.closeSync(traceFd); } catch {}
    try { fs.closeSync(stderrFd); } catch {}
    process.exit(exitCode);
  }, 100);
}

server.listen(sockPath, async () => {
  spawnPiChild(false);

  try {
    await sendCommandToPi({ id: "init-state", type: "get_state" }, 5000);
    state = childIdle ? "idle" : "running";
    writeStatus();
  } catch {}

  if (fs.existsSync(promptPath)) {
    const promptText = fs.readFileSync(promptPath, "utf8").trim();
    if (promptText) {
      try {
        beginAttempt();
        await sendCommandToPi({ id: "init-prompt", type: "prompt", message: withBudgetNote(promptText) }, 0);
      } catch (err) {
        appendStderr(`initial prompt error: ${err.message}\n`);
      }
    }
  }
});
EOF_RPC_BRIDGE
}

do_review_legacy() {
  cd "$REPO" || return 1
  job .prompt > "$RUN_DIR/prompt.txt"
  # A subscription provider is an extension and every other provider is built
  # into pi, so this lane names the one extension it needs. Discovery stays off
  # for the same reason it does in the supervised path.
  local extension=""
  if [ "$(job .provider)" = "claude-code" ]; then
    extension="-e $CLAUDE_CODE_PROVIDER"
  fi
  timeout -k 15 "$(job .piTimeoutSeconds)" \
    pi --provider "$(job .provider)" --model "$(job .model)" --thinking "$(job .thinking)" \
      --mode json --print --no-session --no-extensions --no-skills --no-prompt-templates --approve \
      $extension \
      -- "$(cat "$RUN_DIR/prompt.txt")" > "$RAW" 2>"$RUN_DIR/pi.stderr"
  local pi_exit=$?
  if ! validate_review_events "$pi_exit"; then
    do_trace || true
    return 1
  fi
}

# Pi loads the first context file it finds in the checkout root, and the repo's
# own AGENTS.md is written for someone who commits. A reviewer neither commits
# nor edits product source, so it is given a role-appropriate override built
# from a versioned fragment rather than the contributor guide.
write_reviewer_context() {
  local context
  context=$(jq --raw-output --join-output '.reviewerContext // ""' "$JOB")
  [ -n "$context" ] || return 0
  printf '%s\n' "$context" > "$REPO/AGENTS.override.md"
  # Remembered so the reviewer's own additions can be counted without this one,
  # and so a reviewer that rewrites the file is still counted.
  sha256sum "$REPO/AGENTS.override.md" | cut -d' ' -f1 > "$RUN_DIR/reviewer-context.sha256"
}

# True while AGENTS.override.md is still byte-for-byte the file we wrote.
runner_override_untouched() {
  local expected actual
  [ -f "$RUN_DIR/reviewer-context.sha256" ] || return 1
  [ -f "$REPO/AGENTS.override.md" ] || return 1
  expected=$(cat "$RUN_DIR/reviewer-context.sha256")
  actual=$(sha256sum "$REPO/AGENTS.override.md" | cut -d' ' -f1)
  [ "$expected" = "$actual" ]
}

do_review_supervised() {
  cd "$REPO" || return 1
  mkdir -p "$RUN_DIR/sessions"
  write_reviewer_context
  job .prompt > "$RUN_DIR/prompt.txt"
  # A lane started without a prompt waits idle for one; the check note alone
  # must not become the prompt that wakes it.
  if [ -n "$(job .prompt)" ] && [ -f "$RUN_DIR/check.exit" ]; then
    {
      printf '\n---\n\nA check already ran in this checkout before you started.\n'
      printf 'Command: %s\n' "$(job .checkCommand)"
      printf 'Exit status: %s\n' "$(cat "$RUN_DIR/check.exit")"
      printf 'Its output is at %s. A non-zero exit is evidence about the change, not a reason to stop.\n' "$RUN_DIR/check.log"
    } >> "$RUN_DIR/prompt.txt"
  fi
  run_rpc_bridge "$RUN_DIR"
  local bridge_exit=$?
  if [ "$bridge_exit" -ne 0 ]; then
    return "$bridge_exit"
  fi
}

do_review() {
  if ! is_supervised; then
    do_review_legacy
    return $?
  fi
  do_review_supervised
}

write_review_error() {
  local reason="$1" pi_exit="$2" stop_reason="$3" error_message="$4" stderr_tail
  stderr_tail=$(tail -c 4000 "$RUN_DIR/pi.stderr" 2>/dev/null)
  jq -n --arg reason "$reason" --argjson piExit "$pi_exit" \
    --arg stopReason "$stop_reason" --arg errorMessage "${error_message:0:4000}" \
    --arg stderrTail "$stderr_tail" \
    '{reason:$reason, piExit:$piExit, stopReason:$stopReason,
      errorMessage:$errorMessage, stderrTail:$stderrTail}' > "$REVIEW_ERROR"
}

validate_review_events() {
  local pi_exit="$1" stop_reason error_message has_final
  if ! stop_reason=$(jq -sr '[.[] | select(.type == "turn_end")] | last
                              | .message.stopReason // ""' "$RAW" 2>/dev/null); then
    write_review_error invalid_event_stream "$pi_exit" "" "Pi emitted invalid JSON events"
    return 1
  fi
  error_message=$(jq -sr '[.[] | select(.type == "turn_end")] | last
                           | .message.errorMessage // ""' "$RAW" 2>/dev/null)
  has_final=$(jq -sr '[.[] | select(.type == "agent_end")] | last
                      | ((.messages // []) | map(select(.role == "assistant")) | last
                         | (.content // []) | map(select(.type == "text") | .text)
                         | join("\n") | test("\\S")) // false' "$RAW" 2>/dev/null)

  local stderr_source="$RUN_DIR/pi.stderr"
  if is_supervised && [ -f "$RUN_DIR/pi.attempt.stderr" ]; then
    stderr_source="$RUN_DIR/pi.attempt.stderr"
  fi
  local combined_err="$error_message $(cat "$stderr_source" 2>/dev/null || true)"
  if echo "$combined_err" | grep -qiE '401|403|unauthorized|oauth|invalid_token|expired_token|invalid_api_key|token_expired|authentication_error|jwt expired'; then
    write_review_error auth_blocked "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi
  if echo "$combined_err" | grep -qiE '429|rate_limit|rate limit|insufficient_quota|resource_exhausted|exceeded your current quota'; then
    write_review_error quota_blocked "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi

  if [ "$pi_exit" -ne 0 ]; then
    write_review_error pi_exit "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi
  if [ "$stop_reason" = error ] || [ "$stop_reason" = aborted ]; then
    write_review_error model_error "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi
  if [ "$stop_reason" != stop ]; then
    write_review_error incomplete_result "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi
  if [ "$has_final" != true ]; then
    write_review_error empty_result "$pi_exit" "$stop_reason" "$error_message"
    return 1
  fi
}

# The raw stream is one event per streamed token; the trace keeps only what a
# receipt needs - which tool ran, on what, whether it failed - with results
# clipped so a large file read cannot balloon the exported evidence.
#
# Both ends of a tool result are kept: a check writes its command at the top and
# its exit status at the bottom, so a head-only clip cannot substantiate the
# claim a verifier makes about it.
# What the reviewer changed in its own checkout. `git rev-parse HEAD` proves the
# commit identity it started from; this proves the files it actually ran are
# still that commit, or names exactly how they are not.
do_checkout_delta() {
  cd "$REPO" || return 1
  git --no-pager diff HEAD > "$RUN_DIR/checkout-delta.patch" 2>/dev/null || true
  git status --porcelain > "$RUN_DIR/checkout-status.txt" 2>/dev/null || true
  git ls-files --others --exclude-standard > "$RUN_DIR/checkout-untracked.txt" 2>/dev/null || true
  # This counter answers "what did the reviewer introduce". Our own context file
  # is not an answer to that, and counting it would read 1 on every clean run
  # until nobody looked at it again. A reviewer that edits the file changes its
  # hash, and then it counts.
  if runner_override_untouched; then
    grep -v '^AGENTS\.override\.md$' "$RUN_DIR/checkout-untracked.txt" > "$RUN_DIR/checkout-untracked.tmp" || true
    mv "$RUN_DIR/checkout-untracked.tmp" "$RUN_DIR/checkout-untracked.txt"
    grep -v '^?? AGENTS\.override\.md$' "$RUN_DIR/checkout-status.txt" > "$RUN_DIR/checkout-status.tmp" || true
    mv "$RUN_DIR/checkout-status.tmp" "$RUN_DIR/checkout-status.txt"
  fi
}

do_trace() {
  jq -c 'select(.type == "tool_execution_start" or .type == "tool_execution_end" or .type == "turn_end")
         | if .type == "tool_execution_end"
           then ([.result.content[]?.text // ""] | join("")) as $text
                | {type, toolName, toolCallId: (.toolCallId // .id), isError,
                   resultBytes: ($text | length),
                   result: $text[0:400],
                   resultTail: (if ($text | length) > 400 then $text[-400:] else "" end)}
           elif .type == "turn_end"
           then {type, usage: .message.usage, stopReason: .message.stopReason,
                 errorMessage: ((.message.errorMessage // "")[0:4000])}
           else . end' "$RAW" > "$TRACE"
}

# One report per lane.
#
# The lane is either finished - the review ran to a terminal turn and a report
# was written from it - or it was cut at its window, at its request cap, or by
# the provider. Both leave a report, and only `completion` differs: a lane that
# was cut and a lane that reviewed the change and found nothing must never be
# the same file, because only one of them read the code.
write_report() {
  local completion="$1" reason="${2:-}" final usage tools
  final=$(jq -s 'map(select(.type == "agent_end")) | last
                 | (.messages | map(select(.role == "assistant")) | last | .content
                    | map(select(.type == "text") | .text) | join("\n")) // ""' "$RAW" 2>/dev/null) || true
  [ -n "$final" ] || final='""'
  usage=$(jq -s '[.[] | select(.type == "turn_end") | .message.usage]
                 | {turns: length,
                    input: (map(.input) | add // 0),
                    output: (map(.output) | add // 0),
                    cacheRead: (map(.cacheRead) | add // 0),
                    totalTokens: (map(.totalTokens) | add // 0),
                    costUsd: (map(.cost.total) | add // 0)}' "$RAW" 2>/dev/null) || true
  [ -n "$usage" ] || usage='{"turns":0,"input":0,"output":0,"cacheRead":0,"totalTokens":0,"costUsd":0}'
  tools=$(jq -s '[.[] | select(.type == "tool_execution_start") | {toolName, args}]' "$RAW" 2>/dev/null) || true
  [ -n "$tools" ] || tools='[]'
  jq -n --arg runId "$RUN_ID" \
    --arg requestedHeadSha "$(job .head.sha)" --arg requestedBaseSha "$(job .base.sha)" \
    --arg checkedOutHead "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" \
    --arg checkedOutBase "$(git -C "$REPO" rev-parse base 2>/dev/null || true)" \
    --arg fixtureApplied "$(job 'if (.fixturePatch // "") == "" then "false" else "true" end')" \
    --arg provider "$(job .provider)" --arg model "$(job .model)" \
    --arg piVersion "$(pi --version 2>/dev/null || true)" --arg bunVersion "$(bun --version 2>/dev/null || true)" \
    --arg diffStat "$(cat "$RUN_DIR/diff.stat" 2>/dev/null || true)" \
    --arg reviewerContextOverride "$([ -f "$REPO/AGENTS.override.md" ] && echo true || echo false)" \
    --arg checkoutDelta "$(wc -c < "$RUN_DIR/checkout-delta.patch" 2>/dev/null | tr -d ' ' || echo 0)" \
    --arg checkoutUntracked "$(wc -l < "$RUN_DIR/checkout-untracked.txt" 2>/dev/null | tr -d ' ' || echo 0)" \
    --arg checkTail "$(tail -c 4000 "$RUN_DIR/check.log" 2>/dev/null || true)" \
    --arg completion "$completion" --arg partialReason "$reason" \
    --argjson finalText "$final" --argjson usage "$usage" --argjson toolCalls "$tools" \
    --argjson elapsedSeconds "$(elapsed)" \
    '{runId:$runId,
      completion:$completion,
      partialReason:(if $partialReason == "" then null else $partialReason end),
      checkout:{mode:"git-clone-readonly-proxy", commitIdentityPreserved:true,
                requestedHeadSha:$requestedHeadSha, requestedBaseSha:$requestedBaseSha,
                checkedOutHead:$checkedOutHead, checkedOutBase:$checkedOutBase,
                fixtureCommitApplied:$fixtureApplied,
                reviewerContextOverride:$reviewerContextOverride,
                reviewerDeltaBytes:$checkoutDelta,
                reviewerUntrackedFiles:$checkoutUntracked},
      provider:$provider, model:$model,
      piVersion:$piVersion, bunVersion:$bunVersion, diffStat:$diffStat, checkTail:$checkTail,
      elapsedSeconds:$elapsedSeconds, usage:$usage, toolCalls:$toolCalls, finalText:$finalText}' \
    > "$REPORT"
}

# Why this lane has no finished report, in the runner's own words.
partial_reason() {
  local recorded
  recorded=$(jq -r '.reason // ""' "$REVIEW_ERROR" 2>/dev/null) || true
  if grep -q max_requests "$REVIEW_ERROR" 2>/dev/null; then
    printf 'the lane exhausted its model request cap before it finished'
  elif [ -n "$recorded" ]; then
    printf 'the review ended early (%s) before the lane finished' "$recorded"
  else
    printf 'the review was cut before the lane finished'
  fi
}

do_report() {
  validate_review_events 0 || return 1
  write_report complete ""
}

do_partial_report() {
  write_report partial "${1:-$(partial_reason)}"
}

# The outer `timeout` cuts this whole process group at the lane's window and
# gives it 15 s more before the KILL. Writing the report from the handler is
# what makes a lane cut at its deadline leave evidence instead of nothing.
on_window_spent() {
  if [ ! -s "$REPORT" ]; then
    write_report partial "$(partial_reason)"
    record report 0 0 "cut at the lane's window"
  fi
  write_status finished done "" "" "" "completed"
  exit 0
}

main() {
  : > "$STEPS"
  echo $$ > "$RUN_DIR/runner.pid"
  # The run's own timeout cuts this process group, and the KILL that follows it
  # is 15 s behind. Whatever the lane reached is written down here.
  trap on_window_spent TERM INT
  write_status starting running
  step clone do_clone
  step install do_install
  if is_supervised; then
    step_soft check do_check
  else
    step check do_check
  fi
  # A review that ended without a report - the provider refused, the cap was
  # reached, the child died - is reported as a cut lane, not as no lane.
  step_soft review do_review
  step_soft checkout_delta do_checkout_delta
  # Soft on purpose: a lane killed mid-line leaves a truncated raw stream, and
  # a trace that cannot be cut is not a reason to lose the report as well.
  step_soft trace do_trace
  if [ "$(cat "$RUN_DIR/review.exit" 2>/dev/null || echo 1)" = "0" ]; then
    step_soft report do_report
  fi
  [ -s "$REPORT" ] || step report do_partial_report
  if ! is_supervised; then
    write_status finished done
  else
    write_status finished done "" "" "" "completed"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${2:-}" = "--send" ] || [ "${2:-}" = "--send-file" ]; then
    NODE_BIN=$(command -v node 2>/dev/null || command -v bun 2>/dev/null)
    CMD_FILE="$3"
    if [ "${2:-}" = "--send" ]; then
      CMD_FILE=""
    fi
    RUN_DIR="$RUN_DIR" CMD="$3" CMD_FILE="$CMD_FILE" "$NODE_BIN" - << 'EOF_SEND'
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const runDir = process.env.RUN_DIR;
const sock = path.join(runDir, "rpc.sock");
let cmd = process.env.CMD;
if (process.env.CMD_FILE) {
  cmd = fs.readFileSync(process.env.CMD_FILE, "utf8").replace(/\n$/, "");
  fs.rmSync(process.env.CMD_FILE, { force: true });
}
const client = net.createConnection(sock, () => {
  client.write(cmd + "\n");
});
let buffer = "";
client.setEncoding("utf8");
client.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  if (lines.length > 1) {
    client.destroy();
    process.stdout.write(lines[0] + "\n", () => process.exit(0));
  }
});
client.on("error", (err) => {
  process.stderr.write("socket error: " + err.message + "\n");
  process.exit(1);
});
EOF_SEND
    exit $?
  elif [ "${2:-}" = "--bridge" ]; then
    run_rpc_bridge "$RUN_DIR"
    exit $?
  else
    main
  fi
fi
