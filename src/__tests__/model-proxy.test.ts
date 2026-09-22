import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyModelTotals,
  type ModelCaps,
  type ModelUsage,
  modelCapability,
  modelProxyBaseUrl,
  modelsJsonForProxy,
  proxyModelFetch,
  publicModelUsage,
  readUsage,
  reserveAttempt,
} from "../model-proxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A session whose caps the proxy reads, with the module's default 1024-byte cap. */
const capsFor = (overrides: Partial<ModelCaps> = {}): ModelCaps => ({
  maxRequests: 8,
  maxRetriesPerRequest: 1,
  maxCumulativeInputTokens: 1000,
  maxCumulativeOutputTokens: 1000,
  maxRequestBytes: 1024,
  ...overrides,
});

const sessionConsumer =
  (totals = emptyModelTotals(), caps = capsFor()) =>
  async () => ({
    ok: true as const,
    session: {
      handle: "review-pi-handle",
      upstreamBaseUrl: "https://api.x.ai/v1",
      upstreamAuthorization: "Bearer real-secret",
      caps,
      totals,
    },
  });

const sessionOpener =
  (caps = capsFor()) =>
  async () => ({ handle: "review-pi-handle", caps });

const proxyTarget = async (runId: string, secret = "control-secret") => {
  const capability = await modelCapability(runId, secret);
  return new URL(
    `${modelProxyBaseUrl("https://review.invalid", runId, capability)}/chat/completions`,
  );
};

describe("model proxy", () => {
  it("counts the cached halves of an Anthropic prompt as input, not as nothing", () => {
    // Anthropic opens with the input and closes with the output, and reports the
    // cached halves of the prompt beside `input_tokens` rather than inside it.
    // Replacing one reading with the other, or counting only `input_tokens`,
    // would let a cached review run against the token caps for free.
    const claudeCode = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":3894,"output_tokens":1}}}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}',
    ].join("\n");

    expect(readUsage(claudeCode)).toEqual({ input: 3996, output: 7 });
    // OpenAI-style usage already folds cache reads into `prompt_tokens`, so the
    // same body must not be counted twice.
    expect(
      readUsage('data: {"usage":{"prompt_tokens":30,"completion_tokens":4}}'),
    ).toEqual({ input: 30, output: 4 });
  });

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
      async () => null,
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
    const recorded: ModelUsage[] = [];

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
      sessionOpener(),
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
      sessionOpener(),
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

  it("refuses a body whose declared length is over the session's byte cap", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const url = await proxyTarget("run-declared-length");

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "content-type": "application/json",
          "content-length": "2048",
        },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async () => undefined,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { type: "review_pi_model", reason: "max_request_bytes" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("counts the bytes of a body whose length the request does not declare", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("unexpected")),
    );
    vi.stubGlobal("fetch", upstream);
    const url = await proxyTarget("run-counted-length");
    const oversize = (declared?: string) =>
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "content-type": "application/json",
          ...(declared ? { "content-length": declared } : {}),
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2048));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);

    const undeclared = await proxyModelFetch(
      oversize(),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async () => undefined,
    );
    expect(undeclared.status).toBe(413);

    // A container that understates its own length is still counted: the
    // declared value is a hint from the side of the boundary that is untrusted.
    const understated = await proxyModelFetch(
      oversize("2"),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async () => undefined,
    );
    expect(understated.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("measures a body against the cap its own session carries", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", upstream);
    const url = await proxyTarget("run-session-cap");
    const caps = capsFor({ maxRequestBytes: 8 });
    const send = (body: string) =>
      proxyModelFetch(
        new Request(url, {
          method: "POST",
          headers: { authorization: "Bearer review-pi-handle" },
          body,
        }),
        url,
        "control-secret",
        sessionOpener(caps),
        sessionConsumer(emptyModelTotals(), caps),
        async () => undefined,
      );

    expect((await send("x".repeat(8))).status).toBe(200);
    expect((await send("x".repeat(9))).status).toBe(413);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["GET", "HEAD"])(
    "forwards a %s, which carries no body, instead of refusing it",
    async (method) => {
      const upstream = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(null, { status: 200 })),
      );
      vi.stubGlobal("fetch", upstream);
      const url = await proxyTarget(`run-${method.toLowerCase()}`);

      const response = await proxyModelFetch(
        new Request(url, {
          method,
          headers: { authorization: "Bearer review-pi-handle" },
        }),
        url,
        "control-secret",
        sessionOpener(),
        sessionConsumer(),
        async () => undefined,
      );

      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledOnce();
      const [, init] = upstream.mock.calls[0] ?? [];
      expect(init).toMatchObject({ method, body: null });
    },
  );

  it("leaves the input of a usage frame the body never carried unobserved", () => {
    // Anthropic reports the input on the frame it opens with and the output on
    // the one it closes with. A reading that answers zero for the half it never
    // saw prices an unobserved request as a request that spent nothing.
    expect(readUsage('data: {"usage":{"output_tokens":7}}')).toEqual({
      input: null,
      output: 7,
    });
    expect(readUsage('data: {"usage":{"input_tokens":11}}')).toEqual({
      input: 11,
      output: null,
    });
    expect(readUsage("data: [DONE]")).toBeNull();
  });

  it("records the input as unobserved once the tail no longer carries it", async () => {
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":1}}}',
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${"x".repeat(70_000)}"}}`,
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}',
    ].join("\n\n");
    expect(body.length).toBeGreaterThan(65_536);
    const bytes = new TextEncoder().encode(body);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      ),
    );
    const url = await proxyTarget("run-long-answer");
    const recorded: (ModelUsage | null)[] = [];

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async (_runId, usage) => {
        recorded.push(usage);
      },
    );

    expect(await response.text()).toHaveLength(bytes.byteLength);
    expect(recorded).toEqual([{ input: null, output: 42 }]);
  });

  it("seals the answer text it streamed", async () => {
    const body = [
      'data: {"type":"message_start","message":{"content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha one"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" more"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      "data: [DONE]",
    ].join("\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );
    const url = await proxyTarget("run-seal");
    const seals: (string | null)[] = [];

    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async (_runId, _usage, _retryable, seal) => {
        seals.push(seal);
      },
    );
    await response.text();

    const expected = createHash("sha256")
      .update("alpha one more", "utf8")
      .digest("hex");
    expect(seals).toEqual([expected]);
  });

  it("bounds a retried attempt by the request budget alone", () => {
    // The client repeats a failed request itself, so a retry is one more
    // request against `maxRequests`. A cumulative retry cap would sit behind
    // that budget for any `maxRetriesPerRequest` of one or more, and at zero
    // it would refuse the first attempt of every run.
    const caps = capsFor({ maxRequests: 8, maxRetriesPerRequest: 0 });
    const totals = emptyModelTotals();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(reserveAttempt(totals, caps, attempt > 0)).toBeNull();
    }
    expect(totals).toMatchObject({ requests: 8, retries: 7 });
    expect(reserveAttempt(totals, caps, true)).toBe("max_requests");
  });
});
