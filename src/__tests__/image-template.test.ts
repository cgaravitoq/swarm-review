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
