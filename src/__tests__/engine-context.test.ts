import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const probe = (name: string) => `import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("${name} finds the engine while it runs", () => {
  const engine = new URL("../../container/context/swarm.js", import.meta.url);
  expect(readFileSync(engine, "utf8")).toBe(process.env["EXPECTED_ENGINE"]);
});
`;

/**
 * A tree holding this package's vitest config and every test support file,
 * whose only tests read the engine the way a driver test does.
 */
const stageSuite = async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-engine-context-"));
  roots.push(root);
  const tests = join(root, "src/__tests__");
  await mkdir(tests, { recursive: true });
  await mkdir(join(root, "container"));
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"));
  await cp(
    join(packageRoot, "vitest.config.ts"),
    join(root, "vitest.config.ts"),
  );
  for (const file of await readdir(join(packageRoot, "src/__tests__"))) {
    if (!file.endsWith(".test.ts")) {
      await cp(join(packageRoot, "src/__tests__", file), join(tests, file));
    }
  }
  for (const name of ["first", "second"]) {
    await writeFile(join(tests, `${name}.test.ts`), probe(name));
  }
  return root;
};

const runSuite = (root: string, expectedEngine: string) =>
  spawnSync(join(root, "node_modules/.bin/vitest"), ["run"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EXPECTED_ENGINE: expectedEngine },
  });

describe("the engine placeholder in the image build context", () => {
  it("is there while the suite runs and gone once it ends", async () => {
    const root = await stageSuite();
    const result = runSuite(root, "test engine bundle");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("2 passed");
    expect(existsSync(join(root, "container/context/swarm.js"))).toBe(false);
    expect(existsSync(join(root, "container/context"))).toBe(false);
  });

  it("leaves a bundle built before the run byte for byte", async () => {
    const root = await stageSuite();
    const engine = join(root, "container/context/swarm.js");
    await mkdir(dirname(engine));
    await writeFile(engine, "// the real engine bundle\n");
    const result = runSuite(root, "// the real engine bundle\n");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("2 passed");
    expect(await readFile(engine, "utf8")).toBe("// the real engine bundle\n");
  });

  it("clears a placeholder an interrupted run left behind", async () => {
    const root = await stageSuite();
    const engine = join(root, "container/context/swarm.js");
    await mkdir(dirname(engine));
    await writeFile(engine, "test engine bundle");
    const result = runSuite(root, "test engine bundle");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(engine)).toBe(false);
  });

  it("removes the placeholder when the run is interrupted", async () => {
    const root = await stageSuite();
    const started = join(root, "started");
    await writeFile(
      join(root, "src/__tests__/hang.test.ts"),
      `import { writeFileSync } from "node:fs";
import { it } from "vitest";
it("hangs", async () => {
  writeFileSync(${JSON.stringify(started)}, "");
  await new Promise(() => {});
});
`,
    );
    const suite = spawn(join(root, "node_modules/.bin/vitest"), ["run"], {
      cwd: root,
      env: { ...process.env, EXPECTED_ENGINE: "test engine bundle" },
    });
    const exited = new Promise((resolve) => suite.once("exit", resolve));
    while (!existsSync(started)) await sleep(50);
    suite.kill("SIGINT");
    await exited;
    expect(existsSync(join(root, "container/context/swarm.js"))).toBe(false);
  });
});
