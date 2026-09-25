import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  engineBundle,
  imageReference,
  imageTag,
  imageTagFromFiles,
  laneImageReference,
} from "../image-tag";
import { IMAGE_SOURCES } from "../protocol";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex");

describe("sandbox image tag", () => {
  const sources = Object.fromEntries(
    Object.keys(IMAGE_SOURCES).map((path) => [path, digest(path)]),
  );
  const lock = Buffer.from("target lockfile\n");

  it("is stable for identical source fingerprints and lockfile bytes", () => {
    const first = imageTag(sources, lock);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(imageTag({ ...sources }, Buffer.from(lock))).toBe(first);
  });

  it("changes for one byte of the lockfile", () => {
    expect(imageTag(sources, Buffer.from("target lockfilf\n"))).not.toBe(
      imageTag(sources, lock),
    );
  });

  it.each(Object.keys(IMAGE_SOURCES))("changes for %s", (path) => {
    expect(imageTag({ ...sources, [path]: digest(`${path}!`) }, lock)).not.toBe(
      imageTag(sources, lock),
    );
  });

  it("derives the image name from the repository", () => {
    expect(imageReference("Acme/Product", imageTag(sources, lock))).toBe(
      `ghcr.io/acme/product-swarm-review-sandbox:${imageTag(sources, lock)}`,
    );
  });

  it("uses the computed image by default and preserves an explicit image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-image-choice-"));
    try {
      for (const name of Object.values(IMAGE_SOURCES)) {
        await mkdir(join(directory, name, ".."), { recursive: true });
        await writeFile(join(directory, name), name);
      }
      const lockfile = join(directory, "bun.lock");
      await writeFile(lockfile, lock);
      const expected = imageReference(
        "acme/demo",
        await imageTagFromFiles(directory, lockfile),
      );
      expect(
        await laneImageReference("acme/demo", undefined, directory, lockfile),
      ).toBe(expected);
      expect(
        await laneImageReference(
          "acme/demo",
          "custom-image:one",
          directory,
          lockfile,
        ),
      ).toBe("custom-image:one");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("changes when any real image source or the lockfile changes by one byte", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-image-tag-"));
    try {
      for (const name of Object.values(IMAGE_SOURCES)) {
        await mkdir(join(directory, name, ".."), { recursive: true });
        await writeFile(join(directory, name), name);
      }
      const lockfile = join(directory, "bun.lock");
      await writeFile(lockfile, lock);
      const expected = await imageTagFromFiles(directory, lockfile);
      for (const name of [...Object.values(IMAGE_SOURCES), "bun.lock"]) {
        const file = join(directory, name);
        const original = await readFile(file);
        await writeFile(file, Buffer.concat([original, Buffer.from("x")]));
        expect(await imageTagFromFiles(directory, lockfile)).not.toBe(expected);
        await writeFile(file, original);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds the same engine bytes into any context, so the action and the image build derive one tag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-image-engine-"));
    try {
      const lockfile = join(directory, "bun.lock");
      await writeFile(lockfile, lock);
      const tags: string[] = [];
      for (const build of ["action", "deploy"]) {
        const container = join(directory, build);
        await cp(join(packageRoot, "container"), container, {
          recursive: true,
          filter: (path) =>
            !path.startsWith(join(packageRoot, "container", "context")),
        });
        const { args, cwd } = engineBundle(
          packageRoot,
          join(container, "context", "swarm.js"),
        );
        const built = spawnSync("bun", args, { cwd, encoding: "utf8" });
        expect(built.status, built.stderr).toBe(0);
        tags.push(await imageTagFromFiles(container, lockfile));
      }
      expect(
        await readFile(join(directory, "action", "context", "swarm.js")),
      ).toEqual(
        await readFile(join(directory, "deploy", "context", "swarm.js")),
      );
      expect(tags[0]).toBe(tags[1]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
