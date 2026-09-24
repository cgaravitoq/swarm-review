import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { imageReference, imageTagFromFiles } from "./image-tag";

const exec = promisify(execFile);
type Env = Record<string, string | undefined>;

/** Which step a run died in, as `failure.json` reports it. */
type Stage =
  | "pull request lookup"
  | "account lookup"
  | "registry login"
  | "image pull"
  | "image build"
  | "image push"
  | "review";

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The last non-empty line of a child's stderr, which is where a failure says why. */
const lastLine = (stderr: string) => {
  const lines = stderr.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line) return line;
  }
  return "";
};

function run(command: string, args: string[], env: Env, input?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "pipe"],
    });
    // Only the tail is kept: a build's stderr runs to megabytes, and its last
    // line is the whole of what the failure has to name.
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const cause = lastLine(stderr);
      reject(
        new Error(cause || `${command} ${args[0]} exited with code ${code}`),
      );
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function accountId(env: Env): Promise<string> {
  if (env["CLOUDFLARE_ACCOUNT_ID"]) return env["CLOUDFLARE_ACCOUNT_ID"];
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts",
    {
      headers: {
        authorization: `Bearer ${required(env, "WORKERS_AI_API_KEY")}`,
      },
    },
  );
  if (!response.ok)
    throw new Error(`Cloudflare accounts lookup failed: ${response.status}`);
  const body = (await response.json()) as { result?: { id?: string }[] };
  if (body.result?.length !== 1 || !body.result[0]?.id) {
    throw new Error(
      `the key reaches ${body.result?.length ?? 0} accounts, not one: pass cloudflare-account-id`,
    );
  }
  return body.result[0].id;
}

export async function main(env: Env = process.env): Promise<void> {
  const mode = env["INPUT_MODE"] || "auto";
  if (mode !== "auto" && mode !== "packed" && mode !== "sandbox") {
    throw new Error(`mode must be auto, packed or sandbox: ${mode}`);
  }
  const repository = required(env, "GITHUB_REPOSITORY");
  const pullRequest = required(env, "PULL_REQUEST");
  const actionPath = required(env, "GITHUB_ACTION_PATH");
  const source = join(required(env, "GITHUB_WORKSPACE"), "swarm-review-source");
  const out = join(required(env, "RUNNER_TEMP"), "swarm-review");
  const swarmId = `pr-${pullRequest}-${required(env, "GITHUB_RUN_ID")}-${required(env, "GITHUB_RUN_ATTEMPT")}`;
  const swarmDir = join(out, swarmId);
  let stage: Stage = "pull request lookup";
  let packedFork = false;
  let runEnv = env;
  try {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${repository}/pulls/${pullRequest}`],
      { env },
    );
    const pull = JSON.parse(stdout) as {
      head?: { repo?: { full_name?: string } };
    };
    const headRepository = pull.head?.repo?.full_name;
    if (!headRepository) throw new Error("pull request has no head repository");
    const fork = headRepository.toLowerCase() !== repository.toLowerCase();
    const selected = mode === "auto" ? (fork ? "packed" : "sandbox") : mode;
    packedFork = fork && selected === "packed";
    stage = "account lookup";
    runEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: await accountId(env) };
    const args = [
      join(actionPath, "src", "swarm.ts"),
      "--repo",
      repository,
      "--source",
      source,
      "--pr",
      pullRequest,
    ];

    if (selected === "sandbox") {
      stage = "registry login";
      await run(
        "docker",
        [
          "login",
          "ghcr.io",
          "-u",
          required(env, "GITHUB_ACTOR"),
          "--password-stdin",
        ],
        runEnv,
        `${required(env, "GITHUB_TOKEN")}\n`,
      );
      stage = "image pull";
      const image = imageReference(
        repository,
        await imageTagFromFiles(
          join(actionPath, "container"),
          join(source, "bun.lock"),
        ),
      );
      try {
        await run("docker", ["pull", image], runEnv);
        console.log(`sandbox image pulled: ${image}`);
      } catch {
        console.log(`sandbox image missing, building: ${image}`);
        stage = "image build";
        await run(
          "bun",
          [
            "run",
            join(actionPath, "scripts", "deploy.ts"),
            "--image-only",
            "--repo",
            repository,
            "--target",
            source,
          ],
          runEnv,
        );
        stage = "image push";
        await run("docker", ["push", image], runEnv);
        console.log(`sandbox image pushed: ${image}`);
      }
      args.push(
        "--sandbox",
        "--image",
        image,
        "--provider",
        "cloudflare-workers-ai",
        "--model",
        "@cf/deepseek-ai/deepseek-v4-flash-0731",
        "--reviewers",
        "3",
        "--total-timeout",
        "1500",
        "--verifier-reserve",
        "200",
        "--lane-memory",
        "2g",
        "--lane-cpus",
        "2",
        "--lane-input-cap",
        "4000000",
        "--check",
        "git --no-pager diff --stat base..HEAD",
      );
    } else {
      args.push(
        "--provider",
        "cloudflare-workers-ai",
        "--model",
        "@cf/deepseek-ai/deepseek-v4-flash-0731",
        "--reviewers",
        "3",
      );
    }
    args.push("--swarm-id", swarmId, "--out", out);
    console.log(`review mode: ${selected}${fork ? " (fork)" : ""}`);
    stage = "review";
    await run("bun", args, runEnv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    await mkdir(swarmDir, { recursive: true })
      .then(() =>
        writeFile(
          join(swarmDir, "failure.json"),
          JSON.stringify({ stage, message }),
        ),
      )
      .catch((writeError: unknown) => console.error(writeError));
  }
  await run(
    "bun",
    [
      join(actionPath, "src", "publish.ts"),
      "--receipt",
      join(out, swarmId, "swarm-receipt.json"),
      "--repo",
      repository,
      "--pr",
      pullRequest,
      "--publish",
      "--allow-moved-head",
      ...(packedFork ? ["--fork"] : []),
    ],
    runEnv,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
