import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gitCapability } from "../git-proxy";

const getSandbox = vi.hoisted(() => vi.fn());
// oxlint-disable-next-line anti-slop/no-module-mocking -- The Worker imports the Sandbox SDK at module load.
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  getSandbox,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The Worker imports DurableObject at module load.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const {
  default: worker,
  PullRequestReview,
  ReviewJob,
} = await import("../../worker");

let privateKey: string;
let publicKey: CryptoKey;
beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = keys.publicKey;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer,
  );
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const event = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  repository: { full_name: "acme/demo" },
  pull_request: {
    draft: false,
    author_association: "MEMBER",
    head: { sha: "a".repeat(40) },
    base: { sha: "b".repeat(40) },
  },
  installation: { id: 42 },
  ...overrides,
});
const signed = async (
  body: string,
  secret = "webhook-secret",
  delivery = "12345678-1234-1234-1234-123456789abc",
  kind = "pull_request",
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return new Request("https://review.invalid/github/webhook", {
    method: "POST",
    headers: {
      "x-hub-signature-256": `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      "x-github-delivery": delivery,
      "x-github-event": kind,
    },
    body,
  });
};

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const MOVED = "d".repeat(40);
const API = "https://api.github.com/repos/acme/demo";
const ORIGIN = "https://review.invalid";
const SUPERSEDED = "A newer pull request event superseded this review.";
const PULL = {
  repository: "acme/demo",
  number: 7,
  head: HEAD,
  base: BASE,
  installationId: 42,
};
const BRIEF_AT_BASE = `${API}/contents/.swarm-review/brief.md?ref=${BASE}`;
const CONFIG_AT_BASE = `${API}/contents/.swarm-review/config.json?ref=${BASE}`;
const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 keep
+added
 tail
`;

const finding = (id: string, line: number) => ({
  id,
  severity: "P1",
  file: "src/app.ts",
  line,
  mechanism: `mechanism ${id}`,
  evidence: "evidence",
  affectedBehavior: "behavior",
  status: "confirmed",
  evidenceStrength: "executable",
  reportedBy: ["reviewer-1"],
  verifierReason: "reproduced",
  verifierCommand: null,
  verifierExitStatus: 0,
  diffRelation: "added",
  declaredIntent: null,
});

const receipt = {
  swarmId: "hybrid-one",
  status: "completed",
  requested: { head: HEAD, base: MERGE_BASE, pullRequest: 7 },
  findings: [finding("inline", 2), finding("unanchored", 40)],
};

type Call = { method: string; url: string; headers: Headers; body: unknown };

const github = (
  options: {
    pullHead?: string;
    ancestor?: boolean;
    routes?: Record<
      string,
      (call: Call) => Response | undefined | Promise<Response | undefined>
    >;
  } = {},
) => {
  const pullHead = options.pullHead ?? HEAD;
  const calls: Call[] = [];
  const reviews: { id: number; body: string }[] = [];
  let checkRunId = 99;
  const fake = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const route = `${call.method} ${call.url}`;
    const override = await options.routes?.[route]?.(call);
    if (override) return override;
    if (call.url.endsWith("/access_tokens"))
      return Response.json({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (route === `POST ${API}/check-runs`)
      return Response.json({ id: checkRunId++ });
    if (call.method === "PATCH" && call.url.startsWith(`${API}/check-runs/`))
      return Response.json({});
    if (route === `GET ${API}/compare/${BASE}...${HEAD}`)
      return Response.json({ merge_base_commit: { sha: MERGE_BASE } });
    if (route === `GET ${API}/compare/${MERGE_BASE}...${HEAD}`)
      return new Response(DIFF);
    if (route === `GET ${API}/compare/${HEAD}...${pullHead}`)
      return Response.json({ status: options.ancestor ? "ahead" : "diverged" });
    if (route === `GET ${API}/pulls/7`)
      return Response.json({
        state: "open",
        draft: false,
        merged: false,
        author_association: "MEMBER",
        head: { sha: pullHead },
        base: { sha: BASE },
      });
    if (route === `GET ${API}/pulls/7/reviews?per_page=100&page=1`)
      return Response.json(reviews);
    if (route === `POST ${API}/pulls/7/reviews`) {
      const id = 500 + reviews.length;
      reviews.push({ id, body: (call.body as { body: string }).body });
      return Response.json({
        id,
        html_url: `https://github.com/acme/demo/pull/7#pullrequestreview-${id}`,
      });
    }
    if (call.method === "PUT" && call.url.startsWith(`${API}/pulls/7/reviews/`))
      return Response.json({});
    if (call.method === "GET" && call.url.startsWith(`${API}/contents/`))
      return new Response("Not Found", { status: 404 });
    throw new Error(`unexpected ${route}`);
  });
  vi.stubGlobal("fetch", fake);
  const sent = () =>
    calls.filter((call) => !call.url.endsWith("/access_tokens"));
  return {
    calls,
    reviews,
    sent,
    posts: () =>
      calls.filter(
        (call) =>
          call.method === "POST" && call.url === `${API}/pulls/7/reviews`,
      ),
    checks: () =>
      calls
        .filter(
          (call) =>
            call.method === "PATCH" &&
            (call.body as { status: string }).status === "completed",
        )
        .map((call) => ({
          url: call.url,
          ...(call.body as { conclusion: string; output: object }),
        })),
    progress: () =>
      calls.filter(
        (call) =>
          call.method === "PATCH" &&
          (call.body as { status: string }).status === "in_progress",
      ),
  };
};

const fixture = () => {
  const stored = new Map<string, unknown>();
  const r2 = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => stored.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
    }),
    setAlarm: vi.fn(async () => undefined),
  };
  const pr = new PullRequestReview({} as never, {} as never);
  const job = {
    start: vi.fn<(review: { context?: string }) => Promise<void>>(
      async () => undefined,
    ),
    isDone: vi.fn(async () => true),
    cancel: vi.fn(async () => undefined),
  };
  const destroy = vi.fn(async () => undefined);
  getSandbox.mockReturnValue({ destroy });
  const env = {
    CONTROL_SECRET: "control-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_READ_TOKEN: "legacy-token",
    TARGET_REPOSITORIES:
      "https://github.com/acme/demo.git,https://github.com/acme/other.git",
    PULL_REQUEST_REVIEWS: { getByName: vi.fn(() => pr) },
    REVIEW_JOBS: { getByName: vi.fn(() => job) },
    REVIEW_SANDBOX: "sandboxes",
    PROBE_RESULTS: {
      put: vi.fn(async (key: string, body: string) => {
        r2.set(key, JSON.parse(body));
      }),
      get: vi.fn(async (key: string) =>
        r2.has(key) ? { json: async () => r2.get(key) } : null,
      ),
      head: vi.fn(async (key: string) => (r2.has(key) ? {} : null)),
    },
  };
  Object.assign(pr, { ctx: { storage }, env });
  const started = async (delivery = "12345678-1234-1234-1234-123456789abc") => {
    await worker.fetch(
      await signed(JSON.stringify(event()), "webhook-secret", delivery),
      env as never,
    );
    await pr.alarm();
    return (stored.get("current") as { reviewId: string }).reviewId;
  };
  return { pr, env, stored, storage, r2, job, destroy, started };
};

describe("GitHub App webhook", () => {
  it("refuses a missing or bad signature before parsing", async () => {
    const { env, storage } = fixture();
    const bad = new Request("https://review.invalid/github/webhook", {
      method: "POST",
      body: "not json",
    });
    expect((await worker.fetch(bad, env as never)).status).toBe(401);
    expect(
      (
        await worker.fetch(
          await signed("not json", "wrong-secret"),
          env as never,
        )
      ).status,
    ).toBe(401);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", { pull_request: { ...event().pull_request, draft: true } }],
    [
      "outsider",
      {
        pull_request: {
          ...event().pull_request,
          author_association: "CONTRIBUTOR",
        },
      },
    ],
    ["action", { action: "closed" }],
    ["repository", { repository: { full_name: "acme/unlisted" } }],
  ])("skips %s", async (_name, change) => {
    const { env, storage } = fixture();
    const response = await worker.fetch(
      await signed(JSON.stringify(event(change))),
      env as never,
    );
    expect(response.status).toBe(_name === "repository" ? 403 : 200);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("refuses an unset repository allowlist", async () => {
    const { env, storage } = fixture();
    const response = await worker.fetch(await signed(JSON.stringify(event())), {
      ...env,
      TARGET_REPOSITORIES: undefined,
    } as never);
    expect(response.status).toBe(403);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"])(
    "refuses a signed event while %s is unset",
    async (name) => {
      const { env, storage } = fixture();
      const response = await worker.fetch(
        await signed(JSON.stringify(event())),
        {
          ...env,
          [name]: undefined,
        } as never,
      );
      expect(response.status).toBe(503);
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.setAlarm).not.toHaveBeenCalled();
    },
  );

  it("deduplicates redelivery and starts one review at the merge base after response", async () => {
    const { env, pr, stored, r2, job } = fixture();
    const { calls } = github();
    const body = JSON.stringify(event());
    expect((await worker.fetch(await signed(body), env as never)).status).toBe(
      202,
    );
    expect(calls).toHaveLength(0);
    expect(
      await (await worker.fetch(await signed(body), env as never)).json(),
    ).toEqual({ accepted: false });
    await pr.alarm();
    expect(job.start).toHaveBeenCalledOnce();
    const state = stored.get("current") as {
      reviewId: string;
      checkRunId: number;
      generation: number;
    };
    expect(state).toMatchObject({
      checkRunId: 99,
      generation: 1,
      mergeBase: MERGE_BASE,
      phase: "running",
    });
    expect(job.start).toHaveBeenCalledWith(
      expect.objectContaining({ head: HEAD, base: MERGE_BASE, pr: 7 }),
    );
    expect(r2.get(`reviews/${state.reviewId}/git.json`)).toEqual({
      repository: "acme/demo",
      installationId: 42,
    });
    const token = calls[0]!;
    expect(token.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(token.method).toBe("POST");
    expect(token.body).toEqual({
      repositories: ["demo"],
      permissions: {
        contents: "read",
        checks: "write",
        pull_requests: "write",
      },
    });
    const jwt = token.headers.get("authorization")!.slice(7);
    const [header, claims, signature] = jwt.split(".");
    expect(
      JSON.parse(atob(header!.replace(/-/g, "+").replace(/_/g, "/"))),
    ).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(
      atob(claims!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    expect(payload.iss).toBe("123");
    expect(payload.exp - payload.iat).toBe(600);
    expect(
      await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        Uint8Array.from(
          atob(signature!.replace(/-/g, "+").replace(/_/g, "/")),
          (character) => character.charCodeAt(0),
        ),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
    const create = calls[1]!;
    expect(create.url).toBe(`${API}/check-runs`);
    expect(create.headers.get("authorization")).toBe(
      "Bearer installation-token",
    );
    const createBody = create.body as { started_at: string };
    expect(createBody).toEqual({
      name: "swarm-review",
      head_sha: HEAD,
      status: "in_progress",
      started_at: createBody.started_at,
      output: {
        title: "Swarm review in progress",
        summary: "Reviewing the pull request head.",
      },
    });
    expect(Number.isFinite(Date.parse(createBody.started_at))).toBe(true);
    expect(calls[2]).toMatchObject({
      method: "GET",
      url: `${API}/compare/${BASE}...${HEAD}`,
    });
    expect(calls[2]!.headers.get("authorization")).toBe(
      "Bearer installation-token",
    );
    expect(calls[3]).toMatchObject({ method: "GET", url: BRIEF_AT_BASE });
    expect(calls[4]).toMatchObject({ method: "GET", url: CONFIG_AT_BASE });
    expect(calls[5]).toMatchObject({
      method: "PATCH",
      url: `${API}/check-runs/99`,
      body: {
        status: "in_progress",
        output: {
          title: "Swarm review in progress",
          summary: "Phase: `reviewing`.",
        },
      },
    });
    expect(calls).toHaveLength(6);
    expect(job.start.mock.calls[0]![0]).not.toHaveProperty("context");
    expect(state).toMatchObject({
      briefNote: null,
      shadow: false,
      configNote: null,
    });
  });

  it("ends an unsuccessful review neutrally with the failure reason and publishes nothing", async () => {
    const { r2, pr, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      status: "failed",
      failure: { message: "deadline" },
    });
    await pr.alarm();
    expect(gh.posts()).toEqual([]);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: deadline.\n\nThe receipt names no lanes.",
        },
      }),
    ]);
  });

  it("ends a failure summary whose reason is already a sentence with one period", async () => {
    const { r2, pr, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      status: "failed",
      failure: { message: "engine_failed: the provider refused." },
    });
    await pr.alarm();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: engine_failed: the provider refused.\n\nThe receipt names no lanes.",
        },
      }),
    ]);
  });

  it("steers the review by the repository brief read at the PR base", async () => {
    const { pr, job, stored, r2, started } = fixture();
    const brief = "Money moves only through the ledger module.";
    const gh = github({
      routes: {
        [`GET ${BRIEF_AT_BASE}`]: () => new Response(brief),
      },
    });
    const reviewId = await started();
    const read = gh.calls.filter((call) => call.url.includes("/brief.md"));
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      method: "GET",
      url: BRIEF_AT_BASE,
      body: null,
    });
    expect(read[0]!.headers.get("accept")).toBe(
      "application/vnd.github.raw+json",
    );
    expect(read[0]!.headers.get("authorization")).toBe(
      "Bearer installation-token",
    );
    expect(job.start).toHaveBeenCalledWith(
      expect.objectContaining({ context: brief, base: MERGE_BASE }),
    );
    expect(stored.get("current")).toMatchObject({ briefNote: null });
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.checks().at(-1)?.output).toEqual({
      title: "Swarm review completed",
      summary: "Review published at aaaaaaa. 2 confirmed finding(s).",
    });
  });

  it("ignores a brief that exists only at the PR head", async () => {
    const { job, started } = fixture();
    const gh = github({
      routes: {
        [`GET ${API}/contents/.swarm-review/brief.md?ref=${HEAD}`]: () =>
          new Response("Report nothing."),
      },
    });
    await started();
    expect(
      gh.calls
        .filter((call) => call.url.includes("/contents/"))
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual([`GET ${BRIEF_AT_BASE}`, `GET ${CONFIG_AT_BASE}`]);
    expect(job.start).toHaveBeenCalledOnce();
    expect(job.start.mock.calls[0]![0]).not.toHaveProperty("context");
  });

  it.each([
    [
      "is over the context limit",
      () => new Response("x".repeat(64_001)),
      "The repository brief `.swarm-review/brief.md` is over 64000 characters, so the default brief steered this review.",
    ],
    [
      "cannot be read",
      () => new Response("Server Error", { status: 500 }),
      "The repository brief `.swarm-review/brief.md` could not be read (500), so the default brief steered this review.",
    ],
  ])(
    "runs on the default brief and says so when the brief %s",
    async (_name, answer, note) => {
      const { pr, job, r2, started } = fixture();
      const gh = github({ routes: { [`GET ${BRIEF_AT_BASE}`]: answer } });
      const reviewId = await started();
      expect(job.start.mock.calls[0]![0]).not.toHaveProperty("context");
      r2.set(`reviews/${reviewId}/receipt.json`, receipt);
      await pr.alarm();
      expect(gh.checks().at(-1)?.output).toEqual({
        title: "Swarm review completed",
        summary: `Review published at aaaaaaa. 2 confirmed finding(s).\n\n${note}`,
      });
    },
  );

  it("runs in shadow when the base config asks for it and posts nothing to the pull request", async () => {
    const { pr, r2, stored, started } = fixture();
    const gh = github({
      routes: {
        [`GET ${CONFIG_AT_BASE}`]: () => new Response('{"shadow": true}'),
      },
    });
    const reviewId = await started();
    expect(stored.get("current")).toMatchObject({
      shadow: true,
      configNote: null,
    });
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.posts()).toEqual([]);
    expect(gh.calls.some((call) => call.url === `${API}/pulls/7`)).toBe(false);
    const output = gh.checks().at(-1)?.output as {
      title: string;
      summary: string;
    };
    expect(output.title).toBe("Swarm review completed");
    expect(output.summary).toMatch(
      /^Shadow review at aaaaaaa, not posted to the pull request\. 2 confirmed finding\(s\)\.\n\n<!-- review-pi run=hybrid-one sha=a{40} -->/,
    );
    expect(output.summary).toContain("mechanism inline");
    expect(output.summary).toContain("mechanism unanchored");
  });

  it("posts the review as usual when the base config turns shadow off", async () => {
    const { pr, r2, started } = fixture();
    const gh = github({
      routes: {
        [`GET ${CONFIG_AT_BASE}`]: () => new Response('{"shadow": false}'),
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
    expect(gh.checks().at(-1)?.output).toEqual({
      title: "Swarm review completed",
      summary: "Review published at aaaaaaa. 2 confirmed finding(s).",
    });
  });

  it.each([
    ["{", "is not valid JSON"],
    ["[]", "is not a JSON object"],
    ['{"shadow": false, "mode": "loud"}', "has a key it does not know, `mode`"],
    ['{"shadow": "no"}', "sets `shadow` to something other than true or false"],
    [500, "could not be read (500)"],
  ])(
    "runs in shadow and says why when the config at the base reads %s",
    async (answer, why) => {
      const { pr, r2, started } = fixture();
      const gh = github({
        routes: {
          [`GET ${CONFIG_AT_BASE}`]: () =>
            typeof answer === "number"
              ? new Response("Server Error", { status: answer })
              : new Response(answer),
        },
      });
      const reviewId = await started();
      r2.set(`reviews/${reviewId}/receipt.json`, receipt);
      await pr.alarm();
      expect(gh.posts()).toEqual([]);
      const { summary } = gh.checks().at(-1)!.output as { summary: string };
      expect(summary).toMatch(/^Shadow review at aaaaaaa/);
      expect(
        summary.endsWith(
          `\n\nThe repository config \`.swarm-review/config.json\` ${why}, so this review ran in shadow.`,
        ),
      ).toBe(true);
    },
  );

  it("keeps a long partial shadow review's check summary within GitHub's limit", async () => {
    const { pr, r2, started } = fixture();
    const gh = github({
      routes: {
        [`GET ${CONFIG_AT_BASE}`]: () => new Response('{"shadow": true}'),
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      ...receipt,
      status: "partial",
      findings: [{ ...finding("long", 40), mechanism: "x".repeat(62_000) }],
      lanes: Array.from({ length: 27 }, () => ({
        role: "verifier",
        family: "openai-codex",
        model: "gpt-6-luna",
        status: "failed",
        stopReason: "error",
        error: "e".repeat(500),
      })),
    });
    await pr.alarm();
    const { summary } = gh.checks().at(-1)!.output as { summary: string };
    expect(summary).toMatch(/^Shadow review at aaaaaaa/);
    expect(summary.length).toBe(65_535);
    expect(summary.endsWith("\n\n(Cut here to fit the check run.)")).toBe(true);
  });

  it("waits out a rate-limited brief read and then steers by the brief", async () => {
    const { pr, job, stored, storage } = fixture();
    const brief = "Money moves only through the ledger module.";
    let limited = 1;
    const gh = github({
      routes: {
        [`GET ${BRIEF_AT_BASE}`]: () =>
          limited-- > 0
            ? new Response("API rate limit exceeded", {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "4102444800",
                },
              })
            : new Response(brief),
      },
    });
    await pr.accept(PULL, "b2345678-1234-1234-1234-123456789abc", ORIGIN);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(job.start).not.toHaveBeenCalled();
    expect(stored.get("current")).toMatchObject({
      phase: "pending",
      checkRunId: 99,
      briefNote: null,
    });
    expect(storage.setAlarm).toHaveBeenCalledExactlyOnceWith(4_102_444_800_000);
    await pr.alarm();
    expect(
      gh.calls
        .filter((call) => call.url.includes("/contents/"))
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      `GET ${BRIEF_AT_BASE}`,
      `GET ${BRIEF_AT_BASE}`,
      `GET ${CONFIG_AT_BASE}`,
    ]);
    expect(job.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ context: brief }),
    );
    expect(stored.get("current")).toMatchObject({
      phase: "running",
      checkRunId: 99,
      briefNote: null,
    });
  });

  it("updates the running check once per phase or reviewer change", async () => {
    const { pr, r2, stored, storage, started } = fixture();
    const gh = github();
    const reviewId = await started();
    const progress = () =>
      gh.progress().map((call) => {
        expect(call.url).toBe(`${API}/check-runs/99`);
        expect(call.headers.get("authorization")).toBe(
          "Bearer installation-token",
        );
        return call.body;
      });
    const running = (summary: string) => ({
      status: "in_progress",
      output: { title: "Swarm review in progress", summary },
    });
    expect(progress()).toEqual([running("Phase: `reviewing`.")]);
    await pr.alarm();
    expect(progress()).toHaveLength(1);
    const status = {
      phase: "reviewing",
      reviewers: [
        {
          family: "workers-ai",
          model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
          state: "completed",
        },
        { family: "claude-code", model: "claude-opus-5-5", state: "running" },
      ],
      candidates: 0,
      verified: 0,
    };
    r2.set(`reviews/${reviewId}/status.json`, status);
    await pr.alarm();
    r2.set(`reviews/${reviewId}/status.json`, { ...status, candidates: 3 });
    await pr.alarm();
    const reviewers =
      "- `workers-ai` `@cf/deepseek-ai/deepseek-v4-flash-0731`: `completed`\n- `claude-code` `claude-opus-5-5`: `running`";
    expect(progress()).toEqual([
      running("Phase: `reviewing`."),
      running(`Phase: \`reviewing\`.\n${reviewers}`),
    ]);
    r2.set(`reviews/${reviewId}/status.json`, {
      ...status,
      phase: "verifying",
    });
    storage.setAlarm.mockClear();
    await pr.alarm();
    await pr.alarm();
    expect(progress().slice(2)).toEqual([
      running(`Phase: \`verifying\`.\n${reviewers}`),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "running" });
    expect(gh.checks()).toEqual([]);
  });

  it("keeps the review running when a progress update fails and retries it", async () => {
    const { pr, stored, storage, started } = fixture();
    let failures = 1;
    const gh = github({
      routes: {
        [`PATCH ${API}/check-runs/99`]: () =>
          failures-- > 0
            ? new Response("Bad Gateway", { status: 502 })
            : undefined,
      },
    });
    await started();
    expect(stored.get("current")).toMatchObject({
      phase: "running",
      progress: null,
    });
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
    await pr.alarm();
    expect(gh.progress()).toHaveLength(2);
    expect(stored.get("current")).toMatchObject({
      phase: "running",
      progress: "Phase: `reviewing`.",
    });
  });

  it("sends no progress to a check a newer generation superseded mid-read", async () => {
    const { pr, env, r2, stored, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/status.json`, { phase: "verifying" });
    const read = env.PROBE_RESULTS.get.getMockImplementation()!;
    env.PROBE_RESULTS.get.mockImplementation(async (key: string) => {
      if (key === `reviews/${reviewId}/status.json`)
        await pr.accept(PULL, "f2345678-1234-1234-1234-123456789abc", ORIGIN);
      return read(key);
    });
    gh.calls.length = 0;
    await pr.alarm();
    expect(stored.get("current")).toMatchObject({ generation: 2 });
    expect(
      gh.sent().filter((call) => call.url === `${API}/check-runs/99`),
    ).toEqual([]);
  });

  it("names each lane of a partial review in the final summary", async () => {
    const { pr, r2, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      ...receipt,
      status: "partial",
      lanes: [
        {
          laneId: "reviewer-1",
          role: "reviewer",
          family: "workers-ai",
          model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
          status: "completed",
          stopReason: "stop",
          error: null,
        },
        {
          laneId: "reviewer-2",
          role: "reviewer",
          family: "openai-codex",
          model: "gpt-6-luna",
          status: "cancelled",
          stopReason: "review deadline",
          error: "cut at `deadline` <b>",
        },
      ],
    });
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "success",
        output: {
          title: "Swarm review completed",
          summary: [
            "Review published at aaaaaaa. 2 confirmed finding(s).",
            "",
            "- `reviewer` `workers-ai` `@cf/deepseek-ai/deepseek-v4-flash-0731`: `completed`, stop reason `stop`",
            "- `reviewer` `openai-codex` `gpt-6-luna`: `cancelled`, stop reason `review deadline`, error `cut at 'deadline' ‹b>`",
          ].join("\n"),
        },
      }),
    ]);
  });

  it("names each lane of a failed receipt and its failure", async () => {
    const { pr, r2, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      status: "failed",
      failure: { stage: "cloud_review", message: "engine_failed" },
      lanes: [
        {
          role: "reviewer",
          family: "claude-code",
          model: "claude-opus-5-5",
          status: "failed",
          stopReason: null,
          error: "provider refused",
        },
      ],
    });
    await pr.alarm();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: engine_failed.\n\n- `reviewer` `claude-code` `claude-opus-5-5`: `failed`, error `provider refused`",
        },
      }),
    ]);
  });

  it("ends the check of a failed receipt whose lane is not an object", async () => {
    const { pr, r2, stored, storage, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, {
      status: "failed",
      failure: { stage: "cloud_review", message: "engine_failed" },
      lanes: [null],
    });
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: engine_failed.\n\n- `none` `none` `none`: `none`",
        },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it.each([
    "interrupted",
    "destroy_failed",
    "Durable Object reset because its code was updated; destroy_failed: Durable Object reset because its code was updated.",
    "Durable Object reset because its code was updated.",
    "image source /opt/review/review-run.sh differs from the host's copy: expected 1, observed 2",
  ])(
    "starts a fresh review once when the platform lost the first: %s",
    async (message) => {
      const { pr, r2, job, destroy, stored, started } = fixture();
      const gh = github();
      const first = await started();
      r2.set(`reviews/${first}/receipt.json`, {
        status: "failed",
        failure: { stage: "cloud_review", message },
      });
      await pr.alarm();
      expect(getSandbox).toHaveBeenLastCalledWith("sandboxes", first);
      expect(destroy).toHaveBeenCalledOnce();
      expect(job.start).toHaveBeenCalledOnce();
      await pr.alarm();
      const second = (stored.get("current") as { reviewId: string }).reviewId;
      expect(second).not.toBe(first);
      expect(job.start).toHaveBeenCalledTimes(2);
      expect(job.start.mock.calls[1]![0]).toMatchObject({
        reviewId: second,
        head: HEAD,
        base: MERGE_BASE,
      });
      expect(gh.checks()).toEqual([]);
      expect(stored.get("current")).toMatchObject({
        phase: "running",
        retriedAfter: message,
      });
    },
  );

  it.each([
    "deadline",
    "deadline; destroy_failed: Durable Object reset because its code was updated.",
    "engine_failed; destroy_failed: busy",
    "destroy_failed: Durable Object reset because its code was updated.",
  ])(
    "ends neutral without a retry when the platform did not cause the loss: %s",
    async (message) => {
      const { pr, r2, job, destroy, started } = fixture();
      const gh = github();
      const first = await started();
      r2.set(`reviews/${first}/receipt.json`, {
        status: "failed",
        failure: { stage: "cloud_review", message },
      });
      await pr.alarm();
      expect(destroy).not.toHaveBeenCalled();
      expect(job.start).toHaveBeenCalledOnce();
      expect(gh.checks()).toEqual([
        expect.objectContaining({ conclusion: "neutral" }),
      ]);
    },
  );

  it("does not retry a lost review whose sandbox still cannot be stopped", async () => {
    const { pr, r2, job, destroy, stored, started } = fixture();
    const gh = github();
    const first = await started();
    r2.set(`reviews/${first}/receipt.json`, {
      status: "failed",
      failure: {
        stage: "cloud_review",
        message:
          "Durable Object reset because its code was updated; destroy_failed: Durable Object reset because its code was updated.",
      },
    });
    destroy.mockRejectedValueOnce(new Error("busy"));
    await pr.alarm();
    expect(job.start).toHaveBeenCalledOnce();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: Durable Object reset because its code was updated; destroy_failed: Durable Object reset because its code was updated. Not retried, because its sandbox could not be stopped: busy.\n\nThe receipt names no lanes.",
        },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
  });

  it("publishes the retry of a review a deploy lost and says it was retried", async () => {
    const { pr, r2, stored, started } = fixture();
    const gh = github();
    const first = await started();
    r2.set(`reviews/${first}/receipt.json`, {
      status: "failed",
      failure: {
        stage: "cloud_review",
        message:
          "Durable Object reset because its code was updated; destroy_failed: Durable Object reset because its code was updated.",
      },
    });
    await pr.alarm();
    await pr.alarm();
    const second = (stored.get("current") as { reviewId: string }).reviewId;
    r2.set(`reviews/${second}/receipt.json`, { ...receipt, swarmId: second });
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "success",
        output: {
          title: "Swarm review completed",
          summary:
            "Review published at aaaaaaa. 2 confirmed finding(s).\n\nRetried once: the first attempt ended with `Durable Object reset because its code was updated; destroy_failed: Durable Object reset because its code was updated.`.",
        },
      }),
    ]);
  });

  it("ends neutral when the retry is lost too, and starts no third review", async () => {
    const { pr, r2, job, stored, storage, started } = fixture();
    const gh = github();
    const first = await started();
    r2.set(`reviews/${first}/receipt.json`, {
      status: "failed",
      failure: { stage: "cloud_review", message: "interrupted" },
    });
    await pr.alarm();
    await pr.alarm();
    const second = (stored.get("current") as { reviewId: string }).reviewId;
    r2.set(`reviews/${second}/receipt.json`, {
      status: "failed",
      failure: { stage: "cloud_review", message: "interrupted" },
    });
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(job.start).toHaveBeenCalledTimes(2);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review could not complete: interrupted.\n\nThe receipt names no lanes.\n\nRetried once: the first attempt ended with `interrupted`.",
        },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("binds a git capability to its allowed repository", async () => {
    const { env, r2 } = fixture();
    r2.set("reviews/review-one/git.json", {
      repository: "acme/demo",
      installationId: 42,
    });
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const capability = await gitCapability(
      "review-one",
      "control-secret",
      "acme/other",
    );
    const response = await worker.fetch(
      new Request(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
        { headers: { "x-review-run": "review-one" } },
      ),
      env as never,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a malformed run header before it names an R2 key", async () => {
    const { env } = fixture();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const runId = "review-x/../../other";
    const capability = await gitCapability(
      runId,
      "control-secret",
      "acme/demo",
    );
    const response = await worker.fetch(
      new Request(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
        { headers: { "x-review-run": runId } },
      ),
      env as never,
    );
    expect(response.status).toBe(403);
    expect(env.PROBE_RESULTS.get).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the repository-scoped installation token for the App run's git fetch", async () => {
    const { env, r2 } = fixture();
    r2.set("reviews/review-app/git.json", {
      repository: "acme/demo",
      installationId: 43,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init: RequestInit) => {
        calls.push({ url: String(input), init });
        return String(input).endsWith("/access_tokens")
          ? Response.json({
              token: "app-git-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            })
          : new Response("git response");
      }),
    );
    const capability = await gitCapability(
      "review-app",
      "control-secret",
      "acme/demo",
    );
    const response = await worker.fetch(
      new Request(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
        { headers: { "x-review-run": "review-app" } },
      ),
      env as never,
    );
    expect(response.status).toBe(200);
    const git = calls.at(-1)!;
    expect(git.url).toBe(
      "https://github.com/acme/demo.git/info/refs?service=git-upload-pack",
    );
    expect(
      atob(new Headers(git.init.headers).get("authorization")!.slice(6)),
    ).toBe("x-access-token:app-git-token");
    expect(JSON.stringify(calls)).not.toContain("legacy-token");
  });
});

const REVIEWS = `${API}/pulls/7/reviews?per_page=100&page=1`;

const lost = () => {
  throw new TypeError("Network connection lost.");
};

describe("App review publication", () => {
  it("names the cloud review behind the check in the completed check's external_id", async () => {
    const { pr, r2, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        external_id: reviewId,
        conclusion: "success",
      }),
    ]);
  });

  it("posts one review at the reviewed commit with inline comments on commentable lines and the marker", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    const gh = github();
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    gh.calls.length = 0;
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.sent().map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${API}/pulls/7`,
      `GET ${API}/compare/${BASE}...${HEAD}`,
      `GET ${REVIEWS}`,
      `GET ${API}/compare/${MERGE_BASE}...${HEAD}`,
      `POST ${API}/pulls/7/reviews`,
      `PATCH ${API}/check-runs/99`,
    ]);
    expect(gh.sent()[3]!.headers.get("accept")).toBe(
      "application/vnd.github.v3.diff",
    );
    const post = gh.posts()[0]!;
    expect(post.headers.get("authorization")).toBe("Bearer installation-token");
    const body = post.body as { body: string };
    expect(body).toEqual({
      commit_id: HEAD,
      event: "COMMENT",
      body: body.body,
      comments: [
        {
          path: "src/app.ts",
          line: 2,
          side: "RIGHT",
          body: expect.stringContaining("mechanism inline"),
        },
      ],
    });
    expect(body.body).toContain(
      `<!-- review-pi run=hybrid-one sha=${HEAD} -->`,
    );
    expect(body.body).toContain("mechanism unanchored");
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "success",
        output: {
          title: "Swarm review completed",
          summary: "Review published at aaaaaaa. 2 confirmed finding(s).",
        },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
  });

  it("records the publish intent, and a retry after a crash before the POST posts once", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    let failures = 1;
    const gh = github({
      routes: {
        [`GET ${REVIEWS}`]: () => (failures-- > 0 ? lost() : undefined),
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(stored.get("current")).toMatchObject({ phase: "publishing" });
    expect(gh.posts()).toEqual([]);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    await pr.alarm();
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
    expect(gh.reviews).toHaveLength(1);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
  });

  it("does not post again when the POST reached GitHub but its answer was lost", async () => {
    const { r2, pr, stored, started } = fixture();
    const gh = github({
      routes: {
        [`POST ${API}/pulls/7/reviews`]: (call) => {
          gh.reviews.push({
            id: 900,
            body: (call.body as { body: string }).body,
          });
          return lost();
        },
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(stored.get("current")).toMatchObject({ phase: "publishing" });
    await pr.alarm();
    expect(gh.posts()).toHaveLength(1);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.checks()).toEqual([
      expect.objectContaining({ conclusion: "success" }),
    ]);
  });

  it("publishes at the reviewed commit when the head moved on top of it", async () => {
    const { r2, pr, started } = fixture();
    const gh = github({ pullHead: MOVED, ancestor: true });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.sent().map((call) => call.url)).toContain(
      `${API}/compare/${HEAD}...${MOVED}`,
    );
    expect(
      gh.posts().map((call) => (call.body as { commit_id: string }).commit_id),
    ).toEqual([HEAD]);
  });

  it("refuses a reviewed commit that was force-pushed away and ends the check neutral", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    const gh = github({ pullHead: MOVED, ancestor: false });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.posts()).toEqual([]);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary:
            "Review not published: pull request head moved off the frozen SHA.",
        },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({ phase: "done" });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("marks an older swarm review superseded and leaves other reviews alone", async () => {
    const { r2, pr, started } = fixture();
    const gh = github();
    gh.reviews.push(
      { id: 1, body: `old\n<!-- review-pi run=hybrid-zero sha=${HEAD} -->` },
      { id: 2, body: "a human review" },
    );
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    const puts = gh.calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.url)).toEqual([`${API}/pulls/7/reviews/1`]);
    expect((puts[0]!.body as { body: string }).body).toMatch(
      /^> Superseded by run `hybrid-one` at `aaaaaaa`: https:\/\/github\.com\/acme\/demo\/pull\/7#pullrequestreview-502/,
    );
  });

  it("never publishes a superseded generation's receipt and stops its cloud review", async () => {
    const { r2, pr, stored, env, job, started } = fixture();
    const gh = github();
    const first = await started();
    r2.set(`reviews/${first}/receipt.json`, receipt);
    await worker.fetch(
      await signed(
        JSON.stringify(event()),
        "webhook-secret",
        "22345678-1234-1234-1234-123456789abc",
      ),
      env as never,
    );
    await pr.alarm();
    expect(gh.posts()).toEqual([]);
    expect(job.cancel).toHaveBeenCalledOnce();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        output: expect.objectContaining({
          summary: "A newer pull request event superseded this review.",
        }),
      }),
    ]);
    expect(stored.get("current")).toMatchObject({
      generation: 2,
      checkRunId: 100,
      phase: "running",
    });
    expect(stored.get("superseded")).toEqual([]);
  });

  it("does not post when a newer generation arrives while the older one is publishing", async () => {
    const { r2, pr, stored, started } = fixture();
    const gh = github({
      routes: {
        [`GET ${REVIEWS}`]: async () => {
          await pr.accept(
            {
              repository: "acme/demo",
              number: 7,
              head: HEAD,
              base: BASE,
              installationId: 42,
            },
            "32345678-1234-1234-1234-123456789abc",
            "https://review.invalid",
          );
          return undefined;
        },
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    await pr.alarm();
    expect(gh.posts()).toEqual([]);
    expect(stored.get("current")).toMatchObject({ generation: 2 });
    await pr.alarm();
    expect(gh.checks()).toContainEqual(
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
      }),
    );
  });

  it("ends the retry loop on a review GitHub refuses for good and records why", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    const gh = github({
      routes: {
        [`POST ${API}/pulls/7/reviews`]: () =>
          new Response("Unprocessable Entity", { status: 422 }),
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        conclusion: "neutral",
        output: expect.objectContaining({
          summary:
            "Review not published: GitHub review request failed: 422: Unprocessable Entity.",
        }),
      }),
    ]);
    expect(stored.get("current")).toMatchObject({
      phase: "done",
      outcome:
        "Review not published: GitHub review request failed: 422: Unprocessable Entity.",
    });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("retries a rate-limited review POST at the reset GitHub names", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    let limited = 1;
    const gh = github({
      routes: {
        [`POST ${API}/pulls/7/reviews`]: () =>
          limited-- > 0
            ? new Response("API rate limit exceeded", {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "4102444800",
                },
              })
            : undefined,
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.checks()).toEqual([]);
    expect(stored.get("current")).toMatchObject({ phase: "publishing" });
    expect(storage.setAlarm).toHaveBeenCalledExactlyOnceWith(4_102_444_800_000);
    await pr.alarm();
    expect(gh.reviews).toHaveLength(1);
    expect(gh.checks()).toEqual([
      expect.objectContaining({ conclusion: "success" }),
    ]);
  });

  it("ends the check with the reason of a plain 403 on the review POST", async () => {
    const { r2, pr, stored, storage, started } = fixture();
    const gh = github({
      routes: {
        [`POST ${API}/pulls/7/reviews`]: () =>
          new Response("Resource not accessible by integration", {
            status: 403,
          }),
      },
    });
    const reviewId = await started();
    r2.set(`reviews/${reviewId}/receipt.json`, receipt);
    storage.setAlarm.mockClear();
    await pr.alarm();
    const summary =
      "Review not published: GitHub review request failed: 403: Resource not accessible by integration.";
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Swarm review could not complete", summary },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({
      phase: "done",
      outcome: summary,
    });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("completes the check of a generation GitHub ends for good after creating it", async () => {
    const { pr, stored, storage } = fixture();
    const gh = github({
      routes: {
        [`GET ${API}/compare/${BASE}...${HEAD}`]: () =>
          new Response("Not Found", { status: 404 }),
      },
    });
    await pr.accept(
      {
        repository: "acme/demo",
        number: 7,
        head: HEAD,
        base: BASE,
        installationId: 42,
      },
      "62345678-1234-1234-1234-123456789abc",
      "https://review.invalid",
    );
    storage.setAlarm.mockClear();
    await pr.alarm();
    const summary =
      "Review could not complete: GitHub three-dot compare failed: 404.";
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Swarm review could not complete", summary },
      }),
    ]);
    expect(stored.get("current")).toMatchObject({
      phase: "done",
      outcome: summary,
    });
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no findings array",
      { ...receipt, findings: undefined },
      /^Review not published: .+\.$/,
    ],
    [
      "a null receipt",
      null,
      /^Review not published: the receipt is not a JSON object\.$/,
    ],
  ])(
    "ends the check of a receipt with %s instead of retrying",
    async (_name, malformed, summary) => {
      const { r2, pr, stored, storage, started } = fixture();
      const gh = github();
      const reviewId = await started();
      r2.set(`reviews/${reviewId}/receipt.json`, malformed);
      storage.setAlarm.mockClear();
      await pr.alarm();
      expect(gh.posts()).toEqual([]);
      expect(gh.checks()).toEqual([
        expect.objectContaining({
          url: `${API}/check-runs/99`,
          conclusion: "neutral",
          output: {
            title: "Swarm review could not complete",
            summary: expect.stringMatching(summary),
          },
        }),
      ]);
      expect(stored.get("current")).toMatchObject({ phase: "done" });
      expect(storage.setAlarm).not.toHaveBeenCalled();
    },
  );

  it("drops a superseded check GitHub refuses for good without blocking the next generation", async () => {
    const { pr, stored, storage, started } = fixture();
    const gh = github({
      routes: {
        [`PATCH ${API}/check-runs/99`]: () =>
          new Response("Not Found", { status: 404 }),
      },
    });
    await started();
    await pr.accept(
      {
        repository: "acme/demo",
        number: 7,
        head: HEAD,
        base: BASE,
        installationId: 42,
      },
      "42345678-1234-1234-1234-123456789abc",
      "https://review.invalid",
    );
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(stored.get("superseded")).toEqual([]);
    expect(stored.get("current")).toMatchObject({
      generation: 2,
      checkRunId: 100,
      phase: "running",
    });
    expect(gh.checks().map((check) => check.url)).toEqual([
      `${API}/check-runs/99`,
    ]);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
  });

  it("ends a generation whose check GitHub refuses to create, and a later one still runs", async () => {
    const { stored, storage, job, started } = fixture();
    let refusals = 1;
    github({
      routes: {
        [`POST ${API}/check-runs`]: () =>
          refusals-- > 0
            ? new Response("Forbidden", { status: 403 })
            : undefined,
      },
    });
    storage.setAlarm.mockClear();
    await started();
    expect(stored.get("current")).toMatchObject({
      phase: "done",
      outcome: "create_check_403",
    });
    expect(storage.setAlarm).toHaveBeenCalledOnce();
    await started("52345678-1234-1234-1234-123456789abc");
    expect(stored.get("current")).toMatchObject({
      generation: 2,
      phase: "running",
    });
    expect(job.start).toHaveBeenCalledOnce();
  });
  it("waits out a secondary rate limit GitHub names only in its body", async () => {
    const { pr, stored, storage, job } = fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    let limited = 1;
    const gh = github({
      routes: {
        [`POST ${API}/check-runs`]: () =>
          limited-- > 0
            ? Response.json(
                {
                  message:
                    "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
                },
                { status: 403 },
              )
            : undefined,
      },
    });
    await pr.accept(PULL, "82345678-1234-1234-1234-123456789abc", ORIGIN);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(gh.sent()).toEqual([
      expect.objectContaining({ method: "POST", url: `${API}/check-runs` }),
    ]);
    expect(stored.get("current")).toMatchObject({
      phase: "pending",
      checkRunId: null,
      outcome: null,
    });
    expect(storage.setAlarm).toHaveBeenCalledExactlyOnceWith(now + 60_000);
    await pr.alarm();
    expect(stored.get("current")).toMatchObject({
      phase: "running",
      checkRunId: 99,
    });
    expect(job.start).toHaveBeenCalledOnce();
  });
  it.each([
    [
      "superseded check",
      `PATCH ${API}/check-runs/99`,
      (pr: InstanceType<typeof PullRequestReview>) =>
        pr.accept(PULL, "92345678-1234-1234-1234-123456789abc", ORIGIN),
    ],
    [
      "push offer",
      `POST ${API}/check-runs`,
      (pr: InstanceType<typeof PullRequestReview>) =>
        pr.offer(
          { ...PULL, head: MOVED },
          "a2345678-1234-1234-1234-123456789abc",
        ),
    ],
  ])(
    "retries a rate-limited %s at the reset GitHub names",
    async (_name, route, arrive) => {
      const { pr, stored, storage, started } = fixture();
      let limited = 1;
      const gh = github({
        routes: {
          [route]: (call) =>
            (call.body as { status: string; head_sha?: string }).status ===
              "completed" && limited-- > 0
              ? new Response("API rate limit exceeded", {
                  status: 403,
                  headers: {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": "4102444800",
                  },
                })
              : undefined,
        },
      });
      await started();
      await arrive(pr);
      storage.setAlarm.mockClear();
      await pr.alarm();
      expect(limited).toBe(0);
      expect(storage.setAlarm).toHaveBeenCalledExactlyOnceWith(
        4_102_444_800_000,
      );
      gh.calls.length = 0;
      vi.spyOn(Date, "now").mockReturnValue(4_102_444_800_000);
      await pr.alarm();
      expect(
        gh.sent().filter((call) => `${call.method} ${call.url}` === route),
      ).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({
            status: "completed",
            conclusion: "neutral",
          }),
        }),
      ]);
      expect(stored.get("superseded") ?? []).toEqual([]);
      expect(stored.get("offers") ?? []).toEqual([]);
    },
  );
  it("cancels a review superseded during its start even when the first cancel fails", async () => {
    const { pr, env, stored, job } = fixture();
    const gh = github();
    job.start.mockImplementationOnce(async () => {
      await pr.accept(PULL, "c2345678-1234-1234-1234-123456789abc", ORIGIN);
    });
    job.cancel.mockRejectedValueOnce(new Error("destroy_failed: busy"));
    await pr.accept(PULL, "d2345678-1234-1234-1234-123456789abc", ORIGIN);
    await pr.alarm();
    const first = (job.start.mock.calls[0]![0] as { reviewId: string })
      .reviewId;
    expect(stored.get("superseded")).toEqual([
      expect.objectContaining({ generation: 1, reviewId: first }),
    ]);
    env.REVIEW_JOBS.getByName.mockClear();
    await pr.alarm();
    expect(env.REVIEW_JOBS.getByName).toHaveBeenCalledWith(first);
    expect(stored.get("superseded")).toEqual([
      expect.objectContaining({ generation: 1, cancelFailures: 1 }),
    ]);
    expect(gh.checks()).toEqual([]);
    env.REVIEW_JOBS.getByName.mockClear();
    await pr.alarm();
    expect(env.REVIEW_JOBS.getByName).toHaveBeenCalledWith(first);
    expect(job.cancel).toHaveBeenCalledTimes(2);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        output: expect.objectContaining({ summary: SUPERSEDED }),
      }),
    ]);
    expect(stored.get("superseded")).toEqual([]);
  });

  it("spreads five attempts to complete a superseded check over an hour, then stops", async () => {
    const { pr, stored, storage, started } = fixture();
    const gh = github({
      routes: {
        [`PATCH ${API}/check-runs/99`]: (call) =>
          (call.body as { status: string }).status === "completed"
            ? new Response("upstream error", { status: 502 })
            : undefined,
      },
    });
    await started();
    await pr.accept(PULL, "e2345678-1234-1234-1234-123456789abc", ORIGIN);
    const completions = () =>
      gh.calls.filter(
        (call) =>
          call.method === "PATCH" &&
          call.url === `${API}/check-runs/99` &&
          (call.body as { status: string }).status === "completed",
      );
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (const wait of [60_000, 240_000, 960_000, 3_840_000]) {
      await pr.alarm();
      const attempts = completions().length;
      now += wait - 1;
      await pr.alarm();
      expect(completions()).toHaveLength(attempts);
      now += 1;
    }
    expect(completions()).toHaveLength(4);
    expect(stored.get("superseded")).toEqual([
      expect.objectContaining({ generation: 1, completionFailures: 4 }),
    ]);
    await pr.alarm();
    expect(completions()).toHaveLength(5);
    expect(stored.get("superseded")).toEqual([]);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(completions()).toHaveLength(5);
  });

  it("gives up on a cancel that keeps failing and records it on the superseded check", async () => {
    const { pr, stored, storage, job, started } = fixture();
    const gh = github();
    await started();
    job.cancel.mockRejectedValue(new Error("destroy_failed: busy"));
    await pr.accept(PULL, "e2345678-1234-1234-1234-123456789abc", ORIGIN);
    for (let attempt = 1; attempt < 5; attempt += 1) await pr.alarm();
    expect(gh.checks()).toEqual([]);
    expect(stored.get("superseded")).toEqual([
      expect.objectContaining({ generation: 1, cancelFailures: 4 }),
    ]);
    await pr.alarm();
    expect(job.cancel).toHaveBeenCalledTimes(5);
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        output: {
          title: "Swarm review could not complete",
          summary: `${SUPERSEDED} Its cloud review could not be stopped after 5 attempts: destroy_failed: busy.`,
        },
      }),
    ]);
    expect(stored.get("superseded")).toEqual([]);
    storage.setAlarm.mockClear();
    await pr.alarm();
    expect(job.cancel).toHaveBeenCalledTimes(5);
  });
});

describe("superseded cloud review", () => {
  it("destroys the review's sandbox and ends its job with a superseded receipt", async () => {
    const stored = new Map<string, unknown>([
      [
        "review",
        {
          reviewId: "review-old",
          repository: "acme/demo",
          pr: 7,
          head: HEAD,
          base: MERGE_BASE,
          origin: "https://review.invalid",
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      ["state", "running"],
    ]);
    const r2 = new Map<string, unknown>();
    const storage = {
      get: vi.fn(async (key: string) => stored.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
      deleteAlarm: vi.fn(async () => undefined),
    };
    const destroy = vi.fn(async () => undefined);
    getSandbox.mockReturnValue({ destroy });
    const job = new ReviewJob({} as never, {} as never);
    Object.assign(job, {
      ctx: { storage },
      env: {
        REVIEW_SANDBOX: "sandboxes",
        PROBE_RESULTS: {
          get: vi.fn(async () => null),
          head: vi.fn(async (key: string) => (r2.has(key) ? {} : null)),
          put: vi.fn(async (key: string, body: string) => {
            r2.set(key, JSON.parse(body));
          }),
        },
      },
    });
    await job.cancel();
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(getSandbox).toHaveBeenCalledWith("sandboxes", "review-old");
    expect(destroy).toHaveBeenCalledOnce();
    expect(stored.get("state")).toBe("done");
    expect(r2.get("reviews/review-old/receipt.json")).toMatchObject({
      status: "failed",
      failure: { message: "superseded" },
    });
    await job.cancel();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

const checkRun = (overrides: Record<string, unknown> = {}) => ({
  action: "requested_action",
  requested_action: { identifier: "review" },
  check_run: {
    name: "swarm-review",
    head_sha: HEAD,
    pull_requests: [{ number: 7, head: { sha: HEAD }, base: { sha: BASE } }],
  },
  repository: { full_name: "acme/demo" },
  installation: { id: 42 },
  ...overrides,
});

const checkSuite = (overrides: Record<string, unknown> = {}) => ({
  action: "rerequested",
  check_suite: {
    head_sha: HEAD,
    app: { id: 123 },
    pull_requests: [{ number: 7, head: { sha: HEAD }, base: { sha: BASE } }],
  },
  repository: { full_name: "acme/demo" },
  installation: { id: 42 },
  ...overrides,
});

describe("Checks tab", () => {
  it("answers a push with a neutral check offering Review and starts no review", async () => {
    const { env, pr, stored, job, started } = fixture();
    const gh = github();
    await started();
    const generation = stored.get("current");
    gh.calls.length = 0;
    const response = await worker.fetch(
      await signed(
        JSON.stringify(
          event({
            action: "synchronize",
            pull_request: { ...event().pull_request, head: { sha: MOVED } },
          }),
        ),
        "webhook-secret",
        "62345678-1234-1234-1234-123456789abc",
      ),
      env as never,
    );
    expect(response.status).toBe(202);
    await pr.alarm();
    const offer = gh.sent().filter((call) => call.method === "POST");
    expect(offer.map((call) => call.url)).toEqual([`${API}/check-runs`]);
    const body = offer[0]!.body as { completed_at: string };
    expect(body).toEqual({
      name: "swarm-review",
      head_sha: MOVED,
      status: "completed",
      conclusion: "neutral",
      completed_at: body.completed_at,
      output: {
        title: "Swarm review not started",
        summary:
          "New commits do not start a review. Choose Review to review this head.",
      },
      actions: [
        {
          label: "Review",
          description: "Review this pull request head",
          identifier: "review",
        },
        {
          label: "Deep review",
          description: "Review again with the deepest models",
          identifier: "deep-review",
        },
      ],
    });
    expect(job.start).toHaveBeenCalledOnce();
    expect(job.cancel).not.toHaveBeenCalled();
    expect(stored.get("current")).toEqual(generation);
    expect(stored.get("offers")).toEqual([]);
  });

  it.each([
    ["requested_action", checkRun()],
    [
      "rerequested",
      checkRun({ action: "rerequested", requested_action: undefined }),
    ],
  ])(
    "starts one new generation on %s when the check's head is still the PR head",
    async (_name, payload) => {
      const { env, pr, stored, job, started } = fixture();
      const gh = github();
      await started();
      gh.calls.length = 0;
      const body = JSON.stringify(payload);
      const delivery = "72345678-1234-1234-1234-123456789abc";
      expect(
        await (
          await worker.fetch(
            await signed(body, "webhook-secret", delivery, "check_run"),
            env as never,
          )
        ).json(),
      ).toEqual({ accepted: true });
      expect(
        await (
          await worker.fetch(
            await signed(body, "webhook-secret", delivery, "check_run"),
            env as never,
          )
        ).json(),
      ).toEqual({ accepted: false });
      const pull = gh.sent()[0]!;
      expect(pull).toMatchObject({ method: "GET", url: `${API}/pulls/7` });
      expect(pull.headers.get("authorization")).toBe(
        "Bearer installation-token",
      );
      expect(stored.get("current")).toMatchObject({
        generation: 2,
        phase: "pending",
        event: {
          repository: "acme/demo",
          number: 7,
          head: HEAD,
          base: BASE,
          installationId: 42,
        },
      });
      await pr.alarm();
      expect(job.cancel).toHaveBeenCalledOnce();
      expect(job.start).toHaveBeenCalledTimes(2);
      expect(stored.get("current")).toMatchObject({
        generation: 2,
        phase: "running",
        checkRunId: 100,
      });
    },
  );

  it("runs Deep review as a new deep generation and says so on its check", async () => {
    const { env, pr, job, r2, started } = fixture();
    const gh = github();
    await started();
    const response = await worker.fetch(
      await signed(
        JSON.stringify(
          checkRun({ requested_action: { identifier: "deep-review" } }),
        ),
        "webhook-secret",
        "82345678-1234-1234-1234-123456789abc",
        "check_run",
      ),
      env as never,
    );
    expect(await response.json()).toEqual({ accepted: true });
    const before = Date.now();
    await pr.alarm();
    const [standard, deep] = job.start.mock.calls.map(
      ([review]) =>
        review as { deep?: boolean; deadlineAt: string; reviewId: string },
    );
    expect(standard).not.toHaveProperty("deep");
    expect(deep).toMatchObject({ deep: true });
    const deadline = Date.parse(deep!.deadlineAt);
    expect(deadline - before).toBeGreaterThanOrEqual(13 * 60_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(13 * 60_000);
    r2.set(`reviews/${deep!.reviewId}/receipt.json`, receipt);
    await pr.alarm();
    const actions = [
      {
        label: "Deep review",
        description: "Review again with the deepest models",
        identifier: "deep-review",
      },
    ];
    const note =
      "Deep review: each family's deepest model, with up to 13 minutes.";
    expect(gh.checks()).toEqual([
      expect.objectContaining({
        url: `${API}/check-runs/99`,
        conclusion: "neutral",
        actions,
        output: expect.objectContaining({
          summary: expect.not.stringContaining(note),
        }),
      }),
      expect.objectContaining({
        url: `${API}/check-runs/100`,
        conclusion: "success",
        actions,
        output: expect.objectContaining({
          summary: expect.stringContaining(note),
        }),
      }),
    ]);
  });

  it.each([
    ["another action", checkRun({ requested_action: { identifier: "other" } })],
    [
      "another check",
      checkRun({ check_run: { ...checkRun().check_run, name: "ci" } }),
    ],
  ])("ignores %s", async (_name, payload) => {
    const { env, storage } = fixture();
    const gh = github();
    const response = await worker.fetch(
      await signed(
        JSON.stringify(payload),
        "webhook-secret",
        undefined,
        "check_run",
      ),
      env as never,
    );
    expect(await response.json()).toEqual({ ignored: true });
    expect(gh.calls).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("ignores a re-run whose check is no longer on the PR head", async () => {
    const { env, storage } = fixture();
    github({ pullHead: MOVED });
    const response = await worker.fetch(
      await signed(
        JSON.stringify(checkRun()),
        "webhook-secret",
        undefined,
        "check_run",
      ),
      env as never,
    );
    expect(await response.json()).toEqual({
      ignored: true,
      reason: "head_moved",
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("starts one new generation when Re-run all checks asks for the App's suite", async () => {
    const { env, pr, stored, job, started } = fixture();
    const gh = github();
    await started();
    gh.calls.length = 0;
    const response = await worker.fetch(
      await signed(
        JSON.stringify(checkSuite()),
        "webhook-secret",
        "03345678-1234-1234-1234-123456789abc",
        "check_suite",
      ),
      env as never,
    );
    expect(await response.json()).toEqual({ accepted: true });
    const pull = gh.sent()[0]!;
    expect(pull).toMatchObject({
      method: "GET",
      url: `${API}/pulls/7`,
      body: null,
    });
    expect(pull.headers.get("authorization")).toBe("Bearer installation-token");
    await pr.alarm();
    expect(job.cancel).toHaveBeenCalledOnce();
    expect(job.start).toHaveBeenCalledTimes(2);
    expect(stored.get("current")).toMatchObject({
      generation: 2,
      phase: "running",
      checkRunId: 100,
      event: PULL,
    });
  });

  it("ignores a rerequested suite that belongs to another App", async () => {
    const { env, storage } = fixture();
    const gh = github();
    const response = await worker.fetch(
      await signed(
        JSON.stringify(
          checkSuite({
            check_suite: { ...checkSuite().check_suite, app: { id: 999 } },
          }),
        ),
        "webhook-secret",
        undefined,
        "check_suite",
      ),
      env as never,
    );
    expect(await response.json()).toEqual({ ignored: true });
    expect(gh.calls).toEqual([]);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it.each([
    ["check_run", checkRun()],
    ["check_suite", checkSuite()],
  ])(
    "refuses a %s re-run on a PR the opened path would not review",
    async (kind, payload) => {
      const { env, storage } = fixture();
      const gh = github({
        routes: {
          [`GET ${API}/pulls/7`]: () =>
            Response.json({
              state: "open",
              draft: true,
              author_association: "MEMBER",
              head: { sha: HEAD },
              base: { sha: BASE },
            }),
        },
      });
      const response = await worker.fetch(
        await signed(
          JSON.stringify(payload),
          "webhook-secret",
          undefined,
          kind,
        ),
        env as never,
      );
      expect(await response.json()).toEqual({
        ignored: true,
        reason: "not_reviewable",
      });
      expect(gh.sent().map((call) => `${call.method} ${call.url}`)).toEqual([
        `GET ${API}/pulls/7`,
      ]);
      expect(storage.put).not.toHaveBeenCalled();
    },
  );
});
