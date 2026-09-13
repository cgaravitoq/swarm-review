import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyModelTotals,
  modelCapability,
  modelProxyBaseUrl,
  modelsJsonForProxy,
  proxyModelFetch,
  publicModelUsage,
  reserveAttempt,
} from "../model-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model proxy", () => {
  it("rejects a capability that does not match the run", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-1";
    const secret = "control-secret";
    const url = new URL(
      `https://review.invalid/model/${runId}/deadbeef/chat/completions`,
    );

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      secret,
      async () => ({ ok: false, reason: "no_session" }),
      async () => undefined,
    );

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("injects the DO bearer and never forwards the handle", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "pong" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-2";
    const secret = "control-secret";
    const capability = await modelCapability(runId, secret);
    const url = new URL(
      `${modelProxyBaseUrl("https://review.invalid", runId, capability)}/chat/completions`,
    );
    const totals = emptyModelTotals();
    const recorded: { input: number; output: number }[] = [];

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "grok-4.6" }),
      }),
      url,
      secret,
      async () => {
        reserveAttempt(
          totals,
          {
            maxRequests: 8,
            maxRetriesPerRequest: 1,
            maxCumulativeInputTokens: 1000,
            maxCumulativeOutputTokens: 1000,
            maxRequestBytes: 1024,
          },
          false,
        );
        return {
          ok: true as const,
          session: {
            handle: "review-pi-handle",
            upstreamBaseUrl: "https://api.x.ai/v1",
            upstreamAuthorization: "Bearer real-secret",
            caps: {
              maxRequests: 8,
              maxRetriesPerRequest: 1,
              maxCumulativeInputTokens: 1000,
              maxCumulativeOutputTokens: 1000,
              maxRequestBytes: 1024,
            },
            totals,
          },
        };
      },
      async (_runId, usage) => {
        if (usage) recorded.push(usage);
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("pong");
    const [, init] = upstream.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer real-secret",
    );
    expect(new URL(String(upstream.mock.calls[0]?.[0])).href).toBe(
      "https://api.x.ai/v1/chat/completions",
    );
    expect(recorded).toEqual([{ input: 3, output: 1 }]);
  });

  it("refuses a handle that is not this run's", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-3";
    const secret = "control-secret";
    const capability = await modelCapability(runId, secret);
    const url = new URL(
      `${modelProxyBaseUrl("https://review.invalid", runId, capability)}/chat/completions`,
    );

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer guessed" },
        body: "{}",
      }),
      url,
      secret,
      async () => ({
        ok: true as const,
        session: {
          handle: "review-pi-handle",
          upstreamBaseUrl: "https://api.x.ai/v1",
          upstreamAuthorization: "Bearer real-secret",
          caps: {
            maxRequests: 8,
            maxRetriesPerRequest: 1,
            maxCumulativeInputTokens: 1000,
            maxCumulativeOutputTokens: 1000,
            maxRequestBytes: 1024,
          },
          totals: emptyModelTotals(),
        },
      }),
      async () => undefined,
    );

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the bearer out of models.json", () => {
    const json = modelsJsonForProxy(
      "{}",
      "xai",
      "review-pi-handle",
      "https://review.invalid/model/run/cap",
    );
    expect(json).toContain("review-pi-handle");
    expect(json).not.toContain("Bearer");
  });

  it("reports usage without the upstream credential", () => {
    const usage = publicModelUsage({
      handle: "review-pi-handle",
      upstreamBaseUrl: "https://api.x.ai/v1",
      upstreamAuthorization: "Bearer real-secret",
      caps: {
        maxRequests: 8,
        maxRetriesPerRequest: 1,
        maxCumulativeInputTokens: 1000,
        maxCumulativeOutputTokens: 1000,
        maxRequestBytes: 1024,
      },
      totals: { requests: 1, retries: 0, input: 4, output: 2 },
    });
    expect(JSON.stringify(usage)).not.toContain("real-secret");
    expect(usage).toMatchObject({
      handle: "review-pi-handle",
      totals: { requests: 1, input: 4, output: 2 },
    });
  });
});
