import { afterEach, describe, expect, it, vi } from "vitest";
import { gitCapability, proxyGitFetch } from "../git-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

const REPOSITORY = "https://github.com/acme/demo.git";

describe("read-only Git proxy", () => {
  it("refuses a capability minted for another repository before fetching", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "review-one";
    const capability = await gitCapability(
      runId,
      "control-secret",
      "acme/other",
    );
    const url = new URL(
      `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
    );
    const response = await proxyGitFetch(
      new Request(url, { headers: { "x-review-run": runId } }),
      url,
      "control-secret",
      "installation-token",
      REPOSITORY,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects receive-pack before making an upstream request", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "push-attempt";
    const secret = "control-secret";
    const capability = await gitCapability(runId, secret, "acme/demo");
    const url = new URL(
      `https://review.invalid/git/${capability}/git-receive-pack`,
    );

    const response = await proxyGitFetch(
      new Request(url, {
        method: "POST",
        headers: { "x-review-run": runId },
        body: "push request",
      }),
      url,
      secret,
      "github-token",
      REPOSITORY,
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("authenticates GitHub Smart HTTP with the token as a Basic password", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-1";
    const secret = "control-secret";
    const capability = await gitCapability(runId, secret, "acme/demo");

    await proxyGitFetch(
      new Request(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
        { headers: { "x-review-run": runId } },
      ),
      new URL(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
      ),
      secret,
      "github-token",
      REPOSITORY,
    );

    const [target, init] = upstream.mock.calls[0] ?? [];
    expect(String(target)).toBe(
      `${REPOSITORY}/info/refs?service=git-upload-pack`,
    );
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    expect(authorization.startsWith("Basic ")).toBe(true);
    expect(atob(authorization.slice(6))).toBe("x-access-token:github-token");
  });

  it("preserves Git transport encoding on upload-pack requests", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-2";
    const secret = "control-secret";
    const capability = await gitCapability(runId, secret, "acme/demo");
    const url = new URL(
      `https://review.invalid/git/${capability}/git-upload-pack`,
    );

    await proxyGitFetch(
      new Request(url, {
        method: "POST",
        headers: {
          "x-review-run": runId,
          "content-type": "application/x-git-upload-pack-request",
          "content-encoding": "gzip",
          "git-protocol": "version=2",
        },
        body: "compressed request",
      }),
      url,
      secret,
      "github-token",
      REPOSITORY,
    );

    const [target, init] = upstream.mock.calls[0] ?? [];
    expect(String(target)).toBe(`${REPOSITORY}/git-upload-pack`);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(headers.get("git-protocol")).toBe("version=2");
  });

  // GitHub's edge answers some Cloudflare egress addresses with this page
  // before it reads the credential; the next request can leave from another.
  const edgeRateLimit = () =>
    new Response("<title>Rate limit &middot; GitHub</title>", {
      status: 429,
      headers: { "content-type": "text/html", "retry-after": "300" },
    });

  const uploadPack = async (runId: string) => {
    const secret = "control-secret";
    const capability = await gitCapability(runId, secret, "acme/demo");
    const url = new URL(
      `https://review.invalid/git/${capability}/git-upload-pack`,
    );
    return proxyGitFetch(
      new Request(url, {
        method: "POST",
        headers: {
          "x-review-run": runId,
          "content-type": "application/x-git-upload-pack-request",
        },
        body: "0032want 0123456789abcdef0123456789abcdef01234567\n",
      }),
      url,
      secret,
      "github-token",
      REPOSITORY,
    );
  };

  it("retries an upload-pack GitHub's edge rate-limited with the same request", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(edgeRateLimit())
      .mockResolvedValueOnce(new Response("pack"));
    vi.stubGlobal("fetch", upstream);

    const response = await uploadPack("run-3");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pack");
    expect(upstream).toHaveBeenCalledTimes(2);
    const sent = await Promise.all(
      upstream.mock.calls.map(async ([target, init]) => ({
        target: String(target),
        authorization: new Headers(init?.headers).get("authorization"),
        body: await new Response(init?.body).text(),
      })),
    );
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toBe(
      "0032want 0123456789abcdef0123456789abcdef01234567\n",
    );
  });

  it("hands git GitHub's rate limit once every attempt was refused", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(edgeRateLimit()),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await uploadPack("run-4");

    expect(response.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(5);
  });
});
