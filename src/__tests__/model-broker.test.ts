import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrokerServer,
  readUsage,
  reserveAttempt,
  resolveUpstreamTarget,
} from "../../container/model-broker";
import {
  RESPONSE_TAIL_CHARS,
  WORKER_SSE_LINE_CHARS,
} from "../../container/response-seal";

const CANARY = "canary-bearer-do-not-log-9f3c";

type Received = {
  authorization?: string;
  accountId?: string;
  url: string;
  body: string;
};

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe("model broker", () => {
  let upstream: Server;
  let broker: Server;
  let brokerPort = 0;
  let upstreamPort = 0;
  let received: Received[] = [];
  let ledgerPath = "";
  let scratch = "";
  let upstreamStatus = 200;
  let upstreamBody = "";

  const caps = {
    maxRequests: 3,
    maxRetriesPerRequest: 1,
    maxCumulativeInputTokens: 5000,
    maxCumulativeOutputTokens: 1000,
    maxRequestBytes: 1024,
  };

  const collect = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => resolve(body));
    });

  beforeEach(async () => {
    received = [];
    upstreamStatus = 200;
    upstreamBody = JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1200, completion_tokens: 300 },
    });
    scratch = await mkdtemp(join(tmpdir(), "broker-test-"));
    ledgerPath = join(scratch, "provider-usage.jsonl");
    upstream = createServer(async (request, response) => {
      received.push({
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(typeof request.headers["chatgpt-account-id"] === "string"
          ? { accountId: request.headers["chatgpt-account-id"] }
          : {}),
        url: request.url ?? "",
        body: await collect(request),
      });
      response.writeHead(upstreamStatus, {
        "content-type": "application/json",
      });
      response.end(upstreamBody);
    });
    upstreamPort = await listen(upstream);
    ({ server: broker } = createBrokerServer({
      port: 0,
      handle: "review-pi-handle",
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps,
      ledgerPath,
    }));
    brokerPort = await listen(broker);
  });

  afterEach(async () => {
    await close(broker);
    await close(upstream);
    await rm(scratch, { recursive: true, force: true });
  });

  const call = (init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${brokerPort}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer review-pi-handle",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
      ...init,
    });

  it("substitutes the real bearer and never receives it from the caller", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${CANARY}`);
    expect(received[0]?.body).toBe(
      JSON.stringify({ model: "m", messages: [] }),
    );
    expect(await response.text()).toBe(upstreamBody);
  });

  it("replaces a caller chatgpt-account-id with the broker's upstream account id", async () => {
    await close(broker);
    ({ server: broker } = createBrokerServer({
      port: 0,
      handle: "review-pi-handle",
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      upstreamAccountId: "acct-real",
      caps,
      ledgerPath,
    }));
    brokerPort = await listen(broker);

    const response = await fetch(
      `http://127.0.0.1:${brokerPort}/codex/responses`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer review-pi-handle",
          "chatgpt-account-id": "review-pi",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${CANARY}`);
    expect(received[0]?.accountId).toBe("acct-real");
  });

  it("rejects a caller that does not present the run's handle", async () => {
    const response = await call({
      headers: {
        authorization: "Bearer guessed",
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
    expect(await readFile(ledgerPath, "utf8")).toContain("handle_rejected");
  });

  it("records provider-reported usage rather than trusting the caller", async () => {
    await call();
    const ledger = await readFile(ledgerPath, "utf8");
    const entry = ledger
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((line) => line.event === "provider_request");

    expect(entry.usage).toEqual({ input: 1200, output: 300 });
    expect(entry.totals).toEqual({
      requests: 1,
      retries: 0,
      input: 1200,
      output: 300,
      unended: 0,
    });
  });

  it("records a request it admitted and never saw end", async () => {
    // A provider that accepts the attempt and never answers: this is the shape
    // the Codex provider's WebSocket transport takes through this hop. The
    // handshake reaches a broker that speaks HTTP only, the slot is spent, and
    // the upstream never completes an upgrade the broker cannot make. The
    // ledger has to name the request even though no response ever closes it.
    const silent = createServer(() => {});
    const silentPort = await listen(silent);
    const unendedScratch = await mkdtemp(join(tmpdir(), "broker-unended-"));
    const unendedLedger = join(unendedScratch, "provider-usage.jsonl");
    const { server } = createBrokerServer({
      port: 0,
      handle: "h",
      upstreamBaseUrl: `http://127.0.0.1:${silentPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps: {
        maxRequests: 5,
        maxRetriesPerRequest: 1,
        maxCumulativeInputTokens: 1000,
        maxCumulativeOutputTokens: 1000,
        maxRequestBytes: 4096,
      },
      ledgerPath: unendedLedger,
    });
    const port = await listen(server);
    const controller = new AbortController();

    const pending = fetch(`http://127.0.0.1:${port}/codex/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer h",
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    }).catch(() => undefined);

    const ledgerEntries = async () =>
      (await readFile(unendedLedger, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    // The admission is written before the attempt is sent, so the request is
    // named while the response it waits for is still open.
    await vi.waitFor(async () => {
      expect(
        (await ledgerEntries()).some(
          (entry) => entry["event"] === "provider_admitted",
        ),
      ).toBe(true);
    });

    const entries = await ledgerEntries();
    const admitted = entries.filter(
      (entry) => entry["event"] === "provider_admitted",
    );
    expect(admitted).toHaveLength(1);
    // Nothing about this attempt ever ended, so nothing may read as an outcome.
    expect(entries.some((entry) => entry["event"] === "provider_request")).toBe(
      false,
    );
    expect(admitted[0]?.["totals"]).toMatchObject({
      requests: 1,
      retries: 0,
      unended: 1,
    });

    controller.abort();
    await pending;
    await close(server);
    silent.closeAllConnections();
    await close(silent);
    await rm(unendedScratch, { recursive: true, force: true });
  });

  it("pairs every admission with its own end across the lane's requests", async () => {
    // Two requests in one lane, sent together. An id that restarts with each
    // request names both admissions and both ends alike, and no reader can
    // say which end closed which admission.
    await Promise.all(
      [call(), call()].map((pending) =>
        pending.then((response) => response.text()),
      ),
    );

    const entries = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ids = (event: string) =>
      entries
        .filter((entry) => entry["event"] === event)
        .map((entry) => entry["attemptId"])
        .sort();
    expect(ids("provider_admitted")).toEqual([1, 2]);
    expect(ids("provider_request")).toEqual([1, 2]);
  });

  it("ends an attempt once when the line recording its end cannot be written", async () => {
    const endScratch = await mkdtemp(join(tmpdir(), "broker-ledger-"));
    const ledger = join(endScratch, "provider-usage.jsonl");
    let sent = 0;
    // The ledger turns into a directory while the attempt is in flight, so the
    // append that records this attempt's end throws after the answer is out.
    const provider = createServer(async (_request, response) => {
      sent += 1;
      await rm(ledger);
      await mkdir(ledger);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(upstreamBody);
    });
    const providerPort = await listen(provider);
    const { server, totals } = createBrokerServer({
      port: 0,
      handle: "h",
      upstreamBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps,
      ledgerPath: ledger,
    });
    const [handle] = server.listeners("request") as ((
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>)[];
    const failures: unknown[] = [];
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      handle?.(request, response).catch((error: unknown) => {
        failures.push(error);
      });
    });
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer h" },
      body: "{}",
    });
    const text = await response.text();
    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });
    await close(server);
    await close(provider);
    await rm(endScratch, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(text).toBe(upstreamBody);
    expect(failures).toEqual([expect.objectContaining({ code: "EISDIR" })]);
    // The append is all that failed: the attempt ended once, and the answer
    // the lane already holds is never asked for a second time.
    expect(totals).toMatchObject({ requests: 1, unended: 0 });
    expect(sent).toBe(1);
  });

  const requestEntry = async () =>
    (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["event"] === "provider_request");

  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  it("seals the answer text that crossed the broker, which report.json cannot rewrite", async () => {
    await call();

    expect((await requestEntry())?.["seal"]).toBe(sha256("ok"));
  });

  it("seals Anthropic blocks exactly as pi joins them into finalText", async () => {
    upstreamBody = [
      'data: {"type":"message_start","message":{"content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret reasoning"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"alpha one"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" more"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"beta two"}}',
      'data: {"type":"content_block_stop","index":2}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      "data: [DONE]",
    ].join("\n\n");

    const response = await call();
    const text = await response.text();

    expect(text).toBe(upstreamBody);
    expect((await requestEntry())?.["seal"]).toBe(
      sha256("alpha one more\nbeta two"),
    );
  });

  it("seals nothing over a body whose shape it cannot place", async () => {
    upstreamBody = "Unauthorized";

    const response = await call();

    expect(response.status).toBe(200);
    expect((await requestEntry())?.["seal"]).toBeNull();
  });

  it("seals a stream far past its tail, but no JSON body it only kept the tail of", async () => {
    const pieces = Array.from({ length: 64 }, () =>
      "x".repeat(RESPONSE_TAIL_CHARS / 16),
    );
    const long = pieces.join("");
    upstreamBody = pieces
      .map(
        (content) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
      )
      .join("\n\n");
    await call().then((response) => response.text());
    upstreamBody = JSON.stringify({
      choices: [{ message: { content: long } }],
    });
    await call().then((response) => response.text());

    const seals = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "provider_request")
      .map((entry) => entry["seal"]);
    expect(seals).toEqual([sha256(long), null]);
  });

  it("seals a line past the Worker hop's bound, because this hop holds the lane's own memory", async () => {
    const head = 'data: {"choices":[{"delta":{"content":"';
    const tail = '"}}]}';
    const line = WORKER_SSE_LINE_CHARS + 1;
    const answer = "x".repeat(line - head.length - tail.length);
    upstreamBody = `${head}${answer}${tail}\n\n`;

    await call().then((response) => response.text());

    expect((await requestEntry())?.["seal"]).toBe(sha256(answer));
  });

  it("stops calling the provider once a cumulative token cap is reached", async () => {
    // Two calls put cumulative input at 2400 and output at 600; the third
    // crosses neither, so the request cap is what stops the fourth.
    await call();
    await call();
    await call();
    const denied = await call();

    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({
      error: { reason: "max_requests" },
    });
    expect(received).toHaveLength(3);
  });

  it("counts a retry of a failing upstream and stops at the retry cap", async () => {
    upstreamStatus = 503;
    upstreamBody = JSON.stringify({ error: "unavailable" });

    const response = await call();

    expect(response.status).toBe(503);
    expect(received).toHaveLength(2);
    const totals = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.totals)
      .at(-1).totals;
    // The retried attempt ended at its 503, so the only attempts the totals
    // may call open are ones that never came back.
    expect(totals).toMatchObject({ requests: 2, retries: 1, unended: 0 });
  });

  it("ends every attempt a provider it cannot reach turned away", async () => {
    const unreachable = createServer();
    const unreachablePort = await listen(unreachable);
    await close(unreachable);
    await close(broker);
    ({ server: broker } = createBrokerServer({
      port: 0,
      handle: "review-pi-handle",
      upstreamBaseUrl: `http://127.0.0.1:${unreachablePort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps,
      ledgerPath,
    }));
    brokerPort = await listen(broker);

    const response = await call();

    expect(response.status).toBe(502);
    const entries = (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // Both refusals are the ends of their admissions, so neither attempt may
    // read as still in flight.
    expect(
      entries
        .filter((entry) => entry.event === "provider_error")
        .map((entry) => entry.attemptId),
    ).toEqual([1, 2]);
    expect(entries.filter((entry) => entry.totals).at(-1).totals).toMatchObject(
      { requests: 2, retries: 1, unended: 0 },
    );
  });

  it("refuses a request body past the cap before it reaches the provider", async () => {
    const response = await call({ body: "x".repeat(2048) });

    expect(response.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("reads usage from the last event of a streamed response", () => {
    const stream = [
      'data: {"usage":{"input_tokens":10,"output_tokens":1}}',
      'data: {"usage":{"input_tokens":10,"output_tokens":42}}',
      "data: [DONE]",
    ].join("\n");

    expect(readUsage(stream)).toEqual({ input: 10, output: 42 });
    expect(readUsage("not json at all")).toBeNull();
  });

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
});

describe("a target that tries to choose the provider", () => {
  it("never sends the bearer to a second server, and keeps serving the real one", async () => {
    const stolen: string[] = [];
    const attacker = createServer((request, response) => {
      stolen.push(request.headers.authorization ?? "(none)");
      response.writeHead(200).end("{}");
    });
    const attackerPort = await listen(attacker);
    const honest = createServer((request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ url: request.url }));
    });
    const honestPort = await listen(honest);
    const scratchDir = await mkdtemp(join(tmpdir(), "broker-ssrf-"));
    const ledger = join(scratchDir, "provider-usage.jsonl");
    const { server } = createBrokerServer({
      port: 0,
      handle: "h",
      upstreamBaseUrl: `http://127.0.0.1:${honestPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps: {
        maxRequests: 5,
        maxRetriesPerRequest: 1,
        maxCumulativeInputTokens: 1000,
        maxCumulativeOutputTokens: 1000,
        maxRequestBytes: 4096,
      },
      ledgerPath: ledger,
    });
    const port = await listen(server);

    // An absolute-form request line: legal HTTP, and the exact move a tool
    // running as the target would make to redirect the credential.
    const raw = await new Promise<string>((resolvePromise) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST http://127.0.0.1:${attackerPort}/steal HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            "Authorization: Bearer h\r\n" +
            "Content-Length: 2\r\n\r\n{}",
        );
      });
      let text = "";
      socket.on("data", (chunk) => {
        text += String(chunk);
      });
      socket.on("close", () => resolvePromise(text));
      setTimeout(() => socket.end(), 500);
    });
    // The legitimate path still works through the same broker.
    const honestResponse = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer h" },
      body: "{}",
    });

    await close(server);
    await close(attacker);
    await close(honest);
    const ledgerText = await readFile(ledger, "utf8");
    await rm(scratchDir, { recursive: true, force: true });

    expect(stolen).toEqual([]);
    expect(raw).toContain("403");
    expect(raw).toContain("non_origin_form_target");
    expect(raw).not.toContain(CANARY);
    expect(ledgerText).not.toContain(CANARY);
    expect(honestResponse.status).toBe(200);
    // And the base path is joined rather than replaced.
    expect(await honestResponse.json()).toEqual({ url: "/v1/messages" });
  });

  it("returns a redirect instead of carrying the bearer to its Location", async () => {
    const elsewhere: string[] = [];
    const attacker = createServer((request, response) => {
      elsewhere.push(request.headers.authorization ?? "(none)");
      response.writeHead(200).end("{}");
    });
    const attackerPort = await listen(attacker);
    const redirector = createServer((_request, response) => {
      response
        .writeHead(302, { location: `http://127.0.0.1:${attackerPort}/steal` })
        .end();
    });
    const redirectorPort = await listen(redirector);
    const scratchDir = await mkdtemp(join(tmpdir(), "broker-redirect-"));
    const { server } = createBrokerServer({
      port: 0,
      handle: "h",
      upstreamBaseUrl: `http://127.0.0.1:${redirectorPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps: {
        maxRequests: 5,
        maxRetriesPerRequest: 1,
        maxCumulativeInputTokens: 1000,
        maxCumulativeOutputTokens: 1000,
        maxRequestBytes: 4096,
      },
      ledgerPath: join(scratchDir, "provider-usage.jsonl"),
    });
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer h" },
      body: "{}",
      redirect: "manual",
    });

    await close(server);
    await close(redirector);
    await close(attacker);
    await rm(scratchDir, { recursive: true, force: true });

    expect(response.status).toBe(302);
    expect(elsewhere).toEqual([]);
  });

  it("forwards a stream as it arrives instead of buffering the whole answer", async () => {
    const provider = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"delta","text":"first"}\n\n');
      setTimeout(() => {
        response.write(
          'data: {"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
        );
        response.end("data: [DONE]\n\n");
      }, 300);
    });
    const providerPort = await listen(provider);
    const scratchDir = await mkdtemp(join(tmpdir(), "broker-sse-"));
    const ledger = join(scratchDir, "provider-usage.jsonl");
    const { server } = createBrokerServer({
      port: 0,
      handle: "h",
      upstreamBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
      upstreamAuthorization: `Bearer ${CANARY}`,
      caps: {
        maxRequests: 5,
        maxRetriesPerRequest: 1,
        maxCumulativeInputTokens: 1000,
        maxCumulativeOutputTokens: 1000,
        maxRequestBytes: 4096,
      },
      ledgerPath: ledger,
    });
    const port = await listen(server);

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer h" },
      body: "{}",
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const firstChunk = await reader.read();
    const firstAt = Date.now() - started;
    await reader.cancel();

    await close(server);
    await close(provider);
    const ledgerText = await readFile(ledger, "utf8");
    await rm(scratchDir, { recursive: true, force: true });

    // The first frame reaches the caller long before the provider is done, so
    // a streamed review stays visible instead of arriving in one silent block.
    expect(new TextDecoder().decode(firstChunk.value)).toContain("first");
    expect(firstAt).toBeLessThan(250);
    expect(ledgerText).not.toContain(CANARY);
  });
});

describe("upstream target admission", () => {
  const base = "http://provider.test/v1";

  it("joins the request path under the configured base path", () => {
    expect(resolveUpstreamTarget("/chat/completions?x=1", base).href).toBe(
      "http://provider.test/v1/chat/completions?x=1",
    );
    expect(resolveUpstreamTarget("/messages", "http://p.test/").href).toBe(
      "http://p.test/messages",
    );
  });

  it("refuses an absolute-form request line that names another server", () => {
    // This is the shape that routed the bearer elsewhere: a legal proxy
    // request line, honoured by `new URL(target, base)`, chosen by target code.
    expect(() =>
      resolveUpstreamTarget("http://attacker.test/steal", base),
    ).toThrow(/non_origin_form_target/);
    expect(() => resolveUpstreamTarget("//attacker.test/steal", base)).toThrow(
      /non_origin_form_target/,
    );
  });

  it("confines a traversal attempt under the base rather than above it", () => {
    // `new URL` resolves the `..` segments away, so the climb never reaches the
    // origin root, let alone another host: it lands back under the base path.
    expect(resolveUpstreamTarget("/../../steal", base).href).toBe(
      "http://provider.test/v1/steal",
    );
  });
});

describe("attempt reservation", () => {
  const caps = {
    maxRequests: 2,
    maxRetriesPerRequest: 1,
    maxCumulativeInputTokens: 100,
    maxCumulativeOutputTokens: 100,
    maxRequestBytes: 1024,
  };

  it("spends the slot in the same tick it tests it", () => {
    const totals = {
      requests: 0,
      retries: 0,
      input: 0,
      output: 0,
      unended: 0,
    };

    expect(reserveAttempt(totals, caps, false)).toBeNull();
    expect(totals.requests).toBe(1);
    expect(reserveAttempt(totals, caps, true)).toBeNull();
    expect(totals).toEqual({
      requests: 2,
      retries: 1,
      input: 0,
      output: 0,
      unended: 2,
    });
    // The third attempt is refused instead of being counted after the fact.
    expect(reserveAttempt(totals, caps, false)).toBe("max_requests");
    expect(totals.requests).toBe(2);
  });

  it("refuses once the cumulative token totals are already spent", () => {
    expect(
      reserveAttempt(
        { requests: 0, retries: 0, input: 100, output: 0, unended: 0 },
        caps,
        false,
      ),
    ).toBe("max_input_tokens");
    expect(
      reserveAttempt(
        { requests: 0, retries: 0, input: 0, output: 100, unended: 0 },
        caps,
        false,
      ),
    ).toBe("max_output_tokens");
  });
});
