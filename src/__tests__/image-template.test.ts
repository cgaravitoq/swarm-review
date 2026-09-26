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
  // The request-shape tests drive the Pi in devDependencies, so they only
  // speak for the image while both pin the same Pi.
  it("is the Pi the request-shape tests drive", async () => {
    const dockerfile = await containerFile("Dockerfile");
    const pkg = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { devDependencies: Record<string, string> };
    const pinned = pkg.devDependencies["@earendil-works/pi-coding-agent"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain(`"@earendil-works/pi-coding-agent@${pinned}"`);
  });

  // claude-code-stream.test.ts drives the Claude Code stream in
  // devDependencies, so it only speaks for the image while both pin the same
  // stream: one written for another Pi drops a lane's prompt and tools.
  it("runs the Claude Code stream the request-shape tests drive", async () => {
    const dockerfile = await containerFile("Dockerfile");
    const pkg = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { devDependencies: Record<string, string> };
    const pinned = pkg.devDependencies["@cgaravitoq/pi-claude-code-auth"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain(`"@cgaravitoq/pi-claude-code-auth@${pinned}"`);
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
    expect(named).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-opus-5",
    ]);
    for (const model of named) expect(served).toContain(model);
  });

  it("defines gpt-6-luna in full rather than leaning on Pi's built-in catalog", async () => {
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
