import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchMergeBase, fetchPullRevisions } from "./publish";
import { githubToken } from "./swarm";

const POLL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEADLINE_MARGIN_MS = 60_000;
const UNOBSERVED_DEADLINE_MS = 10 * 60_000;
const MAX_CONTEXT_CHARS = 64_000;
const USER_AGENT = "swarm-review-cli";
const SHA = /^[0-9a-f]{40}$/;
const CONFLICTS = ["--sandbox", "--orca", "--worker", "--hybrid"];

type ReviewStatus = {
  phase?: unknown;
  reviewers?: { family?: unknown; state?: unknown }[];
  candidates?: unknown;
  verified?: unknown;
  deadlineAt?: unknown;
  reason?: unknown;
};

type CloudIo = {
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultIo: CloudIo = {
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const required = (argv: string[], name: string) => {
  const value = flag(argv, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const requiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in the environment`);
  return value;
};

async function readBody(response: Response) {
  const text = await response
    .text()
    .catch((error: unknown) => `unreadable body: ${(error as Error).message}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const describeRefusal = (response: Response, body: unknown) =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { error?: unknown }).error === "string"
    ? `${response.status} ${(body as { error: string }).error}`
    : `${response.status} non-JSON body: ${String(body).slice(0, 200)}`;

async function revisions(argv: string[], repo: string, pr: number) {
  const head = flag(argv, "head");
  const base = flag(argv, "base");
  if (head || base) {
    if (!(head && SHA.test(head) && base && SHA.test(base))) {
      throw new Error("--head and --base must both be full commit SHAs");
    }
    return { head, base };
  }
  const token = githubToken();
  if (!token) {
    throw new Error(
      "resolving the pull request needs GITHUB_TOKEN, GH_TOKEN or gh auth; or pass --head and --base",
    );
  }
  const pull = await fetchPullRevisions(repo, pr, token);
  return {
    head: pull.head.sha,
    base: await fetchMergeBase(repo, pull.base.sha, pull.head.sha, token),
  };
}

const statusLine = (status: ReviewStatus) =>
  [
    `phase ${String(status.phase)}`,
    `reviewers ${(status.reviewers ?? []).map((lane) => `${String(lane.family)} ${String(lane.state)}`).join(", ") || "none"}`,
    `candidates ${String(status.candidates)}`,
    `verified ${String(status.verified)}`,
    ...(status.reason === undefined ? [] : [`reason ${String(status.reason)}`]),
  ].join(" | ");

/** Submits one review to a deployed Worker, follows it, and returns the exit code. */
export async function runCloud(argv: string[], io: CloudIo = defaultIo) {
  const conflict = CONFLICTS.find((name) => argv.includes(name));
  if (conflict) throw new Error(`--cloud cannot be combined with ${conflict}`);
  const repo = required(argv, "repo");
  const pr = Number(required(argv, "pr"));
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("--pr must be a pull request number");
  }
  const out = required(argv, "out");
  const contextPath = flag(argv, "context");
  const context = contextPath ? await readFile(contextPath, "utf8") : undefined;
  if (context !== undefined && context.length > MAX_CONTEXT_CHARS) {
    throw new Error(
      `--context is ${context.length} characters; the Worker accepts at most ${MAX_CONTEXT_CHARS}`,
    );
  }
  const origin = requiredEnv("WORKER_ORIGIN").replace(/\/+$/, "");
  const secret = requiredEnv("CONTROL_SECRET");
  const headers = {
    authorization: `Bearer ${secret}`,
    "user-agent": USER_AGENT,
  };
  const print = (line: string) =>
    io.print(line.replaceAll(secret, "[redacted]"));
  const { head, base } = await revisions(argv, repo, pr);

  const submitted = await fetch(`${origin}/reviews`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      repository: repo,
      pr,
      head,
      base,
      ...(context === undefined ? {} : { context }),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => error as Error);
  if (submitted instanceof Error) {
    print(`cloud review not submitted: ${submitted.message}`);
    return 1;
  }
  const accepted = await readBody(submitted);
  const reviewId =
    typeof accepted === "object" && accepted !== null
      ? (accepted as { reviewId?: unknown }).reviewId
      : undefined;
  if (submitted.status !== 202 || typeof reviewId !== "string") {
    print(`cloud review refused: ${describeRefusal(submitted, accepted)}`);
    return 1;
  }
  print(`cloud review ${reviewId}: accepted for ${repo}#${pr} at ${head}`);
  await mkdir(out, { recursive: true });

  let deadline = io.now() + UNOBSERVED_DEADLINE_MS;
  let lastLine = "";
  while (io.now() <= deadline) {
    const response = await fetch(
      `${origin}/reviews/${encodeURIComponent(reviewId)}`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    ).catch((error: unknown) => error as Error);
    if (response instanceof Error) {
      print(`cloud review ${reviewId}: poll failed: ${response.message}`);
    } else {
      const body = await readBody(response);
      const polled =
        response.ok && typeof body === "object" && body !== null
          ? (body as { status?: ReviewStatus; receipt?: { status?: unknown } })
          : null;
      if (!polled?.status) {
        print(
          `cloud review ${reviewId}: poll failed: ${describeRefusal(response, body)}`,
        );
      } else {
        await writeFile(
          join(out, "status.json"),
          JSON.stringify(polled.status),
        );
        const line = statusLine(polled.status);
        if (line !== lastLine) print(`cloud review ${reviewId}: ${line}`);
        lastLine = line;
        const deadlineAt = Date.parse(String(polled.status.deadlineAt));
        if (Number.isFinite(deadlineAt))
          deadline = deadlineAt + DEADLINE_MARGIN_MS;
        if (polled.receipt) {
          await writeFile(
            join(out, "receipt.json"),
            JSON.stringify(polled.receipt),
          );
          const outcome = String(polled.receipt.status);
          print(`cloud review ${reviewId}: ${outcome}`);
          return outcome === "completed" ? 0 : 1;
        }
      }
    }
    await io.sleep(POLL_MS);
  }
  print(
    `cloud review ${reviewId}: timed out waiting for a receipt past the deadline`,
  );
  return 1;
}
