import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsJsonForProxy } from "../model-proxy";

const PROVIDER = "cloudflare-workers-ai";
const MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const HANDLE = "review-pi-00000000-0000-4000-8000-000000000000";
const BASE_URL = "https://review.example.workers.dev/model/run-1/cap-1";

// Pi's declarations reference @types/node ahead of @cloudflare/workers-types,
// which flips the global `process` the rest of the program compiles against,
// so Pi is loaded through a specifier the compiler does not resolve.
const PI = "@earendil-works/pi-coding-agent";

type PiModel = { id: string; provider: string };

type PiRuntime = {
  getModel(provider: string, id: string): PiModel | undefined;
  streamSimple(
    model: PiModel,
    context: {
      messages: {
        role: "user";
        content: { type: "text"; text: string }[];
        timestamp: number;
      }[];
      tools: {
        name: string;
        description: string;
        parameters: { type: "object"; properties: Record<string, never> };
      }[];
    },
    options: {
      reasoning?: "medium";
      maxRetries: number;
      fetch: (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
    },
  ): { result(): Promise<{ stopReason: string }> };
};

type PiModule = {
  ModelRuntime: {
    create(options: {
      modelsPath: string;
      authPath: string;
    }): Promise<PiRuntime>;
  };
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workers-ai-thinking-"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
  vi.stubGlobal("fetch", () => {
    throw new Error("unexpected network request");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

// Drives the image's Pi model runtime over the models.json the Worker writes
// for a workers-ai lane, so the catalog entry, the lane's override and the
// request builder are all Pi's, and returns what the model proxy receives.
// The report turn runs at `--thinking off`, which Pi's agent turns into no
// `reasoning` at all, with no tools; a tool turn runs at Pi's default, medium.
const READ_TOOL = {
  name: "read",
  description: "Read a file.",
  parameters: { type: "object" as const, properties: {} },
};

const laneRequest = async (turn: "report" | "tool") => {
  const image = await readFile(
    fileURLToPath(new URL("../../container/models.json", import.meta.url)),
    "utf8",
  );
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    modelsJsonForProxy(image, PROVIDER, HANDLE, BASE_URL),
  );
  const { ModelRuntime } = (await import(PI)) as PiModule;
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(dir, "auth.json"),
  });
  const model = runtime.getModel(PROVIDER, MODEL);
  if (!model) throw new Error(`${MODEL} missing from Pi's catalog`);
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const events = runtime.streamSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Write the report." }],
          timestamp: 0,
        },
      ],
      tools: turn === "tool" ? [READ_TOOL] : [],
    },
    {
      ...(turn === "tool" ? { reasoning: "medium" as const } : {}),
      maxRetries: 0,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("stubbed", { status: 500 });
      },
    },
  );
  await events.result();
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) throw new Error("no request");
  expect(request.url).toBe(`${BASE_URL}/chat/completions`);
  expect(request.headers.get("authorization")).toBe(`Bearer ${HANDLE}`);
  return request.body;
};

describe("the workers-ai DeepSeek lane", () => {
  // Against the model, `reasoning_effort: "none"` still reasoned and
  // `chat_template_kwargs: {thinking: false}` did not, so the report turn
  // switches thinking off through the chat template.
  it("turns thinking off through the chat template on the report turn", async () => {
    const body = await laneRequest("report");

    expect(body).toMatchObject({
      model: MODEL,
      chat_template_kwargs: { thinking: false },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });

  // With no `reasoning_effort` the model runs at its default, high: the level
  // the tool turns ran at before.
  it("keeps thinking on through the chat template on a tool turn", async () => {
    const body = await laneRequest("tool");

    expect(body).toMatchObject({
      model: MODEL,
      tools: [{ type: "function", function: { name: "read" } }],
      chat_template_kwargs: { thinking: true },
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});
