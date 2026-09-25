import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deployArguments,
  imageBuildArguments,
  targetCheckout,
} from "../../scripts/deploy";
import { main } from "../../scripts/probe";
import { gitCapability } from "../git-proxy";
import { CONTROL_DIR, MODEL_BROKER, TARGET_UID } from "../isolation";
import { emptyModelTotals, modelCapability } from "../model-proxy";
import {
  IMAGE_SOURCES,
  MAX_ARTIFACT_BYTES,
  REVIEW_RUNNER,
  runDir,
} from "../protocol";

const getSandbox = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  getSandbox,
}));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const {
  default: handler,
  ReviewSandbox,
  CredentialVaultObject,
  CodexRelaySandbox,
} = await import("../../worker");

/** The bindings this suite gives the Worker, with the sandbox SDK mocked out. */
const env = {
  REVIEW_SANDBOX: {} as DurableObjectNamespace<
    InstanceType<typeof ReviewSandbox>
  >,
  CREDENTIAL_VAULT: {} as DurableObjectNamespace<
    InstanceType<typeof CredentialVaultObject>
  >,
  CODEX_RELAY: {} as DurableObjectNamespace<
    InstanceType<typeof CodexRelaySandbox>
  >,
  PROBE_RESULTS: {} as R2Bucket,
  CONTROL_SECRET: "control-secret",
  OPENCODE_API_KEY: "model-secret",
  WORKERS_AI_API_KEY: "workers-ai-secret",
  WORKERS_AI_ACCOUNT_ID: "account-id",
  GITHUB_READ_TOKEN: "github-token",
  TARGET_REPOSITORY: "https://github.com/acme/demo.git",
};

/**
 * The same bindings with no target repository, which the Worker must refuse.
 *
 * `exactOptionalPropertyTypes` will not let an explicit `undefined` stand in for
 * an absent optional property, and unsetting it is the whole point of the case,
 * so each caller casts at the boundary it is testing.
 */
const envWithoutTarget = { ...env, TARGET_REPOSITORY: undefined };

const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);

const expectedSources = (observed: Readonly<Record<string, string>> = {}) => ({
  ...Object.fromEntries(
    Object.keys(IMAGE_SOURCES).map((path) => [path, sha64]),
  ),
  ...observed,
});

/** What the fingerprint exec answers: one line per image source, then the versions. */
const fingerprintStdout = (observed: Readonly<Record<string, string>> = {}) =>
  `${Object.entries(expectedSources(observed))
    .map(([path, sha]) => `${sha}  ${path}`)
    .join("\n")}\npi 0.85.0\n1.4.0\ngit version 2.34.1\n`;

const broker = {
  port: 8317,
  handle: "review-pi-handle",
  upstreamBaseUrl: "https://api.x.ai/v1",
  upstreamAuthorization: "Bearer model-secret",
  caps: {
    maxRequests: 8,
    maxRetriesPerRequest: 1,
    maxCumulativeInputTokens: 1000,
    maxCumulativeOutputTokens: 1000,
    maxRequestBytes: 1024,
  },
  ledgerPath: `${CONTROL_DIR}/provider-usage.jsonl`,
};

const job = {
  runId: "run",
  expectedRunnerSha: sha64,
  expectedSources: expectedSources(),
  head: { sha: sha40 },
  base: { sha: sha40 },
  provider: "xai",
  model: "grok-4.6",
  thinking: "high",
  prompt: "review",
  checkCommand: "true",
  installTimeoutSeconds: 60,
  piTimeoutSeconds: 60,
  totalTimeoutSeconds: 60,
};

const authorized = (url: string, init?: RequestInit) =>
  new Request(url, {
    ...init,
    headers: {
      authorization: "Bearer control-secret",
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const startBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    job,
    broker,
    modelsJson: JSON.stringify({
      providers: { xai: { apiKey: "review-pi-handle" } },
    }),
    ...overrides,
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PROBE_RUN_ID =
  /^probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("operator probe", () => {
  it("starts a burst concurrently and prints each probe's key or error", async () => {
    const pending: ((response: Response) => void)[] = [];
    const fetchProbe = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fake-control-secret",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.workersAi).toEqual({
        accountId: "fake-account",
        bearer: "fake-workers-bearer",
      });
      expect(Object.keys(body.expectedSources)).toEqual(
        Object.keys(IMAGE_SOURCES),
      );
      expect(body).not.toHaveProperty("runId");
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    vi.stubGlobal("fetch", fetchProbe);
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((line) => {
        lines.push(String(line));
        return true;
      });
    try {
      const exit = main(["https://review.invalid", "5"], {
        CONTROL_SECRET: "fake-control-secret",
        CLOUDFLARE_ACCOUNT_ID: "fake-account",
        WORKERS_AI_API_KEY: "fake-workers-bearer",
      });
      await vi.waitFor(() => expect(pending).toHaveLength(5));
      for (const [index, resolve] of pending.entries()) {
        resolve(
          index === 2
            ? new Response(
                JSON.stringify({ error: "r2_put_failed", runId: "probe-2" }),
                { status: 500 },
              )
            : new Response(
                JSON.stringify({
                  key: `probes/probe-${index}.json`,
                  runId: `probe-${index}`,
                  status: "ok",
                }),
              ),
        );
      }
      expect(await exit).toBe(1);
    } finally {
      write.mockRestore();
    }
    expect(lines).toEqual([
      "probe-0 probes/probe-0.json ok\n",
      "probe-1 probes/probe-1.json ok\n",
      "probe 3 error HTTP 500 r2_put_failed\n",
      "probe-3 probes/probe-3.json ok\n",
      "probe-4 probes/probe-4.json ok\n",
    ]);
  });

  it("exits 1 when the Worker answers a probe with a status other than ok", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const run = (statuses: string[]) => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => {
          const index = call++;
          return new Response(
            JSON.stringify({
              key: `probes/probe-${index}.json`,
              runId: `probe-${index}`,
              status: statuses[index],
            }),
          );
        }),
      );
      return main(["https://review.invalid", String(statuses.length)], {
        CONTROL_SECRET: "fake-control-secret",
        CLOUDFLARE_ACCOUNT_ID: "fake-account",
        WORKERS_AI_API_KEY: "fake-workers-bearer",
      });
    };
    try {
      expect(await run(["ok", "ok"])).toBe(0);
      expect(await run(["ok", "failed"])).toBe(1);
    } finally {
      write.mockRestore();
    }
  });

  const laneModelsJson = readFileSync(
    path.join(import.meta.dirname, "../../container/models.json"),
    "utf8",
  );

  const PI_PATHS = new Map([
    ["workers-ai", "/chat/completions"],
    ["openai-codex", "/codex/responses"],
    ["claude-code", "/v1/messages"],
  ]);

  // Pi's --mode json events as a lane reads them: the last turn_end carries
  // the stop reason and, on failure, the provider's error message.
  const piEvents = (errorMessage: string | null) =>
    [
      {
        type: "turn_end",
        message: errorMessage
          ? { role: "assistant", stopReason: "error", errorMessage }
          : { role: "assistant", stopReason: "stop" },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: errorMessage ? [] : [{ type: "text", text: "pong" }],
          },
        ],
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

  const input = () => ({
    expectedSources: expectedSources(),
    workersAi: { accountId: "fake-account", bearer: "fake-workers-bearer" },
  });

  const setup = (
    failure?:
      | "cold"
      | "clone"
      | "claude"
      | "cap"
      | "relay"
      | "codex-400"
      | "codex-cancel"
      | "session"
      | "pi-exit",
  ) => {
    const files = new Map<string, string>([
      ["/opt/review/pi-config/models.json", laneModelsJson],
    ]);
    const stored = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async (key: string) => stored.delete(key),
    };
    const sandbox = new ReviewSandbox({} as never, env as never);
    Object.assign(sandbox, { ctx: { storage } });
    const destroy = vi.fn(async () => undefined);
    const putProbeSessions = sandbox.putProbeSessions.bind(sandbox);
    Object.assign(sandbox, {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string, body: string) => {
        files.set(path, body);
      }),
      putProbeSessions: vi.fn(async (sessions: Record<string, unknown>) => {
        if (failure === "session") throw new Error("session failed");
        await putProbeSessions(sessions as never);
      }),
      destroy,
    });
    const vault = {
      credential: vi.fn(async (provider: string) => ({
        authorization: `Bearer fake-${provider}-bearer`,
        ...(provider === "openai-codex"
          ? { accountId: "fake-codex-account" }
          : {}),
      })),
    };
    const object = {
      head: vi.fn(async (_key: string) => null),
      put: vi.fn(
        async (_key: string, _body: string, _options?: unknown) => undefined,
      ),
    };
    const relayProcess = {
      id: "relay",
      status: "running",
      command: "/usr/local/bun/bin/bun /opt/relay/server.ts",
      waitForPort: vi.fn(async () => undefined),
    };
    const relay = {
      listProcesses: vi.fn(async () => [relayProcess]),
      getProcess: vi.fn(async () => relayProcess),
      containerFetch: vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://codex-relay/codex/responses");
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("authorization")).toBe(
          "Bearer fake-openai-codex-bearer",
        );
        expect(new Headers(init.headers).get("chatgpt-account-id")).toBe(
          "fake-codex-account",
        );
        expect(JSON.parse(await new Response(init.body).text())).toEqual({
          model: "gpt-5.6-sol",
          family: "openai-codex",
        });
        if (failure === "relay") throw new Error("relay unavailable");
        if (failure === "codex-400")
          return new Response(JSON.stringify({ detail: "Unsupported model" }), {
            status: 400,
          });
        if (failure === "codex-cancel")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
                  ),
                );
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [{ content: [{ text: "pong" }] }],
          }),
        );
      }),
    };
    const probeEnv = {
      ...env,
      PROBE_RESULTS: Object.assign({} as R2Bucket, object),
      CREDENTIAL_VAULT: Object.assign({} as typeof env.CREDENTIAL_VAULT, {
        getByName: () => vault,
      }),
    };
    const direct = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(await new Response(init?.body).text());
      if (target.includes("api.cloudflare.com")) {
        expect(target).toBe(
          "https://api.cloudflare.com/client/v4/accounts/fake-account/ai/v1/chat/completions",
        );
        expect(headers.get("authorization")).toBe("Bearer fake-workers-bearer");
        expect(body).toEqual({
          model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
          family: "workers-ai",
        });
        return new Response("{}");
      }
      expect(target).toBe("https://api.anthropic.com/v1/messages");
      expect(headers.get("authorization")).toBe(
        "Bearer fake-claude-code-bearer",
      );
      expect(body).toEqual({ model: "claude-opus-5", family: "claude-code" });
      return failure === "claude" || failure === "cap"
        ? new Response("upstream failure", { status: 503 })
        : new Response("{}");
    });
    vi.stubGlobal("fetch", direct);
    const exec = vi.fn(async (command: string) => {
      if (command.includes("sha256sum")) {
        if (failure === "cold") throw new Error("cold failed");
        return { stdout: fingerprintStdout(), exitCode: 0 };
      }
      if (command.includes("git -c"))
        return { stdout: "", exitCode: failure === "clone" ? 1 : 0 };
      if (command.includes(" pi --provider ")) {
        const directory =
          command.match(/PI_CODING_AGENT_DIR='([^']+)'/)?.[1] ?? "";
        const provider = command.match(/--provider '([^']+)'/)?.[1] ?? "";
        const model = command.match(/--model '([^']+)'/)?.[1] ?? "";
        const family = directory.slice(directory.lastIndexOf("/pi-") + 4);
        if (failure === "pi-exit" && family === "workers-ai")
          return { stdout: "", exitCode: 7 };
        const configured = JSON.parse(
          files.get(`${directory}/models.json`) ?? "{}",
        ).providers[provider];
        const url = `${configured.baseUrl}${PI_PATHS.get(family)}`;
        const authorization = `Bearer ${configured.apiKey}`;
        // Pi retries a retryable assistant error unless its agent dir's
        // settings turn retries off, and its openai-codex transport tries a
        // WebSocket before the streamed POST.
        const settings = JSON.parse(
          files.get(`${directory}/settings.json`) ?? "{}",
        );
        const retries =
          failure === "cap" && family === "claude-code"
            ? 3
            : (settings.retry?.enabled ?? true)
              ? (settings.retry?.maxRetries ?? 3)
              : 0;
        let response: Response;
        let text: string;
        let attempt = 0;
        do {
          if (family === "openai-codex") {
            await (
              await handler.fetch(
                new Request(url, {
                  method: "GET",
                  headers: { authorization, upgrade: "websocket" },
                }),
                probeEnv,
              )
            ).text();
          }
          response = await handler.fetch(
            new Request(url, {
              method: "POST",
              headers: {
                authorization,
                "content-type": "application/json",
              },
              body: JSON.stringify({ model, family }),
            }),
            probeEnv,
          );
          if (failure === "codex-cancel" && family === "openai-codex") {
            const reader = response.body?.getReader();
            text = new TextDecoder().decode((await reader?.read())?.value);
            await reader?.cancel();
          } else {
            text = await response.text();
          }
          attempt += 1;
        } while (
          attempt <= retries &&
          (response.status === 429 || response.status >= 500)
        );
        files.set(
          `${directory}/events.jsonl`,
          piEvents(
            response.ok
              ? null
              : family === "openai-codex"
                ? text
                : `${response.status}: ${text}`,
          ),
        );
        return { stdout: "", exitCode: 0 };
      }
      if (command.includes(" jq -sc ")) {
        const path = command.match(/'([^']+\/events\.jsonl)'/)?.[1] ?? "";
        const summary = spawnSync(
          "sh",
          [
            "-c",
            command
              .replace(/^setpriv .*? --clear-groups /, "")
              .replace(` '${path}'`, ""),
          ],
          { input: files.get(path) ?? "", encoding: "utf8" },
        );
        return { stdout: summary.stdout, exitCode: summary.status ?? 1 };
      }
      if (command.startsWith("stat -c")) {
        const path = command.match(/'([^']+)'/)?.[1] ?? "";
        return {
          stdout: files.has(path) ? `${files.get(path)?.length}\n` : "-1\n",
          exitCode: 0,
        };
      }
      if (command.startsWith("head -c")) {
        const path = command.match(/'([^']+)'/)?.[1] ?? "";
        return { stdout: files.get(path) ?? "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    Object.assign(sandbox, { exec });
    getSandbox.mockClear();
    getSandbox.mockImplementation((_namespace: unknown, id: string) =>
      id === "swarm-review-codex-egress" ? relay : sandbox,
    );
    return {
      sandbox,
      destroy,
      exec,
      direct,
      relay,
      vault,
      object,
      probeEnv,
      files,
      stored,
    };
  };

  it("runs Pi once per family through the model proxy and stores a timed R2 receipt", async () => {
    const fixture = setup();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method),
    );
    const response = await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    const logged = JSON.stringify(logs.map((log) => log.mock.calls));
    for (const log of logs) log.mockRestore();
    for (const bearer of [
      "fake-workers-bearer",
      "fake-openai-codex-bearer",
      "fake-claude-code-bearer",
    ])
      expect(logged).not.toContain(bearer);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runId: string };
    expect(body).toEqual({
      key: `probes/${body.runId}.json`,
      runId: expect.stringMatching(PROBE_RUN_ID),
      status: "ok",
    });
    expect(fixture.direct).toHaveBeenCalledTimes(2);
    expect(fixture.relay.containerFetch).toHaveBeenCalledOnce();
    expect(fixture.vault.credential.mock.calls.map((call) => call[0])).toEqual([
      "openai-codex",
      "openai-codex",
      "claude-code",
    ]);
    const piCommands = fixture.exec.mock.calls
      .map((call) => call[0])
      .filter((command) => command.includes(" pi --provider "));
    const capability = await modelCapability(body.runId, env.CONTROL_SECRET);
    const lane = JSON.parse(laneModelsJson).providers;
    const handles: string[] = [];
    for (const [index, [family, provider, model]] of (
      [
        [
          "workers-ai",
          "cloudflare-workers-ai",
          "@cf/deepseek-ai/deepseek-v4-flash-0731",
        ],
        ["openai-codex", "openai-codex", "gpt-5.6-sol"],
        ["claude-code", "claude-code", "claude-opus-5"],
      ] as const
    ).entries()) {
      const directory = `/workspace/runs/${body.runId}/pi-${family}`;
      const account =
        family === "workers-ai" ? "CLOUDFLARE_ACCOUNT_ID='fake-account' " : "";
      const extension =
        family === "claude-code"
          ? " -e '/opt/review/extensions/claude-code-provider.js'"
          : "";
      expect(piCommands[index]).toBe(
        `cd '${directory}' && setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups env HOME=/home/review-target PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ${account}PI_CODING_AGENT_DIR='${directory}' timeout -k 5 100 pi --provider '${provider}' --model '${model}' --thinking high --mode json --print --no-session --no-extensions --no-skills --no-prompt-templates --approve${extension} -- 'Reply with exactly pong and nothing else.' < /dev/null > events.jsonl 2> pi.stderr`,
      );
      const models = JSON.parse(
        fixture.files.get(`${directory}/models.json`) ?? "",
      );
      const apiKey = models.providers[provider].apiKey;
      expect(models.providers[provider]).toEqual({
        ...lane[provider],
        apiKey,
        baseUrl: `https://review.invalid/model/${body.runId}/${capability}`,
      });
      expect(
        JSON.parse(fixture.files.get(`${directory}/settings.json`) ?? ""),
      ).toEqual({
        retry: { enabled: false, provider: { maxRetries: 0 } },
      });
      handles.push(apiKey);
    }
    expect(piCommands).toHaveLength(3);
    expect(handles[0]).toMatch(/^review-pi-[0-9a-f-]{36}$/);
    expect(handles[1]?.split(".")).toHaveLength(3);
    expect(
      JSON.parse(atob(handles[1]?.split(".")[1] ?? ""))[
        "https://api.openai.com/auth"
      ],
    ).toEqual({ chatgpt_account_id: "review-pi" });
    expect(handles[2]).toMatch(/^review-pi-[0-9a-f-]{36}$/);
    const cloneCommand = fixture.exec.mock.calls.find((call) =>
      call[0].includes("git -c"),
    )?.[0];
    expect(cloneCommand).toMatch(
      /^setpriv --reuid=1102 --regid=1102 --clear-groups git /,
    );
    expect(cloneCommand).toContain("clone --depth 1 --no-tags");
    expect(fixture.object.put).toHaveBeenCalledOnce();
    const [key, raw] = fixture.object.put.mock.calls[0] ?? [];
    expect(key).toBe(`probes/${body.runId}.json`);
    const receipt = JSON.parse(raw ?? "");
    expect(Object.keys(receipt)).toEqual([
      "runId",
      "clock",
      "startedAt",
      "coldStart",
      "clone",
      "sessionSetup",
      "models",
      "sessionClear",
      "shutdown",
    ]);
    expect(receipt.clock).toBe("worker.performance.now");
    expect(Object.keys(receipt.models)).toEqual([
      "workers-ai",
      "openai-codex",
      "claude-code",
    ]);
    expect(fixture.object.put.mock.calls[0]?.[2]).toEqual({
      httpMetadata: { contentType: "application/json" },
    });
    for (const phase of [
      receipt.coldStart,
      receipt.clone,
      receipt.sessionSetup,
      ...Object.values(receipt.models),
      receipt.sessionClear,
      receipt.shutdown,
    ] as { status: string; durationMs: number }[]) {
      expect(phase.status).toBe("ok");
      expect(phase.durationMs).toBeGreaterThan(0);
    }
    for (const family of Object.values(receipt.models))
      expect(family).toMatchObject({ httpStatus: 200, reason: null });
    expect(raw).not.toContain("fake-workers-bearer");
    expect(raw).not.toContain("fake-openai-codex-bearer");
    expect(JSON.stringify([...fixture.files.values()])).not.toContain(
      "fake-workers-bearer",
    );
    expect(JSON.stringify(fixture.exec.mock.calls)).not.toContain(
      "fake-workers-bearer",
    );
    expect(fixture.stored.has("probeSessions")).toBe(false);
    expect(fixture.stored.get("modelSeals")).toBeUndefined();
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it("records a family whose Pi exits nonzero without hiding the families after it", async () => {
    const fixture = setup("pi-exit");
    await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    const receipt = JSON.parse(fixture.object.put.mock.calls[0]?.[1] ?? "");
    expect(receipt.models["workers-ai"]).toMatchObject({
      status: "failed",
      phase: "model_request",
      httpStatus: null,
      reason: "pi_exit",
    });
    expect(receipt.models["openai-codex"].status).toBe("ok");
    expect(receipt.models["claude-code"].status).toBe("ok");
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });

  it("uses the streamed POST status for a successful Codex probe after Pi cancels", async () => {
    const fixture = setup("codex-cancel");
    const attempts = vi.spyOn(fixture.sandbox, "recordModelAttempt");
    await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    const receipt = JSON.parse(fixture.object.put.mock.calls[0]?.[1] ?? "");
    expect(receipt.models["openai-codex"]).toMatchObject({
      status: "ok",
      httpStatus: 200,
      reason: null,
    });
    expect(fixture.relay.containerFetch).toHaveBeenCalledOnce();
    expect(
      attempts.mock.calls
        .map((call) => call[4])
        .filter((outcome) => outcome.reason === "codex_relay_non_post"),
    ).toEqual([{ httpStatus: null, reason: "codex_relay_non_post" }]);
    expect(
      attempts.mock.calls
        .map((call) => call[4])
        .filter((outcome) => outcome.httpStatus === 200),
    ).toHaveLength(3);
  });

  it("refuses to overwrite an existing receipt before starting a Sandbox", async () => {
    const fixture = setup();
    fixture.object.head.mockResolvedValueOnce({} as never);
    const response = await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "probe_exists" });
    expect(fixture.exec).not.toHaveBeenCalled();
    expect(fixture.object.put).not.toHaveBeenCalled();
    expect(fixture.destroy).not.toHaveBeenCalled();
  });

  it("keeps probe sessions apart from a run's own model session", async () => {
    const fixture = setup();
    const probe = {
      handle: "probe-handle",
      upstreamBaseUrl: "https://api.anthropic.com",
      credentialProvider: "claude-code",
      caps: {
        maxRequests: 1,
        maxRetriesPerRequest: 0,
        maxCumulativeInputTokens: 1,
        maxCumulativeOutputTokens: 1,
        maxRequestBytes: 1,
      },
      totals: emptyModelTotals(),
    };
    await fixture.sandbox.putModelSession({ ...probe, handle: "run" });
    await fixture.sandbox.putProbeSessions({ "probe-handle": probe });
    expect(await fixture.sandbox.openModelSession("run")).toBeNull();
    expect(await fixture.sandbox.consumeModelAttempt("run")).toEqual({
      ok: false,
      reason: "no_session",
    });
    expect(
      (await fixture.sandbox.openModelSession("probe-handle"))?.handle,
    ).toBe("probe-handle");
  });

  it.each([
    "cold",
    "clone",
    "claude",
    "cap",
    "relay",
    "codex-400",
    "session",
  ] as const)(
    "destroys after %s failure and records the failed phase",
    async (failure) => {
      const fixture = setup(failure);
      await handler.fetch(
        authorized("https://review.invalid/probe", {
          method: "POST",
          body: JSON.stringify(input()),
        }),
        fixture.probeEnv,
      );
      const raw = fixture.object.put.mock.calls[0]?.[1] ?? "";
      const receipt = JSON.parse(raw);
      expect(fixture.destroy).toHaveBeenCalledOnce();
      expect(receipt.shutdown.status).toBe("ok");
      if (failure === "cold") {
        expect(receipt.coldStart).toMatchObject({
          status: "failed",
          phase: "source_fingerprint",
        });
        expect(receipt.clone).toMatchObject({
          status: "unobserved",
          durationMs: null,
        });
      }
      if (failure === "clone")
        expect(receipt.clone).toMatchObject({
          status: "failed",
          phase: "git_clone",
        });
      const anthropicAttempts = fixture.direct.mock.calls.filter((call) =>
        String(call[0]).startsWith("https://api.anthropic.com/"),
      ).length;
      if (failure === "claude") {
        expect(anthropicAttempts).toBe(1);
        expect(receipt.models["claude-code"]).toMatchObject({
          status: "failed",
          phase: "model_request",
          httpStatus: 503,
          reason: "model_error",
        });
        expect(receipt.models["workers-ai"].status).toBe("ok");
        expect(receipt.models["openai-codex"].status).toBe("ok");
      }
      if (failure === "cap") {
        expect(anthropicAttempts).toBe(2);
        expect(receipt.models["claude-code"]).toMatchObject({
          status: "failed",
          phase: "model_request",
          httpStatus: 429,
          reason: "max_requests",
        });
      }
      if (failure === "relay" || failure === "codex-400") {
        expect(fixture.relay.containerFetch).toHaveBeenCalledOnce();
        expect(receipt.models["openai-codex"]).toMatchObject({
          status: "failed",
          phase: "model_request",
          ...(failure === "relay"
            ? { httpStatus: 502, reason: "codex_relay_failed" }
            : { httpStatus: 400, reason: "model_error" }),
        });
        expect(receipt.models["workers-ai"].status).toBe("ok");
        expect(receipt.models["claude-code"].status).toBe("ok");
      }
      if (failure === "session") {
        expect(receipt.sessionSetup).toMatchObject({
          status: "failed",
          phase: "session_setup",
        });
        expect(receipt.models["workers-ai"]).toMatchObject({
          status: "unobserved",
          durationMs: null,
        });
      }
    },
  );

  it("names the probe's Durable Object itself, whatever run id the request carries", async () => {
    const fixture = setup();
    const response = await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify({ ...input(), runId: "live-run" }),
      }),
      fixture.probeEnv,
    );
    const body = (await response.json()) as { runId: string };
    expect(body.runId).toMatch(PROBE_RUN_ID);
    const ids = getSandbox.mock.calls.map((call) => call[1]);
    expect(ids).not.toContain("live-run");
    expect([
      ...new Set(ids.filter((id) => id !== "swarm-review-codex-egress")),
    ]).toEqual([body.runId]);
    expect(fixture.object.put.mock.calls[0]?.[0]).toBe(
      `probes/${body.runId}.json`,
    );
  });

  it("records a phase that fails before any I/O as unobserved, not measured", async () => {
    const fixture = setup("cold");
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      await handler.fetch(
        authorized("https://review.invalid/probe", {
          method: "POST",
          body: JSON.stringify(input()),
        }),
        fixture.probeEnv,
      );
    } finally {
      now.mockRestore();
    }
    const receipt = JSON.parse(fixture.object.put.mock.calls[0]?.[1] ?? "");
    expect(receipt.coldStart).toEqual({
      status: "failed",
      durationMs: null,
      durationReason: "no_clock_delta",
      phase: "source_fingerprint",
      httpStatus: null,
      reason: "sandbox_exec_failed",
    });
    expect(receipt.clone).toMatchObject({
      durationMs: null,
      durationReason: "not_started",
    });
  });

  it("refuses an unauthenticated probe before starting a Sandbox", async () => {
    const fixture = setup();
    const response = await handler.fetch(
      new Request("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    expect(response.status).toBe(401);
    expect(fixture.exec).not.toHaveBeenCalled();
    expect(fixture.object.put).not.toHaveBeenCalled();
  });

  it("destroys the Sandbox and names r2_put_failed when R2 rejects the receipt", async () => {
    const fixture = setup();
    fixture.object.put.mockRejectedValueOnce(new Error("R2 failed"));
    const response = await handler.fetch(
      authorized("https://review.invalid/probe", {
        method: "POST",
        body: JSON.stringify(input()),
      }),
      fixture.probeEnv,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "r2_put_failed",
      runId: expect.stringMatching(PROBE_RUN_ID),
    });
    expect(fixture.destroy).toHaveBeenCalledOnce();
    expect(fixture.stored.has("probeSessions")).toBe(false);
  });
});

const sandboxForStart = () => {
  const startProcess = vi.fn(
    (command: string, _options?: { env?: Record<string, string> }) =>
      Promise.resolve({
        id: command.includes("model-broker") ? "broker" : "review",
      }),
  );
  const write = vi.fn((_path: string, _content: string) => Promise.resolve());
  getSandbox.mockReturnValue({
    exec: vi.fn((command: string) => {
      if (command.includes("sha256sum")) {
        return Promise.resolve({ stdout: fingerprintStdout() });
      }
      if (command.includes("/api/execute")) {
        return Promise.resolve({ stdout: "403" });
      }
      if (command.includes("DENIED") || command.includes("1102")) {
        return Promise.resolve({ stdout: "DENIED\n" });
      }
      if (command.includes("READABLE")) {
        return Promise.resolve({ stdout: "READABLE\n" });
      }
      if (command.includes("curl -s -o /dev/null")) {
        return Promise.resolve({ stdout: "401" });
      }
      return Promise.resolve({ stdout: "" });
    }),
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: write,
    startProcess,
    putModelSession: vi.fn(() => Promise.resolve()),
    consumeModelAttempt: vi.fn(),
    recordModelAttempt: vi.fn(),
    getContainerPlacementId: vi.fn(() => Promise.resolve("placement")),
    destroy: vi.fn(() => Promise.resolve()),
    listProcesses: vi.fn(() => Promise.resolve([])),
  });
  return { startProcess, write };
};

const sandboxForProbeStart = (probe: {
  status: string;
  body: string | null;
}) => {
  const startProcess = vi.fn((_command: string) =>
    Promise.resolve({ id: "review" }),
  );
  const destroy = vi.fn(() => Promise.resolve());
  const exec = vi.fn((command: string) => {
    if (command.includes("sha256sum")) {
      return Promise.resolve({ stdout: fingerprintStdout() });
    }
    if (command.includes("/api/execute")) {
      return Promise.resolve({ stdout: probe.status });
    }
    if (command.includes("control-api-probe")) {
      if (command.startsWith("stat")) {
        return Promise.resolve({
          stdout: probe.body === null ? "-1\n" : `${probe.body.length}\n`,
        });
      }
      return Promise.resolve({ stdout: probe.body ?? "" });
    }
    return Promise.resolve({ stdout: "" });
  });
  getSandbox.mockReturnValue({
    exec,
    startProcess,
    destroy,
    mkdir: vi.fn(() => Promise.resolve()),
    writeFile: vi.fn(() => Promise.resolve()),
    putModelSession: vi.fn(() => Promise.resolve()),
    getContainerPlacementId: vi.fn(() => Promise.resolve("placement")),
  });
  return { exec, startProcess, destroy };
};

describe("worker-proxy credential isolation", () => {
  it("keeps the relay separate from review sandbox egress settings", () => {
    const relay = new CodexRelaySandbox({} as never, env as never);
    expect(relay.enableInternet).toBe(true);
    expect(relay.allowedHosts).toEqual(["chatgpt.com"]);
    expect(relay.interceptHttps).toBe(false);
    expect(new ReviewSandbox({} as never, env as never)).not.toHaveProperty(
      "allowedHosts",
    );
  });

  it("guards operator routes and returns status without a credential", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const vault = {
      seed: vi.fn(async () => undefined),
      status: vi.fn(async () => [
        {
          provider: "claude-code",
          expiry: null,
          lastRefresh: "2026-09-25T00:00:00.000Z",
        },
      ]),
    };
    const operatorEnv = {
      ...env,
      CREDENTIAL_VAULT: Object.assign({} as typeof env.CREDENTIAL_VAULT, {
        getByName: () => vault,
      }),
    };
    const unauthorized = await handler.fetch(
      new Request("https://review.invalid/credentials"),
      operatorEnv,
    );
    expect(unauthorized.status).toBe(401);
    expect(vault.status).not.toHaveBeenCalled();
    const refusedSeed = await handler.fetch(
      new Request("https://review.invalid/credentials/claude-code", {
        method: "PUT",
        body: JSON.stringify({ token: "fake-claude-token" }),
      }),
      operatorEnv,
    );
    expect(refusedSeed.status).toBe(401);
    expect(vault.seed).not.toHaveBeenCalled();
    const seeded = await handler.fetch(
      authorized("https://review.invalid/credentials/claude-code", {
        method: "PUT",
        body: JSON.stringify({ token: "fake-claude-token" }),
      }),
      operatorEnv,
    );
    expect(seeded.status).toBe(200);
    const listed = await handler.fetch(
      authorized("https://review.invalid/credentials"),
      operatorEnv,
    );
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain("fake-claude-token");
    expect(await seeded.text()).not.toContain("fake-claude-token");
    expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toContain(
      "fake-claude-token",
    );
  });

  it("starts a vault-backed run without putting a bearer in its session", async () => {
    const { write } = sandboxForStart();
    const sandbox = getSandbox();
    const operatorEnv = {
      ...env,
      CREDENTIAL_VAULT: Object.assign({} as typeof env.CREDENTIAL_VAULT, {
        getByName: () => ({
          status: async () => [
            {
              provider: "claude-code",
              expiry: null,
              lastRefresh: "2026-09-25T00:00:00.000Z",
            },
          ],
        }),
      }),
    };
    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody({
          job: { ...job, provider: "claude-code" },
          broker: {
            ...broker,
            upstreamBaseUrl: "https://api.anthropic.com",
            upstreamAuthorization: undefined,
          },
        }),
      }),
      operatorEnv,
    );
    expect(response.status).toBe(200);
    expect(sandbox.putModelSession).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProvider: "claude-code" }),
    );
    expect(sandbox.putModelSession.mock.calls[0]?.[0]).not.toHaveProperty(
      "upstreamAuthorization",
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain("model-secret");
  });

  it("keeps the bearer in the DO session and starts the review as 1102", async () => {
    const { startProcess, write } = sandboxForStart();

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(startProcess).toHaveBeenCalledOnce();
    expect(startProcess.mock.calls[0]?.[0]).toContain(`--reuid=${TARGET_UID}`);
    expect(startProcess.mock.calls[0]?.[1]?.env).toBeUndefined();
    const brokerWrite = write.mock.calls.find((call) =>
      String(call[0]).endsWith("/broker.json"),
    );
    const jobWrite = write.mock.calls.find((call) =>
      String(call[0]).endsWith("/job.json"),
    );
    const modelsWrite = write.mock.calls.find((call) =>
      String(call[0]).endsWith("/models.json"),
    );
    expect(brokerWrite).toBeUndefined();
    expect(String(jobWrite?.[1])).not.toContain("model-secret");
    expect(String(modelsWrite?.[1])).not.toContain("model-secret");
    expect(String(modelsWrite?.[1])).toContain("/model/run/");
    expect(await response.json()).toMatchObject({
      credentialIsolation: { mode: "worker-proxy" },
    });
  });

  it("refuses to start a run when the target repository is unset", async () => {
    const { startProcess } = sandboxForStart();

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      envWithoutTarget as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "target_repository_unset",
    });
    expect(startProcess).not.toHaveBeenCalled();
  });

  it("refuses to proxy git when the target repository is unset", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", upstream);
    const runId = "run-1";
    const capability = await gitCapability(runId, "control-secret");

    const response = await handler.fetch(
      new Request(
        `https://review.invalid/git/${capability}/info/refs?service=git-upload-pack`,
        { headers: { "x-review-run": runId } },
      ),
      envWithoutTarget as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "target_repository_unset",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects the legacy key-in-env start body", async () => {
    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: JSON.stringify({
          runId: "run",
          expectedRunnerSha: sha64,
          provider: "opencode-go",
          totalTimeoutSeconds: 60,
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
  });

  it("records the control API escape it observed and still starts the lane", async () => {
    const { exec, startProcess, destroy } = sandboxForProbeStart({
      status: "200",
      body: JSON.stringify({ stdout: "0\n" }),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      probes: {
        controlApi: {
          httpStatus: 200,
          uid: 0,
          reason: "control_api_runs_privileged",
          escaped: true,
        },
      },
    });
    expect(startProcess).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("/api/execute"));
  });

  it("reports the broker read as unobserved rather than probing for a config it never stages", async () => {
    const { exec } = sandboxForProbeStart({
      status: "403",
      body: null,
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      probes: {
        targetReadBroker: { verdict: null, reason: "broker_config_not_staged" },
      },
    });
    expect(exec).not.toHaveBeenCalledWith(
      expect.stringContaining("broker.json"),
    );
  });

  it("starts a non-canary run whose control API answers as the target uid", async () => {
    const { startProcess, destroy } = sandboxForProbeStart({
      status: "200",
      body: JSON.stringify({ stdout: "1102\n" }),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      probes: {
        controlApi: { uid: 1102, reason: "contained", escaped: false },
      },
      credentialIsolation: { mode: "worker-proxy" },
    });
    expect(startProcess).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("review run lifecycle", () => {
  it("clips oversized artifacts through the real shell read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-pi-artifact-"));
    const directory = path.join(root, "artifact-shell");
    await mkdir(directory);
    await writeFile(
      path.join(directory, "status.json"),
      "x".repeat(MAX_ARTIFACT_BYTES + 17),
    );
    await writeFile(path.join(directory, "install.log"), "installed\n");
    const quotedDirectory = `'${directory.replaceAll("'", "'\\''")}'`;
    const exec = vi.fn(async (command: string) => {
      const platformCommand =
        process.platform === "darwin"
          ? command.replace("stat -c %s", "stat -f %z")
          : command;
      const result = spawnSync(
        "sh",
        [
          "-c",
          platformCommand.replaceAll(
            "/workspace/runs/artifact-shell",
            quotedDirectory,
          ),
        ],
        { encoding: "utf8" },
      );
      return { stdout: result.stdout, stderr: result.stderr };
    });
    getSandbox.mockReturnValue({
      exec,
      getContainerPlacementId: vi.fn(() => Promise.resolve("placement")),
      listProcesses: vi.fn(() => Promise.resolve([])),
      modelUsage: vi.fn(() => Promise.resolve(null)),
    });

    try {
      const response = await handler.fetch(
        authorized("https://review.invalid/runs/artifact-shell/state"),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              path: "/workspace/runs/artifact-shell/status.json",
              exists: true,
              bytes: MAX_ARTIFACT_BYTES + 17,
              truncated: true,
              content: expect.stringMatching(
                new RegExp(`^x{${MAX_ARTIFACT_BYTES}}$`),
              ),
            }),
            expect.objectContaining({
              path: "/workspace/runs/artifact-shell/install.log",
              exists: true,
              content: "installed\n",
            }),
          ]),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("destroys a sandbox rejected by the source fingerprint gate", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    getSandbox.mockReturnValue({
      exec: vi.fn(() =>
        Promise.resolve({
          stdout: "old-runner\npi 0.85.0\n1.4.0\ngit version 2.34.1\n",
        }),
      ),
      destroy,
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "source_mismatch",
      file: REVIEW_RUNNER,
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("refuses a job whose expectedSources leave out an image source", async () => {
    const { "/opt/review/response-seal.ts": _omitted, ...incomplete } =
      job.expectedSources;
    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: JSON.stringify({
          job: { ...job, expectedSources: incomplete },
          broker,
          modelsJson: JSON.stringify({
            providers: { xai: { apiKey: "review-pi-handle" } },
          }),
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_run",
      detail: expect.stringContaining("/opt/review/response-seal.ts"),
    });
  });

  it("refuses an image whose broker copy differs before any model request", async () => {
    const startProcess = vi.fn((_command: string) =>
      Promise.resolve({ id: "review" }),
    );
    const putModelSession = vi.fn(() => Promise.resolve());
    const destroy = vi.fn(() => Promise.resolve());
    const write = vi.fn((_path: string, _content: string) => Promise.resolve());
    getSandbox.mockReturnValue({
      exec: vi.fn((command: string) =>
        command.includes("sha256sum")
          ? Promise.resolve({
              stdout: fingerprintStdout({
                "/opt/review/model-broker.ts": "c".repeat(64),
              }),
            })
          : Promise.resolve({ stdout: "" }),
      ),
      startProcess,
      putModelSession,
      destroy,
      mkdir: vi.fn(() => Promise.resolve()),
      writeFile: write,
      getContainerPlacementId: vi.fn(() => Promise.resolve("placement")),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "source_mismatch",
      file: "/opt/review/model-broker.ts",
    });
    expect(destroy).toHaveBeenCalledOnce();
    // Before any model request: no model session armed, no review process, no staged job.
    expect(putModelSession).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses an image built from another Dockerfile before any model request", async () => {
    const exec = vi.fn((command: string) =>
      command.includes("sha256sum")
        ? Promise.resolve({
            stdout: fingerprintStdout({
              "/opt/review/Dockerfile": "c".repeat(64),
            }),
          })
        : Promise.resolve({ stdout: "" }),
    );
    const putModelSession = vi.fn(() => Promise.resolve());
    const startProcess = vi.fn(() => Promise.resolve({ id: "review" }));
    getSandbox.mockReturnValue({
      exec,
      startProcess,
      putModelSession,
      destroy: vi.fn(() => Promise.resolve()),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs", {
        method: "POST",
        body: startBody(),
      }),
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "source_mismatch",
      file: "/opt/review/Dockerfile",
      expected: sha64,
      observed: "c".repeat(64),
    });
    expect(exec.mock.calls[0]?.[0]).toContain("/opt/review/Dockerfile");
    expect(putModelSession).not.toHaveBeenCalled();
    expect(startProcess).not.toHaveBeenCalled();
  });

  it("destroys on explicit stop when artifact retrieval fails", async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const clearModelSession = vi.fn(() => Promise.resolve());
    getSandbox.mockReturnValue({
      killAllProcesses: vi.fn(() => Promise.resolve(1)),
      exec: vi.fn((command: string) =>
        command.includes("status.json")
          ? Promise.reject(new Error("artifact RPC failed"))
          : Promise.resolve({ stdout: "-1\n" }),
      ),
      clearModelSession,
      destroy,
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs/artifact-failure/stop", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(destroy).toHaveBeenCalledOnce();
    expect(clearModelSession).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      shutdown: { destroy: { acknowledged: true } },
    });
  });

  it("ships the control-side seals out with the stop receipt", async () => {
    getSandbox.mockReturnValue({
      killAllProcesses: vi.fn(() => Promise.resolve(1)),
      exec: vi.fn(() => Promise.resolve({ stdout: "-1\n" })),
      clearModelSession: vi.fn(() => Promise.resolve()),
      modelSeals: vi.fn(() => Promise.resolve(["cafe", null])),
      destroy: vi.fn(() => Promise.resolve()),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs/run/stop", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      control: { modelSeals: ["cafe", null] },
    });
  });

  it("forwards an accept command as the target uid and rejects restart", async () => {
    const exec = vi.fn((_command: string) =>
      Promise.resolve({
        stdout: `${JSON.stringify({ type: "response", command: "accept", success: true })}\n`,
      }),
    );
    getSandbox.mockReturnValue({ exec });

    const accepted = await handler.fetch(
      authorized("https://review.invalid/runs/run/command", {
        method: "POST",
        body: JSON.stringify({ type: "accept" }),
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      command: "accept",
      success: true,
    });
    expect(String(exec.mock.calls[0]?.[0])).toContain(`--reuid=${TARGET_UID}`);
    expect(String(exec.mock.calls[0]?.[0])).toContain("--send");
    expect(String(exec.mock.calls[0]?.[0])).toContain("accept");

    const rejected = await handler.fetch(
      authorized("https://review.invalid/runs/run/command", {
        method: "POST",
        body: JSON.stringify({ type: "restart_process" }),
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("carries a prompt over the argv budget through a file in the run directory", async () => {
    const order: string[] = [];
    const exec = vi.fn((_command: string) => {
      order.push("exec");
      return Promise.resolve({
        stdout: `${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`,
      });
    });
    const write = vi.fn((_path: string, _content: string) => {
      order.push("write");
      return Promise.resolve();
    });
    const nextCommandSequence = vi.fn(() => Promise.resolve(1));
    getSandbox.mockReturnValue({
      exec,
      writeFile: write,
      nextCommandSequence,
    });

    const message = "x".repeat(20_000);
    const delivered = await handler.fetch(
      authorized("https://review.invalid/runs/run/command", {
        method: "POST",
        body: JSON.stringify({ type: "prompt", message }),
      }),
      env,
    );
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({
      command: "prompt",
      success: true,
    });
    expect(write).toHaveBeenCalledOnce();
    const [path, content] = write.mock.calls[0] ?? [];
    expect(String(path)).toBe(`${runDir("run")}/command-1.json`);
    expect(JSON.parse(String(content))).toEqual({ type: "prompt", message });
    const large = String(exec.mock.calls[0]?.[0]);
    expect(large).toContain("--send-file");
    expect(large).toContain(`--reuid=${TARGET_UID}`);
    expect(large).toContain(String(path));
    expect(large).not.toContain(message);

    const small = await handler.fetch(
      authorized("https://review.invalid/runs/run/command", {
        method: "POST",
        body: JSON.stringify({ type: "prompt", message: "y".repeat(1024) }),
      }),
      env,
    );
    expect(small.status).toBe(200);
    expect(write).toHaveBeenCalledOnce();
    expect(nextCommandSequence).toHaveBeenCalledOnce();
    const inline = String(exec.mock.calls[1]?.[0]);
    expect(inline).toContain(" --send ");
    expect(inline).not.toContain("--send-file");
    expect(inline).toContain("y".repeat(1024));
    expect(order).toEqual(["write", "exec", "exec"]);
  });

  it("returns trusted model usage without the bearer", async () => {
    getSandbox.mockReturnValue({
      exec: vi.fn(() => Promise.resolve({ stdout: "-1\n" })),
      getContainerPlacementId: vi.fn(() => Promise.resolve("placement")),
      listProcesses: vi.fn(() => Promise.resolve([])),
      modelUsage: vi.fn(() =>
        Promise.resolve({
          handle: "review-pi-handle",
          caps: broker.caps,
          totals: { requests: 2, retries: 0, input: 9, output: 1 },
        }),
      ),
    });

    const response = await handler.fetch(
      authorized("https://review.invalid/runs/run/state"),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("model-secret");
    expect(body).toMatchObject({
      control: {
        modelUsage: {
          handle: "review-pi-handle",
          totals: { requests: 2, input: 9, output: 1 },
        },
      },
    });
  });

  it("rejects an invalid run id on state instead of interpolating it", async () => {
    const response = await handler.fetch(
      authorized("https://review.invalid/runs/run;id/state"),
      env,
    );
    expect(response.status).toBe(400);
  });
});

describe("deployed container image", () => {
  const packageRoot = path.join(import.meta.dirname, "..", "..");

  it("copies every image source out of container/ to where the Worker looks", async () => {
    const config = await readFile(
      path.join(packageRoot, "wrangler.jsonc"),
      "utf8",
    );
    expect(config).toContain('"name": "swarm-review"');
    expect(config).toContain(
      '"$schema": "./node_modules/wrangler/config-schema.json"',
    );
    expect(config).toContain('"image": "./container/Dockerfile"');
    expect(config).toContain('"image_build_context": "container"');

    const dockerfile = await readFile(
      path.join(packageRoot, "container", "Dockerfile"),
      "utf8",
    );
    const copies = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
      .map((line) => line.split(/\s+/).slice(1));
    expect(copies).toEqual([
      ["context", "/opt/review/lockfile"],
      [
        "claude-code-provider.js",
        "/opt/review/extensions/claude-code-provider.js",
      ],
      ["models.json", "/opt/review/pi-config/models.json"],
      ["model-broker.ts", MODEL_BROKER],
      ["response-seal.ts", "/opt/review/response-seal.ts"],
      ["response-usage.ts", "/opt/review/response-usage.ts"],
      ["review-run.sh", REVIEW_RUNNER],
      ["Dockerfile", "/opt/review/Dockerfile"],
    ]);
  });

  it("compares every file the image is built from, the Dockerfile included", () => {
    const tracked = spawnSync("git", ["ls-files", "container"], {
      cwd: packageRoot,
      encoding: "utf8",
    })
      .stdout.split("\n")
      .filter(Boolean)
      .map((file) => path.relative("container", file));

    expect(tracked.sort()).toEqual(Object.values(IMAGE_SOURCES).sort());
  });

  it("pins what each image installs in its Dockerfile's own bytes", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const base = `FROM docker.io/cloudflare/sandbox:${manifest.dependencies["@cloudflare/sandbox"]}`;

    for (const [image, from] of [
      ["container", `${base} AS bun`],
      ["relay", base],
    ] as const) {
      const dockerfile = await readFile(
        path.join(packageRoot, image, "Dockerfile"),
        "utf8",
      );
      // A build argument would move pi, bun or the base without moving the
      // bytes the gate compares.
      expect(dockerfile).not.toMatch(/^\s*ARG\s/m);
      expect(dockerfile.split("\n")).toContain(from);
    }
  });

  it("boots the relay image with no interpreter pools beside the relay", async () => {
    const dockerfile = await readFile(
      path.join(packageRoot, "relay", "Dockerfile"),
      "utf8",
    );
    for (const pool of ["JAVASCRIPT", "TYPESCRIPT", "PYTHON"]) {
      expect(dockerfile).toMatch(new RegExp(`\\b${pool}_POOL_MIN_SIZE=0\\b`));
    }
  });

  it("keeps the generated bake context out of git", () => {
    const ignored = spawnSync("git", ["check-ignore", "container/context"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(ignored.status).toBe(0);
  });

  it("refuses to deploy without naming the target checkout", () => {
    expect(() => targetCheckout([])).toThrow("--target");
    expect(targetCheckout(["--target", "/checkouts/demo"])).toBe(
      "/checkouts/demo",
    );
  });

  it("forwards every deploy flag except its own target", () => {
    // `--target` names a directory on this host; wrangler refuses an argument
    // it does not know, so passing it through would fail every deploy that
    // also set the repository the Worker serves.
    expect(
      deployArguments([
        "--target",
        "/checkouts/demo",
        "--var",
        "TARGET_REPOSITORY:https://github.com/acme/demo.git",
      ]),
    ).toEqual(["--var", "TARGET_REPOSITORY:https://github.com/acme/demo.git"]);
    expect(deployArguments(["--var", "X:1"])).toEqual(["--var", "X:1"]);
    expect(deployArguments([])).toEqual([]);
    expect(
      deployArguments([
        "--target",
        "/checkouts/demo",
        "--repo",
        "acme/demo",
        "--image-only",
      ]),
    ).toEqual([]);
  });

  it("builds the computed image reference for the lane platform", () => {
    expect(
      imageBuildArguments(
        "ghcr.io/acme/demo-swarm-review-sandbox:1234567890abcdef",
      ),
    ).toEqual([
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      "ghcr.io/acme/demo-swarm-review-sandbox:1234567890abcdef",
      path.join(packageRoot, "container"),
    ]);
  });
});

describe("cloud model session accounting", () => {
  const storage = () => {
    const entries = new Map<string, unknown>();
    return {
      get: (key: string) => Promise.resolve(entries.get(key)),
      put: (key: string, value: unknown) => {
        entries.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(entries.delete(key)),
    };
  };

  const runningSandbox = async (upstreamBaseUrl = broker.upstreamBaseUrl) => {
    const sandbox = new ReviewSandbox({} as never, env as never);
    Object.assign(sandbox, { ctx: { storage: storage() } });
    await sandbox.putModelSession({
      handle: broker.handle,
      upstreamBaseUrl,
      upstreamAuthorization: broker.upstreamAuthorization,
      caps: broker.caps,
      totals: emptyModelTotals(),
    });
    return sandbox;
  };

  const postModel = async (runId: string, body = "{}") => {
    const capability = await modelCapability(runId, "control-secret");
    return handler.fetch(
      new Request(
        `https://review.invalid/model/${runId}/${capability}/chat/completions`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${broker.handle}` },
          body,
        },
      ),
      env,
    );
  };

  it("counts the attempt that follows a retryable failure as a retry", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        ),
      );
    vi.stubGlobal("fetch", upstream);

    const failed = await postModel("retry-run");
    expect(failed.status).toBe(503);
    await failed.text();

    const retried = await postModel("retry-run");
    expect(retried.status).toBe(200);
    await retried.text();

    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await sandbox.modelUsage()).toMatchObject({
      totals: { requests: 2, retries: 1, input: 3, output: 1, unended: 0 },
    });
    // The 503 reported no usage at all, so each sum is one request short.
    expect(await sandbox.modelUsage()).toMatchObject({
      totals: { inputUnobserved: 1, outputUnobserved: 1 },
    });
  });

  it("says a session total is short by the request that never reported that side", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('data: {"usage":{"completion_tokens":7}}'),
        )
        .mockResolvedValueOnce(
          new Response(
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          ),
        ),
    );

    await (await postModel("one-sided-run")).text();
    await (await postModel("one-sided-run")).text();

    // Three input tokens is what one of the two requests reported, and the
    // count beside it is what keeps that sum from reading as the lane's input.
    expect((await sandbox.modelUsage())?.totals).toEqual({
      requests: 2,
      retries: 0,
      input: 3,
      output: 8,
      unended: 0,
      inputUnobserved: 1,
      outputUnobserved: 0,
    });
  });

  it("records a cancelled lane attempt with unobserved usage and seal", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );

    const response = await postModel("abandoned-run");
    await response.body?.cancel();

    expect(await sandbox.modelUsage()).toMatchObject({
      totals: {
        requests: 1,
        unended: 0,
        input: null,
        output: null,
        inputUnobserved: 1,
        outputUnobserved: 1,
      },
    });
    expect(await sandbox.modelSeals()).toEqual([null]);
  });

  it("records a streamed upstream error once with unobserved usage and seal", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("upstream stream failed"));
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const response = await postModel("stream-error-run");
    await expect(response.text()).rejects.toThrow("upstream stream failed");
    expect((await sandbox.modelUsage())?.totals).toEqual({
      requests: 1,
      retries: 0,
      input: null,
      output: null,
      unended: 0,
      inputUnobserved: 1,
      outputUnobserved: 1,
    });
    expect(await sandbox.modelSeals()).toEqual([null]);
  });

  it("leaves unended unobserved on a session stored before it was counted", async () => {
    const sandbox = new ReviewSandbox({} as never, env as never);
    Object.assign(sandbox, { ctx: { storage: storage() } });
    // Durable Object storage outlives a redeploy, so a session an older Worker
    // opened reaches this one without the count.
    await sandbox.putModelSession({
      handle: broker.handle,
      upstreamBaseUrl: broker.upstreamBaseUrl,
      upstreamAuthorization: broker.upstreamAuthorization,
      caps: broker.caps,
      totals: { requests: 1, retries: 0, input: 5, output: 1 },
    });
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          ),
        ),
      ),
    );

    await (await postModel("stored-before-run")).text();

    expect((await sandbox.modelUsage())?.totals).toEqual({
      requests: 2,
      retries: 0,
      input: 8,
      output: 2,
    });
  });

  it("leaves the unobserved counts absent on a session stored before they were counted", async () => {
    const sandbox = new ReviewSandbox({} as never, env as never);
    Object.assign(sandbox, { ctx: { storage: storage() } });
    await sandbox.putModelSession({
      handle: broker.handle,
      upstreamBaseUrl: broker.upstreamBaseUrl,
      upstreamAuthorization: broker.upstreamAuthorization,
      caps: broker.caps,
      totals: { requests: 1, retries: 0, input: 5, output: 1, unended: 0 },
    });
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response('data: {"choices":[{"delta":{"content":"ok"}}]}'),
        ),
      ),
    );

    await (await postModel("stored-before-counts-run")).text();

    // Requests nobody counted before cannot be counted from here, so the
    // count stays absent rather than starting a number that reads as whole.
    expect((await sandbox.modelUsage())?.totals).toEqual({
      requests: 2,
      retries: 0,
      input: 5,
      output: 1,
      unended: 0,
    });
  });

  it("charges nothing for a body it refuses as over the byte cap", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const refused = await postModel(
      "oversize-run",
      "x".repeat(broker.caps.maxRequestBytes + 1),
    );

    expect(refused.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect(await sandbox.modelUsage()).toMatchObject({
      totals: { requests: 0, retries: 0 },
    });
  });

  it("admits nothing for a request it refuses before the upstream", async () => {
    // The run request only asks for an https prefix, so a base no URL parser
    // accepts reaches the session. Nothing can be sent there, and a slot spent
    // before that refusal would be an admission no end ever records.
    const sandbox = await runningSandbox("https://api.x.ai:99999/v1");
    getSandbox.mockReturnValue(sandbox);
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", upstream);

    const refused = await postModel("unroutable-run");

    expect(refused.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(await sandbox.modelUsage()).toMatchObject({
      totals: { requests: 0, unended: 0 },
    });
  });

  it("seals every response the target can read but never write", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    const body = [
      'data: {"type":"message_start","message":{"content":[]}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sealed answer"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      "data: [DONE]",
    ].join("\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    );

    const answered = await postModel("seal-run");
    await answered.text();
    const refused = await postModel("seal-run", "x".repeat(2048));
    expect(refused.status).toBe(413);

    expect(await sandbox.modelSeals()).toEqual([
      createHash("sha256").update("sealed answer", "utf8").digest("hex"),
    ]);
  });

  it("answers a repeated stop with the seals the first one shipped", async () => {
    const sandbox = await runningSandbox();
    Object.assign(sandbox, {
      killAllProcesses: vi.fn(() => Promise.resolve(0)),
      exec: vi.fn(() => Promise.resolve({ stdout: "-1\n" })),
      destroy: vi.fn(() => Promise.resolve()),
    });
    getSandbox.mockReturnValue(sandbox);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "sealed answer" } }] })}\n\n`,
          ),
        ),
      ),
    );
    await (await postModel("stop-run")).text();

    const stops: unknown[] = [];
    for (let stop = 0; stop < 2; stop += 1) {
      const response = await handler.fetch(
        authorized("https://review.invalid/runs/stop-run/stop", {
          method: "POST",
        }),
        env,
      );
      stops.push(((await response.json()) as { control: unknown }).control);
    }

    const shipped = {
      modelSeals: [
        createHash("sha256").update("sealed answer", "utf8").digest("hex"),
      ],
    };
    expect(stops).toEqual([shipped, shipped]);
    expect(await sandbox.consumeModelAttempt()).toEqual({
      ok: false,
      reason: "no_session",
    });
  });
});
