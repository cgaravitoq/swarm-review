import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_SOURCES } from "../src/protocol";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function probeMany(
  origin: string,
  secret: string,
  accountId: string,
  bearer: string,
  count: number,
) {
  if (!Number.isInteger(count) || count < 1 || count > 30) {
    throw new Error("probe count must be between 1 and 30");
  }
  const worker = new URL(origin);
  if (worker.protocol !== "https:")
    throw new Error("worker origin must use HTTPS");
  const expectedSources = Object.fromEntries(
    await Promise.all(
      Object.entries(IMAGE_SOURCES).map(async ([target, source]) => [
        target,
        createHash("sha256")
          .update(await readFile(join(packageRoot, "container", source)))
          .digest("hex"),
      ]),
    ),
  );
  return Promise.allSettled(
    Array.from({ length: count }, async () => {
      const response = await fetch(new URL("/probe", worker), {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedSources,
          workersAi: { accountId, bearer },
        }),
        redirect: "manual",
      });
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => null);
        throw new Error(
          typeof failure === "object" &&
            failure !== null &&
            "error" in failure &&
            typeof failure.error === "string"
            ? `HTTP ${response.status} ${failure.error}`
            : `HTTP ${response.status}`,
        );
      }
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("key" in result) ||
        typeof result.key !== "string" ||
        !("runId" in result) ||
        typeof result.runId !== "string"
      )
        throw new Error("missing R2 key");
      return {
        runId: result.runId,
        key: result.key,
        status: "status" in result ? result.status : null,
      };
    }),
  );
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const [origin, rawCount] = argv;
  const secret = env["CONTROL_SECRET"];
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  const bearer = env["WORKERS_AI_API_KEY"];
  if (!origin || !secret || !accountId || !bearer) {
    throw new Error(
      "usage: CONTROL_SECRET=... CLOUDFLARE_ACCOUNT_ID=... WORKERS_AI_API_KEY=... bun run scripts/probe.ts <worker-origin> [count]",
    );
  }
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const results = await probeMany(origin, secret, accountId, bearer, count);
  for (const [index, result] of results.entries()) {
    process.stdout.write(
      result.status === "fulfilled"
        ? `${result.value.runId} ${result.value.key} ${result.value.status}\n`
        : `probe ${index + 1} error ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`,
    );
  }
  return results.some((result) => result.status === "rejected") ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
