// The only process in the container that holds a model credential.
//
// It runs as `review-control`, a uid the reviewed repository never executes as.
// Pi, its tools, the install and the check command all run as `review-target`,
// which reaches the provider only through this loopback endpoint and never sees
// the bearer: the credential lives in this process's memory and in a 0600 file
// owned by `review-control`, so a target read of the environment, the run
// directory or /proc of this pid is denied by the kernel rather than by
// convention.
//
// It is also the trusted model-call boundary, so the request, retry and token
// caps are enforced here - before the upstream call - and the usage ledger it
// appends to lives in a directory only `review-control` can write. Target code
// can lie in report.json; it cannot lie about what the provider was asked.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

/** The cap that would be broken by admitting one more request, or null. */
export type BrokerCaps = {
  maxRequests: number;
  maxRetriesPerRequest: number;
  maxCumulativeInputTokens: number;
  maxCumulativeOutputTokens: number;
  maxRequestBytes: number;
};

export type BrokerTotals = {
  requests: number;
  retries: number;
  input: number;
  output: number;
};

export type BrokerConfig = {
  port: number;
  handle: string;
  upstreamBaseUrl: string;
  upstreamAuthorization: string;
  upstreamAccountId?: string;
  caps: BrokerCaps;
  ledgerPath: string;
};

export const capViolation = (totals: BrokerTotals, caps: BrokerCaps) => {
  if (totals.requests >= caps.maxRequests) return "max_requests";
  if (totals.retries >= caps.maxRetriesPerRequest * caps.maxRequests) {
    return "max_retries";
  }
  if (totals.input >= caps.maxCumulativeInputTokens) return "max_input_tokens";
  if (totals.output >= caps.maxCumulativeOutputTokens) {
    return "max_output_tokens";
  }
  return null;
};

/**
 * Takes the slot one upstream attempt will consume, or refuses it.
 *
 * Checking a cap and then awaiting anything before spending it is not
 * enforcement: two concurrent requests both read the same pre-await totals, and
 * a retry loop that only checked once spends as many slots as it likes. The
 * reservation is therefore synchronous - the counter moves in the same tick it
 * is tested in, before the first await of the attempt - so what a caller can
 * overshoot by is one in-flight response, never a second request.
 */
export function reserveAttempt(
  totals: BrokerTotals,
  caps: BrokerCaps,
  isRetry: boolean,
) {
  const violation = capViolation(totals, caps);
  if (violation) return violation;
  totals.requests += 1;
  if (isRetry) totals.retries += 1;
  return null;
}

/**
 * The one upstream URL this broker is allowed to reach.
 *
 * The bearer is attached by this process, so whatever this function returns is
 * where the credential goes. An HTTP request line may legally carry an absolute
 * form (`POST https://elsewhere/v1 HTTP/1.1`), and `new URL(target, base)`
 * honours it and silently drops the base - which is a target-controlled process
 * choosing the server that receives the key. So only an origin-form path is
 * accepted, it is joined under the configured base path rather than replacing
 * it, and the result must still sit inside that base.
 */
export function resolveUpstreamTarget(requestUrl: string, baseUrl: string) {
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) {
    throw new Error(`non_origin_form_target: ${requestUrl.slice(0, 80)}`);
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const requested = new URL(requestUrl, "http://broker.invalid");
  if (requested.origin !== "http://broker.invalid") {
    throw new Error(`non_origin_form_target: ${requestUrl.slice(0, 80)}`);
  }
  // `new URL` normalises `..`, so a path that climbs out of the base is caught
  // by the prefix test below rather than reaching the provider.
  const target = new URL(
    `${basePath}${requested.pathname}${requested.search}`,
    base.origin,
  );
  const inside =
    target.pathname === basePath ||
    target.pathname.startsWith(basePath === "" ? "/" : `${basePath}/`);
  if (target.origin !== base.origin || !inside) {
    throw new Error(`upstream_out_of_scope: ${target.href.slice(0, 120)}`);
  }
  return target;
}

/**
 * Provider-reported usage, whether the response was one JSON body or an SSE
 * stream. Only the last usage object in a stream is authoritative, so the scan
 * keeps overwriting rather than summing.
 */
/**
 * Provider-reported usage, whether the response was one JSON body or an SSE
 * stream. A frame updates the fields it carries and the last value of each one
 * wins, rather than the last frame replacing the whole reading: Anthropic opens
 * with the input and closes with the output, so replacing would keep one and
 * lose the other.
 *
 * Anthropic also reports the cached halves of a prompt apart from
 * `input_tokens`, and a review that caches its context spends most of its input
 * there. Counting only `input_tokens` would show a lane sitting against its
 * token ceiling as having spent almost nothing. OpenAI-style usage already folds
 * cache reads into `prompt_tokens`, so the cache fields are added only where a
 * provider reports them on their own.
 */
export const readUsage = (
  body: string,
): { input: number; output: number } | null => {
  const totals = { input: 0, output: 0 };
  let seen = false;
  const numberAt = (record: Record<string, unknown>, key: string) => {
    const value = record[key];
    return typeof value === "number" ? value : 0;
  };
  const consider = (candidate: Record<string, unknown> | undefined) => {
    if (!candidate || typeof candidate !== "object") return;
    const anthropicInput = candidate["input_tokens"];
    const input =
      anthropicInput ?? candidate["prompt_tokens"] ?? candidate["inputTokens"];
    const output =
      candidate["output_tokens"] ??
      candidate["completion_tokens"] ??
      candidate["outputTokens"];
    if (typeof input !== "number" && typeof output !== "number") return;
    seen = true;
    if (typeof input === "number") {
      totals.input =
        input +
        (typeof anthropicInput === "number"
          ? numberAt(candidate, "cache_read_input_tokens") +
            numberAt(candidate, "cache_creation_input_tokens")
          : 0);
    }
    if (typeof output === "number") totals.output = output;
  };
  for (const line of body.split("\n")) {
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const nestedUsage = (key: string) => {
        const container = parsed[key];
        return typeof container === "object" && container !== null
          ? (container as Record<string, unknown>)["usage"]
          : undefined;
      };
      consider(
        (parsed["usage"] as Record<string, unknown> | undefined) ??
          // OpenAI's Responses API nests it under the response, Anthropic's
          // Messages API under the message it opens with.
          (nestedUsage("response") as Record<string, unknown> | undefined) ??
          (nestedUsage("message") as Record<string, unknown> | undefined) ??
          parsed,
      );
    } catch {}
  }
  return seen ? totals : null;
};

/** Enough tail to hold a provider's final usage frame, never the transcript. */
const USAGE_TAIL_BYTES = 65_536;

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : null;

const isStreamIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The answer text one streamed response carries, or null for a body this
 * seal cannot be taken over.
 *
 * This is what pi renders into report.json's `finalText`: the assistant
 * message's text blocks joined with `"\n"`. Anthropic keeps one block per
 * `content_block`, chat completions concatenates every `delta.content` into
 * one block, and the Responses API concatenates per output item the way pi's
 * own slots do. A body of any other shape answers null rather than a digest
 * of a guess: the host must be able to prove the answer crossed this
 * channel, and a seal over invented text proves nothing.
 */
const sseAnswerText = (body: string): string | null => {
  let family: "anthropic" | "chat" | "responses" | null = null;
  const anthropic = new Map<number, { text: string; isText: boolean }>();
  const responses = new Map<number, string>();
  let chatText = "";
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).replace(/^ /, "");
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A data line that is not JSON is a shape this seal cannot stand on.
      return null;
    }
    const record = objectRecord(parsed);
    if (!record) return null;
    const type = typeof record["type"] === "string" ? record["type"] : "";

    if (Array.isArray(record["choices"])) {
      if (family !== null && family !== "chat") return null;
      family = "chat";
      const choice = objectRecord(record["choices"][0]);
      const delta = objectRecord(choice?.["delta"]);
      const content = delta?.["content"];
      if (typeof content === "string" && content.length > 0) {
        chatText += content;
      }
      continue;
    }
    if (type.startsWith("response.")) {
      if (family !== null && family !== "responses") return null;
      family = "responses";
      if (
        type === "response.output_text.delta" ||
        type === "response.refusal.delta"
      ) {
        const index = record["output_index"];
        const delta = record["delta"];
        if (!isStreamIndex(index) || typeof delta !== "string") return null;
        responses.set(index, (responses.get(index) ?? "") + delta);
      }
      continue;
    }
    if (
      type === "content_block_start" ||
      type === "content_block_delta" ||
      type === "content_block_stop" ||
      type === "message_start" ||
      type === "message_delta" ||
      type === "message_stop" ||
      type === "ping"
    ) {
      if (family !== null && family !== "anthropic") return null;
      family = "anthropic";
      if (type === "content_block_start") {
        const index = record["index"];
        if (!isStreamIndex(index)) return null;
        const block = objectRecord(record["content_block"]);
        const isText = block?.["type"] === "text";
        const seed =
          isText && typeof block?.["text"] === "string" ? block["text"] : "";
        anthropic.set(index, { text: seed, isText });
      } else if (type === "content_block_delta") {
        const index = record["index"];
        if (!isStreamIndex(index)) return null;
        const delta = objectRecord(record["delta"]);
        if (delta?.["type"] !== "text_delta") continue;
        const text = delta["text"];
        if (typeof text !== "string") return null;
        const block = anthropic.get(index);
        // A delta whose block never opened as text is text pi never rendered.
        if (block?.isText) block.text += text;
      }
    }
  }
  if (family === "anthropic") {
    return [...anthropic.values()]
      .filter((block) => block.isText)
      .map((block) => block.text)
      .join("\n");
  }
  if (family === "chat") return chatText;
  if (family === "responses") return [...responses.values()].join("\n");
  return null;
};

const jsonAnswerText = (body: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const record = objectRecord(parsed);
  if (!record) return null;
  const choices = record["choices"];
  if (Array.isArray(choices)) {
    const message = objectRecord(objectRecord(choices[0])?.["message"]);
    const content = message?.["content"];
    if (content === null || content === undefined) return "";
    return typeof content === "string" ? content : null;
  }
  const content = record["content"];
  if (Array.isArray(content)) {
    const blocks: string[] = [];
    for (const entry of content) {
      const block = objectRecord(entry);
      if (!block) return null;
      if (block["type"] !== "text") continue;
      if (typeof block["text"] !== "string") return null;
      blocks.push(block["text"]);
    }
    return blocks.join("\n");
  }
  const output = record["output"];
  if (Array.isArray(output)) {
    const items: string[] = [];
    for (const entry of output) {
      const item = objectRecord(entry);
      if (!item) return null;
      if (item["type"] !== "message") continue;
      const parts = item["content"];
      if (!Array.isArray(parts)) return null;
      let text = "";
      for (const part of parts) {
        const piece = objectRecord(part);
        if (!piece) return null;
        if (piece["type"] !== "output_text") continue;
        if (typeof piece["text"] !== "string") return null;
        text += piece["text"];
      }
      items.push(text);
    }
    return items.join("\n");
  }
  return null;
};

export const responseAnswerText = (body: string): string | null => {
  const firstLine = body
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  if (!firstLine) return null;
  if (firstLine.startsWith("{")) return jsonAnswerText(body.trim());
  if (/^(?:data|event|id|retry):/.test(firstLine)) return sseAnswerText(body);
  return null;
};

/**
 * The seal of one response: sha256 of the answer text it carried through
 * this process, or null when its shape put it beyond this seal.
 */
export const responseSeal = (body: string): string | null => {
  const text = responseAnswerText(body);
  return text === null
    ? null
    : createHash("sha256").update(text, "utf8").digest("hex");
};

const readBody = (stream: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

export function createBrokerServer(config: BrokerConfig) {
  const caps = config.caps;
  const ledgerPath = config.ledgerPath;
  const totals = { requests: 0, retries: 0, input: 0, output: 0 };

  const record = (entry: Record<string, unknown>) => {
    appendFileSync(
      ledgerPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  };

  const deny = (res: ServerResponse, status: number, reason: string) => {
    record({ event: "denied", reason, totals: { ...totals } });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "review_pi_broker", reason } }));
  };

  const server = createServer(async (req, res) => {
    // The handle is not a secret - target code can read it out of models.json.
    // It only pins this endpoint to the configured run so an unrelated process in
    // the container cannot quietly spend the run's budget.
    //
    // Pi presents it on `cf-aig-authorization` for the AI Gateway provider and
    // blanks `authorization` there, so a broker that read one header only would
    // reject its own handle for that provider alone.
    const presented = (
      req.headers.authorization ??
      req.headers["cf-aig-authorization"] ??
      ""
    )
      .toString()
      .replace(/^Bearer\s+/i, "");
    if (presented !== config.handle) {
      deny(res, 401, "handle_rejected");
      return;
    }
    const violation = capViolation(totals, caps);
    if (violation) {
      deny(res, 429, violation);
      return;
    }

    let target: URL;
    try {
      target = resolveUpstreamTarget(req.url ?? "/", config.upstreamBaseUrl);
    } catch (error) {
      // The bearer is never attached to a request whose destination this
      // process did not choose.
      deny(res, 403, error instanceof Error ? error.message : String(error));
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      deny(
        res,
        400,
        `request_body_unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (body.length > caps.maxRequestBytes) {
      deny(res, 413, "max_request_bytes");
      return;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "host" || name === "content-length") continue;
      // The handle the target presented never travels: the gateway reads this
      // header in preference to `authorization`, so forwarding it would send
      // the upstream a credential that is not one.
      if (name === "cf-aig-authorization") continue;
      if (typeof value === "string") headers[name] = value;
    }
    headers["authorization"] = config.upstreamAuthorization;
    if (config.upstreamAccountId) {
      headers["chatgpt-account-id"] = config.upstreamAccountId;
    }

    let attempt = 0;
    let lastError = "";
    while (attempt <= caps.maxRetriesPerRequest) {
      // The slot is taken here, synchronously, in the same tick it is tested:
      // the caps bound what is actually sent, not what was intended when the
      // handler started.
      const refusal = reserveAttempt(totals, caps, attempt > 0);
      if (refusal) {
        deny(res, 429, refusal);
        return;
      }
      try {
        const upstream = await fetch(target, {
          method: req.method ?? "POST",
          headers,
          // A redirect is another server asking for the bearer. It is returned
          // to the caller as the provider's own answer, never followed.
          redirect: "manual",
          ...(req.method === "GET" || req.method === "HEAD"
            ? {}
            : { body, duplex: "half" }),
        });
        if (upstream.status >= 500 && attempt < caps.maxRetriesPerRequest) {
          attempt += 1;
          lastError = `upstream ${upstream.status}`;
          record({ event: "provider_retry", status: upstream.status, attempt });
          continue;
        }
        for (const [name, value] of upstream.headers) {
          if (name !== "content-encoding" && name !== "content-length") {
            res.setHeader(name, value);
          }
        }
        res.writeHead(upstream.status);
        // Pi streams, so the answer is forwarded chunk by chunk. Buffering the
        // whole body here would turn a streamed review into one long silence
        // and break the activity the run is watched through. The body is still
        // decoded as it passes: the seal is what this process observed, and
        // the usage frame lives in the last bytes of that same text.
        const decoder = new TextDecoder();
        let streamed = "";
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            streamed += decoder.decode(chunk, { stream: true });
            res.write(Buffer.from(chunk));
          }
          streamed += decoder.decode();
        }
        res.end();
        const usage = readUsage(streamed.slice(-USAGE_TAIL_BYTES));
        if (usage) {
          totals.input += usage.input;
          totals.output += usage.output;
        }
        record({
          event: "provider_request",
          status: upstream.status,
          attempt,
          path: target.pathname,
          usage,
          seal: upstream.body ? responseSeal(streamed) : null,
          totals: { ...totals },
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        record({ event: "provider_error", attempt, message: lastError });
        attempt += 1;
      }
    }
    deny(res, 502, `upstream_unreachable: ${lastError}`);
  });

  record({ event: "broker_start", upstream: config.upstreamBaseUrl, caps });
  return { server, totals };
}

if (process.argv[2]) {
  const config = JSON.parse(
    readFileSync(process.argv[2] ?? "", "utf8"),
  ) as BrokerConfig;
  const { server } = createBrokerServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`broker listening on ${config.port}\n`);
  });
}
