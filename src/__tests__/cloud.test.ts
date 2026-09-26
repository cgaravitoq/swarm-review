import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCloud } from "../cloud";

const SECRET = "control-secret-5f1c9a7e2b";
const ORIGIN = "https://review.example.workers.dev";
const HEAD = "a".repeat(40);
const PR_BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const DEADLINE = "2026-09-26T12:08:00.000Z";

let out: string;
let lines: string[];
let clock: number;
const io = {
  print: (line: string) => lines.push(line),
  sleep: async (ms: number) => {
    clock += ms;
  },
  now: () => clock,
};

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "cloud-test-"));
  lines = [];
  clock = Date.parse("2026-09-26T12:00:00.000Z");
  vi.stubEnv("WORKER_ORIGIN", `${ORIGIN}/`);
  vi.stubEnv("CONTROL_SECRET", SECRET);
  vi.stubEnv("GITHUB_TOKEN", "github-token");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(out, { recursive: true, force: true });
});

type Call = { url: string; method: string; headers: Headers; body: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const status = (
  phase: string,
  states: string[],
  counts: { candidates: number; verified: number },
) => ({
  phase,
  reviewers: states.map((state, index) => ({
    family: ["workers-ai", "openai-codex", "claude-code"][index],
    model: "m",
    state,
  })),
  ...counts,
  deadlineAt: DEADLINE,
  reviewDeadlineAt: DEADLINE,
});

function stubFetch(worker: Response[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({
        url: input,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      if (input.endsWith("/pulls/7"))
        return json({ head: { sha: HEAD }, base: { sha: PR_BASE } });
      if (input.includes("/compare/"))
        return json({ merge_base_commit: { sha: MERGE_BASE } });
      const next = worker.shift();
      if (!next) throw new Error(`unexpected request ${input}`);
      return next;
    }),
  );
  return calls;
}

const argv = (...extra: string[]) => [
  "--cloud",
  "--repo",
  "octo/widget",
  "--pr",
  "7",
  "--out",
  out,
  ...extra,
];

const workerCalls = (calls: Call[]) =>
  calls.filter((call) => call.url.startsWith(ORIGIN));

const expectNoSecret = async () => {
  expect(lines.join("\n")).not.toContain(SECRET);
  for (const name of await readdir(out))
    expect(await readFile(join(out, name), "utf8")).not.toContain(SECRET);
};

it("submits the PR at its head and merge base, follows it to a completed receipt and writes both files", async () => {
  const brief = join(out, "brief.md");
  await writeFile(brief, "Review the parser.");
  const done = status("done", ["completed", "completed", "completed"], {
    candidates: 2,
    verified: 1,
  });
  const receipt = { swarmId: "review-1", status: "completed", findings: [] };
  const calls = stubFetch([
    json({ reviewId: "review-1" }, 202),
    json({
      status: status("reviewing", ["running"], { candidates: 0, verified: 0 }),
    }),
    json({
      status: status("reviewing", ["running"], { candidates: 0, verified: 0 }),
    }),
    json({
      status: status("verifying", ["completed", "completed", "completed"], {
        candidates: 2,
        verified: 0,
      }),
    }),
    json({ status: done, receipt }),
  ]);

  expect(await runCloud(argv("--context", brief), io)).toBe(0);

  expect(calls[0]?.url).toBe(
    "https://api.github.com/repos/octo/widget/pulls/7",
  );
  expect(calls[1]?.url).toBe(
    `https://api.github.com/repos/octo/widget/compare/${PR_BASE}...${HEAD}`,
  );
  const [post, ...polls] = workerCalls(calls);
  expect(post?.url).toBe(`${ORIGIN}/reviews`);
  expect(post?.method).toBe("POST");
  expect(post?.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  expect(post?.headers.get("user-agent")).toBe("swarm-review-cli");
  expect(post?.headers.get("content-type")).toBe("application/json");
  expect(post?.body).toEqual({
    reviewId: expect.stringMatching(
      /^review-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    ),
    repository: "octo/widget",
    pr: 7,
    head: HEAD,
    base: MERGE_BASE,
    context: "Review the parser.",
  });
  expect(polls).toHaveLength(4);
  for (const poll of polls) {
    expect(poll.url).toBe(`${ORIGIN}/reviews/review-1`);
    expect(poll.method).toBe("GET");
    expect(poll.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(poll.headers.get("user-agent")).toBe("swarm-review-cli");
  }
  expect(lines).toEqual([
    `cloud review review-1: accepted for octo/widget#7 at ${HEAD}`,
    "cloud review review-1: phase reviewing | reviewers workers-ai running | candidates 0 | verified 0",
    "cloud review review-1: phase verifying | reviewers workers-ai completed, openai-codex completed, claude-code completed | candidates 2 | verified 0",
    "cloud review review-1: phase done | reviewers workers-ai completed, openai-codex completed, claude-code completed | candidates 2 | verified 1",
    "cloud review review-1: completed",
  ]);
  expect(await readFile(join(out, "status.json"), "utf8")).toBe(
    JSON.stringify(done),
  );
  expect(await readFile(join(out, "receipt.json"), "utf8")).toBe(
    JSON.stringify(receipt),
  );
  await expectNoSecret();
});

it("sends explicit --head and --base without asking GitHub", async () => {
  const calls = stubFetch([
    json({ reviewId: "review-2" }, 202),
    json({
      status: status("done", [], { candidates: 0, verified: 0 }),
      receipt: { status: "completed" },
    }),
  ]);
  expect(await runCloud(argv("--head", HEAD, "--base", PR_BASE), io)).toBe(0);
  expect(calls.map((call) => call.url)).toEqual([
    `${ORIGIN}/reviews`,
    `${ORIGIN}/reviews/review-2`,
  ]);
  expect(calls[0]?.body).toEqual({
    reviewId: expect.stringMatching(
      /^review-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    ),
    repository: "octo/widget",
    pr: 7,
    head: HEAD,
    base: PR_BASE,
  });
});

it("exits non-zero on a partial receipt and says so", async () => {
  stubFetch([
    json({ reviewId: "review-3" }, 202),
    json({
      status: status("done", ["cancelled"], { candidates: 1, verified: 1 }),
      receipt: { status: "partial" },
    }),
  ]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(lines.at(-1)).toBe("cloud review review-3: partial");
  expect(JSON.parse(await readFile(join(out, "receipt.json"), "utf8"))).toEqual(
    { status: "partial" },
  );
});

it("exits non-zero on a failed receipt with the status reason", async () => {
  stubFetch([
    json({ reviewId: "review-4" }, 202),
    json({
      status: {
        ...status("failed", ["unobserved"], { candidates: 0, verified: 0 }),
        reason: "deadline",
      },
      receipt: { status: "failed" },
    }),
  ]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(lines.slice(-2)).toEqual([
    "cloud review review-4: phase failed | reviewers workers-ai unobserved | candidates 0 | verified 0 | reason deadline",
    "cloud review review-4: failed",
  ]);
});

it("names the Worker's error when the POST is refused", async () => {
  const calls = stubFetch([json({ error: "unauthorized" }, 401)]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(lines).toEqual(["cloud review refused: 401 unauthorized"]);
  expect(workerCalls(calls)).toHaveLength(1);
  await expectNoSecret();
});

it("reports a non-JSON error body instead of throwing", async () => {
  stubFetch([
    new Response("<html>error code: 1010</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    }),
  ]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(lines).toEqual([
    "cloud review refused: 403 non-JSON body: <html>error code: 1010</html>",
  ]);
});

it("keeps the secret out of an error body that echoes the authorization header", async () => {
  stubFetch([
    json({ error: `bad header Bearer ${SECRET}` }, 401),
    json({ reviewId: "review-6" }, 202),
    new Response(`upstream saw authorization: Bearer ${SECRET}`, {
      status: 502,
    }),
    json({
      status: status("done", [], { candidates: 0, verified: 0 }),
      receipt: { status: "completed" },
    }),
  ]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(await runCloud(argv(), io)).toBe(0);
  expect(lines).toContain(
    "cloud review refused: 401 bad header Bearer [redacted]",
  );
  expect(lines).toContain(
    "cloud review review-6: poll failed: 502 non-JSON body: upstream saw authorization: Bearer [redacted]",
  );
  await expectNoSecret();
});

function hangUntilAborted() {
  const timers: { ms: number; controller: AbortController }[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    timers.push({ ms, controller });
    return controller.signal;
  });
  const hung = (init: RequestInit = {}) =>
    new Promise<Response>((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    );
  const timeOut = async (index: number) => {
    while (!timers[index]) await new Promise((wake) => setTimeout(wake, 1));
    timers[index].controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
  };
  return { timers, hung, timeOut };
}

it("follows a review whose submit went unanswered under the id it sent", async () => {
  const { timers, hung, timeOut } = hangUntilAborted();
  const calls = stubFetch([
    json({
      status: status("done", [], { candidates: 0, verified: 0 }),
      receipt: { status: "completed" },
    }),
  ]);
  const fetchStub = vi.mocked(fetch);
  const answer = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation(async (input, init) =>
    init?.method === "POST" ? hung(init) : answer(input, init),
  );
  const exit = runCloud(argv(), io);
  await timeOut(0);
  expect(await exit).toBe(0);
  const [, submit] = fetchStub.mock.calls.find(
    ([, init]) => init?.method === "POST",
  )!;
  const { reviewId } = JSON.parse(String(submit?.body)) as {
    reviewId: string;
  };
  expect(submit?.signal).toBe(timers[0]?.controller.signal);
  expect(timers[0]?.ms).toBe(30_000);
  expect(workerCalls(calls).map((call) => call.url)).toEqual([
    `${ORIGIN}/reviews/${reviewId}`,
  ]);
  expect(lines).toEqual([
    `cloud review ${reviewId}: submit unanswered (The operation timed out.); following it in case the Worker started it`,
    `cloud review ${reviewId}: phase done | reviewers none | candidates 0 | verified 0`,
    `cloud review ${reviewId}: completed`,
  ]);
});

it("gives up on an unanswered submit the Worker never started once nothing is observed", async () => {
  const { hung, timeOut } = hangUntilAborted();
  const calls = stubFetch(
    Array.from({ length: 41 }, () => json({ error: "not_found" }, 404)),
  );
  const fetchStub = vi.mocked(fetch);
  const answer = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation(async (input, init) =>
    init?.method === "POST" ? hung(init) : answer(input, init),
  );
  const exit = runCloud(argv(), io);
  await timeOut(0);
  expect(await exit).toBe(1);
  expect(workerCalls(calls)).toHaveLength(41);
  expect(lines.at(-1)).toMatch(
    /^cloud review review-[0-9a-f-]{36}: timed out waiting for a receipt past the deadline$/,
  );
});

it("keeps polling past a poll the Worker never answers once that request times out", async () => {
  const { timers, hung, timeOut } = hangUntilAborted();
  const calls = stubFetch([
    json({ reviewId: "review-7" }, 202),
    json({
      status: status("done", [], { candidates: 0, verified: 0 }),
      receipt: { status: "completed" },
    }),
  ]);
  const fetchStub = vi.mocked(fetch);
  const answer = fetchStub.getMockImplementation()!;
  let polls = 0;
  fetchStub.mockImplementation(async (input, init) =>
    String(input).startsWith(`${ORIGIN}/reviews/`) && polls++ === 0
      ? hung(init)
      : answer(input, init),
  );
  const exit = runCloud(argv(), io);
  await timeOut(1);
  expect(await exit).toBe(0);
  expect(lines).toEqual([
    `cloud review review-7: accepted for octo/widget#7 at ${HEAD}`,
    "cloud review review-7: poll failed: The operation timed out.",
    "cloud review review-7: phase done | reviewers none | candidates 0 | verified 0",
    "cloud review review-7: completed",
  ]);
  expect(timers.map((timer) => timer.ms)).toEqual([30_000, 30_000, 30_000]);
  expect(
    fetchStub.mock.calls
      .filter(([input]) => String(input).startsWith(ORIGIN))
      .map(
        ([, init], index) => init?.signal === timers[index]?.controller.signal,
      ),
  ).toEqual([true, true, true]);
  expect(workerCalls(calls)).toHaveLength(2);
});

it("survives a non-JSON poll and times out past the status deadline plus a margin", async () => {
  const reviewing = json({
    status: status("reviewing", ["running"], { candidates: 0, verified: 0 }),
  });
  const polls = Array.from({ length: 60 }, () =>
    json({
      status: status("reviewing", ["running"], { candidates: 0, verified: 0 }),
    }),
  );
  const calls = stubFetch([
    json({ reviewId: "review-5" }, 202),
    new Response("Bad gateway", { status: 502 }),
    reviewing,
    ...polls,
  ]);
  expect(await runCloud(argv(), io)).toBe(1);
  expect(lines).toEqual([
    `cloud review review-5: accepted for octo/widget#7 at ${HEAD}`,
    "cloud review review-5: poll failed: 502 non-JSON body: Bad gateway",
    "cloud review review-5: phase reviewing | reviewers workers-ai running | candidates 0 | verified 0",
    "cloud review review-5: timed out waiting for a receipt past the deadline",
  ]);
  expect(clock).toBeGreaterThan(Date.parse(DEADLINE) + 60_000);
  expect(clock).toBeLessThanOrEqual(Date.parse(DEADLINE) + 75_000);
  expect(workerCalls(calls).length).toBeLessThan(60);
  await expect(readFile(join(out, "receipt.json"))).rejects.toThrow();
  await expectNoSecret();
});

it("refuses a context over the Worker's limit before any request", async () => {
  const brief = join(out, "brief.md");
  await writeFile(brief, "x".repeat(64_001));
  const calls = stubFetch([]);
  await expect(runCloud(argv("--context", brief), io)).rejects.toThrow(
    "--context is 64001 characters; the Worker accepts at most 64000",
  );
  expect(calls).toHaveLength(0);
});

it("refuses partial or abbreviated revisions before any request", async () => {
  const calls = stubFetch([]);
  await expect(runCloud(argv("--head", HEAD), io)).rejects.toThrow(
    "--head and --base must both be full commit SHAs",
  );
  await expect(
    runCloud(argv("--head", "abc123", "--base", PR_BASE), io),
  ).rejects.toThrow("--head and --base must both be full commit SHAs");
  expect(calls).toHaveLength(0);
});

it("takes the Worker origin and secret only from the environment", async () => {
  vi.stubEnv("CONTROL_SECRET", "");
  const calls = stubFetch([]);
  await expect(runCloud(argv(), io)).rejects.toThrow(
    "CONTROL_SECRET must be set in the environment",
  );
  expect(calls).toHaveLength(0);
});

it.each(["--sandbox", "--orca", "--worker", "--hybrid"])(
  "refuses --cloud with %s",
  async (conflict) => {
    const calls = stubFetch([]);
    await expect(runCloud([...argv(), conflict], io)).rejects.toThrow(
      `--cloud cannot be combined with ${conflict}`,
    );
    expect(calls).toHaveLength(0);
  },
);

it("routes --cloud from the swarm CLI before the hybrid path", () => {
  const result = spawnSync(
    "bun",
    [
      "src/swarm.ts",
      "--cloud",
      "--hybrid",
      "--repo",
      "octo/widget",
      "--pr",
      "7",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CONTROL_SECRET: SECRET, WORKER_ORIGIN: ORIGIN },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--cloud cannot be combined with --hybrid");
  expect(result.stdout + result.stderr).not.toContain(SECRET);
});
