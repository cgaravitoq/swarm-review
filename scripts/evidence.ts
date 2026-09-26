import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertCloudRunId } from "../src/isolation";
import { fetchPullRevisions } from "../src/publish";
import { githubToken } from "../src/swarm";

const PULL = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const EVIDENCE_NAME = /^[a-z0-9-]+\.jsonl$/;

async function reviewOf(target: string) {
  const pull = PULL.exec(target);
  if (!pull) return assertCloudRunId(target);
  const [, repo = "", number = ""] = pull;
  const token = githubToken();
  if (!token) {
    throw new Error(
      "resolving a pull request needs GITHUB_TOKEN, GH_TOKEN or gh auth; or pass the review id",
    );
  }
  const { head } = await fetchPullRevisions(repo, Number(number), token);
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${head.sha}/check-runs?check_name=swarm-review&filter=latest`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "swarm-review-cli",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub check runs request failed: ${response.status}`);
  }
  const { check_runs } = (await response.json()) as {
    check_runs: { external_id: string | null }[];
  };
  const reviewId = check_runs.find((run) => run.external_id)?.external_id;
  if (!reviewId) {
    throw new Error(
      `no swarm-review check at ${head.sha.slice(0, 7)} names a cloud review`,
    );
  }
  return assertCloudRunId(reviewId);
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const [origin, target, out] = argv;
  const secret = env["CONTROL_SECRET"];
  if (!origin || !target || !out || !secret) {
    throw new Error(
      "usage: CONTROL_SECRET=... bun run scripts/evidence.ts <worker-origin> <review-id|owner/name#pr> <out-dir>",
    );
  }
  const worker = new URL(origin);
  if (worker.protocol !== "https:")
    throw new Error("worker origin must use HTTPS");
  const reviewId = await reviewOf(target);
  const headers = { authorization: `Bearer ${secret}` };
  const listed = await fetch(new URL(`/reviews/${reviewId}/evidence`, worker), {
    headers,
    redirect: "manual",
  });
  if (!listed.ok) {
    throw new Error(`listing evidence failed: HTTP ${listed.status}`);
  }
  const { files } = (await listed.json()) as {
    files: { name: string; bytes: number; truncated: boolean }[];
  };
  process.stdout.write(`${reviewId} ${files.length} file(s)\n`);
  await mkdir(out, { recursive: true });
  for (const file of files) {
    if (!EVIDENCE_NAME.test(file.name)) {
      throw new Error(`unexpected evidence name: ${file.name}`);
    }
    const response = await fetch(
      new URL(`/reviews/${reviewId}/evidence/${file.name}`, worker),
      { headers, redirect: "manual" },
    );
    if (!response.ok) {
      throw new Error(`${file.name}: HTTP ${response.status}`);
    }
    await writeFile(join(out, file.name), await response.text());
    process.stdout.write(
      `${file.name} ${file.bytes} bytes${file.truncated ? " (truncated)" : ""}\n`,
    );
  }
  return files.length > 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
