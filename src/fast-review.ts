/**
 * One-shot Grok review: packed source in, JSON findings out. No tools.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readUsage } from "./model-proxy";

const FAST_MAX_TOKENS = 8192;
const FAST_TIMEOUT_MS = 180_000;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 20_000;

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

export type FastReasoning = "off" | "low" | "medium" | "high";

export const FAST_REASONING_LEVELS: readonly FastReasoning[] = [
  "off",
  "low",
  "medium",
  "high",
];

const ANTHROPIC_THINKING_BUDGET = {
  low: 2048,
  medium: 8192,
  high: 16384,
} satisfies Record<Exclude<FastReasoning, "off">, number>;

/** The canary spends little: it proves the model id, not the answer. */
const CANARY_MAX_TOKENS = 256;
const CANARY_TIMEOUT_MS = 60_000;
export const CANARY_PROMPT = "Reply with the single word: ok";

/**
 * The lab behind a model id on the AI Gateway, from the id's own prefix.
 *
 * The gateway's `/compat` route forwards the request body to the vendor almost
 * untouched, so a body that is valid for one lab is refused by another. The
 * prefix is what the gateway itself routes on, which makes it the only thing a
 * caller has to know.
 */
const modelLab = (model: string) => {
  const separator = model.indexOf("/");
  return separator === -1 ? "" : model.slice(0, separator);
};

// A Sonnet report on a 6795-sized pack runs past 8k tokens, and Opus 5 at low
// on the same pack was cut at 18k with its report unfinished (2026-09-14). At
// about 100 tokens a second 32k still lands inside a 600 s reviewer window.
const fastMaxTokens = (model: string) =>
  modelLab(model) === "anthropic" ? 32_768 : FAST_MAX_TOKENS;

/**
 * The body one lab's chat/completions endpoint accepts, measured on 2026-09-10.
 *
 * The labs disagree twice over. OpenAI's reasoning models reject `max_tokens`
 * and refuse any temperature but the default; Anthropic's current models reject
 * `temperature` outright; Workers AI and xAI take the classic shape. And the two
 * labs whose models think by default spend their whole output ceiling on that
 * thinking before a single character of the answer exists: Sonnet 5 returned
 * finish_reason `length` with empty content at 16k output tokens and took 177 s
 * doing it, and DeepSeek V4 Flash the same at 223 s. Both are asked to answer
 * directly unless a reasoning level turns their thinking on. An unrecognized id
 * gets the classic shape, which is what a direct provider call has always sent.
 */
export const packedRequestBody = (input: {
  model: string;
  prompt: string;
  maxTokens: number;
  reasoning?: FastReasoning;
}) => {
  const lab = modelLab(input.model);
  const reasoning = input.reasoning ?? "off";
  const thinkingBudget =
    reasoning === "off" ? null : ANTHROPIC_THINKING_BUDGET[reasoning];
  const maxTokens =
    lab === "anthropic" && thinkingBudget !== null
      ? input.maxTokens + thinkingBudget
      : input.maxTokens;
  return {
    model: input.model,
    messages: [{ role: "user", content: input.prompt }],
    ...(lab === "openai"
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    ...(lab === "openai" || lab === "anthropic" ? {} : { temperature: 0 }),
    ...(lab === "anthropic" && thinkingBudget === null
      ? { thinking: { type: "disabled" } }
      : {}),
    ...(lab === "anthropic" && thinkingBudget !== null
      ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
      : {}),
    ...(lab === "workers-ai"
      ? { chat_template_kwargs: { thinking: reasoning !== "off" } }
      : {}),
    ...(lab === "openai" || lab === "xai" || lab === ""
      ? { reasoning_effort: reasoning === "off" ? "low" : reasoning }
      : {}),
  };
};

export const FAST_REVIEWER_PROMPT = `You are one reviewer of a pull request. You receive a pack: assigned files at HEAD, the diff, and grep hits. That pack is the whole investigation. No shell, no tools.

Angle: {{LANE_FOCUS}}
Assigned files:
{{ASSIGNED_FILES}}

Judge only what is in the pack. Do not mark partial because a test could not be run. status is complete when you have judged the packed files. Empty findings with status complete means the packed change looks clean.

End with one fenced JSON block and nothing after it:
\`\`\`json
{"status": "complete", "blockerReason": "", "findings": [{"severity": "P1", "file": "path/to/file.ts", "line": 42, "mechanism": "what breaks", "evidence": "the line or hunk", "affectedBehavior": "what callers observe"}]}
\`\`\`
severity is P0, P1 or P2. line is the HEAD line number.
`;

export const FAST_VERIFIER_PROMPT = `You verify reviewer candidates against a source pack. No shell. Candidates are claims.

The brief is JSON: \`pullRequest\` is the change's own title and body, null when the run never saw a pull request; \`diff\` lists the hunks this change makes to the file each candidate names, empty when the change does not touch that file; \`candidates\` are the claims.

{{CANDIDATES}}

For each id, answer in this order:

1. declaredIntent. Decide it in one of two forms and write it at the very start of \`reason\`, before anything about the source:
   - \`declared: yes "<clause>" - the finding reports that behavior happening (<in a few words>)\` when \`pullRequest.body\` names the same surface behaving the same way as the finding reports. Quote that clause character-for-character as the body spells it: no capitalization, no added period, no paraphrase. The finding may report the behavior wider, harsher, on more paths, or through an implementation trigger the body never names - a remount, a key, a state on the component the body is describing - and it is still declared. The trigger, the step or the flow is not the behavior: the behavior is the effect the user sees on the element the body names - a copy hidden and then revealed, a duration, a document shape - whatever makes it happen.
   - \`declared: no - finding: <the behavior the finding reports, in a few words>; body: <what the body says about that behavior, or nothing>\` when it does not: the finding reports the body's claim not happening for some input - the body says credentials are redacted and the finding says punctuation makes them leak, the body says a path is bypassed and the finding says it runs - or the body only lists a feature area, or the body never speaks of that behavior at all.
   Then set the \`declaredIntent\` field to that quoted clause, or null.
2. diffRelation. How the change relates to the mechanism: "added" when the change wrote the line the mechanism is about; "touched" when the change rewrote that code or added a path that reaches it; "untouched" when the change neither adds, alters nor reaches it, so the defect predates the change. Cite the hunk header you read it from (\`@@ -a,b +c,d @@\`).
3. status. confirmed or rejected, from the pack. A confirmed finding stays confirmed when the body declares the behavior: declared intent changes how a finding is published, never whether the mechanism is real.

Static evidence is enough. Emit exactly one verdict per candidate, and end your answer with one fenced \`\`\`json block and nothing after it.

\`\`\`json
{"verdicts": [{"id": "c1", "status": "confirmed", "evidenceStrength": "static", "diffRelation": "added", "declaredIntent": null, "reason": "declared: no the body never speaks of that behavior; @@ -12,7 +12,9 @@ the source shows it"}]}
\`\`\`
status is confirmed, rejected, or duplicate (with duplicateOf). diffRelation is added, touched or untouched. declaredIntent is a verbatim sentence from the pull request body, or null.
`;

/**
 * Spend as the answer's own record reports it.
 *
 * `readUsage` reads a body line by line, and the gateway pretty-prints the JSON
 * it gets from OpenAI, so no single line of a Luna answer parses and the whole
 * call looks free. This body is already parsed, so the record is read first and
 * the line scanner stays as the fallback for a streamed one.
 */
const usageFrom = (value: unknown) => {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const input =
    record?.["prompt_tokens"] ??
    record?.["input_tokens"] ??
    record?.["inputTokens"];
  const output =
    record?.["completion_tokens"] ??
    record?.["output_tokens"] ??
    record?.["outputTokens"];
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
};

/**
 * Sends one packed prompt and returns what the provider actually answered.
 *
 * The finish reason and the usage travel with the content because a completion
 * the provider cut at the token ceiling still parses as a well-formed empty
 * answer, and a lane that reports no findings has to be distinguishable from a
 * lane that never got to say them.
 */
export async function completeOnce(input: {
  baseUrl: string;
  bearer: string;
  model: string;
  prompt: string;
  timeoutMs?: number;
  reasoning?: FastReasoning;
  maxTokens?: number;
  signal?: AbortSignal;
}) {
  // The run's own deadline and its cancellation both have to reach the call:
  // a lane that only carries its private timeout keeps spending after the
  // swarm it belongs to has already given up.
  const deadline = AbortSignal.timeout(input.timeoutMs ?? FAST_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  const post = () =>
    fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.bearer}`,
        "content-type": "application/json",
        // The gateway caches an identical body and replays it, usage and all.
        // A cached lane is not a lane that answered this pack, and the receipt
        // would price this run on another run's tokens.
        "cf-aig-skip-cache": "true",
      },
      body: JSON.stringify(
        packedRequestBody({
          model: input.model,
          prompt: input.prompt,
          maxTokens: input.maxTokens ?? fastMaxTokens(input.model),
          reasoning: input.reasoning ?? "off",
        }),
      ),
      signal,
    });
  let response = await post();
  // Six swarms at once put the gateway over its wholesale rate limit (code
  // 2018) and a lane that gave up on the first 429 failed in zero seconds. A
  // rate limit is the lab asking for time, not refusing the call, so the lane
  // waits what it is told, or a growing default, inside its own window.
  for (
    let retry = 1;
    response.status === 429 && retry <= RATE_LIMIT_RETRIES;
    retry += 1
  ) {
    const retryAfter = response.headers.get("retry-after");
    await pause(
      retryAfter === null
        ? RATE_LIMIT_BACKOFF_MS * retry
        : Number(retryAfter) * 1000,
      signal,
    );
    response = await post();
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`fast review ${response.status}: ${body.slice(0, 300)}`);
  }
  const parsed: unknown = JSON.parse(body);
  const record =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const choices = record?.["choices"];
  const first = Array.isArray(choices) ? choices[0] : null;
  const choice =
    first && typeof first === "object" && first !== null
      ? (first as Record<string, unknown>)
      : null;
  const message = choice?.["message"];
  const content =
    message && typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)["content"]
      : null;
  if (typeof content !== "string" || !content) {
    throw new Error("fast review returned no content");
  }
  const finishReason =
    [choice?.["finish_reason"], record?.["stop_reason"]].find(
      (reason): reason is string => typeof reason === "string",
    ) ?? null;
  const streamed = readUsage(body);
  const usage =
    usageFrom(record?.["usage"]) ??
    usageFrom(
      (record?.["response"] as Record<string, unknown> | undefined)?.["usage"],
    ) ??
    (streamed
      ? { inputTokens: streamed.input, outputTokens: streamed.output }
      : null);
  return {
    content,
    finishReason,
    usage: usage ?? {},
  };
}

/** What one canary proved about one model id, with the provider's own words. */
export type ModelCanary = {
  model: string;
  ok: boolean;
  seconds: number;
  error: string | null;
};

/**
 * Proves one model id answers before a lane is packed against it.
 *
 * A lane routed to a model the gateway does not serve must be recorded as
 * blocked, never quietly served by a different lab: the receipt names the model
 * that answered, and a silent substitution makes that name a lie.
 */
export async function canaryModel(input: {
  baseUrl: string;
  bearer: string;
  model: string;
  reasoning?: FastReasoning;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ModelCanary> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  try {
    await completeOnce({
      baseUrl: input.baseUrl,
      bearer: input.bearer,
      model: input.model,
      prompt: CANARY_PROMPT,
      timeoutMs: input.timeoutMs ?? CANARY_TIMEOUT_MS,
      maxTokens: CANARY_MAX_TOKENS,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { model: input.model, ok: true, seconds: seconds(), error: null };
  } catch (error) {
    return {
      model: input.model,
      ok: false,
      seconds: seconds(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Canaries every distinct id once, in parallel, so one lab is paid for once. */
export async function canaryModels(input: {
  baseUrl: string;
  bearer: string;
  models: readonly string[];
  reasoning?: FastReasoning;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const distinct = [...new Set(input.models.filter((model) => model !== ""))];
  return Promise.all(
    distinct.map((model) =>
      canaryModel({
        baseUrl: input.baseUrl,
        bearer: input.bearer,
        model,
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
}

export async function writeFastLaneArtifacts(input: {
  artifactDir: string;
  runId: string;
  attemptId: string;
  provider: string;
  model: string;
  finalText: string;
  wallSeconds: number;
  usage?: Record<string, number>;
  error?: string;
}) {
  await mkdir(input.artifactDir, { recursive: true });
  await writeFile(
    join(input.artifactDir, "report.json"),
    JSON.stringify({ finalText: input.finalText }, null, 2),
  );
  await writeFile(
    join(input.artifactDir, "local-receipt.json"),
    JSON.stringify(
      {
        runId: input.runId,
        attemptId: input.attemptId,
        outcome: input.error ? "failed" : "completed",
        provider: input.provider,
        model: input.model,
        wallSeconds: input.wallSeconds,
        teardownSeconds: 0,
        usage: input.usage ?? {},
        error: input.error ?? null,
        shutdown: { truncatedArtifacts: [] },
      },
      null,
      2,
    ),
  );
}
