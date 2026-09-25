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
        .filter((call) => call.method === "PATCH")
        .map((call) => ({
          url: call.url,
          ...(call.body as { conclusion: string; output: object }),
        })),
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
    start: vi.fn(async () => undefined),
    isDone: vi.fn(async () => true),
    cancel: vi.fn(async () => undefined),
  };
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
  return { pr, env, stored, storage, r2, job, started };
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
    expect(calls).toHaveLength(3);
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
          summary: "Review could not complete: deadline.",
        },
      }),
    ]);
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
    expect(await response.json()).toEqual({ ignored: true });
    expect(storage.put).not.toHaveBeenCalled();
  });
});
