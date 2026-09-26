import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSE_TAIL_CHARS,
  WORKER_SSE_LINE_CHARS,
} from "../../container/response-seal";
import { createCodexRelayHandler } from "../../relay/server";
import {
  CODEX_RELAY_ID,
  CODEX_RELAY_PORT,
  CODEX_UPSTREAM,
  createCodexRelayTransport,
} from "../codex-relay";
import {
  emptyModelTotals,
  type ModelCaps,
  type ModelUsage,
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
  async () => ({
    handle: "review-pi-handle",
    caps,
    upstreamBaseUrl: "https://api.x.ai/v1",
  });

const proxyTarget = async (runId: string, secret = "control-secret") => {
  const capability = await modelCapability(runId, secret);
  return new URL(
    `${modelProxyBaseUrl("https://review.invalid", runId, capability)}/chat/completions`,
  );
};

describe("model proxy", () => {
  it("records the relay's GET refusal and the streamed POST's status when Pi cancels", async () => {
    const runId = "codex-cancel-run";
    const capability = await modelCapability(runId, "control-secret");
    const url = new URL(
      `https://review.invalid/model/${runId}/${capability}/codex/responses`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.output_text.delta","output_index":0,"delta":"pong"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
          ),
        );
      },
    });
    const containerFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer fake-upstream",
      );
      expect(await new Response(init.body).text()).toBe('{"input":"hello"}');
      return new Response(body, { status: 200 });
    });
    const process = {
      id: "relay",
      status: "running",
      command: "/usr/local/bun/bin/bun /opt/relay/server.ts",
      waitForPort: async () => undefined,
    };
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      () => ({
        listProcesses: async () => [process],
        getProcess: async () => process,
        startProcess: async () => process,
        containerFetch,
      }),
    );
    const recorded = vi.fn(async () => undefined);
    const observed = vi.fn(async () => undefined);
    const request = (method: "GET" | "POST") =>
      new Request(url, {
        method,
        headers: { authorization: "Bearer review-pi-handle" },
        ...(method === "POST" && { body: '{"input":"hello"}' }),
      });
    const proxy = (method: "GET" | "POST") =>
      proxyModelFetch(
        request(method),
        url,
        "control-secret",
        async () => ({
          handle: "review-pi-handle",
          caps: capsFor(),
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
        }),
        async () => ({
          ok: true as const,
          session: {
            handle: "review-pi-handle",
            upstreamBaseUrl: "https://chatgpt.com/backend-api",
            credentialProvider: "openai-codex",
            caps: capsFor(),
            totals: emptyModelTotals(),
          },
        }),
        recorded,
        async () => ({ authorization: "Bearer fake-upstream" }),
        relay,
        observed,
      );
    const refused = await proxy("GET");
    expect(refused.status).toBe(404);
    expect(recorded).toHaveBeenCalledWith(
      runId,
      null,
      false,
      null,
      "review-pi-handle",
      { httpStatus: null, reason: "codex_relay_non_post" },
    );
    const answer = await proxy("POST");
    expect(answer.status).toBe(200);
    expect(observed).toHaveBeenLastCalledWith(runId, "review-pi-handle", {
      httpStatus: 200,
      reason: null,
    });
    const reader = answer.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
      "response.completed",
    );
    await reader?.cancel();
    expect(recorded).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveBeenLastCalledWith(
      runId,
      { input: 4, output: 2 },
      false,
      createHash("sha256").update("pong").digest("hex"),
      "review-pi-handle",
      { httpStatus: 200, reason: null },
    );
    expect(containerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cancel after response.completed",
      stopAfterFirst: true,
      firstIsTerminal: true,
    },
    {
      name: "cancel before response.completed",
      stopAfterFirst: true,
      firstIsTerminal: false,
    },
    {
      name: "read through response.completed",
      stopAfterFirst: false,
      firstIsTerminal: false,
    },
  ])(
    "records a Codex stream when readers $name",
    async ({ stopAfterFirst, firstIsTerminal }) => {
      const runId = "codex-terminal-run";
      const capability = await modelCapability(runId, "control-secret");
      const url = new URL(
        `https://review.invalid/model/${runId}/${capability}/codex/responses`,
      );
      const delta =
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"pong"}\n\n';
      const terminal =
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
      const frames = firstIsTerminal ? [delta + terminal] : [delta, terminal];
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe("https://api.x.ai/v1/codex/responses");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer real-secret",
        );
        expect(await new Response(init?.body).text()).toBe("{}");
        let index = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const frame = frames[index++];
              if (frame === undefined) controller.close();
              else controller.enqueue(new TextEncoder().encode(frame));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", upstream);
      const recorded = vi.fn(async () => undefined);
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
        recorded,
      );
      if (stopAfterFirst) {
        const reader = response.body?.getReader();
        expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
          frames[0],
        );
        await reader?.cancel();
      } else {
        expect(await response.text()).toBe(delta + terminal);
      }
      expect(recorded).toHaveBeenCalledOnce();
      expect(recorded).toHaveBeenCalledWith(
        runId,
        stopAfterFirst && !firstIsTerminal
          ? { input: null, output: null }
          : { input: 4, output: 2 },
        false,
        stopAfterFirst && !firstIsTerminal
          ? null
          : createHash("sha256").update("pong").digest("hex"),
        "review-pi-handle",
        { httpStatus: 200, reason: null },
      );
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "Anthropic message_stop",
      body: `${[
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
        'data: {"type":"message_delta","usage":{"input_tokens":4,"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ].join("\n\n")}\n\n`,
      complete: true,
    },
    {
      name: "Anthropic message_delta before message_stop",
      body: `${[
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
        'data: {"type":"message_delta","usage":{"input_tokens":4,"output_tokens":2}}',
      ].join("\n\n")}\n\n`,
      complete: false,
    },
    {
      name: "chat [DONE]",
      body: `${[
        'data: {"choices":[{"delta":{"content":"pong"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
        "data: [DONE]",
      ].join("\n\n")}\n\n`,
      complete: true,
    },
  ])("records a stream cancelled after $name", async ({ body, complete }) => {
    const url = await proxyTarget("other-terminal-run");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe("https://api.x.ai/v1/chat/completions");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer real-secret",
        );
        expect(await new Response(init?.body).text()).toBe("{}");
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const recorded = vi.fn(async () => undefined);
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
      recorded,
    );
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(body);
    await reader?.cancel();
    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith(
      "other-terminal-run",
      complete ? { input: 4, output: 2 } : { input: null, output: null },
      false,
      complete ? createHash("sha256").update("pong").digest("hex") : null,
      "review-pi-handle",
      { httpStatus: 200, reason: null },
    );
  });

  it("observes a streamed response's status before its normal end and records it once", async () => {
    const url = await proxyTarget("complete-stream-run");
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      expect(String(_input)).toBe("https://api.x.ai/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer real-secret",
      );
      expect(await new Response(init?.body).text()).toBe("{}");
      return new Response(
        'data: {"choices":[{"delta":{"content":"pong"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const recorded = vi.fn(async () => undefined);
    const observed = vi.fn(async () => undefined);
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
      recorded,
      undefined,
      undefined,
      observed,
    );
    expect(observed).toHaveBeenCalledWith(
      "complete-stream-run",
      "review-pi-handle",
      { httpStatus: 200, reason: null },
    );
    expect(await response.text()).toContain("pong");
    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith(
      "complete-stream-run",
      { input: 3, output: 1 },
      false,
      createHash("sha256").update("pong").digest("hex"),
      "review-pi-handle",
      { httpStatus: 200, reason: null },
    );
  });

  it("routes Codex through the relay with the exact request and refreshes a 401", async () => {
    const runId = "relay-run";
    const capability = await modelCapability(runId, "control-secret");
    const url = new URL(
      `https://review.invalid/model/${runId}/${capability}/codex/responses`,
    );
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(CODEX_UPSTREAM);
      expect(init?.method).toBe("POST");
      expect(await new Response(init?.body).text()).toBe('{"input":"hello"}');
      return new Headers(init?.headers).get("authorization") ===
        "Bearer fake-old"
        ? new Response("denied", { status: 401 })
        : new Response("done", { status: 200 });
    });
    const handler = createCodexRelayHandler(upstream);
    const containerFetch = vi.fn(async (input: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("cf-relay-hop", "runtime-added");
      return handler(new Request(input, { ...init, headers }));
    });
    const process = {
      id: "relay-process",
      status: "running",
      command: "/usr/local/bun/bin/bun /opt/relay/server.ts",
      waitForPort: vi.fn(async () => undefined),
    };
    const sandbox = {
      listProcesses: vi.fn(async () => []),
      getProcess: vi.fn(async () => process),
      startProcess: vi.fn(async () => process),
      containerFetch,
    };
    const factory = vi.fn(() => sandbox);
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      factory,
    );
    const direct = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", direct);
    const credential = vi.fn(async (_provider: string, rejected?: string) => ({
      authorization: rejected ? "Bearer fake-new" : "Bearer fake-old",
      accountId: "fake-account",
    }));
    const recorded = vi.fn(async () => undefined);
    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "chatgpt-account-id": "review-pi",
          "content-type": "application/json",
          accept: "text/event-stream",
          "openai-beta": "responses=experimental",
          originator: "pi",
          "session-id": "fake-session",
          "user-agent": "pi-test",
          "cf-connecting-ip": "192.0.2.1",
          "cf-visitor": '{"scheme":"https"}',
          "cf-worker": "review.invalid",
          "cf-ew-via": "15",
        },
        body: '{"input":"hello"}',
      }),
      url,
      "control-secret",
      async () => ({
        handle: "review-pi-handle",
        caps: capsFor(),
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
      }),
      async () => ({
        ok: true as const,
        session: {
          handle: "review-pi-handle",
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          credentialProvider: "openai-codex",
          caps: capsFor(),
          totals: emptyModelTotals(),
        },
      }),
      recorded,
      credential,
      relay,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
    expect(upstream).toHaveBeenCalledTimes(2);
    for (const [index, call] of upstream.mock.calls.entries()) {
      expect(Object.fromEntries(new Headers(call[1]?.headers))).toEqual({
        accept: "text/event-stream",
        authorization: index === 0 ? "Bearer fake-old" : "Bearer fake-new",
        "chatgpt-account-id": "fake-account",
        "content-type": "application/json",
        "openai-beta": "responses=experimental",
        originator: "pi",
        "session-id": "fake-session",
        "user-agent": "pi-test",
      });
    }
    expect(credential).toHaveBeenLastCalledWith("openai-codex", "fake-old");
    expect(factory).toHaveBeenCalledWith({}, CODEX_RELAY_ID);
    expect(sandbox.startProcess).toHaveBeenCalledTimes(2);
    expect(process.waitForPort).toHaveBeenCalledWith(CODEX_RELAY_PORT, {
      mode: "tcp",
      timeout: expect.any(Number),
    });
    expect(containerFetch.mock.calls[0]?.[0]).toBe(
      "http://codex-relay/codex/responses",
    );
    expect(direct).not.toHaveBeenCalled();
    expect(recorded).toHaveBeenCalledTimes(1);
  });

  it("converges concurrent cold attempts on the one relay that binds", async () => {
    const command = "/usr/local/bun/bin/bun /opt/relay/server.ts";
    type FakeProcess = {
      id: string;
      status: string;
      command: string;
      waitForPort: () => Promise<void>;
    };
    const processes: FakeProcess[] = [];
    let bound: string | undefined;
    const sandbox = {
      listProcesses: vi.fn(async () => [...processes]),
      getProcess: vi.fn(
        async (id: string) => processes.find((p) => p.id === id) ?? null,
      ),
      startProcess: vi.fn(async (started: string) => {
        const process: FakeProcess = {
          id: `relay-${processes.length}`,
          status: "running",
          command: started,
          waitForPort: async () => {
            await Promise.resolve();
            bound ??= process.id;
            if (bound !== process.id) {
              process.status = "failed";
              throw new Error("process exited before ready");
            }
          },
        };
        processes.push(process);
        return process;
      }),
      containerFetch: vi.fn(async () => new Response("done")),
    };
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      () => sandbox,
    );
    const responses = await Promise.all(
      [1, 2, 3].map(() => relay(CODEX_UPSTREAM, { method: "POST" })),
    );
    expect(sandbox.startProcess.mock.calls.length).toBeGreaterThan(1);
    expect(sandbox.startProcess).toHaveBeenCalledWith(command);
    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["done", "done", "done"]);
    expect(
      processes.filter((process) => process.status === "running"),
    ).toHaveLength(1);
    expect(sandbox.containerFetch).toHaveBeenCalledTimes(3);
  });

  it("reuses a warm relay without starting another", async () => {
    const process = {
      id: "relay-process",
      status: "running",
      command: "/usr/local/bun/bin/bun /opt/relay/server.ts",
      waitForPort: vi.fn(async () => undefined),
    };
    const sandbox = {
      listProcesses: vi.fn(async () => [process]),
      getProcess: vi.fn(async () => process),
      startProcess: vi.fn(async () => process),
      containerFetch: vi.fn(async () => new Response("done")),
    };
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      () => sandbox,
    );
    const response = await relay(CODEX_UPSTREAM, { method: "POST" });
    expect(await response.text()).toBe("done");
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(sandbox.getProcess).toHaveBeenCalledWith("relay-process");
    expect(process.waitForPort).toHaveBeenCalledTimes(1);
  });

  const codexProxy = async (
    relay: typeof fetch | undefined,
    credentialProvider?: "openai-codex",
  ) => {
    const runId = "relay-failure-run";
    const capability = await modelCapability(runId, "control-secret");
    const url = new URL(
      `https://review.invalid/model/${runId}/${capability}/codex/responses`,
    );
    const recorded = vi.fn(async () => undefined);
    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      "control-secret",
      async () => ({
        handle: "review-pi-handle",
        caps: capsFor(),
        upstreamBaseUrl: "https://chatgpt.com/backend-api",
      }),
      async () => ({
        ok: true as const,
        session: {
          handle: "review-pi-handle",
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          upstreamAuthorization: "Bearer fake-carried",
          ...(credentialProvider && { credentialProvider }),
          caps: capsFor(),
          totals: emptyModelTotals(),
        },
      }),
      recorded,
      async () => ({ authorization: "Bearer fake-vault" }),
      relay,
    );
    return { response, recorded, runId };
  };

  it("bounds the wait for a relay that never opens its port", async () => {
    const process = {
      id: "relay-process",
      status: "running",
      command: "/usr/local/bun/bin/bun /opt/relay/server.ts",
      waitForPort: vi.fn(
        (_port: number, options: { timeout?: number }) =>
          new Promise<void>((_resolve, reject) => {
            if (options.timeout !== undefined) {
              reject(new Error("process ready timeout"));
            }
          }),
      ),
    };
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      () => ({
        listProcesses: async () => [],
        getProcess: async () => process,
        startProcess: async () => process,
        containerFetch: async () => new Response("unreachable"),
      }),
    );
    const { response, recorded, runId } = await codexProxy(relay);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: "review_pi_model", reason: "codex_relay_failed" },
    });
    expect(recorded).toHaveBeenCalledWith(
      runId,
      null,
      true,
      null,
      "review-pi-handle",
      { httpStatus: 502, reason: "codex_relay_failed" },
    );
  });

  it("names the relay in every relay failure, vault or carried bearer", async () => {
    const failing = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      () => ({
        listProcesses: async () => [],
        getProcess: async () => null,
        startProcess: async () => {
          throw new Error("container unavailable");
        },
        containerFetch: async () => new Response("unreachable"),
      }),
    );
    for (const provider of ["openai-codex", undefined] as const) {
      for (const [relay, reason] of [
        [failing, "codex_relay_failed"],
        [undefined, "codex_relay_unconfigured"],
      ] as const) {
        const { response, recorded, runId } = await codexProxy(relay, provider);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
          error: { type: "review_pi_model", reason },
        });
        expect(recorded).toHaveBeenCalledWith(
          runId,
          null,
          true,
          null,
          "review-pi-handle",
          { httpStatus: 502, reason },
        );
      }
    }
  });

  it("answers an upstream throw inside the relay as the relay's own 502", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await createCodexRelayHandler(async () => {
      throw new Error("upstream reset with Bearer fake-token");
    })(
      new Request("http://relay/codex/responses", {
        method: "POST",
        headers: { authorization: "Bearer fake-token" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: "codex_relay", reason: "upstream_failed" },
    });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });

  it("drops the encoding headers of a body the relay's fetch already decoded", async () => {
    const response = await createCodexRelayHandler(
      async () =>
        new Response("decoded answer", {
          headers: {
            "content-encoding": "gzip",
            "content-length": "3",
            "content-type": "text/event-stream",
          },
        }),
    )(
      new Request("http://relay/codex/responses", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("decoded answer");
  });

  it("leaves other upstreams on the direct fetch path", async () => {
    const url = await proxyTarget("direct-run");
    const direct = vi.fn<typeof fetch>(async () => new Response("direct"));
    const relay = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", direct);
    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "cf-worker": "review.invalid",
        },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      sessionConsumer(),
      async () => undefined,
      undefined,
      relay,
    );
    expect(await response.text()).toBe("direct");
    expect(direct).toHaveBeenCalledTimes(1);
    expect(String(direct.mock.calls[0]?.[0])).toBe(
      "https://api.x.ai/v1/chat/completions",
    );
    expect(
      new Headers(direct.mock.calls[0]?.[1]?.headers).get("cf-worker"),
    ).toBe("review.invalid");
    expect(relay).not.toHaveBeenCalled();
  });

  it("refuses every other relay method, path and caller-selected target", async () => {
    const upstream = vi.fn<typeof fetch>();
    const handler = createCodexRelayHandler(upstream);
    for (const request of [
      new Request("http://relay/codex/responses", { method: "GET" }),
      new Request("http://relay/other", { method: "POST" }),
      new Request("http://relay/codex/responses?target=evil", {
        method: "POST",
      }),
      new Request("http://relay/codex/responses", {
        method: "POST",
        headers: { "x-orb-upstream-url": "https://evil.invalid" },
      }),
    ]) {
      expect((await handler(request)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses another upstream before opening the relay sandbox", async () => {
    const factory = vi.fn(() => {
      throw new Error("unexpected relay sandbox");
    });
    const relay = createCodexRelayTransport(
      {} as Parameters<typeof createCodexRelayTransport>[0],
      factory,
    );
    expect(
      (
        await relay("https://evil.invalid/backend-api/codex/responses", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      (await relay("https://chatgpt.com/backend-api/other", { method: "POST" }))
        .status,
    ).toBe(404);
    expect(factory).not.toHaveBeenCalled();
  });

  it("streams the relay response before the upstream stream ends", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fake-token",
      );
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await createCodexRelayHandler(upstream)(
      new Request("http://relay/codex/responses", {
        method: "POST",
        headers: { authorization: "Bearer fake-token" },
        body: "{}",
      }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    controller?.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      "first",
    );
    controller?.enqueue(new TextEncoder().encode("second"));
    controller?.close();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
      "second",
    );
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
  it("refreshes and retries a vault-backed 401 once without exposing tokens", async () => {
    const runId = "vault-run";
    const url = await proxyTarget(runId);
    const upstream = vi.fn<typeof fetch>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer fake-old"
        ? new Response("rejected", { status: 401 })
        : new Response("complete", { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);
    const credential = vi.fn(async (_provider: string, rejected?: string) =>
      rejected
        ? { authorization: "Bearer fake-new", accountId: "fake-account" }
        : { authorization: "Bearer fake-old", accountId: "fake-account" },
    );
    const recorded = vi.fn(async () => undefined);
    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      async () => ({
        ok: true as const,
        session: {
          handle: "review-pi-handle",
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          credentialProvider: "openai-codex",
          caps: capsFor(),
          totals: emptyModelTotals(),
        },
      }),
      recorded,
      credential,
    );
    expect(response.status).toBe(200);
    const result = await response.text();
    expect(result).toBe("complete");
    expect(credential).toHaveBeenCalledTimes(2);
    expect(credential).toHaveBeenLastCalledWith("openai-codex", "fake-old");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(
      new Headers(upstream.mock.calls[1]?.[1]?.headers).get(
        "chatgpt-account-id",
      ),
    ).toBe("fake-account");
    expect(result).not.toContain("fake-new");
  });

  it("stops after one vault-backed 401 retry", async () => {
    const runId = "vault-denied";
    const url = await proxyTarget(runId);
    const upstream = vi.fn<typeof fetch>(
      async () => new Response("fake-secret", { status: 401 }),
    );
    vi.stubGlobal("fetch", upstream);
    const credential = vi.fn(async () => ({
      authorization: "Bearer fake-secret",
    }));
    const response = await proxyModelFetch(
      new Request(url, {
        method: "POST",
        headers: { authorization: "Bearer review-pi-handle" },
        body: "{}",
      }),
      url,
      "control-secret",
      sessionOpener(),
      async () => ({
        ok: true as const,
        session: {
          handle: "review-pi-handle",
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          credentialProvider: "openai-codex",
          caps: capsFor(),
          totals: emptyModelTotals(),
        },
      }),
      async () => undefined,
      credential,
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(credential).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("fake-secret");
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
      totals: { requests: 1, retries: 0, input: 4, output: 2, unended: 0 },
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

  it("reads the input a long answer reported on the frame it opened with", async () => {
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
    expect(recorded).toEqual([{ input: 1200, output: 42 }]);
  });

  it("records a partial usage as unobserved when the reader cancels before the closing frame", async () => {
    const opening = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
    ]
      .map((frame) => `${frame}\n\n`)
      .join("");
    const closing = [
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]
      .map((frame) => `${frame}\n\n`)
      .join("");
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.x.ai/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer real-secret",
      );
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const frames = [opening, closing];
            const next = frames[sent];
            sent += 1;
            if (next === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(next));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const url = await proxyTarget("run-partial-usage");
    const recorded: (ModelUsage | null)[] = [];
    const proxy = () =>
      proxyModelFetch(
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

    const cancelled = (await proxy()).body?.getReader();
    expect(new TextDecoder().decode((await cancelled?.read())?.value)).toBe(
      opening,
    );
    await cancelled?.cancel();
    await (await proxy()).text();

    expect(recorded).toEqual([
      { input: null, output: null },
      { input: 10, output: 500 },
    ]);
  });

  it("marks the attempt after a 200 stream that ended before its terminal event as a retry", async () => {
    // Captured from Workers AI's chat completions endpoint for DeepSeek V4
    // Flash; its last line is the `data: [DONE]` a complete stream ends with.
    const captured = readFileSync(
      fileURLToPath(new URL("workers-ai-stream.sse", import.meta.url)),
      "utf8",
    );
    const cut = captured.slice(0, captured.lastIndexOf("data: {"));
    const retryableAfter = async (body: string, cancel = false) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
        ),
      );
      const url = await proxyTarget("early-end-run");
      const retryable: boolean[] = [];
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
        async (_runId, _usage, marked) => {
          retryable.push(marked);
        },
      );
      if (cancel) await response.body?.cancel();
      else await response.text();
      return retryable;
    };

    expect(captured.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(await retryableAfter(captured)).toEqual([false]);
    expect(await retryableAfter(cut)).toEqual([true]);
    expect(await retryableAfter(captured, true)).toEqual([false]);
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

  it("seals a stream far past its tail, but no JSON body it only kept the tail of", async () => {
    const pieces = Array.from({ length: 64 }, () =>
      "x".repeat(RESPONSE_TAIL_CHARS / 16),
    );
    const long = pieces.join("");
    const bodies = [
      pieces
        .map(
          (content) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
        )
        .join("\n\n"),
      JSON.stringify({ choices: [{ message: { content: long } }] }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(bodies.shift() ?? "", { status: 200 })),
      ),
    );
    const url = await proxyTarget("run-seal-bound");
    const seals: (string | null)[] = [];

    for (let call = 0; call < 2; call += 1) {
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
    }

    expect(seals).toEqual([
      createHash("sha256").update(long, "utf8").digest("hex"),
      null,
    ]);
  });

  it("holds a line to the Worker hop's own bound, never the container's", async () => {
    // This proxy is the only hop a cloud lane's model bytes cross, and the
    // bound it can hold is the isolate's. The container's larger bound belongs
    // to the broker, which runs beside the lane's own memory; taking it here
    // would hold a line this isolate cannot read and seal over a guess.
    const head =
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":1},"choices":[{"delta":{"content":"';
    const tail = '"}}]}';
    const lineOf = (chars: number) => {
      const answer = "x".repeat(chars - head.length - tail.length);
      return { answer, frame: `${head}${answer}${tail}\n\n` };
    };
    const atBound = lineOf(WORKER_SSE_LINE_CHARS);
    const pastBound = lineOf(WORKER_SSE_LINE_CHARS + 1);
    const bodies = [atBound.frame, pastBound.frame];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(bodies.shift() ?? "", { status: 200 })),
      ),
    );
    const url = await proxyTarget("run-worker-bound");
    const seals: (string | null)[] = [];
    const usages: (ModelUsage | null)[] = [];

    for (let call = 0; call < 2; call += 1) {
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
        async (_runId, usage, _retryable, seal) => {
          seals.push(seal);
          usages.push(usage);
        },
      );
      await response.text();
    }

    // The line at the bound is read and sealed; the one past it is a line this
    // hop cannot hold, so the response answers null rather than a digest of a
    // guess, and its usage as unobserved rather than a count read off a line
    // the hop never held. A proxy that took the container's bound would read
    // both.
    expect(seals).toEqual([
      createHash("sha256").update(atBound.answer, "utf8").digest("hex"),
      null,
    ]);
    expect(usages).toEqual([
      { input: 3, output: 1 },
      { input: null, output: null },
    ]);
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
