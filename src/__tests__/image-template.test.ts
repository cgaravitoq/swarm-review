import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const containerFile = (name: string) =>
  readFile(
    fileURLToPath(new URL(`../../container/${name}`, import.meta.url)),
    "utf8",
  );

describe("the baked template", () => {
  // The runner tests stage a template under REVIEW_TEMPLATE_ROOT, which
  // production never sets, so only these bytes tie the bake to the lookup.
  it("lands where the runner looks for it by default", async () => {
    const runner = await containerFile("review-run.sh");
    const dockerfile = await containerFile("Dockerfile");
    const root = runner.match(
      /^TEMPLATE_ROOT="\$\{REVIEW_TEMPLATE_ROOT:-([^}]+)\}"$/m,
    )?.[1];
    const destinations = new Map(
      [
        ...dockerfile.matchAll(/^COPY --from=bun-template .*?(\S+) (\S+)$/gm),
      ].map(([, source, destination]) => [source, destination]),
    );

    expect(root).toBeDefined();
    expect(destinations.get("/opt/review/lockfile/node_modules")).toBe(
      `${root}/node_modules-template`,
    );
    expect(destinations.get("/opt/review/lockfile/bun.lock")).toBe(
      `${root}/template-bun.lock`,
    );
  });
});

describe("the image's Pi", () => {
  // Pi 0.86 hands providers a TranscriptContext without `systemPrompt` or
  // `tools`, which the pinned Claude Code stream still reads, so a newer Pi
  // would send the claude-code lanes no prompt and no tools.
  it("stays on the Pi the Claude Code stream reads its context from", async () => {
    const dockerfile = await containerFile("Dockerfile");
    expect(dockerfile).toContain('"@earendil-works/pi-coding-agent@0.85.1"');
    expect(dockerfile).toContain('"@cgaravitoq/pi-claude-code-auth@2.5.2"');
  });

  // claude-code is a custom provider: models.json is its whole catalog, so a
  // model the Worker names and the file lacks fails as an unknown model.
  it("serves every claude-code model the Worker names", async () => {
    const worker = await readFile(
      fileURLToPath(new URL("../../worker.ts", import.meta.url)),
      "utf8",
    );
    const named = [
      ...worker.matchAll(/provider: "claude-code", model: "([^"]+)"/g),
    ].map(([, model]) => model);
    const models = JSON.parse(await containerFile("models.json")) as {
      providers: Record<string, { models?: { id: string }[] }>;
    };
    const served = models.providers["claude-code"]?.models?.map(
      (model) => model.id,
    );
    expect(named).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    for (const model of named) expect(served).toContain(model);
  });

  it("defines gpt-6-luna in full, since Pi 0.85.1 has no built-in entry to override", async () => {
    const models = JSON.parse(await containerFile("models.json")) as {
      providers: Record<string, { models?: { id: string; api?: string }[] }>;
    };
    expect(
      models.providers["openai-codex"]?.models?.find(
        (model) => model.id === "gpt-6-luna",
      ),
    ).toMatchObject({ api: "openai-codex-responses" });
  });
});
