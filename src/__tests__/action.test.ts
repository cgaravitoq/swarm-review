import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../action";
import { imageReference, imageTagFromFiles } from "../image-tag";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function arrange(headRepo: string, pullSucceeds: boolean) {
  const root = await mkdtemp(join(tmpdir(), "swarm-action-"));
  roots.push(root);
  const bin = join(root, "bin");
  const source = join(root, "swarm-review-source");
  await mkdir(bin);
  await mkdir(source);
  await writeFile(join(source, "bun.lock"), "target lockfile\n");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$ACTION_LOG"\n[ "$ACTION_FAIL" = gh ] && exit 1\nprintf '%s\\n' '{"head":{"repo":{"full_name":"${headRepo}"}}}'\n`,
  );
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> "$ACTION_LOG"\nif [ "$1" = login ]; then read -r password; [ "$password" = test-token ] || exit 2; fi\nif [ "$1" = pull ]; then exit ${pullSucceeds ? 0 : 1}; fi\n`,
  );
  await writeFile(
    join(bin, "bun"),
    '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$ACTION_LOG"\nif [ "$1" = "$ACTION_ROOT/src/swarm.ts" ]; then printf "%s\\0" "$@" > "$ACTION_ARGS"; [ "$ACTION_FAIL" = swarm ] && exit 1; fi\nif [ "$2" = "$ACTION_ROOT/scripts/deploy.ts" ] && [ "$ACTION_FAIL" = deploy ]; then printf "docker build failed: exec /bin/sh: exec format error\\n" >&2; exit 1; fi\nexit 0\n',
  );
  for (const name of ["gh", "docker", "bun"]) {
    await chmod(join(bin, name), 0o755);
  }
  const env = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    ACTION_LOG: join(root, "argv.log"),
    ACTION_ARGS: join(root, "swarm-args"),
    ACTION_ROOT: packageRoot,
    GITHUB_ACTION_PATH: packageRoot,
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_WORKSPACE: root,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR: "reviewer",
    GITHUB_TOKEN: "test-token",
    RUNNER_TEMP: root,
    PULL_REQUEST: "42",
    CLOUDFLARE_ACCOUNT_ID: "account",
    WORKERS_AI_API_KEY: "test-key",
  };
  return {
    env,
    log: async () =>
      (await readFile(env.ACTION_LOG, "utf8")).trim().split("\n"),
    swarmArgs: async () =>
      (await readFile(env.ACTION_ARGS, "utf8")).split("\0").slice(0, -1),
    failure: async () =>
      JSON.parse(
        await readFile(
          join(env.RUNNER_TEMP, "swarm-review", "pr-42-123-1", "failure.json"),
          "utf8",
        ),
      ) as { stage: string; message: string },
  };
}

describe("composite action driver", () => {
  it("reviews a fork in auto mode through packed lanes and marks publication", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "auto" });
    const log = await fixture.log();
    expect(log).toContain("gh api repos/acme/demo/pulls/42");
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).toBe(
      `bun ${packageRoot}/src/swarm.ts --repo acme/demo --source ${fixture.env.GITHUB_WORKSPACE}/swarm-review-source --pr 42 --provider cloudflare-workers-ai --model @cf/deepseek-ai/deepseek-v4-flash-0731 --reviewers 3 --swarm-id pr-42-123-1 --out ${fixture.env.RUNNER_TEMP}/swarm-review`,
    );
    expect(log.find((line) => line.includes("src/publish.ts"))).toContain(
      "--fork",
    );
  });

  it("honors packed mode on an own-repository pull request", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "packed" });
    const log = await fixture.log();
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).not.toContain(
      "--sandbox",
    );
    expect(log.find((line) => line.includes("src/publish.ts"))).not.toContain(
      "--fork",
    );
  });

  it("runs an own-repository pull request in sandbox with the exact lane flags and pulled image", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "auto" });
    const log = await fixture.log();
    const image = imageReference(
      "acme/demo",
      await imageTagFromFiles(
        join(packageRoot, "container"),
        join(fixture.env.GITHUB_WORKSPACE, "swarm-review-source", "bun.lock"),
      ),
    );
    expect(log).toContain(`docker pull ${image}`);
    expect(log).toContain("docker login ghcr.io -u reviewer --password-stdin");
    expect(log.find((line) => line.includes("src/swarm.ts"))).toBe(
      `bun ${packageRoot}/src/swarm.ts --repo acme/demo --source ${fixture.env.GITHUB_WORKSPACE}/swarm-review-source --pr 42 --sandbox --image ${image} --provider cloudflare-workers-ai --model @cf/deepseek-ai/deepseek-v4-flash-0731 --reviewers 3 --total-timeout 1500 --verifier-reserve 200 --lane-memory 2g --lane-cpus 2 --lane-input-cap 4000000 --check git --no-pager diff --stat base..HEAD --swarm-id pr-42-123-1 --out ${fixture.env.RUNNER_TEMP}/swarm-review`,
    );
    expect(await fixture.swarmArgs()).toEqual([
      `${packageRoot}/src/swarm.ts`,
      "--repo",
      "acme/demo",
      "--source",
      `${fixture.env.GITHUB_WORKSPACE}/swarm-review-source`,
      "--pr",
      "42",
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
      "--swarm-id",
      "pr-42-123-1",
      "--out",
      `${fixture.env.RUNNER_TEMP}/swarm-review`,
    ]);
    expect(log.some((line) => line.includes("deploy.ts"))).toBe(false);
    expect(log.some((line) => line === `docker push ${image}`)).toBe(false);
  });

  it("builds and pushes the derived image when pull fails", async () => {
    const fixture = await arrange("acme/demo", false);
    await main({ ...fixture.env, INPUT_MODE: "sandbox" });
    const log = await fixture.log();
    const image = imageReference(
      "acme/demo",
      await imageTagFromFiles(
        join(packageRoot, "container"),
        join(fixture.env.GITHUB_WORKSPACE, "swarm-review-source", "bun.lock"),
      ),
    );
    expect(log).toContain(`docker pull ${image}`);
    expect(log).toContain("docker login ghcr.io -u reviewer --password-stdin");
    expect(log).toContain(
      `bun run ${packageRoot}/scripts/deploy.ts --image-only --repo acme/demo --target ${fixture.env.GITHUB_WORKSPACE}/swarm-review-source`,
    );
    expect(log).toContain(`docker push ${image}`);
    expect(log.indexOf(`docker push ${image}`)).toBeLessThan(
      log.findIndex((line) => line.includes("src/swarm.ts")),
    );
  });

  it("publishes the receipt path when the swarm exits non-zero", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "packed", ACTION_FAIL: "swarm" });
    const log = await fixture.log();
    expect(log.at(-1)).toBe(
      `bun ${packageRoot}/src/publish.ts --receipt ${fixture.env.RUNNER_TEMP}/swarm-review/pr-42-123-1/swarm-receipt.json --repo acme/demo --pr 42 --publish --allow-moved-head`,
    );
  });

  it("publishes without the fork note when the pull request lookup fails", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "auto", ACTION_FAIL: "gh" });
    const log = await fixture.log();
    expect(log.some((line) => line.includes("src/swarm.ts"))).toBe(false);
    expect(log.at(-1)).toBe(
      `bun ${packageRoot}/src/publish.ts --receipt ${fixture.env.RUNNER_TEMP}/swarm-review/pr-42-123-1/swarm-receipt.json --repo acme/demo --pr 42 --publish --allow-moved-head`,
    );
  });

  it("publishes when the registry refuses the login", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({
      ...fixture.env,
      INPUT_MODE: "sandbox",
      GITHUB_TOKEN: "wrong-token",
    });
    const log = await fixture.log();
    expect(log).toContain("docker login ghcr.io -u reviewer --password-stdin");
    expect(log.some((line) => line.includes("src/swarm.ts"))).toBe(false);
    expect(log.at(-1)).toBe(
      `bun ${packageRoot}/src/publish.ts --receipt ${fixture.env.RUNNER_TEMP}/swarm-review/pr-42-123-1/swarm-receipt.json --repo acme/demo --pr 42 --publish --allow-moved-head`,
    );
    expect(await fixture.failure()).toEqual({
      stage: "registry login",
      message: "docker login exited with code 2",
    });
  });

  it("publishes when the missing image fails to build", async () => {
    const fixture = await arrange("acme/demo", false);
    await main({
      ...fixture.env,
      INPUT_MODE: "sandbox",
      ACTION_FAIL: "deploy",
    });
    const log = await fixture.log();
    expect(log.some((line) => line.includes("scripts/deploy.ts"))).toBe(true);
    expect(log.some((line) => line.startsWith("docker push "))).toBe(false);
    expect(log.some((line) => line.includes("src/swarm.ts"))).toBe(false);
    expect(log.at(-1)).toBe(
      `bun ${packageRoot}/src/publish.ts --receipt ${fixture.env.RUNNER_TEMP}/swarm-review/pr-42-123-1/swarm-receipt.json --repo acme/demo --pr 42 --publish --allow-moved-head`,
    );
    expect(await fixture.failure()).toEqual({
      stage: "image build",
      message: "docker build failed: exec /bin/sh: exec format error",
    });
  });

  it("runs a fork forced to sandbox without the packed fork note", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "sandbox" });
    const log = await fixture.log();
    expect(log.find((line) => line.includes("src/swarm.ts"))).toContain(
      " --sandbox --image ",
    );
    expect(log.at(-1)).toBe(
      `bun ${packageRoot}/src/publish.ts --receipt ${fixture.env.RUNNER_TEMP}/swarm-review/pr-42-123-1/swarm-receipt.json --repo acme/demo --pr 42 --publish --allow-moved-head`,
    );
  });

  it("refuses an unknown mode before reviewing or publishing", async () => {
    const fixture = await arrange("acme/demo", true);
    await expect(
      main({ ...fixture.env, INPUT_MODE: "sandox" }),
    ).rejects.toThrow("mode must be auto, packed or sandbox: sandox");
    await expect(readFile(fixture.env.ACTION_LOG, "utf8")).rejects.toThrow(
      "ENOENT",
    );
  });
});
