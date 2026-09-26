import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelsJsonForProxy } from "../model-proxy";

const PROVIDER = "cloudflare-workers-ai";
const MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const HANDLE = "review-pi-00000000-0000-4000-8000-000000000000";
const BASE_URL = "https://review.example.workers.dev/model/run-1/cap-1";

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

// Drives Pi 0.85.1's own model runtime over the models.json the Worker writes
// for a workers-ai lane, so the catalog entry, the lane's override and the
// request builder are all Pi's, and returns what the model proxy receives.
// Pi's agent turns `--thinking off` into no `reasoning` at all.
const laneRequest = async (reasoning: "medium" | undefined) => {
  const image = await readFile(
    fileURLToPath(new URL("../../container/models.json", import.meta.url)),
    "utf8",
  );
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    modelsJsonForProxy(image, PROVIDER, HANDLE, BASE_URL),
  );
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
      tools: [],
    },
    {
      ...(reasoning ? { reasoning } : {}),
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
  // Workers AI documents `reasoning_effort` (max, high, low, none) for this
  // model and no `thinking` field, so `thinking: {type: "disabled"}` streamed
  // a full reasoning phase in the report turn.
  it("sends reasoning_effort none on the report turn's --thinking off", async () => {
    const body = await laneRequest(undefined);

    expect(body).toMatchObject({ model: MODEL, reasoning_effort: "none" });
    expect(body).not.toHaveProperty("thinking");
  });

  // Pi's default thinking level is medium, which this model's catalog entry
  // clamps to high: the level the tool turns ran at before.
  it("keeps the tool turns at reasoning_effort high", async () => {
    const body = await laneRequest("medium");

    expect(body).toMatchObject({ model: MODEL, reasoning_effort: "high" });
  });
});
