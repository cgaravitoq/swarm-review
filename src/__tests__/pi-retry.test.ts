import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsJsonForProxy } from "../model-proxy";

// The settings.json the Worker writes, pinned in worker.test.ts.
const REVIEW_SETTINGS = {
  retry: {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 1000,
    provider: { maxRetries: 0 },
  },
};
const PROBE_SETTINGS = {
  retry: { enabled: false, provider: { maxRetries: 0 } },
};

const PI_CLI = fileURLToPath(
  new URL(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    import.meta.url,
  ),
);
const MODELS = fileURLToPath(
  new URL("../../container/models.json", import.meta.url),
);
const PATH = "/model/run-1/cap-1";
const STREAM_ENDED =
  "OpenAI Responses stream ended before a terminal response event";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const HANDLE = `${b64({ alg: "none" })}.${b64({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-fake" },
  exp: 4102444800,
})}.fake`;

type Received = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: { model?: string };
};

const sse = (event: { type: string; [key: string]: unknown }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const created = sse({
  type: "response.created",
  response: { id: "resp_1", status: "in_progress" },
});
const MESSAGE = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "pong", annotations: [] }],
};
const completed = [
  { type: "response.output_item.added", output_index: 0, item: MESSAGE },
  {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: "pong",
  },
  { type: "response.output_item.done", output_index: 0, item: MESSAGE },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
  },
]
  .map(sse)
  .join("");

let dir: string;
let laneServer: Server | undefined;
let laneChild: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-retry-"));
});

// Runs on a timed-out test too, so a hung Pi leaves no process or listener.
afterEach(async () => {
  const pid = laneChild?.pid;
  laneChild = undefined;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
  const server = laneServer;
  laneServer = undefined;
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(dir, { recursive: true, force: true });
});

// Runs Pi 0.85.1's own CLI as a lane runs it, on the openai-codex models.json
// the Worker writes, against a model proxy whose first stream ends before a
// terminal event, as verifier-c5's did on the dev Worker, and whose second
// completes. The WebSocket upgrade is refused, so Pi falls back to the POST.
const runLane = async (settings: unknown) => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body =
        request.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(raw)
          : raw;
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(body.toString()),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(received.length === 1 ? created : `${created}${completed}`);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  laneServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(
    join(dir, "models.json"),
    modelsJsonForProxy(
      readFileSync(MODELS, "utf8"),
      "openai-codex",
      HANDLE,
      `http://127.0.0.1:${port}${PATH}`,
    ),
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  const child = spawn(
    process.execPath,
    [
      PI_CLI,
      "--provider",
      "openai-codex",
      "--model",
      "gpt-6-luna",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--approve",
      "--",
      "Reply with exactly pong and nothing else.",
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: dir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_CODING_AGENT_DIR: dir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  laneChild = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          delayMs?: number;
          errorMessage?: string;
          messages?: {
            role: string;
            stopReason?: string;
            errorMessage?: string;
            content: { type: string; text?: string }[];
          }[];
        },
    );
  const last = events
    .filter((event) => event.type === "agent_end")
    .at(-1)
    ?.messages?.at(-1);
  return { exitCode, stderr, received, events, last };
};

const expectLaneRequests = (received: Received[], count: number) => {
  expect(received).toHaveLength(count);
  for (const request of received) {
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${PATH}/codex/responses`);
    expect(request.headers.authorization).toBe(`Bearer ${HANDLE}`);
    expect(request.headers["chatgpt-account-id"]).toBe("acct-fake");
    expect(request.body.model).toBe("gpt-6-luna");
  }
};

describe("Pi's agent-level retry under a lane's settings.json", () => {
  it("retries a stream that ends early and completes on review settings", async () => {
    const run = await runLane(REVIEW_SETTINGS);
    expect(run.exitCode, run.stderr).toBe(0);
    expectLaneRequests(run.received, 2);
    expect(
      run.events.filter((event) => event.type === "auto_retry_start"),
    ).toEqual([
      expect.objectContaining({ delayMs: 1000, errorMessage: STREAM_ENDED }),
    ]);
    expect(run.last).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "pong" }],
    });
  });

  it("fails on the first early end on probe settings", async () => {
    const run = await runLane(PROBE_SETTINGS);
    expectLaneRequests(run.received, 1);
    expect(run.events.map((event) => event.type)).not.toContain(
      "auto_retry_start",
    );
    expect(run.last).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: STREAM_ENDED,
    });
  });
});
