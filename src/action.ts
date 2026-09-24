import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { imageReference, imageTagFromFiles } from "./image-tag";

const exec = promisify(execFile);
type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command: string, args: string[], env: Env, input?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0]} exited with code ${code}`)),
    );
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
  const account = await accountId(env);
  const runEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: account };
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
    const image = imageReference(
      repository,
      await imageTagFromFiles(
        join(actionPath, "container"),
        join(source, "bun.lock"),
      ),
    );
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
    try {
      await run("docker", ["pull", image], runEnv);
      console.log(`sandbox image pulled: ${image}`);
    } catch {
      console.log(`sandbox image missing, building: ${image}`);
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
  try {
    await run("bun", args, runEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
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
      ...(fork && selected === "packed" ? ["--fork"] : []),
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
