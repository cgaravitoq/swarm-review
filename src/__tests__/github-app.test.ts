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
const { default: worker, PullRequestReview } = await import("../../worker");

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
      "x-github-event": "pull_request",
    },
    body,
  });
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
    },
  };
  Object.assign(pr, { ctx: { storage }, env });
  return { pr, env, stored, storage, r2, job };
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
    ["action", { action: "synchronize" }],
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

  it("deduplicates redelivery, starts one review after response, and completes its check from the receipt", async () => {
    const { env, pr, stored, r2, job } = fixture();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        calls.push({ url: input, init });
        if (input.endsWith("/access_tokens"))
          return Response.json({
            token: "installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        if (input.endsWith("/check-runs")) return Response.json({ id: 99 });
        return Response.json({});
      }),
    );
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
    expect(state).toMatchObject({ checkRunId: 99, generation: 1 });
    expect(r2.get(`reviews/${state.reviewId}/git.json`)).toEqual({
      repository: "acme/demo",
      installationId: 42,
    });
    const token = calls[0]!;
    expect(token.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(token.init.method).toBe("POST");
    expect(JSON.parse(String(token.init.body))).toEqual({
      repositories: ["demo"],
      permissions: {
        contents: "read",
        checks: "write",
        pull_requests: "write",
      },
    });
    const jwt = new Headers(token.init.headers).get("authorization")!.slice(7);
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
    expect(create.url).toBe(
      "https://api.github.com/repos/acme/demo/check-runs",
    );
    expect(new Headers(create.init.headers).get("authorization")).toBe(
      "Bearer installation-token",
    );
    const createBody = JSON.parse(String(create.init.body));
    expect(createBody).toEqual({
      name: "swarm-review",
      head_sha: "a".repeat(40),
      status: "in_progress",
      started_at: createBody.started_at,
      output: {
        title: "Swarm review in progress",
        summary: "Reviewing the pull request head.",
      },
    });
    expect(Number.isFinite(Date.parse(createBody.started_at))).toBe(true);
    r2.set(`reviews/${state.reviewId}/receipt.json`, {
      status: "completed",
      findings: [{ id: 1, status: "confirmed" }],
    });
    await pr.alarm();
    const update = calls[2]!;
    expect(update.url).toBe(
      "https://api.github.com/repos/acme/demo/check-runs/99",
    );
    expect(update.init.method).toBe("PATCH");
    const updateBody = JSON.parse(String(update.init.body));
    expect(updateBody).toEqual({
      status: "completed",
      conclusion: "success",
      completed_at: updateBody.completed_at,
      output: {
        title: "Swarm review completed",
        summary: "Review completed. 1 confirmed finding(s).",
      },
    });
    expect(Number.isFinite(Date.parse(updateBody.completed_at))).toBe(true);
  });

  it("ends an unsuccessful review neutrally with the failure reason", async () => {
    const { env, pr, stored, r2 } = fixture();
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        calls.push(init);
        return input.endsWith("/access_tokens")
          ? Response.json({
              token: "installation-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            })
          : input.endsWith("/check-runs")
            ? Response.json({ id: 100 })
            : Response.json({});
      }),
    );
    await worker.fetch(await signed(JSON.stringify(event())), env as never);
    await pr.alarm();
    const reviewId = (stored.get("current") as { reviewId: string }).reviewId;
    r2.set(`reviews/${reviewId}/receipt.json`, {
      status: "failed",
      failure: { message: "deadline" },
    });
    await pr.alarm();
    expect(JSON.parse(String(calls.at(-1)?.body))).toMatchObject({
      conclusion: "neutral",
      output: { summary: "Review could not complete: deadline." },
    });
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
