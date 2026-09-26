import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/evidence";

const WORKER = "https://review.invalid";
const HEAD = "a".repeat(40);
const transcripts = new Map([
  ["reviewer-1.jsonl", '{"type":"session"}\n'],
  ["verifier-c1.jsonl", '{"type":"message"}\n'],
]);

let scratch: string;
let requests: { url: string; authorization: string | null }[];
let lines: string[];

const serve = (routes: Record<string, () => Response>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const route = routes[url];
      return route ? route() : new Response("not found", { status: 404 });
    }),
  );

const workerRoutes = (reviewId: string, names = [...transcripts.keys()]) => ({
  [`${WORKER}/reviews/${reviewId}/evidence`]: () =>
    Response.json({
      files: names.map((name) => ({
        name,
        bytes: transcripts.get(name)?.length ?? 0,
        truncated: name === "verifier-c1.jsonl",
      })),
    }),
  ...Object.fromEntries(
    names.map((name) => [
      `${WORKER}/reviews/${reviewId}/evidence/${name}`,
      () => new Response(transcripts.get(name)),
    ]),
  ),
});

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "evidence-"));
  requests = [];
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

describe("evidence download", () => {
  it("downloads every lane transcript of a review id behind the control secret", async () => {
    serve(workerRoutes("review-1"));
    const out = join(scratch, "out");

    await expect(
      main([WORKER, "review-1", out], { CONTROL_SECRET: "control-sentinel" }),
    ).resolves.toBe(0);

    expect((await readdir(out)).sort()).toEqual([...transcripts.keys()]);
    for (const [name, content] of transcripts) {
      expect(await readFile(join(out, name), "utf8")).toBe(content);
    }
    expect(requests.map((request) => request.authorization)).toEqual(
      requests.map(() => "Bearer control-sentinel"),
    );
    expect(lines).toContain("verifier-c1.jsonl 19 bytes (truncated)\n");
  });

  it("finds the review behind a pull request in its head check's external_id", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github-sentinel");
    serve({
      "https://api.github.com/repos/acme/demo/pulls/7": () =>
        Response.json({ head: { sha: HEAD }, base: { sha: "b".repeat(40) } }),
      [`https://api.github.com/repos/acme/demo/commits/${HEAD}/check-runs?check_name=swarm-review&filter=latest`]:
        () =>
          Response.json({
            check_runs: [{ external_id: "" }, { external_id: "review-7" }],
          }),
      ...workerRoutes("review-7", ["reviewer-1.jsonl"]),
    });
    const out = join(scratch, "out");

    await expect(
      main([WORKER, "acme/demo#7", out], {
        CONTROL_SECRET: "control-sentinel",
      }),
    ).resolves.toBe(0);

    expect(
      requests.slice(0, 2).map((request) => request.authorization),
    ).toEqual(["Bearer github-sentinel", "Bearer github-sentinel"]);
    expect(await readdir(out)).toEqual(["reviewer-1.jsonl"]);
    expect(lines[0]).toBe("review-7 1 file(s)\n");
  });

  it("writes nothing outside the output directory for a name that would leave it", async () => {
    serve({
      [`${WORKER}/reviews/review-1/evidence`]: () =>
        Response.json({
          files: [{ name: "../escape.jsonl", bytes: 1, truncated: false }],
        }),
      [`${WORKER}/reviews/review-1/../escape.jsonl`]: () => new Response("x"),
    });
    const out = join(scratch, "out");

    await expect(
      main([WORKER, "review-1", out], { CONTROL_SECRET: "control-sentinel" }),
    ).rejects.toThrow("unexpected evidence name: ../escape.jsonl");
    expect(await readdir(scratch)).toEqual(["out"]);
    expect(requests).toHaveLength(1);
  });

  it("exits non-zero for a review with no evidence", async () => {
    serve(workerRoutes("review-1", []));

    await expect(
      main([WORKER, "review-1", join(scratch, "out")], {
        CONTROL_SECRET: "control-sentinel",
      }),
    ).resolves.toBe(1);
  });
});
