import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brokerCaps,
  buildCloudStartPayload,
  commitAt,
  controlPlaneCompletion,
  driveUntilComplete,
  eligibleIdleCandidate,
  FINALIZE_REPORT_MARGIN_MS,
  FINALIZE_REQUEST_RESERVE,
  type LaneBrief,
  observedControl,
  observedIsolation,
  observedModelRequests,
  observedModelUsage,
  promptFailure,
  REPORT_GRACE_MS,
  requestControl,
  runWithCleanup,
  writeCloudReceipt,
} from "../drive";
import { BROKER_LEDGER, parseCloudRunRequest } from "../isolation";
import {
  MAX_FORMAT_CORRECTIONS,
  planBroker,
  readLaneReceipt,
  targetProviderEnv,
} from "../local";
import { SESSION_CAPS } from "../provider-budget";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local driver lifecycle", () => {
  it("resolves a lane's commits against the repository it was told to drive", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sha: "c".repeat(40) }), { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", upstream);

    await expect(
      commitAt("acme/demo", "c".repeat(40), "github-token"),
    ).resolves.toEqual({ sha: "c".repeat(40) });
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      `https://api.github.com/repos/acme/demo/commits/${"c".repeat(40)}`,
    );
  });

  it("keeps a lane room to answer after it is told to stop", () => {
    // One request for the answer, one correction per off-contract final, and
    // enough left over for what a poll missed: a reserve that only covers the
    // answer is a lane that reaches the cap and leaves an empty report, which
    // is exactly what the instruction exists to prevent.
    expect(FINALIZE_REQUEST_RESERVE).toBeGreaterThan(
      MAX_FORMAT_CORRECTIONS + 1,
    );
  });

  it("overrides only the request ceiling a lane was given", () => {
    // A lane's tokens and bytes stay its trial kind's; the ceiling is what a
    // verifier is bounded by, and the finalize reserve comes out of it.
    expect(brokerCaps("t1b", undefined)).toEqual(SESSION_CAPS.t1b);
    expect(brokerCaps("t1b", "32")).toEqual({
      ...SESSION_CAPS.t1b,
      maxRequests: 32,
    });
    expect(brokerCaps("t1a", "8")).toEqual({
      ...SESSION_CAPS.t1a,
      maxRequests: 8,
    });
    expect(() => brokerCaps("t1b", "0")).toThrow(/max-requests/);
    expect(() => brokerCaps("t1b", "1.5")).toThrow(/max-requests/);
    expect(() => brokerCaps("t1b", "2000")).toThrow(/max-requests/);
  });

  it("bounds the pending control request itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ),
    );

    await expect(
      requestControl("https://review.invalid", "/runs", "secret", 5),
    ).rejects.toThrow(/timeout/i);
  });

  it("attempts cleanup after the run path fails", async () => {
    const cleanup = vi.fn(() => Promise.resolve("destroyed"));
    const outcome = await runWithCleanup(
      () => Promise.reject(new Error("state failed")),
      cleanup,
    );

    expect(cleanup).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ cleanupResult: "destroyed" });
    expect(outcome.runError).toEqual(new Error("state failed"));
  });

  it("tells a container that never reached the model from one that did", () => {
    const state = (modelUsage: unknown) => ({
      runId: "run",
      observedAt: "2026-09-10T00:00:00.000Z",
      placementId: null,
      control: { modelUsage },
      artifacts: [],
    });
    // Zero is the only reading that makes a relaunch free, so anything the
    // control plane did not actually report has to read as "not observed":
    // a missing total answered as 0 would buy a spent lane's tokens twice.
    expect(observedModelRequests(state({ totals: { requests: 0 } }))).toBe(0);
    expect(observedModelRequests(state({ totals: { requests: 15 } }))).toBe(15);
    expect(observedModelRequests(state({ totals: {} }))).toBeNull();
    expect(observedModelRequests(state({}))).toBeNull();
    expect(observedModelRequests(state(null))).toBeNull();
    expect(
      observedModelRequests(state({ totals: { requests: "0" } })),
    ).toBeNull();
    expect(observedModelRequests(undefined)).toBeNull();
  });

  it("reads a lane's usage from the control side's session totals", () => {
    const state = (modelUsage: unknown) => ({
      runId: "run",
      observedAt: "2026-09-10T00:00:00.000Z",
      placementId: null,
      control: { modelUsage },
      artifacts: [],
    });

    expect(
      observedModelUsage(
        state({
          totals: {
            requests: 2,
            retries: 0,
            input: 40,
            output: 8,
            unended: 1,
            inputUnobserved: 1,
            outputUnobserved: 0,
          },
        }),
      ),
    ).toEqual({
      requests: 2,
      retries: 0,
      inputTokens: 40,
      outputTokens: 8,
      unended: 1,
      inputUnobserved: 1,
      outputUnobserved: 0,
    });
    // A session whose responses carried no usage frame has no token count: the
    // row records that as unobserved rather than as tokens measured at zero.
    expect(
      observedModelUsage(
        state({
          totals: { requests: 1, retries: 0, input: null, output: null },
        }),
      ),
    ).toEqual({
      requests: 1,
      retries: 0,
      inputTokens: null,
      outputTokens: null,
      unended: null,
      inputUnobserved: null,
      outputUnobserved: null,
    });
    // A Worker deployed before a count existed never reports it, and a count
    // nobody reported is unobserved, not a zero that reads as measured.
    expect(
      observedModelUsage(
        state({ totals: { requests: 3, input: 40, output: 8 } }),
      ),
    ).toEqual({
      requests: 3,
      retries: null,
      inputTokens: 40,
      outputTokens: 8,
      unended: null,
      inputUnobserved: null,
      outputUnobserved: null,
    });
    expect(observedModelUsage(state({ totals: {} }))).toBeNull();
    expect(observedModelUsage(state({}))).toBeNull();
    expect(observedModelUsage(undefined)).toBeNull();
  });

  it("hands a row the Worker session's usage through the cloud receipt", async () => {
    const totals = {
      requests: 2,
      retries: 0,
      input: null,
      output: null,
      unended: 1,
      inputUnobserved: 1,
      outputUnobserved: 1,
    };
    const directory = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    await writeCloudReceipt(directory, {
      runId: "run",
      provider: "openai-codex",
      model: "gpt-5.4",
      wallSeconds: 12,
      ...observedControl(undefined, {
        runId: "run",
        observedAt: "2026-09-10T00:00:00.000Z",
        placementId: null,
        control: { modelUsage: { totals } },
        artifacts: [],
      }),
    });

    // The receipt is the only way the session's count reaches the row, so it
    // is read back through the reader the row uses, not off the helper.
    await expect(readLaneReceipt(directory)).resolves.toMatchObject({
      modelRequests: 2,
      usage: {
        requests: 2,
        retries: 0,
        inputTokens: null,
        outputTokens: null,
        unended: 1,
        inputUnobserved: 1,
        outputUnobserved: 1,
      },
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("carries the escape the control plane reported into the lane receipt", async () => {
    const started = {
      runId: "run",
      processId: "review",
      startedAt: "2026-09-22T00:00:00.000Z",
      placementId: "placement",
      container: {
        runnerSha: "a".repeat(64),
        piVersion: "pi 0.85.0",
        bunVersion: "1.4.0",
        gitVersion: "git version 2.34.1",
      },
      credentialIsolation: {
        mode: "worker-proxy" as const,
        controlUid: 1101,
        targetUid: 1102,
      },
      probes: {
        targetReadBroker: {
          verdict: null,
          reason: "broker_config_not_staged",
        },
        controlApi: {
          httpStatus: 200,
          uid: 0,
          reason: "control_api_runs_privileged",
          escaped: true,
        },
      },
    };
    // A lane that never started measured no isolation at all, and a receipt
    // that answered "contained" there would report containment out of thin air.
    expect(observedIsolation(undefined)).toBeNull();

    const directory = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    // Written the way the driver writes it, so the verdict reaches the row only
    // if the receipt's control observations carry it.
    await writeCloudReceipt(directory, {
      runId: "run",
      provider: "openai-codex",
      model: "gpt-5.4",
      wallSeconds: 12,
      ...observedControl(started, undefined),
    });

    await expect(readLaneReceipt(directory)).resolves.toMatchObject({
      isolation: {
        controlApi: {
          uid: 0,
          reason: "control_api_runs_privileged",
          escaped: true,
        },
        targetReadBroker: {
          verdict: null,
          reason: "broker_config_not_staged",
        },
      },
    });
  });

  it("reads a receipt that recorded no isolation as unobserved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        runId: "run",
        provider: "openai-codex",
        model: "gpt-5.4",
        wallSeconds: 12,
      }),
    );

    await expect(readLaneReceipt(directory)).resolves.toMatchObject({
      isolation: null,
    });
  });

  it("briefs an idle lane once Pi is up and ends it on an empty brief", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const alive = {
      id: "review",
      command: "/opt/review/review-run.sh /workspace/runs/run",
      status: "running",
    };
    const at = (phase: string, extra: Record<string, unknown> = {}) => ({
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [alive],
      artifacts: [
        {
          path: "/workspace/runs/run/status.json",
          exists: true,
          content: JSON.stringify({ phase, state: "running", ...extra }),
        },
      ],
    });
    const candidate = `\`\`\`json\n${JSON.stringify({
      verdicts: [
        {
          id: "c1",
          status: "rejected",
          evidenceStrength: "static",
          reason: "the branch is unreachable",
        },
      ],
    })}\n\`\`\``;
    const verdictIdle = at("review", {
      state: "idle",
      childIdle: true,
      lastCandidateResult: candidate,
    });
    const done = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/run/report.json",
          exists: true,
          content: JSON.stringify({
            checkout: { checkedOutHead: head, checkedOutBase: base },
          }),
        },
        {
          path: "/workspace/runs/run/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    const states = [
      at("install"),
      at("review", { childIdle: true }),
      at("review", { childIdle: true }),
      verdictIdle,
      done,
    ];
    const briefs: (LaneBrief | undefined)[] = [
      undefined,
      { prompt: "verify c1", candidateIds: ["c1"] },
    ];
    const sent: unknown[] = [];
    await driveUntilComplete({
      poll: () => Promise.resolve(states.shift() ?? done),
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      brief: () => Promise.resolve(briefs.shift()),
      requested: { head, base },
      role: "verifier",
      laneId: "verifier",
      candidateIds: [],
      deadline: 1_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    // The brief is not read until Pi idles, is sent exactly once, and the
    // verdict is validated against the ids it carried rather than the empty
    // set the lane started with.
    expect(sent[0]).toEqual({ type: "prompt", message: "verify c1" });
    expect(
      sent.filter((c) => (c as { type: string }).type === "prompt"),
    ).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ type: "accept" });

    const idle = [at("review", { childIdle: true })];
    const ended = await driveUntilComplete({
      poll: () => Promise.resolve(idle.shift() ?? done),
      send: () => Promise.reject(new Error("nothing should be sent")),
      brief: () => Promise.resolve({ prompt: null, candidateIds: [] }),
      requested: { head, base },
      role: "verifier",
      laneId: "verifier",
      candidateIds: [],
      deadline: 1_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(controlPlaneCompletion(ended, { head, base }).reportOk).toBe(false);
  });

  it("does not treat a failed process listing as an exit", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const unobserved = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      processesError: "HTTP error! status: 500",
      artifacts: [],
    };
    expect(controlPlaneCompletion(unobserved, { head, base })).toMatchObject({
      reviewAlive: false,
      reportOk: false,
      processesObserved: false,
    });
    const report = JSON.stringify({
      checkout: { checkedOutHead: head, checkedOutBase: base },
    });
    const done = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/run/report.json",
          exists: true,
          content: report,
        },
        {
          path: "/workspace/runs/run/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    let polls = 0;
    const completed = await driveUntilComplete({
      poll: () => Promise.resolve(polls++ === 0 ? unobserved : done),
      send: () => Promise.resolve({ success: true }),
      requested: { head, base },
      role: "reviewer",
      laneId: "lane-1",
      candidateIds: [],
      deadline: 1_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(polls).toBe(2);
    expect(controlPlaneCompletion(completed, { head, base })).toMatchObject({
      reportOk: true,
      processesObserved: true,
    });
  });

  it("does not treat target-written status.json as completion", () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const report = JSON.stringify({
      checkout: { checkedOutHead: head, checkedOutBase: base },
    });
    const steps = `${JSON.stringify({ step: "report", exit: 0 })}\n`;
    expect(
      controlPlaneCompletion(
        {
          runId: "run",
          observedAt: "",
          placementId: null,
          processes: [
            {
              id: "review",
              command: "/opt/review/review-run.sh /workspace/runs/run",
              status: "running",
            },
          ],
          artifacts: [
            {
              path: "/workspace/runs/run/status.json",
              exists: true,
              content: '{"state":"done"}',
            },
            {
              path: "/workspace/runs/run/report.json",
              exists: true,
              content: report,
            },
            {
              path: "/workspace/runs/run/steps.jsonl",
              exists: true,
              content: steps,
            },
          ],
        },
        { head, base },
      ),
    ).toMatchObject({ reviewAlive: true, reportOk: true });
    expect(
      controlPlaneCompletion(
        {
          runId: "run",
          observedAt: "",
          placementId: null,
          processes: [],
          artifacts: [
            {
              path: "/workspace/runs/run/status.json",
              exists: true,
              content: '{"state":"done"}',
            },
            {
              path: "/workspace/runs/run/report.json",
              exists: true,
              content: report,
            },
            {
              path: "/workspace/runs/run/steps.jsonl",
              exists: true,
              content: steps,
            },
          ],
        },
        { head, base },
      ),
    ).toMatchObject({ reviewAlive: false, reportOk: true });
  });

  it("accepts an idle candidate and fails auth_blocked before the budget", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const running = [
      {
        id: "review",
        command: "/opt/review/review-run.sh /workspace/runs/run",
        status: "running",
      },
    ];
    const candidate = [
      "```json",
      JSON.stringify({
        status: "complete",
        blockerReason: "",
        findings: [
          {
            severity: "P1",
            file: "agents/review-pi/src/drive.ts",
            line: 1,
            mechanism: "handshake omitted accept",
            evidence: "idle with lastCandidateResult and no command route",
            affectedBehavior:
              "the run waits out the budget without report.json",
          },
        ],
      }),
      "```",
    ].join("\n");
    const idle = {
      runId: "review6633d1",
      observedAt: "",
      placementId: null,
      processes: running,
      artifacts: [
        {
          path: "/workspace/runs/review6633d1/status.json",
          exists: true,
          content: JSON.stringify({
            phase: "review",
            state: "idle",
            childIdle: true,
            isStreaming: false,
            inFlightTool: null,
            lastCandidateResult: candidate,
            terminalReason: null,
          }),
        },
      ],
    };
    const report = JSON.stringify({
      checkout: { checkedOutHead: head, checkedOutBase: base },
    });
    const done = {
      runId: "review6633d1",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/review6633d1/report.json",
          exists: true,
          content: report,
        },
        {
          path: "/workspace/runs/review6633d1/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    expect(eligibleIdleCandidate(idle)).toBe(candidate);

    const sent: unknown[] = [];
    const completed = await driveUntilComplete({
      poll: (() => {
        let n = 0;
        return () => Promise.resolve(n++ === 0 ? idle : done);
      })(),
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      requested: { head, base },
      role: "reviewer",
      laneId: "lane-1",
      candidateIds: [],
      deadline: 1_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(sent).toEqual([{ type: "accept" }]);
    expect(controlPlaneCompletion(completed, { head, base })).toMatchObject({
      reportOk: true,
      reviewAlive: false,
    });

    const blocked = {
      runId: "verify6633d1",
      observedAt: "",
      placementId: null,
      processes: running,
      artifacts: [
        {
          path: "/workspace/runs/verify6633d1/status.json",
          exists: true,
          content: JSON.stringify({
            phase: "review",
            state: "blocked",
            childIdle: true,
            terminalReason: "auth_blocked",
            lastCandidateResult: "",
          }),
        },
        {
          path: "/workspace/runs/verify6633d1/review-error.json",
          exists: true,
          content: JSON.stringify({
            reason: "auth_blocked",
            errorMessage: "<html><body>blocked</body></html>",
          }),
        },
      ],
    };
    expect(promptFailure(blocked)).toBe("provider auth_blocked");
    const cancelled: unknown[] = [];
    let now = 0;
    let polls = 0;
    await expect(
      driveUntilComplete({
        poll: () => {
          polls += 1;
          return Promise.resolve(blocked);
        },
        send: (command) => {
          cancelled.push(command);
          return Promise.resolve({ success: true });
        },
        requested: { head, base },
        role: "verifier",
        laneId: "lane-1",
        candidateIds: ["c1"],
        deadline: 600_000,
        now: () => now,
        sleep: () => {
          now += REPORT_GRACE_MS / 2;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("provider auth_blocked");
    // One cancel, and the failure waits out the report grace rather than the
    // whole run budget: a rejected credential still has a container holding
    // work worth writing down.
    expect(cancelled).toEqual([{ type: "cancel" }]);
    expect(polls).toBe(3);
  });

  it("accepts a failed idle candidate then fails model_error without waiting", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const running = [
      {
        id: "review",
        command: "/opt/review/review-run.sh /workspace/runs/run",
        status: "running",
      },
    ];
    const candidate = [
      "```json",
      JSON.stringify({
        status: "complete",
        blockerReason: "",
        findings: [
          {
            severity: "P1",
            file: "agents/review-pi/src/drive.ts",
            line: 1,
            mechanism: "handshake omitted accept",
            evidence: "idle with lastCandidateResult and no command route",
            affectedBehavior:
              "the run waits out the budget without report.json",
          },
        ],
      }),
      "```",
    ].join("\n");
    const failed = {
      runId: "reviewer-2",
      observedAt: "",
      placementId: null,
      processes: running,
      artifacts: [
        {
          path: "/workspace/runs/reviewer-2/status.json",
          exists: true,
          content: JSON.stringify({
            phase: "review",
            state: "failed",
            childIdle: true,
            isStreaming: false,
            inFlightTool: null,
            terminalReason: "model_error",
            lastCandidateResult: candidate,
          }),
        },
        {
          path: "/workspace/runs/reviewer-2/review-error.json",
          exists: true,
          content: JSON.stringify({
            reason: "model_error",
            errorMessage:
              "OpenAI Responses stream ended before a terminal response event",
          }),
        },
      ],
    };
    const report = JSON.stringify({
      checkout: { checkedOutHead: head, checkedOutBase: base },
    });
    const done = {
      runId: "reviewer-2",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/reviewer-2/report.json",
          exists: true,
          content: report,
        },
        {
          path: "/workspace/runs/reviewer-2/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    const sent: unknown[] = [];
    await driveUntilComplete({
      poll: (() => {
        let n = 0;
        return () => Promise.resolve(n++ === 0 ? failed : done);
      })(),
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      requested: { head, base },
      role: "reviewer",
      laneId: "reviewer-2",
      candidateIds: [],
      deadline: 1_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(sent).toEqual([{ type: "accept" }]);

    let polls = 0;
    const hung = {
      ...failed,
      artifacts: [
        {
          path: "/workspace/runs/reviewer-2/status.json",
          exists: true,
          content: JSON.stringify({
            phase: "review",
            state: "failed",
            childIdle: true,
            terminalReason: "model_error",
            lastCandidateResult: "",
          }),
        },
        {
          path: "/workspace/runs/reviewer-2/review-error.json",
          exists: true,
          content: JSON.stringify({
            reason: "model_error",
            errorMessage:
              "OpenAI Responses stream ended before a terminal response event",
          }),
        },
      ],
    };
    // The failure still ends the lane, but the container is told to stop first:
    // the runner writes the report it reached on the way out, and only a lane
    // that never produces one is destroyed with nothing to show.
    const cancelled: unknown[] = [];
    let now = 0;
    await expect(
      driveUntilComplete({
        poll: () => {
          polls += 1;
          return Promise.resolve(hung);
        },
        send: (command) => {
          cancelled.push(command);
          return Promise.resolve({ success: true });
        },
        requested: { head, base },
        role: "reviewer",
        laneId: "reviewer-2",
        candidateIds: [],
        deadline: 600_000,
        now: () => now,
        sleep: () => {
          now += REPORT_GRACE_MS;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/model_error/);
    expect(cancelled).toEqual([{ type: "cancel" }]);
    expect(polls).toBe(2);
  });

  it("spends one request telling a lane at its cap to answer with what it has", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const running = [
      {
        id: "review",
        command: "/opt/review/review-run.sh /workspace/runs/run",
        status: "running",
      },
    ];
    const at = (status: Record<string, unknown>, requests: number) => ({
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: running,
      control: { modelUsage: { totals: { requests } } },
      artifacts: [
        {
          path: "/workspace/runs/run/status.json",
          exists: true,
          content: JSON.stringify({ phase: "review", ...status }),
        },
      ],
    });
    const streaming = at(
      {
        state: "running",
        childIdle: false,
        isStreaming: true,
        inFlightTool: "tool-1",
      },
      62,
    );
    const idle = at(
      {
        state: "idle",
        childIdle: true,
        isStreaming: false,
        inFlightTool: null,
      },
      62,
    );
    const done = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/run/report.json",
          exists: true,
          content: JSON.stringify({
            completion: "partial",
            checkout: { checkedOutHead: head, checkedOutBase: base },
          }),
        },
        {
          path: "/workspace/runs/run/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    const states = [streaming, idle, idle, done];
    const sent: Record<string, unknown>[] = [];
    const finalized: {
      usedRequests: number | null;
      maxRequests: number | null;
    }[] = [];
    const completed = await driveUntilComplete({
      poll: () => Promise.resolve(states.shift() ?? done),
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      requested: { head, base },
      role: "reviewer",
      laneId: "reviewer-1",
      candidateIds: [],
      deadline: 600_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
      maxRequests: 64,
      onFinalize: (info) => {
        finalized.push(info);
      },
    });

    // One instruction, as soon as the reserve is all that is left, and it is
    // steered into the turn the lane is already running: a lane that keeps
    // calling tools is the one that has to be told to stop.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "prompt",
      streamingBehavior: "steer",
    });
    expect(String(sent[0]?.["message"])).toContain("62 of your 64");
    expect(String(sent[0]?.["message"])).toContain("partial");
    expect(finalized).toEqual([
      expect.objectContaining({ usedRequests: 62, maxRequests: 64 }),
    ]);
    expect(64 - 62).toBeLessThanOrEqual(FINALIZE_REQUEST_RESERVE);
    // The lane was cut, and the report it left says so.
    expect(controlPlaneCompletion(completed, { head, base }).reportOk).toBe(
      true,
    );
  });

  it("answers on the brief's verdict deadline without waiting for the request cap", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const running = [
      {
        id: "review",
        command: "/opt/review/review-run.sh /workspace/runs/run",
        status: "running",
      },
    ];
    const at = (
      status: Record<string, unknown>,
      requests: number,
      now: number,
    ) => ({
      now,
      state: {
        runId: "run",
        observedAt: "",
        placementId: null,
        processes: running,
        control: { modelUsage: { totals: { requests } } },
        artifacts: [
          {
            path: "/workspace/runs/run/status.json",
            exists: true,
            content: JSON.stringify({ phase: "review", ...status }),
          },
        ],
      },
    });
    const idle = {
      state: "idle",
      childIdle: true,
      isStreaming: false,
      inFlightTool: null,
    };
    const streaming = {
      state: "running",
      childIdle: false,
      isStreaming: true,
      inFlightTool: "tool-1",
    };
    const done = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/run/report.json",
          exists: true,
          content: JSON.stringify({
            completion: "partial",
            checkout: { checkedOutHead: head, checkedOutBase: base },
          }),
        },
        {
          path: "/workspace/runs/run/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    // The deadline is the pool's, and the lane is nowhere near its request cap
    // when it arrives: five requests of sixty-four, with the reserve untouched.
    const deadline = 300_000;
    const states = [
      at(idle, 3, 1_000),
      at(streaming, 4, deadline - FINALIZE_REPORT_MARGIN_MS - 1_000),
      at(streaming, 5, deadline - FINALIZE_REPORT_MARGIN_MS),
      at(streaming, 6, deadline),
    ];
    let current = 0;
    const sent: Record<string, unknown>[] = [];
    const finalized: { usedRequests: number | null }[] = [];
    const completed = await driveUntilComplete({
      poll: () => {
        const next = states.shift();
        current = next?.now ?? deadline;
        return Promise.resolve(next?.state ?? done);
      },
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      brief: () =>
        Promise.resolve({
          prompt: "verify c1",
          candidateIds: ["c1"],
          verdictDeadlineAt: deadline,
        }),
      requested: { head, base },
      role: "verifier",
      laneId: "verifier-1",
      candidateIds: [],
      deadline: 600_000,
      now: () => current,
      sleep: () => Promise.resolve(),
      maxRequests: 64,
      onFinalize: (info) => {
        finalized.push(info);
      },
    });

    // The brief first, then exactly one finalize, and it is steered into the
    // turn the lane is still running rather than left for an idle moment it
    // may never reach.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ type: "prompt", message: "verify c1" });
    expect(sent[1]).toMatchObject({
      type: "prompt",
      streamingBehavior: "steer",
    });
    expect(String(sent[1]?.["message"])).toContain("verdict deadline");
    expect(String(sent[1]?.["message"])).not.toContain("of your 64");
    expect(finalized).toEqual([
      expect.objectContaining({ usedRequests: 5, maxRequests: 64 }),
    ]);
    expect(64 - 5).toBeGreaterThan(FINALIZE_REQUEST_RESERVE);
    expect(controlPlaneCompletion(completed, { head, base }).reportOk).toBe(
      true,
    );
  });

  it("does not steer a lane that is already idle and waiting for its answer", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const idle = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [
        {
          id: "review",
          command: "/opt/review/review-run.sh /workspace/runs/run",
          status: "running",
        },
      ],
      control: { modelUsage: { totals: { requests: 60 } } },
      artifacts: [
        {
          path: "/workspace/runs/run/status.json",
          exists: true,
          content: JSON.stringify({
            phase: "review",
            state: "idle",
            childIdle: true,
            isStreaming: false,
            inFlightTool: null,
          }),
        },
      ],
    };
    const done = {
      runId: "run",
      observedAt: "",
      placementId: null,
      processes: [],
      artifacts: [
        {
          path: "/workspace/runs/run/report.json",
          exists: true,
          content: JSON.stringify({
            completion: "partial",
            checkout: { checkedOutHead: head, checkedOutBase: base },
          }),
        },
        {
          path: "/workspace/runs/run/steps.jsonl",
          exists: true,
          content: `${JSON.stringify({ step: "report", exit: 0 })}\n`,
        },
      ],
    };
    const states = [idle, done];
    const sent: Record<string, unknown>[] = [];
    await driveUntilComplete({
      poll: () => Promise.resolve(states.shift() ?? done),
      send: (command) => {
        sent.push(command);
        return Promise.resolve({ success: true });
      },
      requested: { head, base },
      role: "reviewer",
      laneId: "reviewer-1",
      candidateIds: [],
      deadline: 600_000,
      now: () => 0,
      sleep: () => Promise.resolve(),
      maxRequests: 64,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "prompt",
      message: expect.stringContaining("60 of your 64"),
    });
  });

  it("keeps the bearer in the broker config and out of the job", () => {
    const plan = planBroker(
      "xai",
      {
        authRoute: "subscription-oauth",
        accessToken: "xai-access",
        expires: Date.now() + 60_000,
        authJson: null,
        env: {},
        redactions: ["xai-access"],
      },
      SESSION_CAPS.t1b,
      BROKER_LEDGER,
    );
    const payload = buildCloudStartPayload({
      job: {
        runId: "run-1",
        expectedRunnerSha: "b".repeat(64),
        head: { sha: "a".repeat(40) },
        base: { sha: "c".repeat(40) },
        provider: "xai",
        model: "grok-4.6",
        thinking: "high",
        prompt: "review",
        checkCommand: "true",
        installTimeoutSeconds: 60,
        piTimeoutSeconds: 60,
        totalTimeoutSeconds: 60,
      },
      broker: plan,
      modelsJson: "{}",
    });
    expect(JSON.stringify(payload.job)).not.toContain("xai-access");
    expect(payload.broker.upstreamAuthorization).toContain("xai-access");
  });

  it("gives the target the account id and keeps the key with the broker", () => {
    const credentials = {
      authRoute: "api-key" as const,
      accessToken: undefined,
      authJson: null,
      env: {
        CLOUDFLARE_API_KEY: "cf-key",
        CLOUDFLARE_ACCOUNT_ID: "0630089e",
      },
      redactions: ["cf-key"],
    };
    // Pi refuses to configure Workers AI without the account id in its own
    // environment, so a lane that never receives it cannot run the provider
    // the isolated modes default to.
    expect(targetProviderEnv("cloudflare-workers-ai", credentials)).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "0630089e",
    });
    expect(targetProviderEnv("xai", credentials)).toEqual({});
    const payload = buildCloudStartPayload({
      job: {
        runId: "run-1",
        expectedRunnerSha: "b".repeat(64),
        head: { sha: "a".repeat(40) },
        base: { sha: "c".repeat(40) },
        provider: "cloudflare-workers-ai",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        thinking: "high",
        prompt: "review",
        checkCommand: "true",
        installTimeoutSeconds: 60,
        piTimeoutSeconds: 60,
        totalTimeoutSeconds: 60,
        targetEnv: targetProviderEnv("cloudflare-workers-ai", credentials),
      },
      broker: planBroker(
        "cloudflare-workers-ai",
        credentials,
        SESSION_CAPS.t1b,
        BROKER_LEDGER,
      ),
      modelsJson: "{}",
    });
    expect(JSON.stringify(payload.job)).not.toContain("cf-key");
    expect(parseCloudRunRequest(payload).job.targetEnv).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "0630089e",
    });
  });
});

describe("writeCloudReceipt", () => {
  it("never lets a reader observe a partial receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    const path = join(directory, "receipt.json");
    const receipt = {
      runId: "run-1",
      probe: "x".repeat(8 * 1024 * 1024),
    };
    const body = JSON.stringify(receipt, null, 2);
    const state = { writing: true, absent: false, torn: false };
    const readers = Array.from({ length: 4 }, () =>
      (async () => {
        while (state.writing) {
          const raw = await readFile(path, "utf8").catch(() => null);
          if (raw === null) state.absent = true;
          else if (raw !== body) state.torn = true;
        }
      })(),
    );
    try {
      await writeCloudReceipt(directory, receipt);
    } finally {
      state.writing = false;
    }
    await Promise.all(readers);

    expect(state.absent).toBe(true);
    expect(state.torn).toBe(false);
    expect(await readFile(path, "utf8")).toBe(body);
    await rm(directory, { recursive: true, force: true });
  });
});
