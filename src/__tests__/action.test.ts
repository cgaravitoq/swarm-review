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
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../action";
import { imageReference, imageTagFromFiles } from "../image-tag";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const runUrl = "https://github.com/acme/demo/actions/runs/123";
const marker = "<!-- swarm-review:run:123 -->";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function arrange(headRepo: string, pullSucceeds: boolean) {
  const root = await mkdtemp(join(tmpdir(), "swarm-action-"));
  roots.push(root);
  const bin = join(root, "bin");
  const source = join(root, "swarm-review-source");
  const swarmDir = join(root, "swarm-review", "pr-42-123-1");
  await mkdir(bin);
  await mkdir(source);
  await writeFile(join(source, "bun.lock"), "target lockfile\n");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$ACTION_LOG"\n[ "$ACTION_FAIL" = gh ] && exit 1\ncase "$2" in */comments) [ "$ACTION_FAIL" = comment ] && exit 1;; esac\nprintf '%s\\n' '{"head":{"repo":{"full_name":"${headRepo}"}}}'\n`,
  );
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf 'docker %s\\n' "$*" >> "$ACTION_LOG"\nif [ "$1" = login ]; then read -r password; [ "$password" = test-token ] || exit 2; fi\nif [ "$1" = pull ]; then exit ${pullSucceeds ? 0 : 1}; fi\n`,
  );
  await writeFile(
    join(bin, "bun"),
    '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$ACTION_LOG"\nif [ "$1" = "$ACTION_ROOT/src/swarm.ts" ]; then printf "%s\\0" "$@" > "$ACTION_ARGS"; out=; id=; previous=; for arg; do case "$previous" in --out) out=$arg;; --swarm-id) id=$arg;; esac; previous=$arg; done; [ -f "$out/$id.run.json" ] || exit 1; mkdir -p "$out" && mkdir "$out/$id" || exit 1; [ "$ACTION_FAIL" = partial ] && printf "{}" > "$out/$id/swarm-receipt.json" && exit 1; [ "$ACTION_FAIL" = swarm ] && exit 1; fi\nif [ "$2" = "$ACTION_ROOT/scripts/deploy.ts" ] && [ "$ACTION_FAIL" = deploy ]; then printf "exec /bin/sh: exec format error\\ndocker build exited with code 1\\n" >&2; exit 1; fi\nexit 0\n',
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
    GITHUB_ENV: join(root, "github-env"),
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKSPACE: root,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR: "reviewer",
    GITHUB_TOKEN: "test-token",
    RUNNER_TEMP: root,
    PULL_REQUEST: "42",
    RUNNER_ARCH: "X64",
    CLOUDFLARE_ACCOUNT_ID: "account",
    WORKERS_AI_API_KEY: "test-key",
  };
  return {
    env,
    swarmDir,
    log: async () =>
      (await readFile(env.ACTION_LOG, "utf8")).trim().split("\n"),
    logText: async () => readFile(env.ACTION_LOG, "utf8"),
    envFile: async () => readFile(env.GITHUB_ENV, "utf8").catch(() => ""),
    swarmArgs: async () =>
      (await readFile(env.ACTION_ARGS, "utf8")).split("\0").slice(0, -1),
    notes: async () => {
      const raw = await readFile(`${swarmDir}.run.json`, "utf8").catch(
        () => null,
      );
      return raw === null
        ? null
        : (JSON.parse(raw) as { fork: boolean; packedRunner?: string });
    },
    failure: async () =>
      JSON.parse(await readFile(join(swarmDir, "failure.json"), "utf8")) as {
        stage: string;
        message: string;
      },
  };
}

describe("composite action driver", () => {
  it("opens the run's comment between the lookup and the swarm", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "auto" });

    const text = await fixture.logText();
    const body = [
      marker,
      "",
      "**swarm-review is reviewing** this pull request with `packed` lanes.",
      "",
      `[Run artifact](${runUrl})`,
    ].join("\n");
    const comment = `gh api repos/acme/demo/issues/42/comments --method POST -f body=${body}`;
    expect(text).toContain(comment);
    expect(text.indexOf(comment)).toBeGreaterThan(
      text.indexOf("gh api repos/acme/demo/pulls/42"),
    );
    expect(text.indexOf(comment)).toBeLessThan(
      text.indexOf(`${packageRoot}/src/swarm.ts`),
    );
  });

  it("handles the publish step the receipt path it defines once", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "packed" });

    expect(await fixture.envFile()).toBe(
      `SWARM_RECEIPT=${fixture.swarmDir}/swarm-receipt.json\n`,
    );
  });

  it("reviews a fork in auto mode through packed lanes", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "auto" });
    const log = await fixture.log();
    expect(log).toContain("gh api repos/acme/demo/pulls/42");
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).toBe(
      `bun ${packageRoot}/src/swarm.ts --repo acme/demo --source ${fixture.env.GITHUB_WORKSPACE}/swarm-review-source --pr 42 --provider cloudflare-workers-ai --model @cf/deepseek-ai/deepseek-v4-flash-0731 --reviewers 3 --swarm-id pr-42-123-1 --out ${fixture.env.RUNNER_TEMP}/swarm-review`,
    );
    expect(log.some((line) => line.includes("src/publish.ts"))).toBe(false);
    expect(await fixture.notes()).toEqual({ fork: true });
  });

  it("honors packed mode on an own-repository pull request", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "packed" });
    const log = await fixture.log();
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).not.toContain(
      "--sandbox",
    );
    expect(await fixture.notes()).toEqual({ fork: false });
  });

  it("reviews through packed lanes when the runner cannot run the sandbox image", async () => {
    const fixture = await arrange("acme/demo", true);
    await main({ ...fixture.env, RUNNER_ARCH: "ARM64", INPUT_MODE: "auto" });
    const log = await fixture.log();
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).toBe(
      `bun ${packageRoot}/src/swarm.ts --repo acme/demo --source ${fixture.env.GITHUB_WORKSPACE}/swarm-review-source --pr 42 --provider cloudflare-workers-ai --model @cf/deepseek-ai/deepseek-v4-flash-0731 --reviewers 3 --swarm-id pr-42-123-1 --out ${fixture.env.RUNNER_TEMP}/swarm-review`,
    );
    expect(await fixture.swarmArgs()).not.toContain("--sandbox");
    expect(await fixture.notes()).toEqual({
      fork: false,
      packedRunner: "ARM64",
    });
  });

  it("reviews through packed lanes when the runner reports no architecture", async () => {
    const fixture = await arrange("acme/demo", true);
    const { RUNNER_ARCH: _arch, ...withoutArch } = fixture.env;
    await main({ ...withoutArch, INPUT_MODE: "auto" });
    const log = await fixture.log();
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).not.toContain(
      "--sandbox",
    );
    expect(await fixture.notes()).toEqual({
      fork: false,
      packedRunner: "unknown",
    });
  });

  it("refuses sandbox mode on a runner that cannot run the sandbox image", async () => {
    const fixture = await arrange("acme/demo", true);
    await expect(
      main({ ...fixture.env, RUNNER_ARCH: "ARM64", INPUT_MODE: "sandbox" }),
    ).rejects.toThrow("sandbox mode needs an X64 runner: RUNNER_ARCH is ARM64");
    const log = await fixture.log();
    expect(log).toEqual(["gh api repos/acme/demo/pulls/42"]);
    expect(await fixture.notes()).toBe(null);
    expect(await fixture.failure()).toEqual({
      stage: "runner check",
      message: "sandbox mode needs an X64 runner: RUNNER_ARCH is ARM64",
    });
  });

  it("carries both packed lane limits for a fork on a runner that cannot run the image", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, RUNNER_ARCH: "ARM64", INPUT_MODE: "auto" });
    const log = await fixture.log();
    expect(log.some((line) => line.startsWith("docker "))).toBe(false);
    expect(log.find((line) => line.includes("src/swarm.ts"))).not.toContain(
      "--sandbox",
    );
    expect(await fixture.notes()).toEqual({
      fork: true,
      packedRunner: "ARM64",
    });
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
    expect(log.some((line) => line.includes("src/publish.ts"))).toBe(false);
    expect(await fixture.notes()).toEqual({ fork: false });
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

  it("fails the step after recording the swarm's own failure", async () => {
    const fixture = await arrange("acme/demo", true);
    await expect(
      main({ ...fixture.env, INPUT_MODE: "packed", ACTION_FAIL: "swarm" }),
    ).rejects.toThrow(`bun ${packageRoot}/src/swarm.ts exited with code 1`);
    const log = await fixture.log();
    expect(log.some((line) => line.includes("src/publish.ts"))).toBe(false);
    expect(await fixture.failure()).toEqual({
      stage: "review",
      message: `bun ${packageRoot}/src/swarm.ts exited with code 1`,
    });
  });

  it("passes the step when the swarm exits non-zero after writing its receipt", async () => {
    const fixture = await arrange("acme/demo", true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await main({
      ...fixture.env,
      INPUT_MODE: "packed",
      ACTION_FAIL: "partial",
    });
    expect(
      await readFile(join(fixture.swarmDir, "swarm-receipt.json"), "utf8"),
    ).toBe("{}");
    expect(await fixture.notes()).toEqual({ fork: false });
    expect(await fixture.failure()).toEqual({
      stage: "review",
      message: `bun ${packageRoot}/src/swarm.ts exited with code 1`,
    });
  });

  it("records the lookup failure, posts no comment and still hands publish the receipt path", async () => {
    const fixture = await arrange("contributor/demo", true);
    await expect(
      main({ ...fixture.env, INPUT_MODE: "auto", ACTION_FAIL: "gh" }),
    ).rejects.toThrow("Command failed: gh api repos/acme/demo/pulls/42");
    const log = await fixture.log();
    expect(log).toEqual(["gh api repos/acme/demo/pulls/42"]);
    expect(await fixture.notes()).toBe(null);
    expect(await fixture.envFile()).toBe(
      `SWARM_RECEIPT=${fixture.swarmDir}/swarm-receipt.json\n`,
    );
    expect(await fixture.failure()).toEqual({
      stage: "pull request lookup",
      message: expect.stringContaining(
        "Command failed: gh api repos/acme/demo/pulls/42",
      ),
    });
  });

  it("keeps reviewing when the run's comment cannot be posted", async () => {
    const fixture = await arrange("acme/demo", true);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await main({
      ...fixture.env,
      INPUT_MODE: "packed",
      ACTION_FAIL: "comment",
    });
    expect(logged).toHaveBeenCalledWith(
      "run comment not posted: gh api exited with code 1",
    );
    const log = await fixture.log();
    expect(log.some((line) => line.includes("repos/acme/demo/issues/42"))).toBe(
      true,
    );
    expect(log.find((line) => line.includes("src/swarm.ts"))).toContain(
      "--swarm-id pr-42-123-1",
    );
    expect(await fixture.notes()).toEqual({ fork: false });
  });

  it("records the registry login failure after opening the run's comment", async () => {
    const fixture = await arrange("acme/demo", true);
    await expect(
      main({
        ...fixture.env,
        INPUT_MODE: "sandbox",
        GITHUB_TOKEN: "wrong-token",
      }),
    ).rejects.toThrow("docker login exited with code 2");
    const log = await fixture.log();
    expect(log).toContain("docker login ghcr.io -u reviewer --password-stdin");
    expect(log.some((line) => line.includes("src/swarm.ts"))).toBe(false);
    expect(log.some((line) => line.includes("src/publish.ts"))).toBe(false);
    expect(await fixture.logText()).toContain(
      "gh api repos/acme/demo/issues/42/comments --method POST -f body=",
    );
    expect(await fixture.failure()).toEqual({
      stage: "registry login",
      message: "docker login exited with code 2",
    });
  });

  it("records a missing image that fails to build", async () => {
    const fixture = await arrange("acme/demo", false);
    await expect(
      main({
        ...fixture.env,
        INPUT_MODE: "sandbox",
        ACTION_FAIL: "deploy",
      }),
    ).rejects.toThrow("docker build exited with code 1");
    const log = await fixture.log();
    expect(log.some((line) => line.includes("scripts/deploy.ts"))).toBe(true);
    expect(log.some((line) => line.startsWith("docker push "))).toBe(false);
    expect(log.some((line) => line.includes("src/swarm.ts"))).toBe(false);
    expect(await fixture.failure()).toEqual({
      stage: "image build",
      message: "docker build exited with code 1",
    });
  });

  it("still fails the step when the failure file cannot be written", async () => {
    const fixture = await arrange("acme/demo", false);
    const failurePath = join(fixture.swarmDir, "failure.json");
    await mkdir(failurePath, { recursive: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      main({
        ...fixture.env,
        INPUT_MODE: "sandbox",
        ACTION_FAIL: "deploy",
      }),
    ).rejects.toThrow("docker build exited with code 1");
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EISDIR", path: failurePath }),
    );
  });

  it("runs a fork forced to sandbox without the packed fork note", async () => {
    const fixture = await arrange("contributor/demo", true);
    await main({ ...fixture.env, INPUT_MODE: "sandbox" });
    const log = await fixture.log();
    expect(log.find((line) => line.includes("src/swarm.ts"))).toContain(
      " --sandbox --image ",
    );
    expect(await fixture.notes()).toEqual({ fork: false });
    expect(await fixture.logText()).toContain("with `sandbox` lanes");
  });

  it("refuses an unknown mode before reviewing or publishing", async () => {
    const fixture = await arrange("acme/demo", true);
    await expect(
      main({ ...fixture.env, INPUT_MODE: "sandox" }),
    ).rejects.toThrow("mode must be auto, packed or sandbox: sandox");
    await expect(readFile(fixture.env.ACTION_LOG, "utf8")).rejects.toThrow(
      "ENOENT",
    );
    expect(await fixture.envFile()).toBe("");
  });
});
