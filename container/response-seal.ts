import { createHash } from "node:crypto";

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
