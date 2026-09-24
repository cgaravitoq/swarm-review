import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPackedUsage,
  canaryModel,
  canaryModels,
  completeOnce,
  packedRequestBody,
  writeFastLaneArtifacts,
} from "../fast-review";
import { readLaneReceipt } from "../local";

afterEach(() => {
  vi.unstubAllGlobals();
});

const chatCompletion = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop", ...extra }],
      usage: { prompt_tokens: 120, completion_tokens: 34 },
    }),
    { status: 200 },
  );

describe("completeOnce", () => {
  it("calls the given upstream and reports what the answer cost", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(chatCompletion("```json\n{}\n```")),
    );
    vi.stubGlobal("fetch", upstream);

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "grok-4.6",
      prompt: "review",
    });

    expect(answer.content).toContain("json");
    expect(answer.finishReason).toBe("stop");
    // Spend is read back from the provider, never assumed.
    expect(answer.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    expect(upstream.mock.calls[0]?.[0]).toBe(
      "https://provider.invalid/v1/chat/completions",
    );
    const init = upstream.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      authorization: "Bearer token",
      // A replay of the gateway's cache is not an answer to this pack, and it
      // arrives with another call's usage attached.
      "cf-aig-skip-cache": "true",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reasoning_effort: "low",
    });
  });
  it("reports a completion the provider cut rather than hiding it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          chatCompletion('```json\n{"status":"complete","findings":[]}\n```', {
            finish_reason: "length",
          }),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "grok-4.6",
      prompt: "review",
    });

    // The block parses and looks clean; only the finish reason says it is not.
    expect(answer.finishReason).toBe("length");
  });

  it("keeps the lab's own name for the reason its answer ended", async () => {
    // The compat route does not rewrite every lab's answer, and Anthropic names
    // a completion cut at the ceiling `max_tokens` rather than `length`. It is
    // the same end, and the lane is cut whichever word the lab used.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                { message: { content: "the pack begins with the diff" } },
              ],
              stop_reason: "max_tokens",
              usage: { input_tokens: 11, output_tokens: 8192 },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://gateway.invalid/v1/compat",
      bearer: "token",
      model: "anthropic/claude-sonnet-5",
      prompt: "review",
    });

    expect(answer.finishReason).toBe("max_tokens");
    expect(answer.usage).toEqual({ inputTokens: 11, outputTokens: 8192 });
  });

  it("leaves a count the usage object never carried unobserved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
              usage: { completion_tokens: 34 },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "grok-4.6",
      prompt: "review",
    });

    // A dropped field reads as nothing to a reader that sums the row.
    expect(answer.usage).toStrictEqual({ inputTokens: null, outputTokens: 34 });
  });

  it("keeps the one side a usage nested under the message reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
              message: { usage: { output_tokens: 9 } },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "grok-4.6",
      prompt: "review",
    });

    expect(answer.usage).toStrictEqual({ inputTokens: null, outputTokens: 9 });
  });

  it("records the spend of an answer that reported none as unobserved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    const artifactDir = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "grok-4.6",
      prompt: "review",
    });
    await writeFastLaneArtifacts({
      artifactDir,
      runId: "run-1",
      attemptId: "attempt-1",
      provider: "grok",
      model: "grok-4.6",
      finalText: answer.content,
      wallSeconds: 7,
      usage: answer.usage,
    });

    // The answer came back and its spend never did: an empty record in the
    // row would read as a lane that was measured and spent nothing.
    await expect(readLaneReceipt(artifactDir)).resolves.toMatchObject({
      usage: null,
    });
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("reads the spend out of an answer the gateway pretty-printed", async () => {
    // OpenAI's answers arrive indented, so no line of the body parses on its
    // own and a line-by-line reader reports a paid call as free.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              {
                choices: [
                  { message: { content: "ok" }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 11001, completion_tokens: 1222 },
              },
              null,
              2,
            ),
            { status: 200 },
          ),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "openai/gpt-5.6-luna",
      prompt: "review",
    });

    expect(answer.usage).toEqual({ inputTokens: 11001, outputTokens: 1222 });
  });

  it("reads a camelCase spend out of an answer the gateway pretty-printed", async () => {
    // Indented, so only the parsed record can carry it: the line reader that
    // would also know the field names never sees a whole frame.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              {
                choices: [
                  { message: { content: "ok" }, finish_reason: "stop" },
                ],
                usage: { inputTokens: 812, outputTokens: 64 },
              },
              null,
              2,
            ),
            { status: 200 },
          ),
        ),
      ),
    );

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "openai/gpt-5.6-luna",
      prompt: "review",
    });

    expect(answer.usage).toEqual({ inputTokens: 812, outputTokens: 64 });
  });

  it("throws with the provider's own words when the call is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid api key" }), {
            status: 401,
          }),
        ),
      ),
    );

    await expect(
      completeOnce({
        baseUrl: "https://provider.invalid/v1",
        bearer: "wrong",
        model: "grok-4.6",
        prompt: "review",
      }),
    ).rejects.toThrow(/401.*invalid api key/);
  });

  it("waits out a rate limit and asks again, then gives up", async () => {
    const limited = () =>
      new Response(JSON.stringify({ error: "Wholesale Rate limited" }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(chatCompletion("```json\n{}\n```"));
    vi.stubGlobal("fetch", upstream);

    const answer = await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "anthropic/claude-opus-5",
      prompt: "review",
    });

    // A 429 is the lab asking for time: the lane waits what it is told and
    // sends the same body again, and the answer is the one that came back.
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(answer.content).toContain("json");

    const exhausted = vi.fn<typeof fetch>(() => Promise.resolve(limited()));
    vi.stubGlobal("fetch", exhausted);
    await expect(
      completeOnce({
        baseUrl: "https://provider.invalid/v1",
        bearer: "token",
        model: "anthropic/claude-opus-5",
        prompt: "review",
      }),
    ).rejects.toThrow(/429.*Wholesale Rate limited/);
    expect(exhausted).toHaveBeenCalledTimes(4);
  });

  it("stops waiting on a rate limit when its window closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response("{}", { status: 429, headers: { "retry-after": "5" } }),
        ),
      ),
    );

    await expect(
      completeOnce({
        baseUrl: "https://provider.invalid/v1",
        bearer: "token",
        model: "anthropic/claude-opus-5",
        prompt: "review",
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout|timed out/i);
  });

  it("sends each lab the body its own endpoint accepts", () => {
    const base = {
      prompt: "review",
      maxTokens: 8192,
      reasoning: "off",
    } as const;

    // Only the labs that understand `reasoning_effort` receive it; the two that
    // think by default are asked for the answer instead, which is what keeps
    // their lane inside the run's window.

    // OpenAI's reasoning models take the newer completion cap, and refuse any
    // temperature but the default: measured against the live gateway.
    expect(
      packedRequestBody({ ...base, model: "openai/gpt-5.6-luna" }),
    ).toEqual({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "review" }],
      max_completion_tokens: 8192,
      reasoning_effort: "low",
    });

    // Anthropic takes `max_tokens` and rejects `temperature` outright.
    expect(
      packedRequestBody({ ...base, model: "anthropic/claude-sonnet-5" }),
    ).toEqual({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 8192,
      thinking: { type: "disabled" },
    });

    expect(
      packedRequestBody({
        ...base,
        model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      }),
    ).toEqual({
      model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 8192,
      temperature: 0,
      chat_template_kwargs: { thinking: false },
    });

    // xAI and any id without a lab prefix keep the classic shape, which is
    // what a direct provider call has always sent.
    expect(packedRequestBody({ ...base, model: "grok-4.6" })).toEqual({
      model: "grok-4.6",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 8192,
      temperature: 0,
      reasoning_effort: "low",
    });
  });

  it("turns each lab's reasoning on at the level it was given", () => {
    const base = { prompt: "review", maxTokens: 8192 };

    // Anthropic needs a thinking budget, and a `max_tokens` ceiling above it:
    // the API refuses a request whose budget does not fit under the ceiling.
    const anthropic = (reasoning: "low" | "medium" | "high") =>
      packedRequestBody({
        ...base,
        model: "anthropic/claude-sonnet-5",
        reasoning,
      });
    expect(anthropic("low")).toEqual({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 10_240,
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
    expect(anthropic("medium")).toEqual({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 16_384,
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
    expect(anthropic("high")).toEqual({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 24_576,
      thinking: { type: "enabled", budget_tokens: 16_384 },
    });

    // OpenAI has no off, so it takes the level straight, and no temperature.
    expect(
      packedRequestBody({
        ...base,
        model: "openai/gpt-5.6-luna",
        reasoning: "high",
      }),
    ).toEqual({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "review" }],
      max_completion_tokens: 8192,
      reasoning_effort: "high",
    });

    expect(
      packedRequestBody({
        ...base,
        model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
        reasoning: "low",
      }),
    ).toEqual({
      model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 8192,
      temperature: 0,
      chat_template_kwargs: { thinking: true },
    });

    // xAI and ids without a lab prefix take the level as an effort, and keep
    // their temperature.
    expect(
      packedRequestBody({ ...base, model: "grok-4.6", reasoning: "high" }),
    ).toEqual({
      model: "grok-4.6",
      messages: [{ role: "user", content: "review" }],
      max_tokens: 8192,
      temperature: 0,
      reasoning_effort: "high",
    });
  });

  it("carries the requested output cap into the body for either family", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(chatCompletion("ok")),
    );
    vi.stubGlobal("fetch", upstream);

    await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "openai/gpt-5.6-luna",
      prompt: "review",
      maxTokens: 16,
    });

    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject(
      { max_completion_tokens: 16 },
    );
  });

  it("gives every lab's body room for a whole answer by default", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(chatCompletion("ok")),
    );
    vi.stubGlobal("fetch", upstream);

    await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "openai/gpt-5.6-luna",
      prompt: "review",
    });
    await completeOnce({
      baseUrl: "https://provider.invalid/v1",
      bearer: "token",
      model: "anthropic/claude-sonnet-5",
      prompt: "review",
    });

    // The ceiling is a safety net, not a budget: a reviewer that reasons in
    // prose before its block has to reach the block inside it. Sonnet writes
    // the longest report of the three labs and was cut at 8k on real packs.
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject(
      { max_completion_tokens: 8192 },
    );
    expect(JSON.parse(String(upstream.mock.calls[1]?.[1]?.body))).toMatchObject(
      { max_tokens: 32_768 },
    );
  });
});

describe("canaryModel", () => {
  it("asks for one word and reports the model answered", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(chatCompletion("ok")),
    );
    vi.stubGlobal("fetch", upstream);

    const canary = await canaryModel({
      baseUrl: "https://gateway.invalid/v1/compat",
      bearer: "token",
      model: "anthropic/claude-sonnet-5",
    });

    expect(canary).toMatchObject({
      model: "anthropic/claude-sonnet-5",
      ok: true,
      error: null,
    });
    expect(canary.seconds).toBeGreaterThanOrEqual(0);
    // The canary is the same wire shape as the lane, so a lab that answers it
    // is a lab that will answer the pack.
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject(
      {
        model: "anthropic/claude-sonnet-5",
        max_tokens: 256,
        thinking: { type: "disabled" },
      },
    );
  });

  it("keeps the provider's own words when the lab refuses the model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: "model not found: anthropic/claude-sonnet-9" },
            }),
            { status: 404 },
          ),
        ),
      ),
    );

    const canary = await canaryModel({
      baseUrl: "https://gateway.invalid/v1/compat",
      bearer: "token",
      model: "anthropic/claude-sonnet-9",
    });

    expect(canary.ok).toBe(false);
    // A blocked lane is read by a person, and the provider's own sentence is
    // the only thing that says which lab refused it and why.
    expect(canary.error).toContain("404");
    expect(canary.error).toContain("model not found");
  });

  it("proves each distinct id once, in parallel", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(chatCompletion("ok")),
    );
    vi.stubGlobal("fetch", upstream);

    const canaries = await canaryModels({
      baseUrl: "https://gateway.invalid/v1/compat",
      bearer: "token",
      models: [
        "anthropic/claude-sonnet-5",
        "openai/gpt-5.6-luna",
        "anthropic/claude-sonnet-5",
        "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      ],
    });

    expect(canaries.map((entry) => entry.model)).toEqual([
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6-luna",
      "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
    ]);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});

describe("addPackedUsage", () => {
  it("leaves a side one answer never reported unobserved for the lane", () => {
    expect(
      addPackedUsage(
        { inputTokens: 5, outputTokens: null },
        { inputTokens: 7, outputTokens: 3 },
      ),
    ).toEqual({ inputTokens: 12, outputTokens: null });
    // An answer that reported no spend at all spent both sides unobserved.
    expect(
      addPackedUsage(null, { inputTokens: 7, outputTokens: 3 }),
    ).toBeNull();
    expect(
      addPackedUsage({ inputTokens: 7, outputTokens: 3 }, null),
    ).toBeNull();
  });
});

describe("writeFastLaneArtifacts", () => {
  it("records a lane whose call never answered as spending an unobserved count", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));

    await writeFastLaneArtifacts({
      artifactDir,
      runId: "run-1",
      attemptId: "attempt-1",
      provider: "grok",
      model: "grok-4.6",
      finalText: "",
      wallSeconds: 7,
      error: "fast review 503: upstream unavailable",
    });

    // No answer came back, so no usage was observed: an empty record in the
    // row would read as a lane that was measured and spent nothing.
    await expect(readLaneReceipt(artifactDir)).resolves.toMatchObject({
      usage: null,
    });
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("never lets a reader observe a partial receipt", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    const path = join(artifactDir, "local-receipt.json");
    const state = { writing: true, absent: false, torn: false };
    const readers = Array.from({ length: 4 }, () =>
      (async () => {
        while (state.writing) {
          const raw = await readFile(path, "utf8").catch(() => null);
          if (raw === null) state.absent = true;
          else {
            // Every strict prefix of the receipt stops before its closing
            // brace, so a parse is the proof the bytes were all there.
            try {
              JSON.parse(raw);
            } catch {
              state.torn = true;
            }
          }
        }
      })(),
    );
    try {
      await writeFastLaneArtifacts({
        artifactDir,
        runId: "run-1",
        attemptId: "attempt-1",
        provider: "grok",
        model: "grok-4.6",
        finalText: "",
        wallSeconds: 7,
        usage: { ["x".repeat(8 * 1024 * 1024)]: 1 },
      });
    } finally {
      state.writing = false;
    }
    await Promise.all(readers);

    expect(state.absent).toBe(true);
    expect(state.torn).toBe(false);
    const written = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(written).toMatchObject({
      runId: "run-1",
      attemptId: "attempt-1",
      outcome: "completed",
    });
    await rm(artifactDir, { recursive: true, force: true });
  });
});
