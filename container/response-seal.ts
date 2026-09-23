import { createHash } from "node:crypto";

/** Enough tail to hold a provider's final usage frame, never the transcript. */
export const RESPONSE_TAIL_CHARS = 65_536;

/**
 * The longest SSE line the seal reads. A line is one event, and a Responses
 * event echoes the request's instructions, so it is bounded like a request.
 */
export const SSE_LINE_CHARS = 8 * 1024 * 1024;

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
 */
export const responseSealer = () => {
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
    if (rawLine.length > SSE_LINE_CHARS) return false;
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
      if (mode === "unsealable" || pending.length > SSE_LINE_CHARS) {
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
