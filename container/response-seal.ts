import { createHash } from "node:crypto";

/** Enough tail to hold a provider's final usage frame, never the transcript. */
export const RESPONSE_TAIL_CHARS = 65_536;

/**
 * The longest SSE line the Worker proxy reads, in UTF-16 code units. A cloud
 * lane's model bytes cross that proxy and no other sealing hop, so this is the
 * longest line a cloud lane's seal can stand on.
 *
 * The number is the isolate's, not the request's. A line is materialized as a
 * string and parsed, so it costs the isolate two to three bytes per character,
 * six for text that is not Latin-1. Driving this module in V8 under
 * `--max-old-space-size=128`, the isolate's ceiling, a line of this bound peaks
 * at 32 MB of heap (ASCII) and 61 MB (two-byte), while a line of the t1b
 * request cap peaks at 104 MB and 136 MB: most of the isolate, or past its
 * ceiling on its own once the text is not Latin-1. A line past the bound is one
 * this hop cannot read, so a cloud lane's seal answers null for it rather than
 * a digest of a guess, and the lane is refused.
 */
export const WORKER_SSE_LINE_CHARS = 8 * 1024 * 1024;

/**
 * The longest SSE line the container broker reads, in UTF-16 code units. Only
 * a local lane runs the broker, so this bound never reads a cloud lane's bytes.
 *
 * A Responses event echoes the request's instructions, so the line a lane can
 * provoke follows the request cap it sends under, and this is the larger cap:
 * t1b's 32 MiB. The cap counts bytes and the line counts code units, and a
 * string's UTF-8 bytes are never fewer than its code units, so an echo in the
 * request's own encoding is no longer than the request was. The event wraps
 * its own fields around the echo, and a provider may re-escape it, a character
 * as a six-character `\uXXXX`, up to six times the request's bytes: a line
 * that grows past the bound that way answers null. The bound is the cap and
 * not six times it, because six times it holds 580 MB of heap for one ASCII
 * line (V8 under `--max-old-space-size=2048`), where the cap peaks at 205 MB
 * for text that is not Latin-1 (under `--max-old-space-size=512`), which the
 * lane's container memory pays for.
 */
export const CONTAINER_SSE_LINE_CHARS = 32 * 1024 * 1024;

const ANTHROPIC_EVENTS = new Set([
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_start",
  "message_delta",
  "message_stop",
  "ping",
]);

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : null;

const isStreamIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

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

/**
 * Seals one response as it streams through a model hop: sha256 of the answer
 * text it carried, or null for a body this seal cannot be taken over or one
 * that carried no answer at all.
 *
 * The answer is what pi renders into report.json's `finalText`: the assistant
 * message's text blocks joined with `"\n"`. Anthropic keeps one block per
 * `content_block`, chat completions concatenates every `delta.content` into
 * one block, and the Responses API concatenates per output item the way pi's
 * own slots do. A body of any other shape answers null rather than a digest
 * of a guess: the host must be able to prove the answer crossed this
 * channel, and a seal over invented text proves nothing.
 *
 * The text is hashed as it arrives, so what is retained is one SSE line and
 * the bounded tail the usage frame is read from. A JSON body is read from
 * that tail, and one longer than the tail answers null.
 *
 * `lineChars` is the longest line the calling hop will hold. A sealed lane's
 * model bytes cross one of the two hops, never both: a cloud lane's cross the
 * Worker proxy, which leaves it at its isolate's bound, and a local lane's
 * cross the container broker, which passes the container's.
 */
export const responseSealer = ({
  lineChars = WORKER_SSE_LINE_CHARS,
}: {
  lineChars?: number;
} = {}) => {
  const hash = createHash("sha256");
  let tail = "";
  let total = 0;
  let pending = "";
  let mode: "unknown" | "sse" | "json" | "unsealable" = "unknown";
  let sawLine = false;
  let family: "anthropic" | "chat" | "responses" | null = null;
  const anthropicBlocks = new Map<number, boolean>();
  let anthropicText: number | null = null;
  const responseItems = new Set<number>();
  let responseItem: number | null = null;
  let answered = false;

  const hashAnswer = (text: string) => {
    hash.update(text, "utf8");
    if (text !== "") answered = true;
  };

  const readLine = (rawLine: string): boolean => {
    if (rawLine.length > lineChars) return false;
    const line = rawLine.replace(/\r$/, "");
    if (!sawLine) {
      if (line.trim() === "") return true;
      // A comment carries no event, so a provider's keep-alive may open the
      // stream. It does not establish the format either: what follows it still
      // has to be one.
      if (line.startsWith(":")) return true;
      sawLine = true;
      if (!/^(?:data|event|id|retry):/.test(line.trim())) return false;
    }
    if (!line.startsWith("data:")) return true;
    const payload = line.slice(5).replace(/^ /, "");
    if (payload === "" || payload === "[DONE]") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A data line that is not JSON is a shape this seal cannot stand on.
      return false;
    }
    const record = objectRecord(parsed);
    if (!record) return false;
    const type = typeof record["type"] === "string" ? record["type"] : "";

    if (Array.isArray(record["choices"])) {
      if (family !== null && family !== "chat") return false;
      family = "chat";
      const choice = objectRecord(record["choices"][0]);
      const content = objectRecord(choice?.["delta"])?.["content"];
      if (typeof content === "string") hashAnswer(content);
      return true;
    }
    if (type.startsWith("response.")) {
      if (family !== null && family !== "responses") return false;
      family = "responses";
      if (
        type !== "response.output_text.delta" &&
        type !== "response.refusal.delta"
      ) {
        return true;
      }
      const index = record["output_index"];
      const delta = record["delta"];
      if (!isStreamIndex(index) || typeof delta !== "string") return false;
      if (index !== responseItem) {
        // A hash cannot go back to an item it already closed.
        if (responseItems.has(index)) return false;
        if (responseItems.size > 0) hash.update("\n", "utf8");
        responseItems.add(index);
        responseItem = index;
      }
      hashAnswer(delta);
      return true;
    }
    if (!ANTHROPIC_EVENTS.has(type)) return true;
    if (family !== null && family !== "anthropic") return false;
    family = "anthropic";
    if (type === "content_block_start") {
      const index = record["index"];
      if (!isStreamIndex(index) || anthropicBlocks.has(index)) return false;
      const block = objectRecord(record["content_block"]);
      const isText = block?.["type"] === "text";
      if (isText) {
        if (anthropicText !== null) hash.update("\n", "utf8");
        anthropicText = index;
        const seed = block["text"];
        if (typeof seed === "string") hashAnswer(seed);
      }
      anthropicBlocks.set(index, isText);
    } else if (type === "content_block_delta") {
      const index = record["index"];
      if (!isStreamIndex(index)) return false;
      const delta = objectRecord(record["delta"]);
      if (delta?.["type"] !== "text_delta") return true;
      const text = delta["text"];
      if (typeof text !== "string") return false;
      // A delta whose block never opened as text is text pi never rendered.
      if (anthropicBlocks.get(index) !== true) return true;
      if (index !== anthropicText) return false;
      hashAnswer(text);
    }
    return true;
  };

  return {
    write(chunk: string) {
      total += chunk.length;
      tail = (tail + chunk).slice(-RESPONSE_TAIL_CHARS);
      if (mode === "json" || mode === "unsealable") return;
      let text = chunk;
      if (mode === "unknown") {
        text = chunk.trimStart();
        if (text === "") return;
        mode = text.startsWith("{") ? "json" : "sse";
        if (mode === "json") return;
      }
      if (!text.includes("\n")) {
        pending += text;
      } else {
        const lines = (pending + text).split("\n");
        pending = lines.pop() ?? "";
        if (!lines.every(readLine)) mode = "unsealable";
      }
      if (mode === "unsealable" || pending.length > lineChars) {
        mode = "unsealable";
        pending = "";
      }
    },
    tail: () => tail,
    seal(): string | null {
      if (mode === "json") {
        const text =
          total <= RESPONSE_TAIL_CHARS ? jsonAnswerText(tail.trim()) : null;
        return text
          ? createHash("sha256").update(text, "utf8").digest("hex")
          : null;
      }
      if (mode !== "sse" || !readLine(pending) || !answered) return null;
      return hash.digest("hex");
    },
  };
};
