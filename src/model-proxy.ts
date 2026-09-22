/**
 * Model transport for the container, mirroring the git proxy.
 *
 * The sandbox SDK control API runs as root, so no container uid can hold the
 * provider bearer. The Worker Durable Object keeps the credential and the
 * usage counters; the container only receives a nonsecret handle and a
 * run-scoped URL under /model/<runId>/<capability>/.
 */

import { createHash } from "node:crypto";
import { assertCloudRunId } from "./isolation";

export type ModelCaps = {
  maxRequests: number;
  maxRetriesPerRequest: number;
  maxCumulativeInputTokens: number;
  maxCumulativeOutputTokens: number;
  maxRequestBytes: number;
};

/** Provider-reported usage. A field the body never carried is null, never zero. */
export type ModelUsage = { input: number | null; output: number | null };

export type ModelTotals = {
  requests: number;
  retries: number;
  input: number | null;
  output: number | null;
};

export type ModelSession = {
  handle: string;
  upstreamBaseUrl: string;
  upstreamAuthorization: string;
  upstreamAccountId?: string;
  caps: ModelCaps;
  totals: ModelTotals;
  /** Set once an attempt failed the way a client repeats; the next one is a retry. */
  retryPending?: boolean;
  /** One seal per response this proxy observed, null where none could be taken. */
  seals?: (string | null)[];
};

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function modelCapability(runId: string, secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:model:${runId}`),
  );
  return hex(digest);
}

export function modelProxyBaseUrl(
  origin: string,
  runId: string,
  capability: string,
) {
  return `${origin}/model/${runId}/${capability}`;
}

export function modelsJsonForProxy(
  modelsJson: string,
  provider: string,
  handle: string,
  baseUrl: string,
) {
  const parsed: unknown = JSON.parse(modelsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("models.json: expected a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  const providers = (
    typeof config["providers"] === "object" &&
    config["providers"] !== null &&
    !Array.isArray(config["providers"])
      ? { ...(config["providers"] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const current = (
    typeof providers[provider] === "object" &&
    providers[provider] !== null &&
    !Array.isArray(providers[provider])
      ? { ...(providers[provider] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  providers[provider] = { ...current, apiKey: handle, baseUrl };
  return JSON.stringify({ ...config, providers });
}

export const emptyModelTotals = (): ModelTotals => ({
  requests: 0,
  retries: 0,
  input: null,
  output: null,
});

export function publicModelUsage(session: ModelSession | undefined) {
  if (!session) return null;
  return {
    handle: session.handle,
    caps: session.caps,
    totals: session.totals,
  };
}

export const capViolation = (totals: ModelTotals, caps: ModelCaps) => {
  if (totals.requests >= caps.maxRequests) return "max_requests";
  if (totals.input !== null && totals.input >= caps.maxCumulativeInputTokens) {
    return "max_input_tokens";
  }
  if (
    totals.output !== null &&
    totals.output >= caps.maxCumulativeOutputTokens
  ) {
    return "max_output_tokens";
  }
  return null;
};

export function reserveAttempt(
  totals: ModelTotals,
  caps: ModelCaps,
  isRetry: boolean,
) {
  const violation = capViolation(totals, caps);
  if (violation) return violation;
  totals.requests += 1;
  if (isRetry) totals.retries += 1;
  return null;
}

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

export const readUsage = (body: string): ModelUsage | null => {
  const totals: ModelUsage = { input: null, output: null };
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
  return totals.input === null && totals.output === null ? null : totals;
};

const jsonError = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { type: "review_pi_model", reason } }), {
    status,
    headers: { "content-type": "application/json" },
  });

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

/**
 * A status a client repeats, which makes the attempt that follows it on this
 * session a retry rather than a new request. The observed attempt is the only
 * source of that count the container cannot forge.
 */
const retryableFailure = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/**
 * The request body, or the refusal when it is over the session's byte cap.
 *
 * The declared length arrives from the container, which is the untrusted side
 * of this boundary, so the bytes are counted as they are read either way: a
 * target that understates its own `content-length` cannot carry a body past
 * the cap the broker enforces for the local path.
 */
const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "max_request_bytes"> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return "max_request_bytes";
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "max_request_bytes";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/**
 * The handle the target presented, from either header it may arrive on.
 *
 * Pi blanks `authorization` and signs with `cf-aig-authorization` for the AI
 * Gateway provider, so reading one header only would reject the run's own
 * handle for that provider alone.
 */
const presentedHandle = (request: Request) =>
  (
    request.headers.get("authorization") ??
    request.headers.get("cf-aig-authorization") ??
    ""
  ).replace(/^Bearer\s+/i, "");

export async function proxyModelFetch(
  request: Request,
  url: URL,
  secret: string,
  open: (runId: string) => Promise<{ handle: string; caps: ModelCaps } | null>,
  consume: (
    runId: string,
  ) => Promise<
    { ok: true; session: ModelSession } | { ok: false; reason: string }
  >,
  recordAttempt: (
    runId: string,
    usage: ModelUsage | null,
    retryable: boolean,
    seal: string | null,
  ) => Promise<void>,
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const runIdRaw = segments[1];
  const capability = segments[2];
  const rest = `/${segments.slice(3).join("/")}`;
  if (!runIdRaw || !capability || segments.slice(3).length === 0) {
    return jsonError(404, "not_found");
  }
  let runId: string;
  try {
    runId = assertCloudRunId(runIdRaw);
  } catch {
    return jsonError(400, "invalid_run");
  }
  if (capability !== (await modelCapability(runId, secret))) {
    return jsonError(403, "capability_rejected");
  }
  const opened = await open(runId);
  if (!opened) return jsonError(429, "no_session");
  if (presentedHandle(request) !== opened.handle) {
    return jsonError(401, "handle_rejected");
  }
  const method = request.method;
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : await readBoundedBody(request, opened.caps.maxRequestBytes);
  if (body === "max_request_bytes") return jsonError(413, body);
  const consumed = await consume(runId);
  if (!consumed.ok) return jsonError(429, consumed.reason);
  let target: URL;
  try {
    target = resolveUpstreamTarget(
      `${rest}${url.search}`,
      consumed.session.upstreamBaseUrl,
    );
  } catch (error) {
    return jsonError(
      403,
      error instanceof Error ? error.message : String(error),
    );
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", consumed.session.upstreamAuthorization);
  headers.delete("host");
  // The gateway reads this header in preference to `authorization`, so leaving
  // the target's handle on it would send the upstream a credential that is not
  // one.
  headers.delete("cf-aig-authorization");
  headers.delete("content-length");
  if (consumed.session.upstreamAccountId) {
    headers.set("chatgpt-account-id", consumed.session.upstreamAccountId);
  }
  const upstream = await fetch(target, {
    method,
    headers,
    body,
    redirect: "manual",
  } as RequestInit).catch(async (error: unknown) => {
    await recordAttempt(runId, null, true, null);
    throw error;
  });
  const retryable = retryableFailure(upstream.status);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  if (!upstream.body) {
    await recordAttempt(runId, null, retryable, null);
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
  const decoder = new TextDecoder();
  let streamed = "";
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      streamed += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    async flush() {
      streamed += decoder.decode();
      await recordAttempt(
        runId,
        readUsage(streamed.slice(-65_536)),
        retryable,
        responseSeal(streamed),
      );
    },
  });
  return new Response(upstream.body.pipeThrough(stream), {
    status: upstream.status,
    headers: responseHeaders,
  });
}
