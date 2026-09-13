import { afterEach, describe, expect, it, vi } from "vitest";
import { gitCapability, proxyGitFetch } from "../git-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

const REPOSITORY = "https://github.com/acme/demo.git";

describe("read-only Git proxy", () => {
  it("rejects receive-pack before making an upstream request", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "push-attempt";
    const secret = "control-secret";
    const capability = await gitCapability(runId, secret);
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
    const capability = await gitCapability(runId, secret);

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
    const capability = await gitCapability(runId, secret);
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
});
