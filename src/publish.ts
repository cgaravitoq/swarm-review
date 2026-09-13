/**
 * Turns one swarm receipt into one GitHub pull request review.
 *
 * Only confirmed findings this change introduced and did not declare are
 * publishable as defects. A finding the change's own body declares as intended
 * is published as an advisory, one on code the change never touches is kept
 * out of the review as out-of-diff, and unverified and rejected candidates stay
 * in the receipt. Comments attach to the GitHub three-dot diff
 * (merge-base...head) on side RIGHT at the frozen head SHA. The GitHub
 * credential stays on the host. Publishing is opt-in.
 */

import { readFile } from "node:fs/promises";

export const REVIEW_EVENT = "COMMENT" as const;
export const REVIEW_SIDE = "RIGHT" as const;

const CONFIDENCE_BY_SEVERITY = { P0: 1, P1: 2, P2: 3, P3: 4 } as const;

const CONFIDENCE_LABELS = [
  "Critical problems",
  "Critical problems",
  "Significant bugs",
  "Implementation issues",
  "Minor polish",
  "Production ready",
] as const;

export const CONFIDENCE_LEGEND =
  "Confidence: 5 production ready · 4 minor polish · 3 implementation issues · 2 significant bugs · 0-1 critical problems. Computed from confirmed findings, never estimated by a model.";

/**
 * The severity a finding the change declares as intended is published at.
 *
 * A declared behavior is not a defect to fix, so it never lowers the
 * confidence; it is still published, labelled advisory, because a reviewer has
 * to be able to read what the change meant to do.
 */
export const ADVISORY_SEVERITY = "P3";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** How a change relates to the mechanism a confirmed finding describes. */
export type DiffRelation = "added" | "touched" | "untouched";

/** What publication does with one confirmed finding. */
export type PublicationDisposition = "publishable" | "advisory" | "out-of-diff";

/**
 * The rule that decides what a confirmed finding is worth publishing.
 *
 * The verifier confirms that a mechanism exists; these two fields say whether
 * this change is the reason. A behavior the change's own body declares as
 * intended is an advisory, never a defect. A mechanism on a line the change
 * neither adds, alters nor reaches predates the change, so publishing it would
 * charge this pull request for someone else's defect. Everything else is
 * published exactly as before.
 */
export const publicationDisposition = (finding: {
  diffRelation: string | null;
  declaredIntent: string | null;
}): PublicationDisposition =>
  finding.declaredIntent
    ? "advisory"
    : finding.diffRelation === "untouched"
      ? "out-of-diff"
      : "publishable";

type Finding = {
  id: string;
  severity: string;
  file: string;
  line: number;
  mechanism: string;
  evidence: string;
  affectedBehavior: string;
  status: string;
  evidenceStrength: string;
  reportedBy: string[];
  verifierReason: string | null;
  verifierCommand: string | null;
  verifierExitStatus: number | null;
  /** How this change relates to the mechanism, as the verifier ruled. */
  diffRelation: DiffRelation | null;
  /** The change's own sentence declaring that behavior, copied verbatim. */
  declaredIntent: string | null;
  /** What publication did with it; recomputed here, never trusted from the receipt. */
  publication?: PublicationDisposition;
};

export type SwarmReceipt = {
  swarmId: string;
  status: string;
  requested: { head: string; base: string; pullRequest: number | null };
  findings: Finding[];
  coverage?: { changedFiles: string[]; uncoveredFiles: string[] };
  lanes?: { role: string; model: string | null; status: string }[];
  wallSeconds?: number;
};

/**
 * What a review is anchored to.
 *
 * The merge base, not the destination tip: the tip moves every time anything
 * lands on the base branch, while the merge base is what the three-dot diff -
 * and therefore the review - was actually computed from.
 */
export type ExpectedRevisions = {
  head: string;
  mergeBase: string;
};

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

export function parsePublishOptions(argv: string[]) {
  const receiptPath = flag(argv, "receipt");
  if (!receiptPath) throw new Error("--receipt is required");
  const repo = flag(argv, "repo");
  if (!repo) throw new Error("--repo is required");
  const pullRequest = flag(argv, "pr");
  const expectedHead = flag(argv, "expected-head");
  const expectedMergeBase = flag(argv, "expected-merge-base");
  return {
    receiptPath,
    repo,
    ...(pullRequest ? { pullRequest: Number(pullRequest) } : {}),
    ...(expectedHead ? { expectedHead } : {}),
    ...(expectedMergeBase ? { expectedMergeBase } : {}),
    publish: argv.includes("--publish"),
    minSeverity: flag(argv, "min-severity") ?? "P2",
  };
}

const REVIEW_MARKER_PREFIX = "<!-- review-pi run=";

export const reviewMarker = (swarmId: string, head: string) =>
  `${REVIEW_MARKER_PREFIX}${swarmId} sha=${head} -->`;

const SUPERSEDED_PREFIX = "> Superseded by run ";

/**
 * Earlier swarm reviews on the pull request, found by the marker every run
 * writes. One already marked superseded stays as it is: its header names the
 * run that replaced it, and that is still true.
 */
export const supersededReviews = <Review extends { body?: string | null }>(
  reviews: readonly Review[],
) =>
  reviews.filter(
    (review) =>
      (review.body ?? "").includes(REVIEW_MARKER_PREFIX) &&
      !(review.body ?? "").startsWith(SUPERSEDED_PREFIX),
  );

export const supersededBody = (
  body: string,
  by: { swarmId: string; head: string; url: string },
) =>
  `${SUPERSEDED_PREFIX}\`${by.swarmId}\` at \`${by.head.slice(0, 7)}\`: ${by.url}\n\n${body}`;

/**
 * The lines a review can anchor a comment to.
 *
 * GitHub accepts an inline comment only on a line the three-dot diff touches,
 * so the unified diff's added and context lines on the new side (RIGHT) are
 * the whole of what is addressable.
 */
export function commentableLines(unifiedDiff: string) {
  const byFile = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const raw of unifiedDiff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file && !byFile.has(file)) byFile.set(file, new Set());
      continue;
    }
    if (raw.startsWith("@@")) {
      const hunk = /\+(\d+)/.exec(raw);
      line = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (!file || line === 0) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      byFile.get(file)?.add(line);
      line += 1;
    }
  }
  return byFile;
}

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

const atLeast = (severity: string, minimum: string) => {
  const rank = SEVERITY_ORDER.indexOf(
    severity as (typeof SEVERITY_ORDER)[number],
  );
  const floor = SEVERITY_ORDER.indexOf(
    minimum as (typeof SEVERITY_ORDER)[number],
  );
  return rank !== -1 && floor !== -1 && rank <= floor;
};

const HEADLINE_LIMIT = 160;

/**
 * The first sentence of a text, cut at a word boundary when it runs long.
 *
 * A single letter before the period ("e.g.", "U.S.") does not end a sentence.
 * The trailing period is dropped because the result heads a comment.
 */
export const headline = (text: string) => {
  const trimmed = text.trim();
  const sentence = (
    /^[\s\S]*?(?<!\b[A-Za-z])[.!?](?=\s|$)/.exec(trimmed)?.[0] ?? trimmed
  ).replace(/\.$/, "");
  if (sentence.length <= HEADLINE_LIMIT) return sentence;
  return `${sentence.slice(0, HEADLINE_LIMIT).replace(/\s+\S*$/, "")}…`;
};

const shortSha = (sha: string) => sha.slice(0, 7);

/** A fence one backtick longer than any run inside keeps the block closed. */
const fenced = (lines: string[], info: string) => {
  const longest = Math.max(
    2,
    ...lines.flatMap((line) =>
      (line.match(/`+/g) ?? []).map((run) => run.length),
    ),
  );
  const fence = "`".repeat(longest + 1);
  return [`${fence}${info}`, ...lines, fence];
};

/** A reviewer may leave the observed behavior empty; the mechanism then heads. */
const symptom = (finding: Finding) =>
  headline(finding.affectedBehavior || finding.mechanism);

/** The verifier's command is reported as what it ran, never as a repro. */
const verifierLines = (finding: Finding) => {
  const lines: string[] = [];
  if (finding.verifierCommand) {
    lines.push(
      `**Verifier ran:** \`${finding.verifierCommand}\` (exit ${finding.verifierExitStatus ?? "unknown"}, in its sandbox clone of the head)`,
    );
  }
  if (finding.verifierReason) {
    lines.push(`**Verifier:** ${finding.verifierReason}`);
  }
  return lines;
};

/**
 * One finding as an inline comment: the symptom as a headline, the mechanism
 * as the paragraph, the evidence and verification collapsed, and a prompt an
 * agent can be handed to fix it.
 */
export const findingBody = (finding: Finding, head: string) => {
  return [
    `**${finding.severity}** · ${symptom(finding)}`,
    "",
    finding.mechanism,
    "",
    "<details>",
    "<summary>Evidence and verification</summary>",
    "",
    ...(finding.affectedBehavior
      ? [`**Observed:** ${finding.affectedBehavior}`]
      : []),
    `**Evidence:** ${finding.evidence}`,
    ...verifierLines(finding),
    "",
    `<sub>${finding.id} · ${finding.status} · ${finding.evidenceStrength} · reported by ${finding.reportedBy.join(", ")}</sub>`,
    "</details>",
    "",
    "<details>",
    "<summary>Prompt to fix with an agent</summary>",
    "",
    ...fenced(
      [
        `Fix ${finding.file}:${finding.line} at ${shortSha(head)}.`,
        `Symptom: ${finding.affectedBehavior || finding.mechanism}`,
        `Mechanism: ${finding.mechanism}`,
        `Evidence: ${finding.evidence}`,
        "Done when the symptom no longer occurs and a test pins it.",
      ],
      "text",
    ),
    "</details>",
  ].join("\n");
};

/**
 * Merge confidence 0-5 on Greptile's legend, computed from the worst confirmed
 * publishable severity so two runs that verify the same things print the same
 * number and a reader can recompute it from the findings table.
 */
export function reviewScore(receipt: SwarmReceipt) {
  if (receipt.status !== "completed") {
    return {
      available: false as const,
      reason: "partial_or_failed" as const,
      legend: CONFIDENCE_LEGEND,
    };
  }
  // An advisory is the change's own declared intent and an out-of-diff finding
  // is not this change's defect, so neither is risk this pull request carries.
  const confirmed = receipt.findings.filter(
    (finding) =>
      finding.status === "confirmed" &&
      publicationDisposition(finding) === "publishable",
  );
  const ranks = confirmed
    .map((finding) =>
      SEVERITY_ORDER.indexOf(
        finding.severity as (typeof SEVERITY_ORDER)[number],
      ),
    )
    .filter((rank) => rank !== -1)
    .sort((a, b) => a - b);
  const worst = ranks[0] === undefined ? undefined : SEVERITY_ORDER[ranks[0]];
  const critical = confirmed.filter(
    (finding) => finding.severity === "P0",
  ).length;
  const value =
    worst === undefined
      ? 5
      : worst === "P0" && critical > 1
        ? 0
        : CONFIDENCE_BY_SEVERITY[worst];
  return {
    available: true as const,
    value,
    label: CONFIDENCE_LABELS[value],
    legend: CONFIDENCE_LEGEND,
  };
}

export function assertPublishableReceipt(
  receipt: SwarmReceipt,
  expected: ExpectedRevisions,
) {
  if (!FULL_SHA.test(receipt.requested.head)) {
    throw new Error("receipt head must be a full SHA");
  }
  if (!FULL_SHA.test(receipt.requested.base)) {
    throw new Error("receipt base must be a full SHA");
  }
  if (receipt.requested.head !== expected.head) {
    throw new Error("receipt head does not match the frozen head");
  }
  if (receipt.requested.base !== expected.mergeBase) {
    throw new Error("receipt base does not match the frozen merge base");
  }
  if (receipt.status !== "completed") {
    throw new Error("publication requires a completed review");
  }
  for (const [index, finding] of receipt.findings.entries()) {
    if (
      finding.status !== "confirmed" &&
      finding.status !== "rejected" &&
      finding.status !== "unverified"
    ) {
      throw new Error(`findings[${index}] has an unpublished status`);
    }
    if (
      !SEVERITY_ORDER.includes(
        finding.severity as (typeof SEVERITY_ORDER)[number],
      )
    ) {
      throw new Error(`findings[${index}] has an unknown severity`);
    }
  }
}

const count = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`;

const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|");

const blobLink = (repo: string, head: string, finding: Finding) =>
  `[${finding.file}:${finding.line}](https://github.com/${repo}/blob/${head}/${finding.file}#L${finding.line})`;

const proof = (finding: Finding) =>
  finding.declaredIntent
    ? `declared: "${finding.declaredIntent}"`
    : finding.evidenceStrength === "executable"
      ? "reproduced in sandbox"
      : finding.evidenceStrength === "static"
        ? "read in source"
        : finding.evidenceStrength;

const bySeverity = (a: Finding, b: Finding) =>
  SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
  SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]);

const modelName = (model: string) => model.slice(model.lastIndexOf("/") + 1);

const coverageLine = (
  receipt: SwarmReceipt,
  counts: { unverified: number; rejected: number; outOfDiff: number },
) => {
  const parts: string[] = [];
  if (receipt.coverage) {
    parts.push(
      `${count(receipt.coverage.changedFiles.length, "changed file")} reviewed, ${receipt.coverage.uncoveredFiles.length} not reviewed`,
    );
  }
  const models = (role: string) => [
    ...new Set(
      (receipt.lanes ?? [])
        .filter((lane) => lane.role === role && lane.status === "completed")
        .flatMap((lane) => (lane.model ? [modelName(lane.model)] : [])),
    ),
  ];
  const reviewers = models("reviewer");
  if (reviewers.length > 0) parts.push(`reviewers ${reviewers.join(", ")}`);
  const verifiers = models("verifier");
  const verified = receipt.findings.length - counts.unverified;
  parts.push(
    `${count(receipt.findings.length, "candidate")}: ${verified} verified${verifiers.length > 0 ? ` in sandbox by ${verifiers.join(", ")}` : ""}, ${counts.unverified} unverified, ${counts.rejected} rejected, ${counts.outOfDiff} out-of-diff`,
  );
  if (receipt.wallSeconds !== undefined) parts.push(`${receipt.wallSeconds} s`);
  return parts.join(" · ");
};

/**
 * Splits confirmed findings into anchored inline comments, summary-only ones,
 * advisories the change declared as intended, and out-of-diff findings that
 * were never published. Unverified and rejected candidates are counted, never
 * posted.
 */
export function buildReview(
  receipt: SwarmReceipt,
  commentable: Map<string, Set<number>>,
  repo: string,
  minSeverity = "P2",
) {
  const head = receipt.requested.head;
  const comments: {
    path: string;
    line: number;
    side: typeof REVIEW_SIDE;
    body: string;
  }[] = [];
  const published: Finding[] = [];
  const unanchored: Finding[] = [];
  const advisories: Finding[] = [];
  const outOfDiff: Finding[] = [];
  for (const finding of receipt.findings) {
    if (finding.status !== "confirmed") continue;
    const disposition = publicationDisposition(finding);
    if (disposition === "out-of-diff") {
      outOfDiff.push(finding);
      continue;
    }
    if (disposition === "advisory") {
      advisories.push(finding);
      continue;
    }
    if (!atLeast(finding.severity, minSeverity)) continue;
    published.push(finding);
    if (commentable.get(finding.file)?.has(finding.line)) {
      comments.push({
        path: finding.file,
        line: finding.line,
        side: REVIEW_SIDE,
        body: findingBody(finding, head),
      });
    } else {
      unanchored.push(finding);
    }
  }

  const unverified = receipt.findings.filter(
    (finding) => finding.status === "unverified",
  ).length;
  const rejected = receipt.findings.filter(
    (finding) => finding.status === "rejected",
  ).length;
  const score = reviewScore(receipt);
  const files = new Set(
    [...published, ...advisories].map((finding) => finding.file),
  );
  const headlineParts = [
    score.available
      ? `**Confidence ${score.value}/5 · ${score.label}**`
      : `**Confidence unavailable (${score.reason})**`,
    count(published.length, "finding to fix", "findings to fix"),
    count(advisories.length, "advisory", "advisories"),
    receipt.coverage
      ? `${files.size} of ${receipt.coverage.changedFiles.length} changed files with findings`
      : count(files.size, "file with findings", "files with findings"),
  ];
  const preExisting = outOfDiff.filter(
    (finding) => finding.evidenceStrength === "executable",
  );
  if (preExisting.length > 0) {
    headlineParts.push(
      `${count(preExisting.length, "pre-existing defect")} verified by execution`,
    );
  }
  if (unverified > 0) {
    headlineParts.push(`${count(unverified, "candidate")} unverified`);
  }
  if (receipt.coverage && receipt.coverage.uncoveredFiles.length > 0) {
    headlineParts.push(
      `${count(receipt.coverage.uncoveredFiles.length, "file")} not reviewed`,
    );
  }
  const summary = [
    reviewMarker(receipt.swarmId, head),
    headlineParts.join(" · "),
    "",
  ];
  const rows = [...published.sort(bySeverity), ...advisories];
  if (rows.length > 0) {
    summary.push(
      "| Sev | Where | What | Proof |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (finding) =>
          `| ${finding.severity} | ${blobLink(repo, head, finding)} | ${cell(symptom(finding))} | ${cell(proof(finding))} |`,
      ),
      "",
    );
  } else if (outOfDiff.length === 0) {
    summary.push("No confirmed finding survived verification.", "");
  }
  for (const finding of unanchored) {
    summary.push(
      "<details>",
      `<summary>${finding.severity} · ${finding.file}:${finding.line} · ${cell(symptom(finding))} · outside the three-dot diff, so not inline</summary>`,
      "",
      findingBody(finding, head),
      "</details>",
      "",
    );
  }
  // A defect the verifier reproduced on code this change never touches is not
  // this pull request's to carry, but it is the best-evidenced thing the run
  // found, so it stays in sight rather than in the coverage block.
  if (preExisting.length > 0) {
    summary.push(
      "**Pre-existing, outside the score:** reproduced by the verifier on code this change neither adds, alters nor reaches.",
      "",
      "| Sev | Where | What | Proof |",
      "| --- | --- | --- | --- |",
      ...preExisting.map(
        (finding) =>
          `| ${finding.severity} | ${blobLink(repo, head, finding)} | ${cell(symptom(finding))} | ${cell(proof(finding))} |`,
      ),
      "",
      ...preExisting.flatMap((finding) => [
        "<details>",
        `<summary>${finding.severity} · ${finding.file}:${finding.line} · ${cell(symptom(finding))} · pre-existing</summary>`,
        "",
        findingBody(finding, head),
        "</details>",
        "",
      ]),
    );
  }
  summary.push(
    "<details>",
    "<summary>Coverage</summary>",
    "",
    coverageLine(receipt, {
      unverified,
      rejected,
      outOfDiff: outOfDiff.length,
    }),
  );
  if (receipt.coverage && receipt.coverage.uncoveredFiles.length > 0) {
    summary.push(
      `- not reviewed: ${receipt.coverage.uncoveredFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  for (const finding of outOfDiff) {
    if (preExisting.includes(finding)) continue;
    summary.push(
      `- out-of-diff, confirmed on code this change neither adds, alters nor reaches, not published: \`${finding.file}:${finding.line}\` - ${finding.mechanism}`,
    );
  }
  summary.push(
    "</details>",
    "",
    `<sub>${score.legend} Reviewed \`${shortSha(head)}\` against merge base \`${shortSha(receipt.requested.base)}\` · run \`${receipt.swarmId}\`</sub>`,
  );

  return {
    commit_id: head,
    body: summary.join("\n"),
    event: REVIEW_EVENT,
    comments,
    score,
  };
}

export function githubReviewPayload(review: ReturnType<typeof buildReview>) {
  return {
    commit_id: review.commit_id,
    body: review.body,
    event: review.event,
    comments: review.comments,
  };
}

export function alreadyPublished(
  reviews: readonly { body?: string | null }[],
  swarmId: string,
  head: string,
) {
  const marker = reviewMarker(swarmId, head);
  return reviews.some((review) => (review.body ?? "").includes(marker));
}

const githubHeaders = (token: string, accept: string) => ({
  authorization: `Bearer ${token}`,
  accept,
  "user-agent": "review-pi",
});

/** Destination tip, merge-base, and HEAD of an open pull request. */
export async function fetchPullRevisions(
  repo: string,
  pullRequest: number,
  token: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${pullRequest}`,
    { headers: githubHeaders(token, "application/vnd.github+json") },
  );
  if (!response.ok) {
    throw new Error(`GitHub pull request request failed: ${response.status}`);
  }
  return (await response.json()) as {
    state: string;
    draft: boolean;
    head: { sha: string };
    base: { sha: string };
  };
}

export async function fetchMergeBase(
  repo: string,
  base: string,
  head: string,
  token: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/compare/${base}...${head}`,
    { headers: githubHeaders(token, "application/vnd.github+json") },
  );
  if (!response.ok) {
    throw new Error(`GitHub three-dot compare failed: ${response.status}`);
  }
  const compared = (await response.json()) as {
    merge_base_commit: { sha: string };
  };
  return compared.merge_base_commit.sha;
}

/** GitHub three-dot diff (merge-base...head), the surface comments attach to. */
export async function fetchThreeDotDiff(
  repo: string,
  base: string,
  head: string,
  token: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/compare/${base}...${head}`,
    { headers: githubHeaders(token, "application/vnd.github.v3.diff") },
  );
  if (!response.ok) {
    throw new Error(`GitHub three-dot diff request failed: ${response.status}`);
  }
  return response.text();
}

/**
 * Every review on the pull request, not just the first page.
 *
 * A missed page reads as "never published", and the run would post its own
 * review a second time.
 */
export async function fetchReviews(
  repo: string,
  pullRequest: number,
  token: string,
) {
  const reviews: { id: number; body?: string | null }[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${pullRequest}/reviews?per_page=100&page=${page}`,
      { headers: githubHeaders(token, "application/vnd.github+json") },
    );
    if (!response.ok) {
      throw new Error(`GitHub reviews request failed: ${response.status}`);
    }
    const batch = (await response.json()) as {
      id: number;
      body?: string | null;
    }[];
    reviews.push(...batch);
    if (batch.length < 100) return reviews;
  }
}

export async function revalidatePullRequest(
  repo: string,
  pullRequest: number,
  token: string,
  expected: ExpectedRevisions,
) {
  if (!FULL_SHA.test(expected.head) || !FULL_SHA.test(expected.mergeBase)) {
    throw new Error("expected revisions must be full SHAs");
  }
  const pull = await fetchPullRevisions(repo, pullRequest, token);
  if (pull.state !== "open") {
    throw new Error(`pull request is ${pull.state}, not open`);
  }
  if (pull.head.sha !== expected.head) {
    throw new Error("pull request head moved off the frozen SHA");
  }
  // The destination tip is read live and deliberately not frozen: anything
  // landing on the base branch moves it without touching this change. What has
  // to hold is the merge base, because that is what the reviewed diff was cut
  // from.
  const mergeBase = await fetchMergeBase(
    repo,
    pull.base.sha,
    expected.head,
    token,
  );
  if (mergeBase !== expected.mergeBase) {
    throw new Error("pull request merge-base moved off the frozen SHA");
  }
  const reviews = await fetchReviews(repo, pullRequest, token);
  const diff = await fetchThreeDotDiff(
    repo,
    expected.mergeBase,
    expected.head,
    token,
  );
  return { pull, mergeBase, diff, reviews };
}

export async function postReview(
  repo: string,
  pullRequest: number,
  token: string,
  review: ReturnType<typeof githubReviewPayload>,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${pullRequest}/reviews`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token, "application/vnd.github+json"),
        "content-type": "application/json",
      },
      body: JSON.stringify(review),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub review request failed: ${response.status}: ${text}`,
    );
  }
  return JSON.parse(text) as { id: number; html_url: string };
}

/** Only the review's author may edit it; every run publishes as the same user. */
export async function updateReviewBody(
  repo: string,
  pullRequest: number,
  reviewId: number,
  token: string,
  body: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${pullRequest}/reviews/${reviewId}`,
    {
      method: "PUT",
      headers: {
        ...githubHeaders(token, "application/vnd.github+json"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub review update failed: ${response.status}: ${await response.text()}`,
    );
  }
}

export function publishCommand(options: {
  receiptPath: string;
  repo: string;
  pullRequest: number;
  expected: ExpectedRevisions;
}) {
  return [
    "bun run src/publish.ts",
    `--receipt ${options.receiptPath}`,
    `--repo ${options.repo}`,
    `--pr ${options.pullRequest}`,
    `--expected-head ${options.expected.head}`,
    `--expected-merge-base ${options.expected.mergeBase}`,
    "--publish",
  ].join(" ");
}

async function main() {
  const options = parsePublishOptions(process.argv.slice(2));
  const receipt = JSON.parse(
    await readFile(options.receiptPath, "utf8"),
  ) as SwarmReceipt;
  const pullRequest = options.pullRequest ?? receipt.requested.pullRequest;
  if (!pullRequest) {
    throw new Error("no pull request in the receipt; pass --pr");
  }
  const expected: ExpectedRevisions = {
    head: options.expectedHead ?? receipt.requested.head,
    mergeBase: options.expectedMergeBase ?? receipt.requested.base,
  };
  assertPublishableReceipt(receipt, expected);
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const validated = await revalidatePullRequest(
    options.repo,
    pullRequest,
    token,
    expected,
  );
  if (alreadyPublished(validated.reviews, receipt.swarmId, expected.head)) {
    throw new Error(
      "a review for this run and SHA is already on the pull request",
    );
  }
  const built = buildReview(
    receipt,
    commentableLines(validated.diff),
    options.repo,
    options.minSeverity,
  );
  const payload = githubReviewPayload(built);
  const superseded = supersededReviews(validated.reviews);
  const command = publishCommand({
    receiptPath: options.receiptPath,
    repo: options.repo,
    pullRequest,
    expected,
  });

  if (!options.publish) {
    console.log(
      JSON.stringify(
        {
          github: payload,
          score: built.score,
          expected,
          mergeBase: validated.mergeBase,
          supersedes: superseded.map((review) => review.id),
          command,
        },
        null,
        2,
      ),
    );
    console.log(
      `\ndry run: ${payload.comments.length} inline comments for ${options.repo}#${pullRequest}. Pass --publish to send.`,
    );
    return;
  }
  const posted = await postReview(options.repo, pullRequest, token, payload);
  console.log(posted.html_url);
  for (const review of superseded) {
    try {
      await updateReviewBody(
        options.repo,
        pullRequest,
        review.id,
        token,
        supersededBody(review.body ?? "", {
          swarmId: receipt.swarmId,
          head: expected.head,
          url: posted.html_url,
        }),
      );
      console.log(`superseded review ${review.id}`);
    } catch (error: unknown) {
      console.error(
        `review ${review.id} not marked superseded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
