import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
appendFileSync(process.env.PI_LOG, JSON.stringify({args, env, phase, family: process.env.PI_FAMILY, promptChars: prompt.length, prompt}) + "\\n");
const event = (data) => process.stdout.write(JSON.stringify(data) + "\\n");
if ((process.env.PI_HANG === "cap" || process.env.PI_HANG === "time") && !reportTurn) {
  setInterval(() => {
    event({type:"turn_start"});
    event({type:"turn_end",message:{stopReason:"toolUse",usage:{input:1,output:1,totalTokens:2}}});
  }, process.env.PI_HANG === "time" ? 300 : 20);
} else if (process.env.PI_HANG === "error") {
  event({type:"turn_start"});
  event({type:"turn_end",message:{stopReason:"error",errorMessage:"400 status code (no body)",usage:{input:0,output:0,totalTokens:0}}});
  event({type:"agent_end",messages:[{role:"assistant",content:[],stopReason:"error",errorMessage:"400 status code (no body)"}]});
} else if (process.env.PI_HANG === "deadline") {
  setInterval(() => {}, 1000);
} else {
  event({type:"turn_start"});
  event({type:"turn_end",message:{stopReason:"stop",usage:{input:2,output:3,totalTokens:5}}});
  const answer = verifying
    ? {verdicts:[{id:"c1",status:"confirmed",severity:"P1",evidenceStrength:"static",diffRelation:"added",declaredIntent:null,reason:"value changes for callers"}]}
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
        PATH: `${input.bin}:${process.env.PATH}`,
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
  expect(receipt.lanes?.[0]?.turns).toBe(9);
  expect(receipt.candidates).toHaveLength(1);
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
  expect(calls).toHaveLength(3);
  expect(calls[1]?.args).toContain("--no-tools");
  expect(calls[1]?.args).toContain("--session-id");
  const sessionId = (args: string[]) => args[args.indexOf("--session-id") + 1];
  expect(sessionId(calls[1]!.args)).toBe(sessionId(calls[0]!.args));
  expect(calls[1]?.prompt).toContain("report now");
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
  expect(receipt.lanes[0]?.turns).toBeLessThan(9);
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
  expect(receipt.lanes[1]).toMatchObject({ status: "completed", turns: 9 });
  expect(receipt.findings[0]?.status).toBe("confirmed");
  const calls = (await readFile(input.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[] });
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
  expect(receipt.wallSeconds).toBeLessThan(4);
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
  expect(receipt.lanes?.[0]?.stopReason).toBe("deadline");
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
