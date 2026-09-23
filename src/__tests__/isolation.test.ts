import { describe, expect, it } from "vitest";
import {
  BRIDGE_COMMAND_MAX_BYTES,
  bridgeCommandFile,
  bridgeCommandPayload,
  interpretControlApiProbe,
  interpretProviderCanary,
  parseBridgeCommand,
  parseCloudRunRequest,
  posixQuote,
  TARGET_UID,
  targetCanaryCommand,
  targetReviewCommand,
  targetSendCommand,
  targetSendFileCommand,
} from "../isolation";
import { IMAGE_SOURCES } from "../protocol";

const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);
const expectedSources = Object.fromEntries(
  Object.keys(IMAGE_SOURCES).map((path) => [path, sha64]),
);

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
  ledgerPath: "/opt/review/control/provider-usage.jsonl",
};

const job = {
  runId: "run-1",
  expectedRunnerSha: sha64,
  expectedSources,
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

describe("posix quoting", () => {
  it("quotes single quotes for the shell rather than JSON", () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`);
    expect(posixQuote("it's")).not.toBe(JSON.stringify("it's"));
  });
});

describe("bridge commands", () => {
  it("quotes accept for the target uid and refuses restart", () => {
    expect(() => parseBridgeCommand({ type: "restart_process" })).toThrow(
      /unsupported command/,
    );
    const command = parseBridgeCommand({ type: "accept" });
    expect(
      targetSendCommand(
        "/workspace/runs/run",
        "/opt/review/review-run.sh",
        command,
      ),
    ).toContain("--send");
    expect(
      targetSendCommand(
        "/workspace/runs/run",
        "/opt/review/review-run.sh",
        command,
      ),
    ).toContain("1102");
  });

  it("carries a streaming prompt only with a behaviour Pi accepts", () => {
    // A lane that keeps calling tools is told to answer inside the turn it is
    // already running, which Pi only accepts with a streamingBehaviour.
    expect(
      parseBridgeCommand({
        type: "prompt",
        message: "Stop investigating now",
        streamingBehavior: "steer",
      }),
    ).toEqual({
      type: "prompt",
      message: "Stop investigating now",
      streamingBehavior: "steer",
    });
    expect(parseBridgeCommand({ type: "prompt", message: "go" })).toEqual({
      type: "prompt",
      message: "go",
    });
    expect(() =>
      parseBridgeCommand({
        type: "prompt",
        message: "go",
        streamingBehavior: "interrupt",
      }),
    ).toThrow(/streamingBehavior/);
  });

  it("carries a prompt under the argv budget inline", () => {
    const directory = "/workspace/runs/run";
    const runner = "/opt/review/review-run.sh";
    const command = parseBridgeCommand({
      type: "prompt",
      message: "x".repeat(1024),
    });
    const sent = targetSendCommand(directory, runner, command);
    expect(sent).toContain(` ${posixQuote(bridgeCommandPayload(command))}`);
    expect(sent).not.toContain("--send-file");
    expect(sent).toContain(`--reuid=${TARGET_UID}`);
  });

  it("carries a prompt over the argv budget as a file the runner reads once", () => {
    const directory = "/workspace/runs/run";
    const runner = "/opt/review/review-run.sh";
    const command = parseBridgeCommand({
      type: "prompt",
      message: "x".repeat(BRIDGE_COMMAND_MAX_BYTES),
    });
    const payload = bridgeCommandPayload(command);
    expect(payload.length).toBeGreaterThan(BRIDGE_COMMAND_MAX_BYTES);
    expect(() => targetSendCommand(directory, runner, command)).toThrow(
      /command too large/,
    );

    const path = bridgeCommandFile(directory, 7);
    expect(path).toBe(`${directory}/command-7.json`);
    const sent = targetSendFileCommand(directory, runner, path);
    expect(sent).toContain("--send-file");
    expect(sent).toContain(posixQuote(path));
    expect(sent).toContain(`--reuid=${TARGET_UID}`);
    expect(sent).not.toContain(payload);
  });
});

describe("cloud run request", () => {
  it("rejects a run id that would interpolate as a shell metacharacter", () => {
    expect(() =>
      parseCloudRunRequest({
        job: { ...job, runId: "run;id" },
        broker,
        modelsJson: "{}",
      }),
    ).toThrow(/run id/);
  });

  it("rejects a non-integer timeout before it is interpolated", () => {
    expect(() =>
      parseCloudRunRequest({
        job: { ...job, totalTimeoutSeconds: "60; rm" },
        broker,
        modelsJson: "{}",
      }),
    ).toThrow(/totalTimeoutSeconds/);
  });

  it("keeps the bearer out of the sanitized job", () => {
    const parsed = parseCloudRunRequest({
      job,
      broker,
      modelsJson: JSON.stringify({
        providers: { xai: { apiKey: "review-pi-handle" } },
      }),
    });
    expect(JSON.stringify(parsed.job)).not.toContain("model-secret");
    expect(parsed.job.runId).toBe("run-1");
    expect(parsed.job.totalTimeoutSeconds).toBe(60);
  });
});

describe("command interpolation", () => {
  it("shell-quotes the handle instead of JSON-escaping it", () => {
    const command = targetCanaryCommand(
      "/workspace/runs/run-1",
      "review-pi-$(reboot)",
      "https://review.invalid/model/run-1/cap/chat/completions",
    );
    expect(command).toContain(
      posixQuote("authorization: Bearer review-pi-$(reboot)"),
    );
    expect(command).not.toContain(
      JSON.stringify("authorization: Bearer review-pi-$(reboot)"),
    );
    expect(command).toContain(
      posixQuote("/workspace/runs/run-1/canary-request.json"),
    );
  });

  it("embeds only a validated integer timeout", () => {
    expect(() =>
      targetReviewCommand(
        "/workspace/runs/run-1",
        Number.NaN,
        "/opt/review/review-run.sh",
      ),
    ).toThrow(/totalTimeoutSeconds/);
    expect(
      targetReviewCommand(
        "/workspace/runs/run-1",
        90,
        "/opt/review/review-run.sh",
      ),
    ).toContain("timeout -k 15 90 ");
  });

  it("passes an allowlisted provider address and refuses anything else", () => {
    expect(
      targetReviewCommand(
        "/workspace/runs/run-1",
        90,
        "/opt/review/review-run.sh",
        { CLOUDFLARE_ACCOUNT_ID: "0630089e" },
      ),
    ).toContain("CLOUDFLARE_ACCOUNT_ID='0630089e' PI_CODING_AGENT_DIR=");
    // The target holds an address, never a bearer, and never a name nobody
    // vetted: the allowlist is the only reason this cannot become a channel.
    expect(() =>
      targetReviewCommand(
        "/workspace/runs/run-1",
        90,
        "/opt/review/review-run.sh",
        { CLOUDFLARE_API_KEY: "secret" },
      ),
    ).toThrow(/targetEnv name not allowed/);
    expect(() =>
      targetReviewCommand(
        "/workspace/runs/run-1",
        90,
        "/opt/review/review-run.sh",
        { CLOUDFLARE_ACCOUNT_ID: "id; reboot" },
      ),
    ).toThrow(/targetEnv value invalid/);
  });
});

describe("control API containment probe", () => {
  it("treats id -u 0 or 1101 as an escape", () => {
    expect(
      interpretControlApiProbe(200, JSON.stringify({ stdout: "0\n" })),
    ).toMatchObject({ escaped: true, uid: 0 });
    expect(
      interpretControlApiProbe(200, JSON.stringify({ stdout: "1101\n" })),
    ).toMatchObject({ escaped: true, uid: 1101 });
  });

  it("does not treat a refused control API as an escape", () => {
    expect(interpretControlApiProbe(403, "")).toMatchObject({
      escaped: false,
      reason: "http_403",
    });
    expect(
      interpretControlApiProbe(200, JSON.stringify({ stdout: "1102\n" })),
    ).toMatchObject({ escaped: false, uid: 1102 });
  });
});

describe("provider canary interpretation", () => {
  it("rejects a 200 SSE body that ends in a provider error", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"error":{"message":"upstream failed"}}',
    ].join("\n");
    expect(interpretProviderCanary(200, body)).toMatchObject({
      completed: false,
      reason: "provider_error",
    });
  });

  it("requires stop and output, not merely HTTP 200", () => {
    expect(interpretProviderCanary(200, "{}")).toMatchObject({
      completed: false,
      reason: "incomplete",
    });
    expect(
      interpretProviderCanary(
        200,
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "pong" } }],
        }),
      ),
    ).toMatchObject({
      completed: true,
      stopReason: "stop",
      output: "pong",
    });
  });
});
