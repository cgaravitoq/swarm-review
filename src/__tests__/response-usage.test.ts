import { describe, expect, it } from "vitest";
import { readUsage, usageReader } from "../../container/response-usage";

const claudeCode = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":3894,"output_tokens":1}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  "",
].join("\n\n");

describe("response usage", () => {
  it("reads usage from the last event of a streamed response", () => {
    const stream = [
      'data: {"usage":{"input_tokens":10,"output_tokens":1}}',
      'data: {"usage":{"input_tokens":10,"output_tokens":42}}',
      "data: [DONE]",
    ].join("\n");

    expect(readUsage(stream)).toEqual({ input: 10, output: 42 });
  });

  it("counts the cached halves of an Anthropic prompt as input, not as nothing", () => {
    // Anthropic reports the cached halves of the prompt beside `input_tokens`
    // rather than inside it. Counting only `input_tokens` would let a cached
    // review run against the token caps for free.
    expect(readUsage(claudeCode)).toEqual({ input: 3996, output: 7 });
    // OpenAI-style usage already folds cache reads into `prompt_tokens`, so the
    // same body must not be counted twice.
    expect(
      readUsage('data: {"usage":{"prompt_tokens":30,"completion_tokens":4}}'),
    ).toEqual({ input: 30, output: 4 });
  });

  it("keeps each field a closing frame leaves out at the value an earlier frame gave it", () => {
    // A closing frame repeats the counts it knows and may carry a null or omit
    // the rest; either way the cached input the opening frame reported stands.
    const closing = claudeCode.replace(
      '"usage":{"output_tokens":7}',
      '"usage":{"input_tokens":2,"cache_read_input_tokens":null,"output_tokens":7}',
    );

    expect(readUsage(closing)).toEqual({ input: 3996, output: 7 });
  });

  it("leaves a side no frame reported unobserved, never zero", () => {
    expect(readUsage('data: {"usage":{"output_tokens":7}}')).toEqual({
      input: null,
      output: 7,
    });
    expect(readUsage('data: {"usage":{"input_tokens":11}}')).toEqual({
      input: 11,
      output: null,
    });
    expect(readUsage("data: [DONE]")).toEqual({ input: null, output: null });
    expect(readUsage("not json at all")).toEqual({ input: null, output: null });
  });

  it("reads a frame however the stream splits it", () => {
    const reader = usageReader({ lineChars: 1024 });
    for (const character of claudeCode) reader.write(character);

    expect(reader.read()).toEqual({ input: 3996, output: 7 });
  });

  it("reads a body that ends without a newline", () => {
    const reader = usageReader({ lineChars: 1024 });
    reader.write(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );

    expect(reader.read()).toEqual({ input: 12, output: 3 });
  });

  it("answers both sides unobserved once a line is past the hop's bound", () => {
    // The long line may have carried either side, so what the earlier frames
    // reported is no longer the whole reading.
    const opening =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n';
    const long = `data: {"usage":{"output_tokens":9},"pad":"${"x".repeat(64)}"}`;

    const ended = usageReader({ lineChars: 64 });
    ended.write(`${opening}${long}\n\n`);
    expect(ended.read()).toEqual({ input: null, output: null });

    const open = usageReader({ lineChars: 64 });
    open.write(opening);
    open.write(long);
    expect(open.read()).toEqual({ input: null, output: null });

    const fits = usageReader({ lineChars: long.length });
    fits.write(`${opening}${long}\n\n`);
    expect(fits.read()).toEqual({ input: 5, output: 9 });
  });
});
