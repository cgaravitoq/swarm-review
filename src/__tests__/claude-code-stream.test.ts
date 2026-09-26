import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { modelsJsonForProxy } from "../model-proxy";

const PI_CLI = fileURLToPath(
  new URL(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    import.meta.url,
  ),
);
const MODELS = fileURLToPath(
  new URL("../../container/models.json", import.meta.url),
);
const PROVIDER = fileURLToPath(
  new URL("../../container/claude-code-provider.js", import.meta.url),
);
const PATH = "/model/run-1/cap-1";
const HANDLE = "handle-not-a-credential";
const MARKER = "Review only the diff of this pull request.";

type Received = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: {
    model?: string;
    messages?: { content: { type: string; text?: string }[] }[];
    tools?: { name: string }[];
  };
};

const sse = (event: { type: string; [key: string]: unknown }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const reply = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "pong" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map(sse)
  .join("");

let dir: string;
let laneServer: Server | undefined;
let laneChild: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-code-stream-"));
});

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

// Pi 0.86 moved the system prompt and the tools out of the context a custom
// stream receives, so a Claude Code stream that still reads them the old way
// posts a lane's request with neither, and nothing downstream fails. The
// stream carries the lane's system prompt in the first user message, since
// Anthropic answers a subscription token only under Claude Code's own.
it("sends a claude-code lane's system prompt and tools through the Pi and stream the suite pins", async () => {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(reply);
    });
  });
  laneServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(
    join(dir, "models.json"),
    modelsJsonForProxy(
      readFileSync(MODELS, "utf8"),
      "claude-code",
      HANDLE,
      `http://127.0.0.1:${port}${PATH}`,
    ),
  );
  const child = spawn(
    process.execPath,
    [
      PI_CLI,
      "--provider",
      "claude-code",
      "--model",
      "claude-opus-5-5",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      PROVIDER,
      "--tools",
      "read,grep",
      "--append-system-prompt",
      MARKER,
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
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );

  expect(exitCode, stderr).toBe(0);
  expect(received).toHaveLength(1);
  const [request] = received;
  expect(request?.method).toBe("POST");
  expect(request?.url).toBe(`${PATH}/v1/messages`);
  expect(request?.headers.authorization).toBe(`Bearer ${HANDLE}`);
  expect(request?.body.model).toBe("claude-opus-5-5");
  const [prompt] = request?.body.messages?.[0]?.content ?? [];
  expect(prompt?.text).toContain(`<addendum>\n${MARKER}\n</addendum>`);
  expect(request?.body.tools?.map((tool) => tool.name)).toEqual([
    "mcp_Read",
    "mcp_Grep",
  ]);
});
