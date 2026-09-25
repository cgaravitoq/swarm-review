import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reviewerPrompt, verifierPrompt } from "../prompts/hybrid";
import { writeAtomic } from "./attempt";
import {
  packBudgetChars,
  packLaneContext,
  wholeChangeFits,
} from "./pack-context";
import { assertPublishableReceipt } from "./publish";
import {
  applyVerdicts,
  assignLanes,
  type Candidate,
  collapseIdenticalCandidates,
  parseCandidates,
  parseVerdicts,
  reviewerLaneId,
  type Verdict,
  verifierBrief,
} from "./swarm";

type Family = "workers-ai" | "openai-codex" | "claude-code";
type Lane = {
  family: Family;
  provider: string;
  model: string;
  piDir: string;
  extensions: string[];
  env: Record<string, string>;
};
type LaneResult = {
  status: "completed" | "failed" | "cut";
  stopReason: string | null;
  turns: number;
  usage: { input: number; output: number; totalTokens: number } | null;
  finalText: string;
  error: string | null;
};

const value = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const required = (argv: string[], name: string) => {
  const found = value(argv, name);
  if (!found) throw new Error(`--${name} is required`);
  return found;
};
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function parseLane(value: unknown): Lane {
  const lane = record(value);
  if (!lane) throw new Error("invalid lane");
  const family = lane["family"];
  const env = record(lane["env"]);
  if (
    (family !== "workers-ai" &&
      family !== "openai-codex" &&
      family !== "claude-code") ||
    typeof lane["provider"] !== "string" ||
    typeof lane["model"] !== "string" ||
    typeof lane["piDir"] !== "string" ||
    !Array.isArray(lane["extensions"]) ||
    !lane["extensions"].every((entry) => typeof entry === "string") ||
    !env ||
    !Object.values(env).every((entry) => typeof entry === "string")
  )
    throw new Error("invalid lane config");
  return {
    family,
    provider: lane["provider"],
    model: lane["model"],
    piDir: lane["piDir"],
    extensions: lane["extensions"] as string[],
    env: env as Record<string, string>,
  };
}

const turnCap = 8;
const tools = "read,grep,find,ls";

function runPi(input: {
  lane: Lane;
  source: string;
  prompt: string;
  deadlineAt: number;
  children: Set<ChildProcess>;
}): Promise<LaneResult> {
  return new Promise((resolveResult) => {
    const args = [
      "--provider",
      input.lane.provider,
      "--model",
      input.lane.model,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--tools",
      tools,
      ...input.lane.extensions.flatMap((extension) => ["-e", extension]),
      "--",
      input.prompt,
    ];
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...input.lane.env,
      PI_CODING_AGENT_DIR: input.lane.piDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    };
    const child = spawn("pi", args, {
      cwd: input.source,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    input.children.add(child);
    let stdout = "";
    let stderr = "";
    let turns = 0;
    let stopReason: string | null = null;
    let usage: LaneResult["usage"] = null;
    let finalText = "";
    let cut: "deadline" | "turn cap" | null = null;
    let complete = false;
    const kill = (reason: "deadline" | "turn cap") => {
      if (complete || cut) return;
      cut = reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(
      () => kill("deadline"),
      Math.max(0, input.deadlineAt - Date.now()),
    );
    const consume = (line: string) => {
      if (cut) return;
      let event: Record<string, unknown> | null = null;
      try {
        event = record(JSON.parse(line));
      } catch {
        return;
      }
      if (!event) return;
      if (event["type"] === "turn_end") {
        turns += 1;
        const message = record(event["message"]);
        if (typeof message?.["stopReason"] === "string")
          stopReason = message["stopReason"];
        const observed = record(message?.["usage"]);
        if (observed) {
          const inputTokens = observed["input"];
          const outputTokens = observed["output"];
          const totalTokens = observed["totalTokens"];
          if (
            typeof inputTokens === "number" &&
            typeof outputTokens === "number" &&
            typeof totalTokens === "number"
          ) {
            usage ??= { input: 0, output: 0, totalTokens: 0 };
            usage.input += inputTokens;
            usage.output += outputTokens;
            usage.totalTokens += totalTokens;
          }
        }
      }
      if (event["type"] === "turn_start" && turns >= turnCap) kill("turn cap");
      if (event["type"] === "agent_end") {
        const messages = event["messages"];
        if (Array.isArray(messages)) {
          const assistant = [...messages]
            .reverse()
            .find((item) => record(item)?.["role"] === "assistant");
          const content = record(assistant)?.["content"];
          if (Array.isArray(content))
            finalText = content
              .flatMap((item) => {
                const part = record(item);
                return part?.["type"] === "text" &&
                  typeof part["text"] === "string"
                  ? [part["text"]]
                  : [];
              })
              .join("\n");
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        consume(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      stderr += error.message;
    });
    child.once("close", (code) => {
      complete = true;
      clearTimeout(timer);
      input.children.delete(child);
      if (stdout.trim()) consume(stdout.trim());
      const status = cut
        ? "cut"
        : code === 0 && finalText && stopReason !== "error"
          ? "completed"
          : "failed";
      resolveResult({
        status,
        stopReason: cut ?? stopReason,
        turns,
        usage,
        finalText,
        error:
          status === "failed" ? stderr.trim() || `pi exited ${code}` : null,
      });
    });
  });
}

export async function runHybrid(argv: string[]) {
  required(argv, "repo");
  const source = resolve(required(argv, "source"));
  const out = resolve(required(argv, "out"));
  const head = required(argv, "head");
  const base = required(argv, "base");
  const pullRequest = Number(required(argv, "pr"));
  const timeout = Number(value(argv, "total-timeout") ?? 480);
  if (
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    !Number.isInteger(pullRequest) ||
    pullRequest <= 0
  )
    throw new Error("invalid timeout or pull request");
  const config = record(
    JSON.parse(await readFile(required(argv, "lanes"), "utf8")),
  );
  if (
    !config ||
    !Array.isArray(config["reviewers"]) ||
    !Array.isArray(config["verifiers"])
  )
    throw new Error("invalid lanes file");
  const reviewers = config["reviewers"].map(parseLane);
  const verifiers = config["verifiers"].map(parseLane);
  if (
    reviewers.length === 0 ||
    reviewers.length > 3 ||
    new Set(verifiers.map((lane) => lane.family)).size !== verifiers.length
  )
    throw new Error("invalid lane count or duplicate verifier family");
  const actualHead = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actualHead !== head) throw new Error("source HEAD differs from --head");
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeout * 1000;
  const children = new Set<ChildProcess>();
  const stop = () => {
    for (const child of children)
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await mkdir(out, { recursive: true });
  const changedFiles = execFileSync(
    "git",
    ["-C", source, "diff", "--name-only", `${base}...${head}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const budget = Math.min(
    ...reviewers.map((lane) => packBudgetChars("t1b", lane.model)),
  );
  const assignments = assignLanes(
    changedFiles,
    reviewers.length,
    wholeChangeFits({ repo: source, head, base, files: changedFiles, budget }),
  );
  const context = value(argv, "context")
    ? await readFile(required(argv, "context"), "utf8")
    : "";
  const status = {
    phase: "reviewing" as "reviewing" | "verifying" | "done" | "failed",
    reviewers: reviewers.map((lane) => ({
      family: lane.family,
      model: lane.model,
      state: "running",
    })),
    candidates: 0,
    verified: 0,
    deadlineAt: new Date(deadlineAt).toISOString(),
  };
  let statusWrite = Promise.resolve();
  const writeStatus = () => {
    const body = JSON.stringify(status);
    statusWrite = statusWrite.then(() =>
      writeAtomic(join(out, "status.json"), body),
    );
    return statusWrite;
  };
  await writeStatus();
  const laneRows: {
    laneId: string;
    role: string;
    family: Family;
    provider: string;
    model: string;
    status: string;
    stopReason: string | null;
    turns: number;
    usage: LaneResult["usage"];
    blockerReason?: string | null;
    contractError?: string | null;
    error?: string | null;
    candidateIds?: string[];
  }[] = [];
  const candidateRows: Candidate[][] = reviewers.map(() => []);
  try {
    await Promise.all(
      reviewers.map(async (lane, index) => {
        const assignment = assignments[index];
        if (!assignment) return;
        const pack = packLaneContext({
          repo: source,
          head,
          base,
          files: assignment.files,
          budget: packBudgetChars("t1b", lane.model),
        });
        const prompt = `${reviewerPrompt}\n\n${context}\n\nAngle: ${assignment.focus}\nAssigned files: ${assignment.files.join(", ")}\n\n${pack.pack}`;
        const result = await runPi({
          lane,
          source,
          prompt,
          deadlineAt,
          children,
        });
        const parsed =
          result.status === "completed"
            ? parseCandidates(result.finalText, reviewerLaneId(index))
            : null;
        const laneStatus = parsed?.error
          ? "malformed"
          : parsed?.completion === "partial"
            ? "blocked"
            : result.status === "completed"
              ? "completed"
              : result.status === "cut"
                ? "cancelled"
                : "failed";
        if (parsed && !parsed.error) candidateRows[index] = parsed.candidates;
        laneRows[index] = {
          laneId: reviewerLaneId(index),
          role: "reviewer",
          family: lane.family,
          provider: lane.provider,
          model: lane.model,
          status: laneStatus,
          stopReason: result.stopReason,
          turns: result.turns,
          usage: result.usage,
          blockerReason: parsed?.blockerReason ?? null,
          contractError: parsed?.error ?? null,
          error: result.error,
        };
        status.reviewers[index]!.state = laneStatus;
        await writeStatus();
      }),
    );
    const candidates = collapseIdenticalCandidates(candidateRows.flat());
    status.candidates = candidates.length;
    status.phase = "verifying";
    await writeStatus();
    const verdicts: Verdict[] = [];
    await Promise.all(
      candidates.map(async (candidate) => {
        const finderFamilies = new Set(
          candidate.reportedBy.map((id) => {
            const index = Number(id.slice("reviewer-".length)) - 1;
            return reviewers[index]?.family;
          }),
        );
        const lane = verifiers.find(
          (entry) => !finderFamilies.has(entry.family),
        );
        if (!lane || Date.now() >= deadlineAt) return;
        const brief = verifierBrief({
          repo: source,
          base,
          head,
          files: [candidate.file],
          pullRequest: null,
          candidates: [
            {
              id: candidate.id,
              severity: candidate.severity,
              file: candidate.file,
              line: candidate.line,
              mechanism: candidate.mechanism,
              evidence: candidate.evidence,
              affectedBehavior: candidate.affectedBehavior,
            },
          ],
        });
        const pack = packLaneContext({
          repo: source,
          head,
          base,
          files: [candidate.file],
          budget: packBudgetChars("t1b", lane.model),
        });
        const result = await runPi({
          lane,
          source,
          prompt: `${verifierPrompt}\n\n${JSON.stringify(brief)}\n\n${pack.pack}`,
          deadlineAt,
          children,
        });
        const parsed =
          result.status === "completed"
            ? parseVerdicts(result.finalText, [candidate.id])
            : null;
        if (parsed && !parsed.error) {
          verdicts.push(...parsed.verdicts);
          status.verified += 1;
          await writeStatus();
        }
        laneRows.push({
          laneId: `verifier-${candidate.id}`,
          role: "verifier",
          family: lane.family,
          provider: lane.provider,
          model: lane.model,
          status: parsed?.error
            ? "malformed"
            : result.status === "completed"
              ? "completed"
              : result.status === "cut"
                ? "cancelled"
                : "failed",
          stopReason: result.stopReason,
          turns: result.turns,
          usage: result.usage,
          candidateIds: [candidate.id],
          contractError: parsed?.error ?? null,
          error: result.error,
        });
      }),
    );
    const adjudicated = applyVerdicts(candidates, verdicts);
    const uncoveredFiles = changedFiles.filter(
      (file) =>
        !assignments.some(
          (assignment, index) =>
            assignment.files.includes(file) &&
            laneRows[index]?.["status"] === "completed",
        ),
    );
    const complete =
      laneRows
        .slice(0, reviewers.length)
        .every((lane) => lane?.["status"] === "completed") &&
      uncoveredFiles.length === 0 &&
      adjudicated.findings.every((finding) => finding.status !== "unverified");
    const receipt = {
      swarmId: `hybrid-${randomUUID()}`,
      status: complete ? "completed" : "partial",
      requested: { head, base, pullRequest },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallSeconds: Math.round((Date.now() - startedAt) / 1000),
      coverage: {
        changedFiles,
        assignments: Object.fromEntries(
          assignments.map((assignment, index) => [
            reviewerLaneId(index),
            assignment,
          ]),
        ),
        uncoveredFiles,
      },
      lanes: laneRows,
      candidates,
      findings: adjudicated.findings,
      duplicates: adjudicated.duplicates,
      unverified: adjudicated.findings
        .filter((finding) => finding.status === "unverified")
        .map((finding) => finding.id),
      verification: {
        mode: "hybrid",
        unverified: adjudicated.findings
          .filter((finding) => finding.status === "unverified")
          .map((finding) => finding.id),
      },
    };
    assertPublishableReceipt(receipt, { head, mergeBase: base });
    await writeAtomic(
      join(out, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    status.phase = "done";
    await writeStatus();
  } catch (error) {
    status.phase = "failed";
    await writeStatus();
    throw error;
  } finally {
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
