import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_SSE_LINE_CHARS,
  RESPONSE_TAIL_CHARS,
  responseSealer,
  WORKER_SSE_LINE_CHARS,
} from "../../container/response-seal";
import { SESSION_CAPS } from "../provider-budget";

const containerDir = fileURLToPath(
  new URL("../../container", import.meta.url).href,
);

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** A body as a hop sees it: in pieces that split lines and events anywhere. */
const sealOf = (body: string, piece = 7) => {
  const sealer = responseSealer();
  for (let start = 0; start < body.length; start += piece) {
    sealer.write(body.slice(start, start + piece));
  }
  return sealer.seal();
};

const chatBody = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;

describe("response seal", () => {
  it("reads each provider family's answer the way pi renders finalText", () => {
    const anthropic = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"secret reasoning"}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"alpha one"}}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":"seed"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":" beta"}}',
      "data: [DONE]",
    ].join("\n\n");
    const chat = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
      'data: {"choices":[{"delta":{"content":"gamma "}}]}',
      'data: {"choices":[{"delta":{"content":"delta"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");
    const responses = [
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"eps "}',
      'data: {"type":"response.refusal.delta","output_index":0,"content_index":0,"delta":"zeta"}',
      'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"eta"}',
      "data: [DONE]",
    ].join("\n");
    const jsonChat = JSON.stringify({
      choices: [{ message: { content: "json answer" } }],
    });

    expect(sealOf(anthropic)).toBe(sha256("alpha one\nseed beta"));
    expect(sealOf(chat)).toBe(sha256("gamma delta"));
    expect(sealOf(responses)).toBe(sha256("eps zeta\neta"));
    expect(sealOf(jsonChat)).toBe(sha256("json answer"));
    for (const body of ["Unauthorized", "", '{"error":"quota"}']) {
      expect(sealOf(body)).toBeNull();
    }
  });

  it("seals a stream an SSE comment opens", () => {
    const answer = "answer after a keep-alive";
    for (const opening of [
      ": keep-alive\n\n",
      ": OPENROUTER PROCESSING\n\n",
      ": a comment\r\n\r\n",
    ]) {
      expect(sealOf(`${opening}${chatBody(answer)}`)).toBe(sha256(answer));
    }
    // A comment does not establish the wire format, so what follows it still
    // has to be one rather than an attested answer.
    expect(sealOf(": keep-alive\n\nUnauthorized")).toBeNull();
  });

  it("refuses a line that is not SSE after an opening comment, whatever follows it", () => {
    // Were the comment to establish the format, the junk would read as a line
    // with no data and the event after it would seal.
    expect(sealOf(`: keep-alive\n\nnope\n\n${chatBody("x")}`)).toBeNull();
  });

  it("ignores a comment between events and seals nothing for comments alone", () => {
    expect(
      sealOf(`${chatBody("before")}: keep-alive\n\n${chatBody("after")}`),
    ).toBe(sha256("beforeafter"));
    expect(sealOf(": keep-alive\n\n: OPENROUTER PROCESSING\n\n")).toBeNull();
  });

  it("seals nothing for a response that carried no answer", () => {
    const noAnswer = [
      JSON.stringify({ choices: [] }),
      JSON.stringify({ choices: [{ message: { content: null } }] }),
      [
        'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ].join("\n"),
      [
        'data: {"type":"response.created","response":{"output":[]}}',
        'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"late"}]}]}}',
      ].join("\n"),
      [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"read"}}',
      ].join("\n"),
    ];

    for (const body of noAnswer) {
      expect(sealOf(body)).toBeNull();
    }
  });

  it("hashes a stream as it passes and keeps only a tail and one line of it", () => {
    const long = "x".repeat(RESPONSE_TAIL_CHARS * 4);
    const streamed = Array.from({ length: 64 }, () =>
      chatBody(long.slice(0, RESPONSE_TAIL_CHARS / 16)).replace(
        "data: [DONE]\n\n",
        "",
      ),
    ).join("");

    expect(sealOf(streamed, 4096)).toBe(sha256(long));
    // A JSON body is read from the retained tail, so one longer than the tail
    // was never held whole and cannot be sealed.
    expect(
      sealOf(JSON.stringify({ choices: [{ message: { content: long } }] })),
    ).toBeNull();
    expect(
      sealOf(chatBody("x".repeat(WORKER_SSE_LINE_CHARS)), 1 << 20),
    ).toBeNull();
  });

  it("reads a line at each hop's bound and answers null one character past it", () => {
    // The frame is one data line of exactly `chars` characters, so the length
    // under test is the line the hop is asked to hold and nothing else.
    const head = 'data: {"choices":[{"delta":{"content":"';
    const tail = '"}}]}';
    const lineOf = (chars: number) => {
      const answer = "x".repeat(chars - head.length - tail.length);
      return { answer, frame: `${head}${answer}${tail}\n\n` };
    };
    const sealOfLine = (lineChars: number, chars: number) => {
      const sealer = responseSealer({ lineChars });
      sealer.write(lineOf(chars).frame);
      return sealer.seal();
    };
    const answerSeal = (chars: number) => sha256(lineOf(chars).answer);

    expect(WORKER_SSE_LINE_CHARS).toBe(8 * 1024 * 1024);
    expect(sealOfLine(WORKER_SSE_LINE_CHARS, WORKER_SSE_LINE_CHARS)).toBe(
      answerSeal(WORKER_SSE_LINE_CHARS),
    );
    expect(
      sealOfLine(WORKER_SSE_LINE_CHARS, WORKER_SSE_LINE_CHARS + 1),
    ).toBeNull();

    // The container hop, which only a local lane crosses, reads a line the
    // Worker hop cannot: up to the larger request cap a lane sends under.
    expect(CONTAINER_SSE_LINE_CHARS).toBe(SESSION_CAPS.t1b.maxRequestBytes);
    expect(
      sealOfLine(CONTAINER_SSE_LINE_CHARS, WORKER_SSE_LINE_CHARS + 1),
    ).toBe(answerSeal(WORKER_SSE_LINE_CHARS + 1));
    expect(sealOfLine(CONTAINER_SSE_LINE_CHARS, CONTAINER_SSE_LINE_CHARS)).toBe(
      answerSeal(CONTAINER_SSE_LINE_CHARS),
    );
    expect(
      sealOfLine(CONTAINER_SSE_LINE_CHARS, CONTAINER_SSE_LINE_CHARS + 1),
    ).toBeNull();
  });

  it("ships in the image beside every broker that imports it", async () => {
    // The broker runs from the image, never from this tree, so a module it
    // imports but the image lacks fails only inside a real lane.
    const broker = await readFile(
      join(containerDir, "model-broker.ts"),
      "utf8",
    );
    const dockerfile = await readFile(join(containerDir, "Dockerfile"), "utf8");
    const imported = [...broker.matchAll(/from "\.\/([^"]+)"/g)].map(
      ([, module]) => `${module}.ts`,
    );

    expect(imported).toContain("response-seal.ts");
    for (const module of imported) {
      expect(dockerfile).toContain(`COPY ${module} /opt/review/${module}`);
    }
  });
});
