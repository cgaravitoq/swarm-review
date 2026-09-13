import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alreadyPublished,
  assertPublishableReceipt,
  buildReview,
  commentableLines,
  fetchReviews,
  findingBody,
  githubReviewPayload,
  headline,
  parsePublishOptions,
  publicationDisposition,
  REVIEW_EVENT,
  REVIEW_SIDE,
  reviewScore,
  type SwarmReceipt,
  supersededBody,
  supersededReviews,
  updateReviewBody,
} from "../publish";

const diff = `diff --git a/src/local.ts b/src/local.ts
index 1111111..2222222 100644
--- a/src/local.ts
+++ b/src/local.ts
@@ -40,6 +40,8 @@ const before = 1;
 context line
+added line
+another added line
 trailing context
diff --git a/src/swarm.ts b/src/swarm.ts
index 3333333..4444444 100644
--- a/src/swarm.ts
+++ b/src/swarm.ts
@@ -10,3 +10,4 @@ export const module = 1;
 keep
+new column
`;

const finding = (
  overrides: Partial<SwarmReceipt["findings"][number]> = {},
) => ({
  id: "c1",
  severity: "P0",
  file: "src/local.ts",
  line: 41,
  mechanism: "the teardown never removes the staged token",
  evidence: "local-receipt.json shows authRemoved false",
  affectedBehavior: "a subscription bearer stays inside a live container",
  status: "confirmed",
  evidenceStrength: "executable",
  reportedBy: ["reviewer-1"],
  verifierReason: "reproduced against the receipt",
  verifierCommand: "bun --filter swarm-review test",
  verifierExitStatus: 0,
  diffRelation: "added" as const,
  declaredIntent: null,
  ...overrides,
});

const receipt = (findings: SwarmReceipt["findings"]): SwarmReceipt => ({
  swarmId: "swarm-1",
  status: "completed",
  requested: {
    head: "cf811bc736a15f9af5cbe6014a7236f488181088",
    base: "3d83c39ede844acb0571078ed46c5c87708ba62a",
    pullRequest: 6528,
  },
  findings,
});

describe("commentable lines", () => {
  it("maps the new side of every hunk and nothing else", () => {
    const lines = commentableLines(diff);
    expect([...(lines.get("src/local.ts") ?? [])]).toEqual([40, 41, 42, 43]);
    expect([...(lines.get("src/swarm.ts") ?? [])]).toEqual([10, 11]);
    expect(lines.has("src/untouched.ts")).toBe(false);
  });
});

describe("review payload", () => {
  it("anchors a finding on a diff line and never requests changes", () => {
    const review = buildReview(
      receipt([finding()]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.event).toBe(REVIEW_EVENT);
    expect(review.event).not.toBe("REQUEST_CHANGES");
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({
      path: "src/local.ts",
      line: 41,
      side: REVIEW_SIDE,
    });
    expect(review.commit_id).toBe(receipt([finding()]).requested.head);
    expect(githubReviewPayload(review).commit_id).toHaveLength(40);
    expect(review.comments[0]?.body).toContain("the teardown never removes");
    expect(review.comments[0]?.body).toContain(
      "bun --filter swarm-review test",
    );
  });

  it("moves a finding outside the diff into the summary instead of dropping it", () => {
    // One unanchorable comment makes GitHub reject the whole review, and a
    // consumer the change breaks at a distance is usually the finding worth
    // keeping.
    const review = buildReview(
      receipt([
        finding({
          id: "c2",
          file: "src/consumer.ts",
          line: 900,
          mechanism: "the consumer still passes the removed field",
        }),
      ]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain("src/consumer.ts:900");
    expect(review.body).toContain(
      "the consumer still passes the removed field",
    );
  });

  it("publishes only confirmed findings and keeps unverified unpublished", () => {
    const review = buildReview(
      receipt([
        finding({ id: "c1", status: "rejected", line: 41 }),
        finding({
          id: "c2",
          status: "unverified",
          line: 42,
          mechanism: "no verdict was ever recorded",
        }),
        finding({ id: "c3", status: "confirmed", line: 43 }),
      ]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]?.line).toBe(43);
    expect(review.body).toContain("1 candidate unverified");
    expect(review.body).not.toContain("no verdict was ever recorded");
  });

  it("honours the severity floor", () => {
    const review = buildReview(
      receipt([
        finding({ id: "c1", severity: "P2", line: 41 }),
        finding({ id: "c2", severity: "P0", line: 42 }),
      ]),
      commentableLines(diff),
      "acme/demo",
      "P0",
    );

    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]?.line).toBe(42);
  });

  it("publishes a finding the change declares as intended as a P3 advisory", () => {
    // The behavior is real and the change's own body says it meant to do it,
    // so it stays readable and stops being charged as a regression.
    const declared = finding({
      id: "c1",
      severity: "P1",
      line: 41,
      diffRelation: "touched",
      declaredIntent: "set media bullet narration copy duration to 2 seconds",
    });

    const review = buildReview(
      receipt([declared]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain("advisory");
    expect(review.body).toContain(
      'declared: "set media bullet narration copy duration to 2 seconds"',
    );
    expect(reviewScore(receipt([declared]))).toMatchObject({
      available: true,
      value: 5,
    });
  });

  it("records an untouched finding as out-of-diff and never publishes it", () => {
    // pr6545 published three confirmed findings on a diff that was not the
    // change's: code nothing in the diff reaches is not this pull request's
    // defect, however well the mechanism was verified.
    const untouched = finding({
      id: "c1",
      line: 41,
      diffRelation: "untouched",
    });

    const review = buildReview(
      receipt([untouched]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain("src/local.ts:41");
    expect(review.body).toContain("out-of-diff");
    expect(review.body).toContain("1 out-of-diff");
    expect(review.body).not.toContain(
      "No confirmed finding survived verification",
    );
    expect(reviewScore(receipt([untouched]))).toMatchObject({
      available: true,
      value: 5,
    });
  });

  it("publishes a finding the change neither declares nor predates", () => {
    const review = buildReview(
      receipt([finding({ id: "c1", line: 41 })]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments.map((comment) => comment.line)).toEqual([41]);
    expect(
      reviewScore(receipt([finding({ id: "c1", line: 41 })])),
    ).toMatchObject({ value: 1 });
  });

  it("says so plainly when nothing survived", () => {
    const review = buildReview(
      receipt([]),
      commentableLines(diff),
      "acme/demo",
    );

    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain("No confirmed finding survived verification");
  });

  it("maps the worst confirmed severity onto the confidence legend", () => {
    const at = (findings: SwarmReceipt["findings"]) =>
      reviewScore(receipt(findings));
    expect(at([])).toMatchObject({ value: 5, label: "Production ready" });
    expect(at([finding({ severity: "P2" })])).toMatchObject({
      value: 3,
      label: "Implementation issues",
    });
    expect(
      at([finding({ severity: "P2" }), finding({ id: "c2", severity: "P1" })]),
    ).toMatchObject({ value: 2, label: "Significant bugs" });
    expect(at([finding({ severity: "P0" })])).toMatchObject({
      value: 1,
      label: "Critical problems",
    });
    expect(
      at([finding({ severity: "P0" }), finding({ id: "c2", severity: "P0" })]),
    ).toMatchObject({ value: 0, label: "Critical problems" });
    // A rejected P0 is not a confirmed one.
    expect(at([finding({ severity: "P0", status: "rejected" })])).toMatchObject(
      { value: 5 },
    );
    expect(reviewScore(receipt([])).legend).toContain("5 production ready");
  });

  it("prints the confidence and its legend in the summary", () => {
    const body = buildReview(
      receipt([finding({ severity: "P1" })]),
      commentableLines(diff),
      "acme/demo",
    ).body;
    expect(body).toContain("Confidence 2/5");
    expect(body).toContain("Significant bugs");
    expect(body).toContain("never estimated by a model");
  });

  it("scores only a completed review and refuses a partial one", () => {
    const completed = receipt([finding()]);
    expect(reviewScore(completed)).toMatchObject({
      available: true,
      value: 1,
    });
    expect(reviewScore({ ...completed, status: "partial" })).toMatchObject({
      available: false,
    });
    expect(() =>
      assertPublishableReceipt(
        { ...completed, status: "partial" },
        {
          head: completed.requested.head,
          mergeBase: completed.requested.base,
        },
      ),
    ).toThrow(/completed review/);
  });

  it("refuses a severity outside the contract instead of scoring around it", () => {
    // reviewScore ignores a rank it cannot place, so an off-contract severity
    // would print 5/5 next to a row that calls the same finding one to fix.
    const odd = receipt([finding({ severity: "P4" })]);
    expect(() =>
      assertPublishableReceipt(odd, {
        head: odd.requested.head,
        mergeBase: odd.requested.base,
      }),
    ).toThrow(/unknown severity/);
  });

  it("anchors the review to the merge base, never the destination tip", () => {
    const completed = receipt([finding()]);
    // The receipt's base is the merge base the diff was cut from; a review
    // frozen against the tip would be unpublishable the moment anything lands
    // on the base branch.
    expect(() =>
      assertPublishableReceipt(completed, {
        head: completed.requested.head,
        mergeBase: completed.requested.base,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishableReceipt(completed, {
        head: completed.requested.head,
        mergeBase: "9".repeat(40),
      }),
    ).toThrow(/merge base/);
    expect(
      buildReview(completed, commentableLines(diff), "acme/demo").body,
    ).toContain("against merge base");
  });

  it("deduplicates by run and frozen head marker", () => {
    const built = buildReview(
      receipt([finding()]),
      commentableLines(diff),
      "acme/demo",
    );
    expect(
      alreadyPublished(
        [{ body: built.body }],
        "swarm-1",
        receipt([finding()]).requested.head,
      ),
    ).toBe(true);
    expect(
      alreadyPublished([], "swarm-1", receipt([finding()]).requested.head),
    ).toBe(false);
  });
});

describe("summary body", () => {
  const build = (findings: SwarmReceipt["findings"], extra = {}) =>
    buildReview(
      { ...receipt(findings), ...extra },
      commentableLines(diff),
      "acme/demo",
    ).body;

  it("opens with the confidence, the counts and the caveats", () => {
    const body = build(
      [
        finding({ id: "c1", severity: "P2" }),
        finding({ id: "c2", status: "unverified", line: 42 }),
        finding({
          id: "c3",
          severity: "P1",
          line: 43,
          declaredIntent: "the token is kept",
        }),
      ],
      {
        coverage: {
          changedFiles: ["src/local.ts", "src/swarm.ts", "src/other.ts"],
          uncoveredFiles: ["src/other.ts"],
        },
      },
    );
    const [marker, headlineLine] = body.split("\n");
    expect(marker).toBe(
      "<!-- review-pi run=swarm-1 sha=cf811bc736a15f9af5cbe6014a7236f488181088 -->",
    );
    expect(headlineLine).toBe(
      "**Confidence 3/5 · Implementation issues** · 1 finding to fix · 1 advisory · 1 of 3 changed files with findings · 1 candidate unverified · 1 file not reviewed",
    );
    expect(body).toContain("- not reviewed: `src/other.ts`");
  });

  it("lists every published finding and advisory as a table row linked to the head", () => {
    const body = build([
      finding({ id: "c1", severity: "P2", line: 41 }),
      finding({
        id: "c2",
        severity: "P0",
        line: 42,
        evidenceStrength: "static",
        affectedBehavior: "the | pipe breaks\nthe table",
      }),
      finding({
        id: "c3",
        severity: "P3",
        line: 43,
        declaredIntent: "the token is kept",
      }),
    ]);
    const rows = body.split("\n").filter((line) => line.startsWith("| P"));
    expect(rows).toEqual([
      "| P0 | [src/local.ts:42](https://github.com/acme/demo/blob/cf811bc736a15f9af5cbe6014a7236f488181088/src/local.ts#L42) | the \\| pipe breaks the table | read in source |",
      "| P2 | [src/local.ts:41](https://github.com/acme/demo/blob/cf811bc736a15f9af5cbe6014a7236f488181088/src/local.ts#L41) | a subscription bearer stays inside a live container | reproduced in sandbox |",
      '| P3 | [src/local.ts:43](https://github.com/acme/demo/blob/cf811bc736a15f9af5cbe6014a7236f488181088/src/local.ts#L43) | a subscription bearer stays inside a live container | declared: "the token is kept" |',
    ]);
  });

  it("leaves a confirmed finding below the minimum severity out of the review", () => {
    const review = buildReview(
      receipt([
        finding({ id: "c1", severity: "P2", line: 41 }),
        finding({ id: "c2", severity: "P3", line: 42 }),
      ]),
      commentableLines(diff),
      "acme/demo",
    );
    const [, headlineLine] = review.body.split("\n");
    expect(headlineLine).toContain("1 finding to fix");
    expect(
      review.body.split("\n").filter((line) => line.startsWith("| P")),
    ).toHaveLength(1);
    expect(review.body).not.toContain("src/local.ts:42");
    expect(review.comments.map((comment) => comment.line)).toEqual([41]);
  });

  it("keeps the full body of a finding it could not anchor inline", () => {
    const body = build([
      finding({ id: "c2", file: "src/consumer.ts", line: 900 }),
    ]);
    expect(body).toContain(
      "<summary>P0 · src/consumer.ts:900 · a subscription bearer stays inside a live container · outside the three-dot diff, so not inline</summary>",
    );
    expect(body).toContain("Fix src/consumer.ts:900 at cf811bc.");
  });

  it("collapses coverage, lanes and out-of-diff findings under one block", () => {
    const body = build(
      [
        finding({ id: "c1", status: "rejected" }),
        finding({
          id: "c2",
          line: 42,
          diffRelation: "untouched",
          evidenceStrength: "static",
        }),
      ],
      {
        coverage: { changedFiles: ["src/local.ts"], uncoveredFiles: [] },
        lanes: [
          {
            role: "reviewer",
            model: "anthropic/claude-sonnet-5",
            status: "completed",
          },
          {
            role: "reviewer",
            model: "openai/gpt-5.6-luna",
            status: "failed",
          },
          // A lane whose receipt file went missing records no model at all.
          { role: "reviewer", model: null, status: "completed" },
          {
            role: "verifier",
            model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
            status: "completed",
          },
        ],
        wallSeconds: 317,
      },
    );
    const coverage = body.slice(
      body.indexOf("<summary>Coverage</summary>"),
      body.lastIndexOf("</details>"),
    );
    expect(coverage).toContain(
      "1 changed file reviewed, 0 not reviewed · reviewers claude-sonnet-5 · 2 candidates: 2 verified in sandbox by deepseek-v4-flash-0731, 0 unverified, 1 rejected, 1 out-of-diff · 317 s",
    );
    expect(coverage).toContain(
      "- out-of-diff, confirmed on code this change neither adds, alters nor reaches, not published: `src/local.ts:42` - the teardown never removes the staged token",
    );
  });

  it("keeps a pre-existing defect the verifier reproduced in sight", () => {
    // 6797 carried a P1 reproduced by a sandbox test on a route the change
    // never touched; buried in the coverage block, nobody read it.
    const body = build([
      finding({
        id: "c3",
        severity: "P1",
        file: "src/other.ts",
        line: 239,
        diffRelation: "untouched",
        affectedBehavior: "a missing repository answers a generic 502",
      }),
    ]);
    const [, headlineLine] = body.split("\n");
    expect(headlineLine).toContain("Confidence 5/5");
    expect(headlineLine).toContain(
      "1 pre-existing defect verified by execution",
    );
    expect(body).toContain(
      "**Pre-existing, outside the score:** reproduced by the verifier",
    );
    expect(body).toContain(
      "| P1 | [src/other.ts:239](https://github.com/acme/demo/blob/cf811bc736a15f9af5cbe6014a7236f488181088/src/other.ts#L239) | a missing repository answers a generic 502 | reproduced in sandbox |",
    );
    expect(body).toContain("Fix src/other.ts:239 at cf811bc.");
    expect(body).not.toContain("- out-of-diff, confirmed on code");
    expect(body).not.toContain("No confirmed finding survived verification");
  });

  it("closes with the legend, the revisions and the run", () => {
    const body = build([]);
    expect(body.split("\n").at(-1)).toBe(
      "<sub>Confidence: 5 production ready · 4 minor polish · 3 implementation issues · 2 significant bugs · 0-1 critical problems. Computed from confirmed findings, never estimated by a model. Reviewed `cf811bc` against merge base `3d83c39` · run `swarm-1`</sub>",
    );
  });
});

describe("inline comment", () => {
  it("leads with the severity and the observed behavior, not the mechanism", () => {
    const body = findingBody(
      finding({
        affectedBehavior:
          "a subscription bearer stays inside a live container. Nothing revokes it.",
      }),
      receipt([]).requested.head,
    );
    const [first, blank, second] = body.split("\n");
    expect(first).toBe(
      "**P0** · a subscription bearer stays inside a live container",
    );
    expect(blank).toBe("");
    expect(second).toBe("the teardown never removes the staged token");
  });

  it("collapses evidence, verification and provenance under one details block", () => {
    const body = findingBody(finding(), receipt([]).requested.head);
    const details = body.slice(
      body.indexOf("<summary>Evidence and verification</summary>"),
      body.indexOf("</details>"),
    );
    expect(details).toContain("**Evidence:** local-receipt.json");
    expect(details).toContain(
      "**Verifier ran:** `bun --filter swarm-review test` (exit 0, in its sandbox clone of the head)",
    );
    expect(details).toContain("**Verifier:** reproduced against the receipt");
    expect(details).toContain(
      "<sub>c1 · confirmed · executable · reported by reviewer-1</sub>",
    );
    // GitHub renders markdown inside details only after a blank line.
    expect(body).toContain("</summary>\n\n");
  });

  it("ends with a fenced prompt naming the file, the head and the symptom", () => {
    const body = findingBody(finding(), receipt([]).requested.head);
    const prompt = body.slice(body.indexOf("```text"));
    expect(prompt).toContain("Fix src/local.ts:41 at cf811bc.");
    expect(prompt).toContain(
      "Symptom: a subscription bearer stays inside a live container",
    );
    expect(prompt).toContain(
      "Mechanism: the teardown never removes the staged token",
    );
    expect(prompt).not.toContain("bun --filter swarm-review test");
  });

  it("keeps the fix prompt fenced when the evidence carries a fence", () => {
    const body = findingBody(
      finding({ evidence: "the hunk reads\n```ts\nconst x = 1;\n```" }),
      receipt([]).requested.head,
    );
    const prompt = body.slice(body.indexOf("````text"));
    expect(prompt.startsWith("````text\nFix src/local.ts:41")).toBe(true);
    expect(prompt.trimEnd().endsWith("\n````\n</details>")).toBe(true);
  });

  it("omits the verifier lines when nothing was run", () => {
    const body = findingBody(
      finding({ verifierCommand: null, verifierReason: null }),
      receipt([]).requested.head,
    );
    expect(body).not.toContain("**Verifier");
  });
});

describe("headline", () => {
  it("takes the first sentence without its period", () => {
    expect(headline("The token leaks. Then it expires.")).toBe(
      "The token leaks",
    );
    expect(
      headline("Fails on tiny inputs, e.g. empty arrays. Then crashes."),
    ).toBe("Fails on tiny inputs, e.g. empty arrays");
    expect(headline("no period at all")).toBe("no period at all");
    expect(
      headline("Cache misses spike in the U.S. region. Then recover."),
    ).toBe("Cache misses spike in the U.S. region");
  });

  it("heads with the mechanism when the reviewer left the behavior empty", () => {
    const empty = finding({ affectedBehavior: "" });
    const body = findingBody(empty, receipt([]).requested.head);
    expect(body.split("\n")[0]).toBe(
      "**P0** · the teardown never removes the staged token",
    );
    expect(body).not.toContain("**Observed:**");
    expect(body).toContain(
      "Symptom: the teardown never removes the staged token",
    );
    const row = buildReview(
      receipt([empty]),
      commentableLines(diff),
      "acme/demo",
    )
      .body.split("\n")
      .find((line) => line.startsWith("| P0"));
    expect(row).toContain("| the teardown never removes the staged token |");
  });

  it("cuts a long sentence at a word boundary", () => {
    const long = `${"word ".repeat(40)}end.`;
    const cut = headline(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut).not.toMatch(/\s…$/);
  });
});

describe("publication disposition", () => {
  it("prefers the change's declared intent, then refuses code it never touches", () => {
    expect(
      publicationDisposition({ diffRelation: "added", declaredIntent: null }),
    ).toBe("publishable");
    expect(
      publicationDisposition({
        diffRelation: "touched",
        declaredIntent: null,
      }),
    ).toBe("publishable");
    expect(
      publicationDisposition({ diffRelation: null, declaredIntent: null }),
    ).toBe("publishable");
    expect(
      publicationDisposition({
        diffRelation: null,
        declaredIntent: "stays hidden while cards move",
      }),
    ).toBe("advisory");
    expect(
      publicationDisposition({
        diffRelation: "untouched",
        declaredIntent: null,
      }),
    ).toBe("out-of-diff");
    expect(
      publicationDisposition({
        diffRelation: "untouched",
        declaredIntent: "stays hidden while cards move",
      }),
    ).toBe("advisory");
  });
});

describe("publish options", () => {
  it("does not publish unless asked", () => {
    expect(
      parsePublishOptions(["--receipt", "/tmp/r.json", "--repo", "acme/demo"])
        .publish,
    ).toBe(false);
    expect(
      parsePublishOptions([
        "--receipt",
        "/tmp/r.json",
        "--repo",
        "acme/demo",
        "--publish",
      ]).publish,
    ).toBe(true);
  });

  it("requires a receipt", () => {
    expect(() => parsePublishOptions([])).toThrow("--receipt is required");
  });

  it("carries the target repository as a flag with no default", () => {
    expect(
      parsePublishOptions(["--receipt", "/tmp/r.json", "--repo", "acme/demo"])
        .repo,
    ).toBe("acme/demo");
    expect(() => parsePublishOptions(["--receipt", "/tmp/r.json"])).toThrow(
      "--repo is required",
    );
  });
});

describe("existing reviews", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supersedes only earlier swarm reviews that are not already marked", () => {
    const own = buildReview(
      receipt([finding()]),
      commentableLines(diff),
      "acme/demo",
    ).body;
    const marked = supersededBody(own, {
      swarmId: "swarm-2",
      head: "a".repeat(40),
      url: "https://github.com/acme/demo/pull/1#pullrequestreview-2",
    });
    const reviews = [
      { id: 1, body: own },
      { id: 2, body: "a human review" },
      { id: 3, body: null },
      { id: 4, body: marked },
    ];
    expect(supersededReviews(reviews).map((review) => review.id)).toEqual([1]);
    expect(marked.split("\n")[0]).toBe(
      "> Superseded by run `swarm-2` at `aaaaaaa`: https://github.com/acme/demo/pull/1#pullrequestreview-2",
    );
    // The original marker survives the edit, so the duplicate check for that
    // run and head still holds.
    expect(
      alreadyPublished(
        [{ body: marked }],
        "swarm-1",
        receipt([]).requested.head,
      ),
    ).toBe(true);
  });

  it("edits a review body with a PUT on the review", async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", upstream);

    await updateReviewBody("acme/demo", 7, 99, "token", "new body");

    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.github.com/repos/acme/demo/pulls/7/reviews/99",
    );
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "new body" });
  });

  it("reports a refused edit instead of hiding it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("not the author", { status: 403 })),
      ),
    );
    await expect(
      updateReviewBody("acme/demo", 7, 99, "token", "new body"),
    ).rejects.toThrow(/403: not the author/);
  });

  it("reads every page before deciding nothing was published yet", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ id: index, body: "other" })),
      [{ id: 100, body: "<!-- review-pi run=swarm-1 sha=abc -->" }],
    ];
    const upstream = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).includes("page=2") ? pages[1] : pages[0],
          ),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", upstream);

    const reviews = await fetchReviews("acme/demo", 1, "token");

    // A review sitting past the first page reads as "never published", and the
    // run posts a duplicate over it.
    expect(reviews).toHaveLength(101);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[0]?.[0])).toContain("per_page=100");
    expect(alreadyPublished(reviews, "swarm-1", "abc")).toBe(true);
  });
});
