import { spawn } from "node:child_process";
import { cp, glob, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { imageReference, imageTagFromFiles } from "../src/image-tag";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contextDir = join(packageRoot, "container", "context");
const wranglerBin = join(packageRoot, "node_modules", ".bin", "wrangler");
const pollIntervalMs = 10_000;
const rolloutTimeoutMs = 15 * 60_000;

const targetManifests = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "patches/*",
  "scripts/package.json",
  "apps/*/package.json",
  "agents/*/package.json",
  "packages/*/package.json",
  "packages/agents/*/package.json",
  "tooling/*/package.json",
  "features/*/package.json",
];

type ContainerApp = {
  id: string;
  name: string;
  version: number;
  active_rollout_id?: string;
  configuration?: { image?: string };
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export const targetCheckout = (argv: string[]) => {
  const flag = argv.indexOf("--target");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      "the bake needs a checkout: bun run deploy --target <checkout>",
    );
  }
  return resolve(value);
};

/**
 * The bake's own `--target` and its value, dropped from what wrangler gets.
 *
 * The target names a directory on this host to read manifests out of; wrangler
 * has no idea what it is, and passing it through fails the deploy. Everything
 * else is forwarded, which is how the repository a Worker serves is set:
 * `bun run deploy --target <checkout> --var TARGET_REPOSITORY:<clone url>`.
 */
export const deployArguments = (argv: string[]) => {
  const flag = argv.indexOf("--target");
  const remaining =
    flag === -1 ? argv : [...argv.slice(0, flag), ...argv.slice(flag + 2)];
  const repo = remaining.indexOf("--repo");
  const withoutRepo =
    repo === -1
      ? remaining
      : [...remaining.slice(0, repo), ...remaining.slice(repo + 2)];
  return withoutRepo.filter((argument) => argument !== "--image-only");
};

export const imageBuildArguments = (reference: string) => [
  "build",
  "--platform",
  "linux/amd64",
  "-t",
  reference,
  join(packageRoot, "container"),
];

const dockerBuild = (reference: string) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn("docker", imageBuildArguments(reference), {
      cwd: packageRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`docker build exited with code ${code}`)),
    );
  });

const materialize = async (checkout: string) => {
  for (const name of ["package.json", "bun.lock"]) {
    if (!(await exists(join(checkout, name)))) {
      throw new Error(`--target ${checkout} has no ${name}`);
    }
  }
  const manifests: string[] = [];
  for (const pattern of targetManifests) {
    for await (const file of glob(pattern, { cwd: checkout })) {
      manifests.push(file);
    }
  }
  await rm(contextDir, { recursive: true, force: true });
  for (const manifest of manifests) {
    const destination = join(contextDir, manifest);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(checkout, manifest), destination, {
      preserveTimestamps: true,
    });
  }
  return manifests.length;
};

const wrangler = (args: string[], tee = false) =>
  new Promise<string>((resolvePromise, reject) => {
    const child = spawn(wranglerBin, args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (tee) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (tee) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(`wrangler ${args.join(" ")} exited with code ${code}`),
          ),
    );
  });

const parseJson = <T>(output: string): T => {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start === -1) throw new Error("wrangler printed no JSON");
  return JSON.parse(lines.slice(start).join("\n")) as T;
};

const containerAppName = () => {
  const { config, error } = ts.readConfigFile(
    join(packageRoot, "wrangler.jsonc"),
    ts.sys.readFile,
  );
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  }
  const container = config.containers[0] as { class_name: string };
  return `${config.name as string}-${container.class_name}`.toLowerCase();
};

const waitForRollout = async (id: string) => {
  const deadline = Date.now() + rolloutTimeoutMs;
  while (true) {
    const app = parseJson<ContainerApp>(
      await wrangler(["containers", "info", id, "--json"]),
    );
    if (!app.active_rollout_id) return app;
    if (Date.now() >= deadline) {
      throw new Error(
        `rollout ${app.active_rollout_id} is still active after ${rolloutTimeoutMs / 60_000} minutes`,
      );
    }
    console.log(`rollout ${app.active_rollout_id} still active, waiting`);
    await new Promise((wake) => setTimeout(wake, pollIntervalMs));
  }
};

const main = async () => {
  const checkout = targetCheckout(process.argv.slice(2));
  const manifests = await materialize(checkout);
  console.log(
    `bake context ${relative(packageRoot, contextDir)} <- ${checkout} (${manifests} manifests)`,
  );

  if (process.argv.includes("--image-only")) {
    const repoIndex = process.argv.indexOf("--repo");
    const repository = process.argv[repoIndex + 1];
    if (!repository) throw new Error("--image-only requires --repo owner/repo");
    const tag = await imageTagFromFiles(
      join(packageRoot, "container"),
      join(contextDir, "bun.lock"),
    );
    const reference = imageReference(repository, tag);
    await dockerBuild(reference);
    console.log(`image: ${reference}`);
    return;
  }

  const deployed = await wrangler(
    ["deploy", ...deployArguments(process.argv.slice(2))],
    true,
  );
  const name = containerAppName();
  const apps = parseJson<ContainerApp[]>(
    await wrangler(["containers", "list", "--json", "--per-page", "100"]),
  );
  const app = apps.find((entry) => entry.name === name);
  if (!app) throw new Error(`no container application named ${name}`);
  const final = await waitForRollout(app.id);

  console.log(
    [
      `worker version: ${deployed.match(/Current Version ID:\s*(\S+)/)?.[1] ?? "unknown"}`,
      `container app: ${final.id} (${final.name}) version ${final.version}`,
      `image: ${final.configuration?.image ?? "unknown"}`,
      "active_rollout_id: none",
      `url: ${deployed.match(/https:\/\/\S+\.workers\.dev/)?.[0] ?? "unknown"}`,
    ].join("\n"),
  );
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
