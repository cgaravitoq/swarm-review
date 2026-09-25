import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparationFailureReceipt } from "../attempt";
import {
  alreadyPublished,
  assertPublishableReceipt,
  buildReview,
  commentableLines,
  fetchReviews,
  findingBody,
  githubReviewPayload,
  headline,
  main,
  parsePublishOptions,
  publicationDisposition,
  REVIEW_EVENT,
  REVIEW_SIDE,
  readRunNotes,
  refusalReason,
  revalidatePullRequest,
  reviewMarker,
  reviewScore,
  type SwarmReceipt,
  supersededBody,
  supersededReviews,
  updateIssueComment,
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
  it("marks a packed fork in Coverage", () => {
    const body = buildReview(
      receipt([]),
      new Map(),
      "acme/demo",
      "P2",
      true,
    ).body;
    expect(body).toContain("<summary>Coverage</summary>\n");
    expect(body).toContain("- fork reviewed with packed lanes");
    expect(buildReview(receipt([]), new Map(), "acme/demo").body).not.toContain(
      "fork reviewed",
    );
  });

  it("marks a runner that cannot run the sandbox image in Coverage", () => {
    const body = buildReview(
      receipt([]),
      new Map(),
      "acme/demo",
      "P2",
      false,
      "ARM64",
    ).body;
    expect(body).toContain("<summary>Coverage</summary>\n");
    expect(body).toContain(
      "- runner ARM64 cannot run the sandbox image: reviewed with packed lanes",
    );
    expect(buildReview(receipt([]), new Map(), "acme/demo").body).not.toContain(
      "cannot run the sandbox image",
    );
  });

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

  it("scores only a completed review, publishes a partial one and refuses a failed one", () => {
    const completed = receipt([finding()]);
    const expected = {
      head: completed.requested.head,
      mergeBase: completed.requested.base,
    };
    expect(reviewScore(completed)).toMatchObject({
      available: true,
      value: 1,
    });
    // What a partial review confirmed is real; what it did not find is not
    // evidence of absence, so the finding publishes and the number does not.
    expect(reviewScore({ ...completed, status: "partial" })).toMatchObject({
      available: false,
      reason: "partial review",
    });
    expect(() =>
      assertPublishableReceipt({ ...completed, status: "partial" }, expected),
    ).not.toThrow();
    expect(() =>
      assertPublishableReceipt({ ...completed, status: "failed" }, expected),
    ).toThrow(/completed or partial review/);
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

  it("says why a file too large for any lane was left out", () => {
    const body = build([finding({ id: "c1", severity: "P2" })], {
      coverage: {
        changedFiles: ["src/local.ts", "fixtures/corpus.json"],
        uncoveredFiles: ["fixtures/corpus.json"],
        unpackableFiles: [
          {
            file: "fixtures/corpus.json",
            diffBytes: 2_150_400,
            headBytes: 2_150_400,
            binary: false,
          },
        ],
      },
    });
    expect(body).toContain("- not reviewed: `fixtures/corpus.json`");
    expect(body).toContain(
      "- too large for one lane: `fixtures/corpus.json` (2100 KB of diff, 2100 KB at head)",
    );
  });

  it("says a binary was left out for what it is, not for its size", () => {
    const body = build([finding({ id: "c1", severity: "P2" })], {
      coverage: {
        changedFiles: ["src/local.ts", "assets/Inter-Regular.ttf"],
        uncoveredFiles: ["assets/Inter-Regular.ttf"],
        unpackableFiles: [
          {
            file: "assets/Inter-Regular.ttf",
            diffBytes: 120,
            headBytes: 341_888,
            binary: true,
          },
        ],
      },
    });
    expect(body).toContain("- not reviewed: `assets/Inter-Regular.ttf`");
    expect(body).toContain(
      "- binary, not read as text: `assets/Inter-Regular.ttf`",
    );
    expect(body).not.toContain("too large for one lane");
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

  it("names the angle a lane never finished, even when its files were covered", () => {
    const body = build([finding({ id: "c1", severity: "P2" })], {
      status: "partial",
      coverage: { changedFiles: ["src/local.ts"], uncoveredFiles: [] },
      lanes: [
        {
          laneId: "reviewer-1",
          role: "reviewer",
          model: "anthropic/claude-sonnet-5",
          status: "blocked",
          focus: "the changed code itself",
          blockerReason: "answer cut at 16384 output tokens",
        },
        {
          laneId: "reviewer-2",
          role: "reviewer",
          model: "openai/gpt-5.6-luna",
          status: "completed",
          focus: "the blast radius of the change",
        },
        {
          laneId: "verifier-1",
          role: "verifier",
          model: "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
          status: "completed",
        },
      ],
    });
    const [, headlineLine] = body.split("\n");

    expect(headlineLine).toBe(
      "**Confidence unavailable (partial review)** · 1 finding to fix · 0 advisories · 1 of 1 changed files with findings",
    );
    expect(body).toContain(
      "- reviewer lane did not finish: the changed code itself (claude-sonnet-5, blocked: answer cut at 16384 output tokens)",
    );
    expect(body).not.toContain("the blast radius of the change (");
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

  it("does not claim a sandbox for a verifier that read a pack", () => {
    const body = build([finding({ id: "c1" })], {
      lanes: [
        {
          role: "verifier",
          model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
          status: "completed",
        },
      ],
      verification: { mode: "packed" },
    });

    expect(body).toContain(
      "1 candidate: 1 verified by deepseek-v4-flash-0731, 0 unverified",
    );
    expect(body).not.toContain("verified in sandbox");
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

describe("run notes", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const notesFor = async (raw: string | null) => {
    const directory = await mkdtemp(join(tmpdir(), "review-pi-notes-"));
    directories.push(directory);
    const artifactRoot = join(directory, "swarm-1");
    if (raw !== null) await writeFile(`${artifactRoot}.run.json`, raw);
    return readRunNotes(artifactRoot);
  };

  it("reads the fork and the runner the action recorded", async () => {
    expect(await notesFor('{"fork":true,"packedRunner":"ARM64"}')).toEqual({
      fork: true,
      packedRunner: "ARM64",
    });
  });

  it("carries no note the action did not write", async () => {
    expect(await notesFor('{"fork":false}')).toEqual({ fork: false });
    expect(await notesFor(null)).toEqual({ fork: false });
    expect(await notesFor("not json")).toEqual({ fork: false });
  });
});

describe("moved head", () => {
  const head = "a".repeat(40);
  const later = "b".repeat(40);
  const base = "c".repeat(40);
  const expected = { head, mergeBase: base };
  const github = (status: "ahead" | "diverged", state = "open") =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const accept = String(
        (init?.headers as Record<string, string> | undefined)?.["accept"],
      );
      if (url.endsWith("/pulls/7")) {
        return Response.json({
          state,
          draft: false,
          merged: state === "merged",
          head: { sha: later },
          base: { sha: base },
        });
      }
      if (url.includes(`/compare/${head}...${later}`)) {
        return Response.json({ status });
      }
      if (url.includes(`/compare/${base}...${head}`)) {
        return accept.includes("diff")
          ? new Response("")
          : Response.json({ merge_base_commit: { sha: base } });
      }
      return Response.json([]);
    });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses a head that moved unless told the review may sit behind it", async () => {
    vi.stubGlobal("fetch", github("ahead"));
    await expect(
      revalidatePullRequest("acme/demo", 7, "t", expected),
    ).rejects.toThrow("pull request head moved off the frozen SHA");
  });

  it("publishes behind a head the reviewed commit is still under", async () => {
    const fetchMock = github("ahead");
    vi.stubGlobal("fetch", fetchMock);
    const validated = await revalidatePullRequest(
      "acme/demo",
      7,
      "t",
      expected,
      true,
    );
    expect(validated.pull.head.sha).toBe(later);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(`/compare/${head}...${later}`),
      ),
    ).toBe(true);
  });

  it("publishes on a change that merged with the reviewed commit in it, never on one closed unmerged", async () => {
    vi.stubGlobal("fetch", github("ahead", "merged"));
    await expect(
      revalidatePullRequest("acme/demo", 7, "t", expected, true),
    ).resolves.toMatchObject({ pull: { merged: true } });
    vi.stubGlobal("fetch", github("ahead", "closed"));
    await expect(
      revalidatePullRequest("acme/demo", 7, "t", expected, true),
    ).rejects.toThrow("pull request is closed, not open");
  });

  it("still refuses a head the reviewed commit was force-pushed out of", async () => {
    vi.stubGlobal("fetch", github("diverged"));
    await expect(
      revalidatePullRequest("acme/demo", 7, "t", expected, true),
    ).rejects.toThrow("pull request head moved off the frozen SHA");
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

describe("a run that publishes no review", () => {
  const head = "a".repeat(40);
  const base = "c".repeat(40);
  const later = "b".repeat(40);
  const env = {
    GITHUB_TOKEN: "token",
    GITHUB_RUN_ID: "4242",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/demo",
  };
  const runUrl = "https://github.com/acme/demo/actions/runs/4242";
  const marker = "<!-- swarm-review:run:4242 -->";
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.exitCode = 0;
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const publish = (
    receiptPath: string,
    runEnv: Record<string, string | undefined> = env,
    flags = ["--publish"],
  ) =>
    main(
      ["--receipt", receiptPath, "--repo", "acme/demo", "--pr", "7", ...flags],
      runEnv,
    );

  const issueRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("/issues/"));

  const artifactDirectory = async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-pi-refusal-"));
    directories.push(directory);
    const suiteDir = join(directory, "swarm-1");
    await mkdir(suiteDir, { recursive: true });
    return suiteDir;
  };

  const artifact = async (
    swarm: SwarmReceipt | ReturnType<typeof preparationFailureReceipt>,
    phases: { runId: string; phase: string; state: string }[] = [],
    notes: { fork?: boolean; packedRunner?: string } = {},
  ) => {
    const suiteDir = await artifactDirectory();
    const receiptPath = join(suiteDir, "swarm-receipt.json");
    await writeFile(receiptPath, JSON.stringify(swarm));
    await writeFile(`${suiteDir}.run.json`, JSON.stringify(notes));
    for (const phase of phases) {
      await mkdir(join(suiteDir, phase.runId), { recursive: true });
      await writeFile(
        join(suiteDir, phase.runId, "status.json"),
        JSON.stringify(phase),
      );
    }
    return receiptPath;
  };

  /** The artifact of a run that died before `swarm.ts` could write a receipt. */
  const artifactWithoutReceipt = async (failure?: {
    stage: string;
    message: string;
  }) => {
    const suiteDir = await artifactDirectory();
    if (failure) {
      await writeFile(join(suiteDir, "failure.json"), JSON.stringify(failure));
    }
    return join(suiteDir, "swarm-receipt.json");
  };

  const commentUrl =
    /^https:\/\/api\.github\.com\/repos\/acme\/demo\/issues\/comments\/(\d+)$/;

  const commentBody = (init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      Object.keys(parsed).join() === "body" &&
      typeof (parsed as { body: unknown }).body === "string"
      ? (parsed as { body: string }).body
      : null;
  };

  const bot = "github-actions[bot]";

  type Comment = { id: number; user: { login: string }; body: string };

  const github = ({
    moved = false,
    seeded = [] as Comment[],
    editable = true,
    viewerFails = false,
    reviews = [] as { id: number; body: string }[],
  } = {}) => {
    const comments: Comment[] = [...seeded];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const accept = String(
        (init?.headers as Record<string, string> | undefined)?.["accept"] ?? "",
      );
      if (url === "https://api.github.com/graphql") {
        return viewerFails
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : Response.json(
              { data: { viewer: { login: bot } } },
              { status: 200 },
            );
      }
      if (url.includes("/issues/comments/")) {
        const id = Number(commentUrl.exec(url)?.[1]);
        const comment = comments.find((entry) => entry.id === id);
        const deleting = method === "DELETE" && init?.body === undefined;
        const body = method === "PATCH" ? commentBody(init) : null;
        if (!comment || (!deleting && body === null)) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (!editable || comment.user.login !== bot) {
          return Response.json({ message: "Forbidden" }, { status: 403 });
        }
        if (deleting) {
          comments.splice(comments.indexOf(comment), 1);
          return new Response(null, { status: 204 });
        }
        comment.body = body ?? "";
        return Response.json(comment, { status: 200 });
      }
      if (url.includes("/issues/7/comments")) {
        if (method !== "POST") return Response.json(comments, { status: 200 });
        const body = commentBody(init);
        if (
          url !== "https://api.github.com/repos/acme/demo/issues/7/comments" ||
          body === null
        ) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        const comment = { id: comments.length + 1, user: { login: bot }, body };
        comments.push(comment);
        return Response.json(comment, { status: 201 });
      }
      if (url.includes("/pulls/7/reviews")) {
        return method === "POST"
          ? Response.json(
              {
                id: 9,
                html_url:
                  "https://github.com/acme/demo/pull/7#pullrequestreview-9",
              },
              { status: 201 },
            )
          : Response.json(reviews, { status: 200 });
      }
      if (url.endsWith("/pulls/7")) {
        return Response.json(
          {
            state: "open",
            draft: false,
            merged: false,
            head: { sha: moved ? later : head },
            base: { sha: base },
          },
          { status: 200 },
        );
      }
      if (accept.includes("diff")) return new Response(diff, { status: 200 });
      if (url.includes(`/compare/${head}...${later}`)) {
        return Response.json(
          { status: moved ? "diverged" : "ahead" },
          { status: 200 },
        );
      }
      return Response.json(
        { merge_base_commit: { sha: base } },
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, comments };
  };

  const failed = (): SwarmReceipt => ({
    swarmId: "swarm-1",
    status: "failed",
    requested: { head, base, pullRequest: 7 },
    findings: [],
    lanes: [
      {
        laneId: "reviewer-1",
        runId: "swarm-1-reviewer-1",
        role: "reviewer",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        status: "failed",
      },
    ],
  });

  const reviewing = `${marker}\n\n**swarm-review is reviewing** this pull request with \`packed\` lanes.`;

  /** Every request on an existing comment, as method, URL and body. */
  const commentRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/issues/comments/"))
      .map(([url, init]) => [
        (init as RequestInit | undefined)?.method,
        url,
        (init as RequestInit | undefined)?.body,
      ]);

  const completed = (): SwarmReceipt => ({
    swarmId: "swarm-1",
    status: "completed",
    requested: { head, base, pullRequest: 7 },
    findings: [],
  });

  it("comments the refusal and the phase the run died in, and still fails", async () => {
    const api = github();
    const receiptPath = await artifact(failed(), [
      { runId: "swarm-1-reviewer-1", phase: "install", state: "failed" },
    ]);

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(process.exitCode).toBe(1);
    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]?.body ?? "";
    expect(body).toContain(marker);
    expect(body).toContain(
      "publication requires a completed or partial review",
    );
    expect(body).toContain("`install` `failed`");
    expect(body).toContain(runUrl);
    expect(
      api.fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/pulls/7") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("posts no comment once the review is published", async () => {
    const api = github();
    const receiptPath = await artifact(completed());

    await expect(publish(receiptPath)).resolves.toBeUndefined();

    expect(api.comments).toEqual([]);
    expect(
      api.fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/pulls/7/reviews") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("deletes every comment the run opened once the review is published", async () => {
    const api = github({
      seeded: [
        { id: 30, user: { login: bot }, body: reviewing },
        { id: 31, user: { login: bot }, body: reviewing },
      ],
    });
    const receiptPath = await artifact(completed());

    await expect(publish(receiptPath)).resolves.toBeUndefined();

    expect(api.comments).toEqual([]);
    expect(commentRequests(api.fetchMock)).toEqual([
      [
        "DELETE",
        "https://api.github.com/repos/acme/demo/issues/comments/30",
        undefined,
      ],
      [
        "DELETE",
        "https://api.github.com/repos/acme/demo/issues/comments/31",
        undefined,
      ],
    ]);
  });

  it("turns one of the run's comments into the refusal and deletes the rest", async () => {
    const api = github({
      seeded: [
        { id: 30, user: { login: bot }, body: reviewing },
        { id: 31, user: { login: bot }, body: reviewing },
      ],
    });
    const receiptPath = await artifact(failed());

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(api.comments).toMatchObject([
      {
        id: 30,
        body: expect.stringContaining("**swarm-review published no review.**"),
      },
    ]);
    expect(
      commentRequests(api.fetchMock).map(([method, url]) => [method, url]),
    ).toEqual([
      ["PATCH", "https://api.github.com/repos/acme/demo/issues/comments/30"],
      ["DELETE", "https://api.github.com/repos/acme/demo/issues/comments/31"],
    ]);
  });

  it("keeps the published review when the run's comment cannot be deleted", async () => {
    const api = github({
      seeded: [{ id: 30, user: { login: bot }, body: reviewing }],
      editable: false,
    });
    const receiptPath = await artifact(completed());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publish(receiptPath)).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(
        /^run comment 30 not deleted: GitHub comment delete failed: 403/,
      ),
    );
    errors.mockRestore();
    expect(process.exitCode).toBe(0);
    expect(api.comments).toHaveLength(1);
  });

  it("logs a viewer lookup that failed instead of claiming silence", async () => {
    const api = github({ viewerFails: true });
    const receiptPath = await artifact(completed());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publish(receiptPath)).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(
      "viewer lookup failed, so the run's comment cannot be claimed: GitHub viewer request failed: 401",
    );
    errors.mockRestore();
    expect(api.comments).toEqual([]);
  });

  it("comments the stage and message the action recorded when no receipt was written", async () => {
    const api = github();
    const receiptPath = await artifactWithoutReceipt({
      stage: "image build",
      message: "docker build failed: exec /bin/sh: exec format error",
    });

    await expect(publish(receiptPath)).rejects.toThrow(
      "image build: docker build failed: exec /bin/sh: exec format error",
    );

    expect(process.exitCode).toBe(1);
    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]?.body ?? "";
    expect(body).toContain(
      "`image build: docker build failed: exec /bin/sh: exec format error`",
    );
    expect(body).not.toContain("ENOENT");
  });

  it("keeps the ENOENT when neither a receipt nor a failure was written", async () => {
    const api = github();
    const receiptPath = await artifactWithoutReceipt();

    await expect(publish(receiptPath)).rejects.toThrow("ENOENT");

    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]?.body).toContain("ENOENT");
  });

  it("tells an unreadable status.json from one that was never written", async () => {
    const api = github();
    const swarm = failed();
    swarm.lanes = [
      ...(swarm.lanes ?? []),
      {
        laneId: "reviewer-2",
        runId: "swarm-1-reviewer-2",
        role: "reviewer",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        status: "failed",
      },
    ];
    const receiptPath = await artifact(swarm);
    const runDir = join(dirname(receiptPath), "swarm-1-reviewer-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "status.json"), '{"phase":');

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    const body = api.comments[0]?.body ?? "";
    expect(body).toContain(
      "| `reviewer-1` | `failed` | unreadable status.json |",
    );
    expect(body).toContain("| `reviewer-2` | `failed` | no status.json |");
  });

  it("publishes the packed fork note the run recorded", async () => {
    const api = github();
    const receiptPath = await artifact(completed(), [], { fork: true });

    await publish(receiptPath);

    const request = api.fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/pulls/7/reviews") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const payload = JSON.parse(
      String((request?.[1] as RequestInit | undefined)?.body),
    ) as {
      body: string;
    };
    expect(payload.body).toContain("<summary>Coverage</summary>");
    expect(payload.body).toContain("- fork reviewed with packed lanes");
  });

  it("publishes both packed lane notes the run recorded", async () => {
    const api = github();
    const receiptPath = await artifact(completed(), [], {
      fork: true,
      packedRunner: "ARM64",
    });

    await publish(receiptPath);

    const request = api.fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/pulls/7/reviews") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const payload = JSON.parse(
      String((request?.[1] as RequestInit | undefined)?.body),
    ) as {
      body: string;
    };
    expect(payload.body).toContain("<summary>Coverage</summary>");
    expect(payload.body).toContain("- fork reviewed with packed lanes");
    expect(payload.body).toContain(
      "- runner ARM64 cannot run the sandbox image: reviewed with packed lanes",
    );
  });

  it("keeps one comment per run id and edits it on a re-run", async () => {
    const api = github();
    const receiptPath = await artifact(failed());
    const other = { ...env, GITHUB_RUN_ID: "5151" };

    for (const runEnv of [env, other, env, other]) {
      await expect(publish(receiptPath, runEnv)).rejects.toThrow(
        "publication requires a completed or partial review",
      );
    }

    expect(api.comments.map((comment) => comment.body.split("\n")[0])).toEqual([
      marker,
      "<!-- swarm-review:run:5151 -->",
    ]);
    const methods = issueRequests(api.fetchMock).map(
      ([, init]) => (init as RequestInit | undefined)?.method ?? "GET",
    );
    expect(methods.filter((method) => method === "POST")).toHaveLength(2);
    const edits = issueRequests(api.fetchMock).filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(edits.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/acme/demo/issues/comments/1",
      "https://api.github.com/repos/acme/demo/issues/comments/2",
    ]);
    await expect(
      updateIssueComment("acme/demo", 99, "token", "body"),
    ).rejects.toThrow("GitHub comment update failed: 404");
  });

  it("keeps a marker a lane wrote from claiming another run's comment", async () => {
    const api = github();
    const receiptPath = await artifact(failed(), [
      {
        runId: "swarm-1-reviewer-1",
        phase: `install ${marker}`,
        state: `failed ${marker}`,
      },
    ]);
    const lane = { ...env, GITHUB_RUN_ID: "777" };

    await expect(publish(receiptPath, lane)).rejects.toThrow(
      "publication requires a completed or partial review",
    );
    const planted = api.comments[0]?.body ?? "";
    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(planted).not.toContain(marker);
    expect(api.comments.map((comment) => comment.body.split("\n")[0])).toEqual([
      "<!-- swarm-review:run:777 -->",
      marker,
    ]);
    expect(api.comments[0]?.body).toBe(planted);
    expect(
      issueRequests(api.fetchMock).filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toHaveLength(0);
  });

  it("renders every lane-written field as inert text", async () => {
    const api = github();
    const image = "![x](https://evil.example/t.png) [d](https://evil.example)";
    const long = `${"a".repeat(79)}|tail`;
    const swarm = failed();
    swarm.lanes = [
      ...(swarm.lanes ?? []),
      {
        laneId: "reviewer-2",
        runId: "swarm-1-reviewer-2",
        role: "reviewer",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        status: "failed",
      },
    ];
    const receiptPath = await artifact(swarm, [
      { runId: "swarm-1-reviewer-1", phase: "install", state: image },
      { runId: "swarm-1-reviewer-2", phase: "install", state: long },
    ]);

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    const body = api.comments[0]?.body ?? "";
    expect(body).toContain(`| \`install\` \`${image}\` |`);
    expect(body).toContain(`| \`install\` \`${"a".repeat(79)}\\|\` |`);
  });

  it("keeps a refusal from carrying a comment marker", () => {
    expect(refusalReason(new Error(`no receipt ${marker}`))).not.toContain(
      "<!--",
    );
  });

  it("posts its own comment beside another author's that carries its marker", async () => {
    const forged = {
      id: 50,
      user: { login: "mallory" },
      body: `${marker}\n\nforged`,
    };
    const api = github({ seeded: [{ ...forged }] });
    const receiptPath = await artifact(failed());

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(api.comments[0]).toEqual(forged);
    expect(api.comments.slice(1)).toMatchObject([
      {
        user: { login: bot },
        body: expect.stringMatching(/^<!-- swarm-review:run:4242 -->\n/),
      },
    ]);
    expect(
      api.fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/issues/comments/"),
      ),
    ).toHaveLength(0);
  });

  it("claims only a comment its marker opens", async () => {
    const quoting = {
      id: 50,
      user: { login: bot },
      body: `a note quoting ${marker}\nnothing more`,
    };
    const api = github({ seeded: [{ ...quoting }] });
    const receiptPath = await artifact(failed());

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(api.comments[0]).toEqual(quoting);
    expect(api.comments.slice(1)).toMatchObject([
      {
        user: { login: bot },
        body: expect.stringMatching(/^<!-- swarm-review:run:4242 -->\n/),
      },
    ]);
  });

  it("posts a fresh comment when its own comment refuses the edit", async () => {
    const own = { id: 50, user: { login: bot }, body: `${marker}\n\nold` };
    const api = github({ seeded: [{ ...own }], editable: false });
    const receiptPath = await artifact(failed());

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(api.comments[0]).toEqual(own);
    expect(api.comments.slice(1)).toMatchObject([
      {
        user: { login: bot },
        body: expect.stringContaining(
          "publication requires a completed or partial review",
        ),
      },
    ]);
  });

  it("keeps the refusal when the receipt's lanes cannot be read", async () => {
    const api = github();
    const receiptPath = await artifact({
      ...failed(),
      lanes: [null as never],
    });

    await expect(publish(receiptPath)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(process.exitCode).toBe(1);
    expect(api.comments).toEqual([]);
  });

  it("leaves the pull request alone on a dry run", async () => {
    const api = github();
    const receiptPath = await artifact(failed());

    await expect(publish(receiptPath, env, [])).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(process.exitCode).toBe(1);
    expect(api.comments).toEqual([]);
    expect(issueRequests(api.fetchMock)).toHaveLength(0);
  });

  it("posts no comment without a workflow run to name", async () => {
    const api = github();
    const receiptPath = await artifact(failed());
    const { GITHUB_RUN_ID: _, ...anonymous } = env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publish(receiptPath, anonymous)).rejects.toThrow(
      "publication requires a completed or partial review",
    );

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(api.comments).toEqual([]);
    expect(issueRequests(api.fetchMock)).toHaveLength(0);
  });

  const preparationFailed = (message: string) =>
    preparationFailureReceipt(
      { attemptId: "attempt-1", startedAt: Date.now(), path: "attempt.json" },
      "object-fetch",
      new Error(message),
      {
        swarmId: "swarm-1",
        requested: { head: null, base: null, pullRequest: 7 },
      },
    );

  it("comments the failure of a run that never reached its lanes", async () => {
    const api = github();
    const receiptPath = await artifact(
      preparationFailed("git fetch exited 128: repository not found"),
    );

    await expect(publish(receiptPath)).rejects.toThrow(
      "object-fetch: git fetch exited 128: repository not found",
    );

    expect(process.exitCode).toBe(1);
    expect(
      issueRequests(api.fetchMock).filter(
        ([url, init]) =>
          url === "https://api.github.com/repos/acme/demo/issues/7/comments" &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(api.comments).toHaveLength(1);
    expect(api.comments[0]?.body.split("\n")[2]).toBe(
      "**swarm-review published no review.** `object-fetch: git fetch exited 128: repository not found`",
    );
  });

  it("renders a preparation failure's message as inert text", async () => {
    const api = github();
    const receiptPath = await artifact(
      preparationFailed(`bad \`ref\` ${marker}`),
    );

    await expect(publish(receiptPath)).rejects.toThrow("object-fetch: bad");

    const reason = api.comments[0]?.body.split("\n")[2] ?? "";
    expect(reason).toContain(
      "object-fetch: bad 'ref' ‹!-- swarm-review:run:4242 --",
    );
    expect(reason).not.toContain("<!--");
    expect(reason.match(/`/g)).toHaveLength(2);
  });

  it("deletes the run's comment when its review is already on the pull request", async () => {
    const api = github({
      seeded: [{ id: 30, user: { login: bot }, body: reviewing }],
      reviews: [
        {
          id: 3,
          body: `${reviewMarker("swarm-1", head)}\nearlier review`,
        },
      ],
    });
    const receiptPath = await artifact(completed());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publish(receiptPath)).resolves.toBeUndefined();

    errors.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(
      api.fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/pulls/7/reviews") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
    expect(api.comments).toEqual([]);
    expect(commentRequests(api.fetchMock)).toEqual([
      [
        "DELETE",
        "https://api.github.com/repos/acme/demo/issues/comments/30",
        undefined,
      ],
    ]);
  });

  it("comments a head that moved off the frozen SHA", async () => {
    const api = github({ moved: true });
    const receiptPath = await artifact(completed());

    await expect(publish(receiptPath)).rejects.toThrow(
      "pull request head moved off the frozen SHA",
    );

    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]?.body ?? "";
    expect(body).toContain("pull request head moved off the frozen SHA");
    expect(body).toContain(runUrl);
  });
});
