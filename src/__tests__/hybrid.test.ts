import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertPublishableReceipt, type SwarmReceipt } from "../publish";

type HybridReceipt = SwarmReceipt & {
  candidates: unknown[];
  lanes: (NonNullable<SwarmReceipt["lanes"]>[number] & {
    stopReason: string | null;
    turns: number;
    finalText: string;
    contractError: string | null;
  })[];
};

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup(verifierFamily = "openai-codex") {
  const root = await mkdtemp(join(tmpdir(), "hybrid-test-"));
  roots.push(root);
  const source = join(root, "source");
  const bin = join(root, "bin");
  const out = join(root, "out");
  await mkdir(source);
  await mkdir(bin);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(source, "a.ts"), "export const value = 1;\n");
  git("add", "a.ts");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "-qm",
    "base",
  );
  const base = git("rev-parse", "HEAD");
  await writeFile(join(source, "a.ts"), "export const value = 2;\n");
  git("add", "a.ts");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "-qm",
    "head",
  );
  const head = git("rev-parse", "HEAD");
  const log = join(root, "pi.jsonl");
  const fake = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const reportTurn = args.includes("--no-tools");
const env = Object.keys(process.env).sort();
const phase = JSON.parse(readFileSync(process.env.PI_OUT + "/status.json", "utf8")).phase;
const verifying = phase === "verifying";
appendFileSync(process.env.PI_LOG, JSON.stringify({at: Date.now(), args, env, phase, family: process.env.PI_FAMILY, promptChars: prompt.length, prompt}) + "\\n");
appendFileSync(args[args.indexOf("--session-dir") + 1] + "/2026-09-26T12-00-00-000Z_" + args[args.indexOf("--session-id") + 1] + ".jsonl", JSON.stringify({type: reportTurn ? "report" : "turn", family: process.env.PI_FAMILY}) + "\\n");
const event = (data) => process.stdout.write(JSON.stringify(data) + "\\n");
if (process.env.PI_HANG === "runaway" || ((process.env.PI_HANG === "cap" || process.env.PI_HANG === "time") && !reportTurn)) {
  setInterval(() => {
    event({type:"turn_start"});
    event({type:"turn_end",message:{stopReason:"toolUse",usage:{input:1,output:1,totalTokens:2}}});
  }, process.env.PI_HANG === "time" ? 300 : 20);
} else if (process.env.PI_HANG === "error") {
  event({type:"turn_start"});
  event({type:"turn_end",message:{stopReason:"error",errorMessage:"400 status code (no body)",usage:{input:0,output:0,totalTokens:0}}});
  event({type:"agent_end",messages:[{role:"assistant",content:[],stopReason:"error",errorMessage:"400 status code (no body)"}]});
} else if (process.env.PI_HANG === "midturn") {
  const fence = String.fromCharCode(96).repeat(3);
  const report = fence + "json\\n" + JSON.stringify({status:"complete",blockerReason:"",findings:[{severity:"P1",file:"a.ts",line:1,mechanism:"value changes",evidence:"diff",affectedBehavior:"caller sees 2"}]}) + "\\n" + fence;
  const usage = {input:1,output:1,totalTokens:2};
  event({type:"turn_start"});
  event({type:"message_update",usage,assistantMessageEvent:{type:"thinking_start",contentIndex:0}});
  event({type:"message_update",usage,assistantMessageEvent:{type:"thinking_delta",contentIndex:0,delta:"weighing "}});
  event({type:"message_update",usage,assistantMessageEvent:{type:"thinking_delta",contentIndex:0,delta:"the change"}});
  event({type:"message_update",usage,assistantMessageEvent:{type:"text_start",contentIndex:1}});
  for (const delta of ["🧪".repeat(5000), report])
    event({type:"message_update",usage,assistantMessageEvent:{type:"text_delta",contentIndex:1,delta}});
  setInterval(() => {}, 1000);
} else if (process.env.PI_HANG === "deadline" || (process.env.PI_HANG === "stall" && !reportTurn)) {
  setInterval(() => {}, 1000);
} else {
  event({type:"turn_start"});
  event({type:"turn_end",message:{stopReason:"stop",usage:{input:2,output:3,totalTokens:5}}});
  const candidateId = (prompt.match(/"candidates":\\[\\{"id":"(c\\d+)"/) ?? [])[1] ?? "c1";
  const answer = verifying
    ? {verdicts:[{id:candidateId,status:"confirmed",severity:"P1",evidenceStrength:"static",diffRelation:"added",declaredIntent:null,reason:"value changes for callers"}]}
    : process.env.PI_REPORT === "none" ? {status:"complete",blockerReason:"",findings:[]}
    : process.env.PI_REPORT === "many" ? {status:"complete",blockerReason:"",findings:Array.from({length:9},(_, index) => ({severity:index === 0 ? "P2" : "P1",file:"a.ts",line:1,mechanism:"value changes " + index,evidence:"diff",affectedBehavior:"caller sees 2"}))}
    : {status:"complete",blockerReason:"",findings:[{severity:"P1",file:"a.ts",line:1,mechanism:"value changes",evidence:"diff",affectedBehavior:"caller sees 2"}]};
  const fence = String.fromCharCode(96).repeat(3);
  const text = process.env.PI_REPORT === "empty" && !verifying ? "" : process.env.PI_REPORT === "invalid" && !verifying ? "not a report" : process.env.PI_REPORT === "large" && !verifying ? "🧪".repeat(5000) + fence + "json\\n" + JSON.stringify(answer) + "\\n" + fence : fence + "json\\n" + JSON.stringify(answer) + "\\n" + fence;
  event({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text}]}]});
}
`;
  await writeFile(join(bin, "pi"), fake, { mode: 0o755 });
  const lane = (family: string, provider: string, model: string) => ({
    family,
    provider,
    model,
    piDir: join(root, family),
    extensions: [join(root, "provider.js")],
    env: { PI_LOG: log, PI_OUT: out, PI_FAMILY: family },
  });
  const lanes = join(root, "lanes.json");
  await writeFile(
    lanes,
    JSON.stringify({
      reviewers: [lane("workers-ai", "cloudflare-workers-ai", "test-a")],
      verifiers: [lane(verifierFamily, "openai-codex", "test-b")],
    }),
  );
  return { root, source, bin, out, log, lanes, head, base };
}

function run(
  input: Awaited<ReturnType<typeof setup>>,
  timeout = 10,
  bundle?: string,
  envExtra: Record<string, string> = {},
) {
  return spawnSync(
    "bun",
    [
      bundle ?? join(import.meta.dirname, "../swarm.ts"),
      "--hybrid",
      "--repo",
      "owner/name",
      "--source",
      input.source,
      "--pr",
      "12",
      "--head",
      input.head,
      "--base",
      input.base,
      "--lanes",
      input.lanes,
      "--total-timeout",
      String(timeout),
      "--out",
      input.out,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      cwd: input.source,
      env: {
        ...process.env,
        PATH: `${input.bin}:${process.env["PATH"]}`,
        PARENT_SECRET_SENTINEL: "do-not-copy",
        ...envExtra,
      },
    },
  );
}

it("runs read-only cross-family lanes with a scrubbed environment and a publishable receipt", async () => {
  const input = await setup();
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          env: string[];
          phase: string;
          family: string;
        },
    );
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.phase)).toEqual(["reviewing", "verifying"]);
  expect(calls.map((call) => call.family)).toEqual([
    "workers-ai",
    "openai-codex",
  ]);
  for (const call of calls) {
    expect(call.args).toContain("--session-id");
    expect(call.args).toContain("--no-extensions");
    expect(call.args).toContain("--no-skills");
    expect(call.args).toContain("--no-prompt-templates");
    expect(
      call.args.slice(
        call.args.indexOf("--tools"),
        call.args.indexOf("--tools") + 2,
      ),
    ).toEqual(["--tools", "read,grep,find,ls"]);
    expect(call.args).not.toContain("--approve");
    expect(call.env).not.toContain("PARENT_SECRET_SENTINEL");
    expect(call.env).toContain("PI_OFFLINE");
    expect(call.env).toContain("PI_SKIP_VERSION_CHECK");
  }
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.findings[0]?.status).toBe("confirmed");
  expect(receipt.lanes?.map((lane) => lane.status)).toEqual([
    "completed",
    "completed",
  ]);
  assertPublishableReceipt(receipt, {
    head: input.head,
    mergeBase: input.base,
  });
  expect(
    JSON.parse(await readFile(join(input.out, "status.json"), "utf8")).phase,
  ).toBe("done");
});

it("hands Pi a context pack larger than one argument can carry", async () => {
  const input = await setup();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", input.source, ...args], { encoding: "utf8" });
  await writeFile(
    join(input.source, "a.ts"),
    `export const value = 2;\n${"// padding line\n".repeat(100_000)}`,
  );
  git("add", "a.ts");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "-qm",
    "large head",
  );
  const head = git("rev-parse", "HEAD").trim();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].model = "@cf/deepseek-ai/deepseek-v4-flash-0731";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run({ ...input, head });
  expect(result.status, result.stderr).toBe(0);
  const [reviewer] = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; promptChars: number });
  expect(reviewer?.promptChars).toBeGreaterThan(1_600_000);
  expect(
    Math.max(...(reviewer?.args ?? []).map((arg) => arg.length)),
  ).toBeLessThan(131_072);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[0]?.status).toBe("completed");
});

it("leaves a candidate unverified when every verifier is from the finder family", async () => {
  const input = await setup("workers-ai");
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.status).toBe("partial");
  expect(receipt.findings[0]?.status).toBe("unverified");
  expect((await readFile(input.log, "utf8")).trim().split("\n")).toHaveLength(
    1,
  );
});

async function familyLanes(
  input: Awaited<ReturnType<typeof setup>>,
  reviewers: [string, Record<string, string>][],
  verifiers: [string, Record<string, string>][],
) {
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  const base = config.reviewers[0];
  const lane = ([family, env]: [string, Record<string, string>]) => ({
    ...base,
    family,
    env: { ...base.env, PI_FAMILY: family, ...env },
  });
  await writeFile(
    input.lanes,
    JSON.stringify({
      reviewers: reviewers.map(lane),
      verifiers: verifiers.map(lane),
    }),
  );
}

it("sends a candidate to a family whose reviewer completed over one whose reviewer was cut", async () => {
  const input = await setup();
  await familyLanes(
    input,
    [
      ["claude-code", {}],
      ["workers-ai", { PI_HANG: "deadline" }],
      ["openai-codex", { PI_REPORT: "none" }],
    ],
    [
      ["workers-ai", {}],
      ["openai-codex", {}],
      ["claude-code", {}],
    ],
  );
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(
    receipt.lanes.filter((lane) => lane.role === "verifier"),
  ).toMatchObject([{ family: "openai-codex", status: "completed" }]);
  expect(
    (await calls(input.log))
      .filter((call) => call.phase === "verifying")
      .map((call) => call.family),
  ).toEqual(["openai-codex"]);
  expect(receipt.findings[0]?.status).toBe("confirmed");
});

it("offers a candidate to the first finder-free family in the Worker's verifier order when every reviewer completes", async () => {
  const cases = [
    { finder: "claude-code", verifier: "openai-codex" },
    { finder: "openai-codex", verifier: "claude-code" },
  ];
  for (const { finder, verifier } of cases) {
    const input = await setup();
    await familyLanes(
      input,
      ["workers-ai", "openai-codex", "claude-code"].map((family) => [
        family,
        family === finder ? {} : { PI_REPORT: "none" },
      ]),
      [
        ["openai-codex", {}],
        ["claude-code", {}],
        ["workers-ai", {}],
      ],
    );
    const result = run(input);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(
      await readFile(join(input.out, "receipt.json"), "utf8"),
    ) as HybridReceipt;
    expect(
      receipt.lanes.filter((lane) => lane.role === "reviewer"),
    ).toMatchObject([
      { family: "workers-ai", status: "completed" },
      { family: "openai-codex", status: "completed" },
      { family: "claude-code", status: "completed" },
    ]);
    expect(
      (await calls(input.log))
        .filter((call) => call.phase === "verifying")
        .map((call) => call.family),
    ).toEqual([verifier]);
    expect(receipt.findings[0]?.status).toBe("confirmed");
  }
});

it("rules on at most eight candidates per verifier family, most severe first, and declares the rest", async () => {
  const input = await setup();
  await familyLanes(
    input,
    [["workers-ai", { PI_REPORT: "many" }]],
    [["openai-codex", {}]],
  );
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(
    (await calls(input.log)).filter((call) => call.phase === "verifying"),
  ).toHaveLength(8);
  expect(
    receipt.findings.filter((finding) => finding.status === "confirmed"),
  ).toHaveLength(8);
  expect(
    receipt.findings.filter((finding) => finding.status === "unverified"),
  ).toEqual([
    expect.objectContaining({
      mechanism: "value changes 0",
      unverifiedReason:
        "every verifier family that can rule already has 8 candidates",
    }),
  ]);
  expect(receipt.status).toBe("partial");
});

it("hands a candidate past one family's share to the next family that can rule", async () => {
  const input = await setup();
  await familyLanes(
    input,
    [["workers-ai", { PI_REPORT: "many" }]],
    [
      ["openai-codex", {}],
      ["claude-code", {}],
    ],
  );
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(
    (await calls(input.log))
      .filter((call) => call.phase === "verifying")
      .map((call) => call.family)
      .sort(),
  ).toEqual([...Array(8).fill("openai-codex"), "claude-code"].sort());
  expect(
    receipt.findings.every((finding) => finding.status === "confirmed"),
  ).toBe(true);
});

it("never sends a candidate to a family whose reviewer failed", async () => {
  const input = await setup();
  await familyLanes(
    input,
    [
      ["claude-code", {}],
      ["openai-codex", { PI_HANG: "error" }],
    ],
    [
      ["openai-codex", {}],
      ["workers-ai", {}],
    ],
  );
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[1]).toMatchObject({
    family: "openai-codex",
    status: "failed",
  });
  expect(
    (await calls(input.log))
      .filter((call) => call.phase === "verifying")
      .map((call) => call.family),
  ).toEqual(["workers-ai"]);
  expect(receipt.findings[0]?.status).toBe("confirmed");
});

it("leaves a candidate unverified with a reason when no verifier family can rule on it", async () => {
  const input = await setup();
  await familyLanes(
    input,
    [
      ["claude-code", {}],
      ["openai-codex", { PI_HANG: "error" }],
    ],
    [
      ["openai-codex", {}],
      ["claude-code", {}],
    ],
  );
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.status).toBe("partial");
  expect(receipt.findings[0]).toMatchObject({
    status: "unverified",
    unverifiedReason:
      "no verifier family can rule: reported by claude-code; reviewer failed in openai-codex",
  });
  expect(receipt.lanes.some((lane) => lane.role === "verifier")).toBe(false);
  expect(
    (await calls(input.log)).filter((call) => call.phase === "verifying"),
  ).toHaveLength(0);
});

it("keeps what a lane cut mid-turn had streamed as partial evidence and never parses it", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "midturn";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 3);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt & {
    lanes: {
      streamed?: { partial: boolean; text: string; thinkingChars: number };
    }[];
  };
  const lane = receipt.lanes[0]!;
  expect(lane).toMatchObject({
    status: "cancelled",
    stopReason: "review deadline",
    finalText: "",
    contractError: null,
  });
  expect(lane.streamed).toMatchObject({
    partial: true,
    thinkingChars: "weighing the change".length,
  });
  expect(Buffer.byteLength(lane.streamed!.text)).toBeLessThanOrEqual(16 * 1024);
  expect(lane.streamed!.text).not.toContain("\uFFFD");
  expect(lane.streamed!.text).toContain('"status":"complete"');
  expect(lane.streamed!.text.startsWith("🧪")).toBe(true);
  expect(receipt.candidates).toHaveLength(0);
  expect(receipt.findings).toHaveLength(0);
  expect(receipt.status).toBe("partial");
});

it("uses a third family when two finder families reported the same candidate", async () => {
  const input = await setup("claude-code");
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers.push({
    ...config.verifiers[0],
    family: "openai-codex",
    env: { ...config.verifiers[0].env, PI_FAMILY: "openai-codex" },
  });
  config.verifiers[0].env.PI_FAMILY = "claude-code";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  );
  expect(receipt.candidates).toHaveLength(1);
  expect(receipt.candidates[0].reportedBy.sort()).toEqual([
    "reviewer-1",
    "reviewer-2",
  ]);
  expect(receipt.lanes[2].family).toBe("claude-code");
  expect(receipt.findings[0].status).toBe("confirmed");
});

it("gives a lane at the tool-turn budget one tools-off report turn and publishes its candidate", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "cap";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes?.[0]?.status).toBe("completed");
  expect(receipt.lanes?.[0]?.model).toBe("test-a");
  expect(receipt.lanes?.[0]?.turns).toBe(17);
  expect(receipt.candidates).toHaveLength(1);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.prompt).toContain("at most 16 investigation turns");
  expect(calls[1]?.args).toContain("--no-tools");
  expect(calls[1]?.args).toContain("--session-id");
  const sessionId = (args: string[]) => args[args.indexOf("--session-id") + 1];
  expect(sessionId(calls[1]!.args)).toBe(sessionId(calls[0]!.args));
  expect(calls[1]?.prompt).toContain("report now");
});

it("keeps each lane's Pi session under its lane id, the report turn included", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "cap";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const lanes = join(input.out, "lanes");
  expect((await readdir(lanes)).sort()).toEqual([
    "reviewer-1.jsonl",
    "verifier-c1.jsonl",
  ]);
  const session = async (name: string) =>
    (await readFile(join(lanes, name), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  expect(await session("reviewer-1.jsonl")).toEqual([
    { type: "turn", family: "workers-ai" },
    { type: "report", family: "workers-ai" },
  ]);
  expect(await session("verifier-c1.jsonl")).toEqual([
    { type: "turn", family: "openai-codex" },
  ]);
});

it("runs each lane's tool turns at the thinking level its config names and the report turn off", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].thinking = "low";
  config.reviewers[0].env.PI_HANG = "cap";
  config.verifiers[0].thinking = "high";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; family: string });
  const thinking = (args: string[]) =>
    args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2);
  expect(
    calls.map((call) => [
      call.family,
      call.args.includes("--no-tools") ? "report" : "tools",
      ...thinking(call.args),
    ]),
  ).toEqual([
    ["workers-ai", "tools", "--thinking", "low"],
    ["workers-ai", "report", "--thinking", "off"],
    ["openai-codex", "tools", "--thinking", "high"],
  ]);
});

it("refuses a lane whose thinking level Pi does not know", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].thinking = "extreme";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("invalid lane config");
});

it("kills a tools-off report turn that starts a second turn past the cap", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "runaway";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes?.[0]).toMatchObject({
    status: "cancelled",
    stopReason: "turn cap",
    turns: 17,
  });
  expect(receipt.candidates).toEqual([]);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[] });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toContain("--no-tools");
});

it("records an unparseable report as a contract error with its final text", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_REPORT = "invalid";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[0]).toMatchObject({
    status: "malformed",
    contractError: "no fenced json block",
    finalText: "not a report",
  });
  expect(receipt.candidates).toHaveLength(0);
});

it("records an empty final answer as a contract error", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_REPORT = "empty";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[0]).toMatchObject({
    status: "malformed",
    contractError: "no fenced json block",
    finalText: "",
  });
  expect(receipt.candidates).toHaveLength(0);
});

it("reserves time for a tools-off report before the deadline", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "time";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 3);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[0]?.status).toBe("completed");
  expect(receipt.lanes[0]?.turns).toBeLessThan(17);
  expect(receipt.candidates).toHaveLength(1);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[] });
  expect(calls[1]?.args).toContain("--no-tools");
});

it("gives a verifier at its tool-turn budget one tools-off verdict turn", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.verifiers[0].env.PI_HANG = "cap";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 6);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[1]).toMatchObject({ status: "completed", turns: 17 });
  expect(receipt.findings[0]?.status).toBe("confirmed");
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  expect(calls[1]?.prompt).toContain("at most 16 investigation turns");
  expect(calls[2]?.args).toContain("--no-tools");
});

it("cuts a slow verifier within its own time budget and leaves its candidate unverified", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.verifiers[0].env.PI_HANG = "deadline";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 4);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes[1]).toMatchObject({
    status: "cancelled",
    stopReason: "deadline",
  });
  expect(receipt.findings[0]?.status).toBe("unverified");
  expect(receipt.wallSeconds).toBeLessThanOrEqual(4);
});

it("keeps only the last 16 KiB of a lane's final text while parsing the whole answer", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_REPORT = "large";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(Buffer.byteLength(receipt.lanes[0]!.finalText)).toBeLessThanOrEqual(
    16 * 1024,
  );
  expect(receipt.lanes[0]?.finalText).not.toContain("\uFFFD");
  expect(receipt.lanes[0]?.finalText).toContain('"status":"complete"');
  expect(receipt.candidates).toHaveLength(1);
});

it("records Pi's own error for a lane whose turn ended in error", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "error";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt & { lanes: { usage: unknown }[] };
  expect(receipt.lanes[0]).toMatchObject({
    status: "failed",
    stopReason: "error",
    error: "400 status code (no body)",
    usage: null,
  });
});

it("kills a lane at the deadline and writes its receipt", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "deadline";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 1);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes?.[0]?.status).toBe("cancelled");
  expect(receipt.lanes?.[0]?.stopReason).toBe("review deadline");
});

type Call = { at: number; args: string[]; phase: string; family: string };
const calls = async (log: string) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
const windows = async (out: string) => {
  const status = JSON.parse(await readFile(join(out, "status.json"), "utf8"));
  const receipt = JSON.parse(
    await readFile(join(out, "receipt.json"), "utf8"),
  ) as HybridReceipt & { startedAt: string; finishedAt: string };
  return {
    receipt,
    startedAt: Date.parse(receipt.startedAt),
    reviewDeadlineAt: Date.parse(status.reviewDeadlineAt),
    deadlineAt: Date.parse(status.deadlineAt),
  };
};

it("hands a reviewer still running at the review deadline one tools-off report turn and keeps its findings", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "stall";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 10);
  expect(result.status, result.stderr).toBe(0);
  const { receipt, startedAt, reviewDeadlineAt } = await windows(input.out);
  expect(reviewDeadlineAt - startedAt).toBe(6000);
  const log = await calls(input.log);
  const reviewer = log.filter((call) => call.family === "workers-ai");
  expect(reviewer.map((call) => call.args.includes("--no-tools"))).toEqual([
    false,
    true,
  ]);
  expect(reviewer[1]!.at).toBeLessThan(reviewDeadlineAt);
  expect(
    reviewer[1]!.args.slice(
      reviewer[1]!.args.indexOf("--thinking"),
      reviewer[1]!.args.indexOf("--thinking") + 2,
    ),
  ).toEqual(["--thinking", "off"]);
  expect(reviewer[0]!.args).not.toContain("--thinking");
  expect(receipt.lanes[0]).toMatchObject({ status: "completed" });
  expect(receipt.candidates).toHaveLength(1);
  expect(receipt.findings[0]?.status).toBe("confirmed");
});

it("declares a reviewer cut at the review deadline when its report turn does not finish", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "deadline";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 10);
  expect(result.status, result.stderr).toBe(0);
  const { receipt, startedAt, reviewDeadlineAt } = await windows(input.out);
  const log = await calls(input.log);
  expect(log.map((call) => call.args.includes("--no-tools"))).toEqual([
    false,
    true,
  ]);
  expect(receipt.lanes[0]).toMatchObject({
    status: "cancelled",
    stopReason: "review deadline",
  });
  expect(receipt.status).toBe("partial");
  expect(Date.parse(receipt.finishedAt)).toBeLessThan(reviewDeadlineAt + 1000);
  expect(reviewDeadlineAt - startedAt).toBe(6000);
});

it("starts the verifiers after a stalled reviewer's review deadline and ends them by the run deadline", async () => {
  const input = await setup("claude-code");
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers.push({
    ...config.reviewers[0],
    family: "openai-codex",
    env: {
      ...config.reviewers[0].env,
      PI_FAMILY: "openai-codex",
      PI_HANG: "deadline",
    },
  });
  config.verifiers[0].env = {
    ...config.verifiers[0].env,
    PI_FAMILY: "claude-code",
    PI_HANG: "deadline",
  };
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 10);
  expect(result.status, result.stderr).toBe(0);
  const { receipt, reviewDeadlineAt, deadlineAt } = await windows(input.out);
  const verifier = (await calls(input.log)).find(
    (call) => call.family === "claude-code",
  );
  expect(verifier?.at).toBeGreaterThanOrEqual(reviewDeadlineAt);
  const verifierLane = receipt.lanes.find((lane) => lane.role === "verifier");
  expect(verifierLane).toMatchObject({
    status: "cancelled",
    stopReason: "deadline",
  });
  expect(Date.parse(receipt.finishedAt)).toBeLessThan(deadlineAt + 500);
  expect(receipt.findings[0]?.status).toBe("unverified");
});

it("starts the verifiers before the review deadline when every reviewer ends early", async () => {
  const input = await setup();
  const result = run(input, 10);
  expect(result.status, result.stderr).toBe(0);
  const { reviewDeadlineAt } = await windows(input.out);
  const verifier = (await calls(input.log)).find(
    (call) => call.phase === "verifying",
  );
  expect(verifier?.at).toBeLessThan(reviewDeadlineAt);
});

it("runs the single-file bundle from a checkout without node_modules", async () => {
  const input = await setup();
  const bundle = join(input.root, "engine.js");
  const built = spawnSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "../swarm.ts"),
      "--target",
      "bun",
      "--outfile",
      bundle,
    ],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  const result = run(input, 10, bundle);
  expect(result.status, result.stderr).toBe(0);
  expect(
    JSON.parse(await readFile(join(input.out, "receipt.json"), "utf8"))
      .findings[0].status,
  ).toBe("confirmed");
});
