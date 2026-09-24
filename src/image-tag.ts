import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_SOURCES } from "./protocol";

export function imageTag(
  sources: Readonly<Record<string, string>>,
  lockfile: Uint8Array,
): string {
  const fingerprint = Object.keys(IMAGE_SOURCES)
    .map((path) => {
      const sha = sources[path];
      if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
        throw new Error(`missing image source fingerprint: ${path}`);
      }
      return `${sha}  ${path}\n`;
    })
    .join("");
  return createHash("sha256")
    .update(fingerprint)
    .update(lockfile)
    .digest("hex")
    .slice(0, 16);
}

export async function imageTagFromFiles(
  containerDir: string,
  lockfilePath: string,
): Promise<string> {
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(IMAGE_SOURCES).map(async ([path, name]) => [
        path,
        createHash("sha256")
          .update(await readFile(join(containerDir, name)))
          .digest("hex"),
      ]),
    ),
  );
  return imageTag(sources, await readFile(lockfilePath));
}

export function imageReference(repository: string, tag: string): string {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
    throw new Error(`expected owner/repo, got ${repository}`);
  }
  return `ghcr.io/${repository.toLowerCase()}-swarm-review-sandbox:${tag}`;
}

export async function laneImageReference(
  repository: string,
  requested: string | undefined,
  containerDir: string,
  lockfilePath: string,
): Promise<string> {
  if (requested !== undefined) {
    return requested;
  }
  return imageReference(
    repository,
    await imageTagFromFiles(containerDir, lockfilePath),
  );
}
