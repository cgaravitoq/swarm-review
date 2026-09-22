import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { responseAnswerText } from "../../container/response-seal";

const containerDir = fileURLToPath(
  new URL("../../container", import.meta.url).href,
);

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

    expect(responseAnswerText(anthropic)).toBe("alpha one\nseed beta");
    expect(responseAnswerText(chat)).toBe("gamma delta");
    expect(responseAnswerText(responses)).toBe("eps zeta\neta");
    expect(responseAnswerText(jsonChat)).toBe("json answer");
    for (const body of ["Unauthorized", "", '{"error":"quota"}']) {
      expect(responseAnswerText(body)).toBeNull();
    }
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
