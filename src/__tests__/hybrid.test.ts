import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertPublishableReceipt, type SwarmReceipt } from "../publish";

type HybridReceipt = SwarmReceipt & {
  lanes: (NonNullable<SwarmReceipt["lanes"]>[number] & {
    stopReason: string | null;
    turns: number;
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
const prompt = args.at(-1);
const verifying = prompt.includes('"candidates"');
const env = Object.keys(process.env).sort();
const phase = JSON.parse(readFileSync(process.env.PI_OUT + "/status.json", "utf8")).phase;
appendFileSync(process.env.PI_LOG, JSON.stringify({args, env, phase, family: process.env.PI_FAMILY}) + "\\n");
const event = (data) => process.stdout.write(JSON.stringify(data) + "\\n");
if (process.env.PI_HANG === "cap") {
  setInterval(() => {
    event({type:"turn_start"});
    event({type:"turn_end",message:{stopReason:"tool_use",usage:{input:1,output:1,totalTokens:2}}});
  }, 20);
} else if (process.env.PI_HANG === "deadline") {
  setInterval(() => {}, 1000);
} else {
  event({type:"turn_start"});
  event({type:"turn_end",message:{stopReason:"stop",usage:{input:2,output:3,totalTokens:5}}});
  const answer = verifying
    ? {verdicts:[{id:"c1",status:"confirmed",severity:"P1",evidenceStrength:"static",diffRelation:"added",declaredIntent:null,reason:"value changes for callers"}]}
    : {status:"complete",blockerReason:"",findings:[{severity:"P1",file:"a.ts",line:1,mechanism:"value changes",evidence:"diff",affectedBehavior:"caller sees 2"}]};
  const fence = String.fromCharCode(96).repeat(3);
  event({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:fence+"json\\n"+JSON.stringify(answer)+"\\n"+fence}]}]});
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
    expect(call.args).toContain("--no-session");
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

it("kills a lane at the turn cap and declares it", async () => {
  const input = await setup();
  const config = JSON.parse(await readFile(input.lanes, "utf8"));
  config.reviewers[0].env.PI_HANG = "cap";
  await writeFile(input.lanes, JSON.stringify(config));
  const result = run(input, 5);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(
    await readFile(join(input.out, "receipt.json"), "utf8"),
  ) as HybridReceipt;
  expect(receipt.lanes?.[0]?.status).toBe("cancelled");
  expect(receipt.lanes?.[0]?.model).toBe("test-a");
  expect(receipt.lanes?.[0]?.stopReason).toBe("turn cap");
  expect(receipt.lanes?.[0]?.turns).toBe(8);
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
