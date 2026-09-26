import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickTier } from "../jev";

// A real System One answer, captured from api.typesafe.ai: Jev leaned deep at
// 0.47 confidence for a pull request that changed models and deadlines.
const captured = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "jev-systemone-response.json"),
    "utf8",
  ),
) as {
  answers: { tier: { choice: string; confidence: number } };
};

const metadata = {
  title: "docs: explain the brief",
  description: "Adds a paragraph to the README.",
  files: [{ path: "README.md", additions: 3, deletions: 1 }],
  totalFiles: 1,
};

const answering = (tier: { choice: string; confidence: number }) => ({
  ...captured,
  answers: { tier: { ...captured.answers.tier, ...tier } },
});

const typesafe = (...responses: Response[]) => {
  const fake = vi.fn(async (_input: URL | string, _init?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("no response left");
    return response;
  });
  vi.stubGlobal("fetch", fake);
  return fake;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickTier", () => {
  it("asks Jev one tier question about the metadata and nothing else", async () => {
    const fetch = typesafe(
      Response.json(answering({ choice: "light", confidence: 0.91 })),
    );
    expect(await pickTier("typesafe-key", metadata)).toEqual({
      tier: "light",
      note: "Tier light, picked by Jev from the pull request's metadata with confidence 0.91: A trivial change: documentation, comments, formatting, a rename, a version bump, or tests only, with no change to behavior that users or other systems rely on.",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer typesafe-key",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "jev-latest",
      state: metadata,
      questions: {
        tier: {
          type: "choice",
          instructions:
            "Pick how deeply to review this pull request from its metadata alone: its title, its description, and each changed file's path with the lines added and removed.",
          criteria: {
            light:
              "A trivial change: documentation, comments, formatting, a rename, a version bump, or tests only, with no change to behavior that users or other systems rely on.",
            standard:
              "An ordinary feature or fix whose risk stays inside one area of the code.",
            deep: "A change to authentication, authorization, payments, secrets, infrastructure or deployment, data migrations or storage formats, or concurrency, or a large change across many areas.",
          },
        },
      },
    });
  });

  it("runs standard when Jev's real answer leans under the threshold", async () => {
    typesafe(Response.json(captured));
    expect(await pickTier("typesafe-key", metadata)).toEqual({
      tier: "standard",
      note: "Tier standard: Jev leaned deep with confidence 0.47, under 0.55.",
    });
  });

  it("takes Jev's pick at exactly the threshold", async () => {
    typesafe(Response.json(answering({ choice: "deep", confidence: 0.55 })));
    expect(await pickTier("typesafe-key", metadata)).toMatchObject({
      tier: "deep",
    });
  });

  it("runs standard when Jev refuses the key, without asking again", async () => {
    const fetch = typesafe(
      Response.json({ error: { message: "bad key" } }, { status: 401 }),
    );
    expect(await pickTier("typesafe-key", metadata)).toEqual({
      tier: "standard",
      note: expect.stringMatching(
        /^Tier standard: Jev did not answer \(.+\)\.$/,
      ),
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("asks once more after a server error, then runs standard", async () => {
    const fetch = typesafe(
      new Response("unavailable", { status: 503 }),
      new Response("unavailable", { status: 503 }),
      Response.json(answering({ choice: "deep", confidence: 0.9 })),
    );
    expect(await pickTier("typesafe-key", metadata)).toMatchObject({
      tier: "standard",
      note: expect.stringContaining("Jev did not answer"),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
