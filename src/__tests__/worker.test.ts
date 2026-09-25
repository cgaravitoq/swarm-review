import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deployArguments,
  imageBuildArguments,
  targetCheckout,
} from "../../scripts/deploy";
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

  it("keeps an attempt unended when the client walks away before the stream closes", async () => {
    const sandbox = await runningSandbox();
    getSandbox.mockReturnValue(sandbox);
    // A provider that opens a body and never closes it: the flush that records
    // the attempt never runs, so the slot is spent with no end observed.
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

    // The request is counted and the record says it never ended, so a row that
    // reads these totals cannot read its tokens as an observed zero.
    expect(await sandbox.modelUsage()).toMatchObject({
      totals: { requests: 1, unended: 1 },
    });
    expect(await sandbox.modelSeals()).toEqual([]);
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
