import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packBudgetChars,
  packLaneContext,
  symbolsFromDiff,
  unpackableFiles,
  wholeChangeFits,
  wholeChangePack,
} from "../pack-context";
import { SESSION_CAPS } from "../provider-budget";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

describe("packLaneContext", () => {
  it("packs the assigned diff and grep hits from the same commit", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(
      join(repo, "src/a.ts"),
      "export function keep() { return 1 }\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repo, "src/a.ts"),
      "export function keep() { return 1 }\nexport function added() { return 2 }\n",
    );
    await writeFile(
      join(repo, "src/b.ts"),
      "import { added } from './a'\nadded()\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    expect(symbolsFromDiff("+\n+export function added() {}\n")).toEqual([
      "added",
    ]);
    const packed = packLaneContext({
      repo,
      head,
      base,
      files: ["src/a.ts"],
      budget: packBudgetChars("t1b", "grok-4.6"),
    });
    expect(packed.symbols).toContain("added");
    expect(packed.pack).toContain("export function added");
    expect(packed.pack).toContain("src/b.ts");
    expect(packed.pack.indexOf("# Diff")).toBeLessThan(
      packed.pack.indexOf("# src/a.ts"),
    );
  });

  it("drops a file it cannot fit whole and names it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-big-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    const bulk = Array.from(
      { length: 3000 },
      (_, index) => `export const bulk${index} = ${index};`,
    ).join("\n");
    await writeFile(join(repo, "big.ts"), `${bulk}\n`);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repo, "big.ts"),
      `export const touched = true;\n${bulk}\n`,
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    // A budget small enough that one file cannot fit, whatever the trial cap.
    const packed = packLaneContext({
      repo,
      head,
      base,
      files: ["big.ts"],
      budget: 4_000,
    });

    // Half a file would read as the whole file to the model, so it is left
    // out and the caller is told which file it is missing.
    expect(packed.droppedFiles).toEqual(["big.ts"]);
    expect(packed.filesPacked).toEqual([]);
    expect(packed.truncated).toBe(false);
    expect(packed.pack).toContain("# Diff");
    expect(packed.pack).not.toContain(`export const bulk2999 = ${2999};`);
  });

  it("names the file whose own diff no lane could hold", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-fixture-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "small.ts"), "export const small = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    // A fixture landing whole in the diff, the shape of a base64 document
    // checked in beside the code that reads it.
    const fixture = Array.from({ length: 200 }, () => "QUJD".repeat(19)).join(
      "\n",
    );
    await writeFile(join(repo, "fixture.json"), `${fixture}\n`);
    await writeFile(join(repo, "small.ts"), "export const small = 2;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const oversized = unpackableFiles({
      repo,
      head,
      base,
      files: ["fixture.json", "small.ts"],
      budget: 4_000,
    });

    // Past half a lane's budget the diff of one file leaves no room for the
    // rest of the lane, so it is reported with its size rather than packed.
    expect(oversized.map((entry) => entry.file)).toEqual(["fixture.json"]);
    expect(oversized[0]?.diffBytes).toBeGreaterThan(2_000);
    expect(
      unpackableFiles({ repo, head, base, files: ["small.ts"], budget: 4_000 }),
    ).toEqual([]);
  });

  it("names a binary, and a file too large at head to sit beside its diff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-binary-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    // A lockfile's shape: a few lines change, and the file at head is most of
    // a lane. A font's shape: bytes with no text in them, at any size.
    const lock = Array.from(
      { length: 200 },
      (_, index) => `"pkg-${index}": "1.0.${index}"`,
    );
    const glyphs = Buffer.from(
      Array.from({ length: 512 }, (_, index) => index % 256),
    );
    await writeFile(join(repo, "lock.txt"), `${lock.join("\n")}\n`);
    await writeFile(join(repo, "font.ttf"), glyphs);
    await writeFile(join(repo, "small.ts"), "export const small = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    lock[0] = '"pkg-0": "2.0.0"';
    await writeFile(join(repo, "lock.txt"), `${lock.join("\n")}\n`);
    await writeFile(
      join(repo, "font.ttf"),
      Buffer.from(glyphs.map((byte: number) => 255 - byte)),
    );
    await writeFile(join(repo, "small.ts"), "export const small = 2;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const unpackable = unpackableFiles({
      repo,
      head,
      base,
      files: ["font.ttf", "lock.txt", "small.ts"],
      budget: 4_000,
    });

    // The lane packs each assigned file whole at head beside the diff, so the
    // lockfile's few changed lines are not what decides: the file is. The font
    // fits any budget and is still left out, because a model handed its bytes
    // would judge them as source.
    expect(unpackable).toEqual([
      {
        file: "font.ttf",
        diffBytes: expect.any(Number),
        headBytes: 512,
        binary: true,
      },
      {
        file: "lock.txt",
        diffBytes: expect.any(Number),
        headBytes: expect.any(Number),
        binary: false,
      },
    ]);
    expect(unpackable[1]?.diffBytes).toBeLessThan(2_000);
    expect(unpackable[1]?.headBytes).toBeGreaterThan(2_000);
  });

  it("derives the budget from whichever ceiling binds first", () => {
    // t1a's request cap is under the model's prompt limit, so the trial binds.
    expect(packBudgetChars("t1a", "grok-4.6")).toBe(
      (SESSION_CAPS.t1a.maxInputTokensPerRequest - 2_000) * 3,
    );
    // t1b's cap is over it, so the model does: a pack the provider refuses
    // whole is not a budget, it is a wasted run.
    expect(packBudgetChars("t1b", "grok-4.6")).toBe((500_000 - 2_000) * 3);
    // Workers AI's own endpoint names the model without the gateway prefix,
    // and a lane on it is held to the same window, not the unknown floor.
    expect(
      packBudgetChars("t1b", "@cf/deepseek-ai/deepseek-v4-flash-0731"),
    ).toBe(
      packBudgetChars(
        "t1b",
        "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      ),
    );
    expect(
      packBudgetChars("t1b", "@cf/deepseek-ai/deepseek-v4-flash-0731"),
    ).toBeGreaterThan(packBudgetChars("t1b", "some-unknown-model"));
    expect(packBudgetChars("t1b", "some-unknown-model")).toBeLessThan(
      packBudgetChars("t1b", "grok-4.6"),
    );
  });

  it("knows the prompt ceiling of every lab the packed lanes route to", () => {
    // Workers AI and OpenAI are the figures this repository already holds;
    // Claude is the family's 200k floor even though Sonnet 5 takes far more.
    // An unknown id keeps the 128k fallback, which is a smaller pack, never a
    // refused one.
    // The trial's own request cap binds before Luna's window does.
    expect(packBudgetChars("t1b", "openai/gpt-5.6-luna")).toBe(
      (SESSION_CAPS.t1b.maxInputTokensPerRequest - 2_000) * 3,
    );
    expect(
      packBudgetChars(
        "t1b",
        "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      ),
    ).toBe((1_048_576 - 2_000) * 3);
    expect(packBudgetChars("t1b", "anthropic/claude-sonnet-5")).toBe(
      (200_000 - 2_000) * 3,
    );
    expect(packBudgetChars("t1b", "anthropic/claude-sonnet-9")).toBe(
      (128_000 - 2_000) * 3,
    );
  });

  it("reads grep hits when head is a branch name, not a sha", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-ref-"));
    temporary.push(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const keep = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    await writeFile(
      join(repo, "src/a.ts"),
      "export const keep = 1;\nexport function reached() {}\n",
    );
    await writeFile(
      join(repo, "src/b.ts"),
      "import { reached } from './a';\nreached();\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);

    const packed = packLaneContext({
      repo,
      head: "main",
      base,
      files: ["src/a.ts"],
      budget: packBudgetChars("t1b", "grok-4.6"),
    });

    // The call sites are the only context beyond the assignment; reading the
    // revision itself as a path would drop all of them without a word.
    expect(packed.filesPacked).toContain("src/b.ts");
    expect(packed.pack).toContain("import { reached }");
  });

  it("names an assigned file the change deleted instead of skipping it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-gone-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "gone.ts"), "export const gone = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "gone.ts"]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const packed = packLaneContext({
      repo,
      head,
      base,
      files: ["gone.ts"],
      budget: packBudgetChars("t1b", "grok-4.6"),
    });

    // The diff carries the deletion, so this is evidence the lane has, not a
    // gap; it is recorded so nobody has to guess which of the two it was.
    expect(packed.missingAtHead).toEqual(["gone.ts"]);
    expect(packed.droppedFiles).toEqual([]);
    expect(packed.pack).toContain("gone.ts");
  });

  it("measures the whole change against one lane's budget", async () => {
    const repo = await mkdtemp(join(tmpdir(), "review-pi-pack-whole-"));
    temporary.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@invalid"]);
    git(repo, ["config", "user.name", "t"]);
    const files = ["a.ts", "b.ts", "c.ts"];
    for (const file of files) {
      await writeFile(join(repo, file), `export const ${file[0]} = 1;\n`);
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    for (const file of files) {
      await writeFile(join(repo, file), `export const ${file[0]} = 2;\n`);
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "head"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    const pack = wholeChangePack({ repo, head, base, files });
    expect(pack.filesPacked).toEqual(files);
    const size = pack.bytes;
    // Both sides are sizes: a pack that lands on the budget fits it, and one
    // byte past it does not, whatever the number of files behind it.
    expect(wholeChangeFits({ repo, head, base, files, budget: size })).toBe(
      true,
    );
    expect(wholeChangeFits({ repo, head, base, files, budget: size - 1 })).toBe(
      false,
    );
  });
});
