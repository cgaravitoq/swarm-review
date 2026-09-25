/** Provider-reported usage. A side the response never reported is null, never zero. */
export type ModelUsage = { input: number | null; output: number | null };

const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "prompt_tokens",
  "inputTokens",
  "output_tokens",
  "completion_tokens",
  "outputTokens",
] as const;

const CLOSING_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.incomplete",
  "message_delta",
  "message_stop",
]);

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : null;

/**
 * Reads the usage a provider reported in one response as it streams through a
 * model hop, from every frame, wherever in the response it arrives.
 *
 * A Responses answer reports both sides on a closing event that repeats the
 * whole answer, so a reading kept to the tail of a long answer loses both.
 * Anthropic reports the input on the frame it opens with and the output on the
 * one it closes with; the one stream captured on 2026-09-24 repeated the input
 * and both cache fields on its closing frame as well, but the reader does not
 * depend on that repeat. Each field keeps the last value any frame gave it, as
 * pi's own reader does, so a closing frame that leaves a field out or sends it
 * as null keeps the value an earlier frame gave it.
 *
 * Anthropic also reports the cached halves of a prompt apart from
 * `input_tokens`, and a review that caches its context spends most of its input
 * there. Counting only `input_tokens` would show a lane sitting against its
 * token ceiling as having spent almost nothing. OpenAI-style usage already folds
 * cache reads into `prompt_tokens`, so the cache fields are added only where a
 * provider reports them on their own.
 *
 * `lineChars` is the longest line the calling hop will hold. A line past it is
 * one the hop cannot read, and whatever usage it carried is unknown, so the
 * reading answers both sides unobserved rather than a sum that may be short.
 * The line is held a second time beside the sealer's copy: driving both over a
 * two-byte line at the bound, V8's smallest passing `--max-old-space-size`
 * moves from 40 to 56 MB at the Worker's bound, inside its isolate's 128, and
 * from 144 to 208 MB at the container's.
 *
 * `closed` says whether a frame that carries the final usage went by: a
 * Responses closing event, Anthropic's `message_delta` or `message_stop`, a
 * chat chunk with its own usage, or `[DONE]`. Before one, Anthropic has only
 * reported the output it opened with, so a stream that stops early has no
 * usage a reader may count as whole.
 */
export const usageReader = ({ lineChars }: { lineChars: number }) => {
  const last = new Map<(typeof USAGE_FIELDS)[number], number>();
  let pending = "";
  let unreadable = false;
  let closed = false;

  const readLine = (line: string) => {
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.trim();
    if (payload === "[DONE]") closed = true;
    if (!payload || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const frame = objectRecord(parsed);
    if (!frame) return;
    const type = frame["type"];
    if (
      typeof type === "string"
        ? CLOSING_EVENTS.has(type)
        : objectRecord(frame["usage"]) !== null
    ) {
      closed = true;
    }
    // OpenAI's Responses API nests it under the response, Anthropic's
    // Messages API under the message it opens with.
    const usage =
      objectRecord(frame["usage"]) ??
      objectRecord(objectRecord(frame["response"])?.["usage"]) ??
      objectRecord(objectRecord(frame["message"])?.["usage"]) ??
      frame;
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (typeof value === "number") last.set(field, value);
    }
  };

  return {
    write(chunk: string) {
      if (unreadable) return;
      if (!chunk.includes("\n")) {
        pending += chunk;
      } else {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > lineChars) {
            unreadable = true;
            break;
          }
          readLine(line);
        }
      }
      if (unreadable || pending.length > lineChars) {
        unreadable = true;
        pending = "";
      }
    },
    read(): ModelUsage {
      if (unreadable) return { input: null, output: null };
      readLine(pending);
      const anthropicInput = last.get("input_tokens");
      return {
        input:
          anthropicInput === undefined
            ? (last.get("prompt_tokens") ?? last.get("inputTokens") ?? null)
            : anthropicInput +
              (last.get("cache_read_input_tokens") ?? 0) +
              (last.get("cache_creation_input_tokens") ?? 0),
        output:
          last.get("output_tokens") ??
          last.get("completion_tokens") ??
          last.get("outputTokens") ??
          null,
      };
    },
    closed: () => closed,
  };
};

/** The usage one whole body reported, read the way a hop reads it streaming. */
export const readUsage = (body: string) => {
  const reader = usageReader({ lineChars: body.length });
  reader.write(body);
  return reader.read();
};
