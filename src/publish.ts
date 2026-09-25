/**
 * Turns one swarm receipt into one GitHub pull request review.
 *
 * Only confirmed findings this change introduced and did not declare are
 * publishable as defects. A finding the change's own body declares as intended
 * is published as an advisory, one on code the change never touches is kept
 * out of the review as out-of-diff, and unverified and rejected candidates stay
 * in the receipt. Comments attach to the GitHub three-dot diff
 * (merge-base...head) on side RIGHT at the frozen head SHA. The GitHub
 * credential stays on the host. Publishing is opt-in; a published run deletes
 * the comment it opened and a refused one turns it into the refusal.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitHubRequestError } from "./github-app";

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
  failure?: { stage: string; message: string };
  findings: Finding[];
  coverage?: {
    changedFiles: string[];
    uncoveredFiles: string[];
    unpackableFiles?: {
      file: string;
      diffBytes: number;
      headBytes: number;
      binary: boolean;
    }[];
  };
  lanes?: {
    laneId?: string;
    /** The run dir this lane's artifacts sit in, one per launch. */
    runId?: string;
    role: string;
    model: string | null;
    status: string;
    /** What the lane was pointed at; a reviewer lane names its angle. */
    focus?: string;
    blockerReason?: string | null;
    contractError?: string | null;
    error?: string | null;
  }[];
  wallSeconds?: number;
  verification?: { mode: string };
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
    allowMovedHead: argv.includes("--allow-moved-head"),
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
  // A partial review saw less than the change: what it confirmed is real,
  // but nothing it did not find is evidence of absence, so no number.
  if (receipt.status !== "completed") {
    return {
      available: false as const,
      reason: `${receipt.status} review`,
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
  // A run that failed before its lanes has no revisions to check, and its own
  // failure is the reason the pull request is owed.
  if (receipt.status === "failed" && receipt.failure) {
    throw new Error(`${receipt.failure.stage}: ${receipt.failure.message}`);
  }
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
  // A partial review still carries what the verifier confirmed, and the body
  // says which lane never finished. A failed one confirmed nothing.
  if (receipt.status !== "completed" && receipt.status !== "partial") {
    throw new Error("publication requires a completed or partial review");
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
  const where = receipt.verification?.mode === "packed" ? "" : " in sandbox";
  parts.push(
    `${count(receipt.findings.length, "candidate")}: ${verified} verified${verifiers.length > 0 ? `${where} by ${verifiers.join(", ")}` : ""}, ${counts.unverified} unverified, ${counts.rejected} rejected, ${counts.outOfDiff} out-of-diff`,
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
  fork = false,
  packedRunner?: string,
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
  if (fork) summary.push("- fork reviewed with packed lanes");
  if (packedRunner) {
    summary.push(
      `- runner ${packedRunner} cannot run the sandbox image: reviewed with packed lanes`,
    );
  }
  if (receipt.coverage && receipt.coverage.uncoveredFiles.length > 0) {
    summary.push(
      `- not reviewed: ${receipt.coverage.uncoveredFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
  }
  for (const entry of receipt.coverage?.unpackableFiles ?? []) {
    summary.push(
      entry.binary
        ? `- binary, not read as text: \`${entry.file}\``
        : `- too large for one lane: \`${entry.file}\` (${Math.round(entry.diffBytes / 1024)} KB of diff, ${Math.round(entry.headBytes / 1024)} KB at head)`,
    );
  }
  // A lane that did not finish is an angle nobody took, even when another
  // lane held the same files: the files count as covered, the angle does not.
  for (const lane of receipt.lanes ?? []) {
    if (lane.role !== "reviewer" || lane.status === "completed") continue;
    const reason = lane.blockerReason ?? lane.contractError ?? lane.error;
    summary.push(
      `- reviewer lane did not finish: ${lane.focus ?? lane.laneId ?? "unnamed"} (${lane.model ? modelName(lane.model) : "no model"}, ${lane.status}${reason ? `: ${reason}` : ""})`,
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
    throw new GitHubRequestError(
      `GitHub pull request request failed: ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as {
    state: string;
    draft: boolean;
    merged: boolean;
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
    throw new GitHubRequestError(
      `GitHub three-dot compare failed: ${response.status}`,
      response.status,
    );
  }
  const compared = (await response.json()) as {
    merge_base_commit: { sha: string };
  };
  return compared.merge_base_commit.sha;
}

/** Whether `ancestor` is in `head`'s history: compare reports "ahead" or "identical". */
export async function fetchIsAncestor(
  repo: string,
  ancestor: string,
  head: string,
  token: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/compare/${ancestor}...${head}`,
    { headers: githubHeaders(token, "application/vnd.github+json") },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub three-dot compare failed: ${response.status}`,
      response.status,
    );
  }
  const compared = (await response.json()) as { status: string };
  return compared.status === "ahead" || compared.status === "identical";
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
    throw new GitHubRequestError(
      `GitHub three-dot diff request failed: ${response.status}`,
      response.status,
    );
  }
  return response.text();
}

/**
 * Every page of a GitHub list endpoint, not just the first.
 *
 * A missed page reads as "never written", and the caller then posts a second
 * copy of something the pull request already carries.
 */
async function githubPages<T>(
  path: string,
  what: string,
  token: string,
): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com${path}?per_page=100&page=${page}`,
      { headers: githubHeaders(token, "application/vnd.github+json") },
    );
    if (!response.ok) {
      throw new GitHubRequestError(
        `GitHub ${what} request failed: ${response.status}`,
        response.status,
      );
    }
    const batch = (await response.json()) as T[];
    entries.push(...batch);
    if (batch.length < 100) return entries;
  }
}

export const fetchReviews = (
  repo: string,
  pullRequest: number,
  token: string,
) =>
  githubPages<{ id: number; body?: string | null }>(
    `/repos/${repo}/pulls/${pullRequest}/reviews`,
    "reviews",
    token,
  );

export const fetchIssueComments = (
  repo: string,
  pullRequest: number,
  token: string,
) =>
  githubPages<{
    id: number;
    user?: { login: string } | null;
    body?: string | null;
  }>(`/repos/${repo}/issues/${pullRequest}/comments`, "comments", token);

export async function revalidatePullRequest(
  repo: string,
  pullRequest: number,
  token: string,
  expected: ExpectedRevisions,
  allowMovedHead = false,
) {
  if (!FULL_SHA.test(expected.head) || !FULL_SHA.test(expected.mergeBase)) {
    throw new Error("expected revisions must be full SHAs");
  }
  const pull = await fetchPullRevisions(repo, pullRequest, token);
  // A review posted at the commit it read stays true when commits land on
  // top, or when the change merges: GitHub marks a comment on a line those
  // commits changed as outdated, and a merged change still has its authors to
  // read what was found. A head the frozen commit is no longer behind was
  // force-pushed, and the review would then describe a change nobody can see.
  if (pull.state !== "open" && !(allowMovedHead && pull.merged)) {
    throw new Error(`pull request is ${pull.state}, not open`);
  }
  if (pull.head.sha !== expected.head) {
    if (
      !allowMovedHead ||
      !(await fetchIsAncestor(repo, expected.head, pull.head.sha, token))
    ) {
      throw new Error("pull request head moved off the frozen SHA");
    }
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
    throw new GitHubRequestError(
      `GitHub review request failed: ${response.status}: ${text}`,
      response.status,
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
    throw new GitHubRequestError(
      `GitHub review update failed: ${response.status}: ${await response.text()}`,
      response.status,
    );
  }
}

/**
 * The run a refusal is reported against: its id keys the marker and its page
 * is where the run's artifact sits.
 *
 * The id is the workflow run rather than the swarm, because a re-run keeps the
 * run id and moves only the attempt: the same reader, the same run, and the
 * comment it already has is the one to edit.
 */
export const runIdentity = (env: Record<string, string | undefined>) => {
  const server = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  const runId = env["GITHUB_RUN_ID"];
  return server && repository && runId
    ? { runId, url: `${server}/${repository}/actions/runs/${runId}` }
    : null;
};

export type RunIdentity = NonNullable<ReturnType<typeof runIdentity>>;

const RUN_MARKER_PREFIX = "<!-- swarm-review:run:";

/** One comment per run: the marker is what a re-run finds and edits. */
export const runMarker = (runId: string) => `${RUN_MARKER_PREFIX}${runId} -->`;

/** The step a lane was in when it stopped, as its own status.json records it. */
export type LanePhase = {
  runId: string;
  /** null when the lane wrote a status.json nothing can parse. */
  phase: string | null;
  state: string | null;
};

const parseLanePhase = (raw: string, runDir: string): LanePhase => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const runId = record["runId"];
  const phase = record["phase"];
  const state = record["state"];
  return typeof runId === "string" &&
    typeof phase === "string" &&
    typeof state === "string"
    ? { runId, phase, state }
    : { runId: runDir, phase: null, state: null };
};

/**
 * The phase every lane died in, read from the status.json each lane rewrites at
 * every step.
 *
 * The lane's receipt names its outcome and the swarm's receipt names its
 * status, but neither names the step it was in when it stopped; only this file
 * does, and only a lane that ran in a container writes one.
 */
export async function lanePhases(artifactRoot: string): Promise<LanePhase[]> {
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const phases: LanePhase[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(
      join(artifactRoot, entry.name, "status.json"),
      "utf8",
    ).catch(() => null);
    if (raw !== null) phases.push(parseLanePhase(raw, entry.name));
  }
  return phases.sort((a, b) => a.runId.localeCompare(b.runId));
}

/**
 * The failure the action wrote beside the receipt it never produced.
 *
 * A run that dies before `swarm.ts` runs leaves nothing to publish and an
 * ENOENT that says only which file is missing; the stage and the message the
 * action recorded say which step died and why.
 */
const runFailure = async (
  artifactRoot: string,
): Promise<{ stage: string; message: string } | null> => {
  const raw = await readFile(join(artifactRoot, "failure.json"), "utf8").catch(
    () => null,
  );
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const stage = record["stage"];
  const message = record["message"];
  return typeof stage === "string" && typeof message === "string"
    ? { stage, message }
    : null;
};

/**
 * What the action recorded for the review it is about to run.
 *
 * The notes travel beside the receipt's directory rather than as flags, so
 * publish reads the same run's own record whatever the review step did with
 * them.
 */
export type RunNotes = { fork: boolean; packedRunner?: string };

export async function readRunNotes(artifactRoot: string): Promise<RunNotes> {
  const raw = await readFile(`${artifactRoot}.run.json`, "utf8").catch(
    () => null,
  );
  if (raw === null) return { fork: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fork: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { fork: false };
  const record = parsed as Record<string, unknown>;
  const packedRunner = record["packedRunner"];
  return {
    fork: record["fork"] === true,
    ...(typeof packedRunner === "string" ? { packedRunner } : {}),
  };
}

/** One lane as the comment names it. */
export type RefusalLane = {
  lane: string;
  status: string;
  phase: LanePhase | null;
};

/**
 * The lanes a refusal names: the receipt's own, each with the phase its
 * status.json recorded.
 *
 * A run that died before it wrote a receipt still wrote one status.json per
 * lane that started, and those are the only names left of it.
 */
export const refusalLanes = (
  lanes: NonNullable<SwarmReceipt["lanes"]>,
  phases: readonly LanePhase[],
): RefusalLane[] => {
  const byRunId = new Map(phases.map((phase) => [phase.runId, phase]));
  if (lanes.length === 0) {
    return phases.map((phase) => ({
      lane: phase.runId,
      status: "unobserved",
      phase,
    }));
  }
  return lanes.map((lane) => ({
    lane: lane.laneId ?? lane.runId ?? lane.role,
    status: lane.status,
    phase: (lane.runId !== undefined && byRunId.get(lane.runId)) || null,
  }));
};

const REFUSAL_REASON_LIMIT = 400;

/** The refusal as one line: it heads a public comment, not a log file. */
export const refusalReason = (error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error))
    .replaceAll("`", "'")
    .replaceAll("<", "‹")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= REFUSAL_REASON_LIMIT
    ? text
    : `${text.slice(0, REFUSAL_REASON_LIMIT).replace(/\s+\S*$/, "")}…`;
};

/**
 * A lane-written field as a code span in a table cell. The lane's own file is
 * target-writable inside its container, so nothing from it reaches the comment
 * as markup or as another run's marker. The cut comes before the escape so it
 * cannot split an escaped pipe.
 */
const statusCell = (text: string) =>
  `\`${cell(text.slice(0, 80).replaceAll("`", "'").replaceAll("<", "‹"))}\``;

/** A lane's step, or the reason there is none to name. */
const phaseCell = (phase: LanePhase | null) =>
  phase === null
    ? "no status.json"
    : phase.phase === null || phase.state === null
      ? "unreadable status.json"
      : `${statusCell(phase.phase)} ${statusCell(phase.state)}`;

/**
 * What a run that published no review leaves behind: the refusal, the phase
 * each lane reached, and the run whose artifact holds the rest.
 */
export const refusalCommentBody = (input: {
  runId: string;
  reason: string;
  url: string;
  lanes: readonly RefusalLane[];
}) =>
  [
    runMarker(input.runId),
    "",
    `**swarm-review published no review.** \`${input.reason}\``,
    ...(input.lanes.length === 0
      ? []
      : [
          "",
          "| Lane | Status | Phase |",
          "| --- | --- | --- |",
          ...input.lanes.map(
            (lane) =>
              `| ${statusCell(lane.lane)} | ${statusCell(lane.status)} | ${phaseCell(lane.phase)} |`,
          ),
        ]),
    "",
    `[Run artifact](${input.url})`,
  ].join("\n");

/**
 * What the run's comment says while the lanes are reading the change.
 *
 * `action.ts` opens it as soon as the mode is chosen, so a reader who asked
 * for the review sees one run's answer in one place, from the first minute.
 */
export const runningCommentBody = (input: {
  runId: string;
  mode: string;
  url: string;
}) =>
  [
    runMarker(input.runId),
    "",
    `**swarm-review is reviewing** this pull request with \`${input.mode}\` lanes.`,
    "",
    `[Run artifact](${input.url})`,
  ].join("\n");

export async function postIssueComment(
  repo: string,
  pullRequest: number,
  token: string,
  body: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${pullRequest}/comments`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token, "application/vnd.github+json"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub comment request failed: ${response.status}: ${await response.text()}`,
      response.status,
    );
  }
}

export async function updateIssueComment(
  repo: string,
  commentId: number,
  token: string,
  body: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        ...githubHeaders(token, "application/vnd.github+json"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub comment update failed: ${response.status}: ${await response.text()}`,
      response.status,
    );
  }
}

export async function deleteIssueComment(
  repo: string,
  commentId: number,
  token: string,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
    {
      method: "DELETE",
      headers: githubHeaders(token, "application/vnd.github+json"),
    },
  );
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub comment delete failed: ${response.status}: ${await response.text()}`,
      response.status,
    );
  }
}

/**
 * The login the token acts as. REST's `/user` refuses an installation token,
 * while GraphQL's viewer answers for it and for a personal token alike.
 */
export async function fetchViewerLogin(token: string) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...githubHeaders(token, "application/vnd.github+json"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "query { viewer { login } }" }),
  });
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub viewer request failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = (await response.json()) as {
    data?: { viewer?: { login?: unknown } | null } | null;
  };
  const login = parsed.data?.viewer?.login;
  return typeof login === "string" ? login : null;
}

/**
 * Every comment this run opened.
 *
 * Only a comment the token's identity wrote is the run's, so one carrying the
 * marker under another author is left alone. A re-run of the same run id keeps
 * the attempts it replaced, so there can be more than one.
 */
async function runComments(input: {
  repo: string;
  pullRequest: number;
  token: string;
  runId: string;
}) {
  const marker = runMarker(input.runId);
  const viewer = await fetchViewerLogin(input.token).catch((error: unknown) => {
    console.error(
      `viewer lookup failed, so the run's comment cannot be claimed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  return (
    await fetchIssueComments(input.repo, input.pullRequest, input.token)
  ).filter(
    (comment) =>
      viewer !== null &&
      comment.user?.login === viewer &&
      (comment.body ?? "").startsWith(`${marker}\n`),
  );
}

async function deleteRunComment(
  repo: string,
  commentId: number,
  token: string,
) {
  try {
    await deleteIssueComment(repo, commentId, token);
  } catch (error: unknown) {
    console.error(
      `run comment ${commentId} not deleted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Leaves the run exactly one comment: the first of its own that takes the
 * edit, every other one deleted, and one posted when none took it.
 */
export async function upsertRunComment(input: {
  repo: string;
  pullRequest: number;
  token: string;
  runId: string;
  body: string;
}) {
  let kept = false;
  for (const comment of await runComments(input)) {
    if (!kept) {
      try {
        await updateIssueComment(
          input.repo,
          comment.id,
          input.token,
          input.body,
        );
        kept = true;
        continue;
      } catch (error: unknown) {
        console.error(
          `run comment ${comment.id} not edited: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await deleteRunComment(input.repo, comment.id, input.token);
  }
  if (kept) return "edited" as const;
  await postIssueComment(
    input.repo,
    input.pullRequest,
    input.token,
    input.body,
  );
  return "created" as const;
}

/**
 * Reports a refusal on the pull request, best effort.
 *
 * The caller has already decided to fail: a report that cannot be posted is
 * logged and never replaces the refusal itself.
 */
async function reportRefusal(input: {
  run: RunIdentity | null;
  repo: string;
  pullRequest: number | null;
  token: string | null;
  receipt: SwarmReceipt | null;
  artifactRoot: string;
  error: unknown;
}) {
  if (!input.run || input.pullRequest === null || input.token === null) return;
  try {
    const outcome = await upsertRunComment({
      repo: input.repo,
      pullRequest: input.pullRequest,
      token: input.token,
      runId: input.run.runId,
      body: refusalCommentBody({
        runId: input.run.runId,
        reason: refusalReason(input.error),
        url: input.run.url,
        lanes: refusalLanes(
          input.receipt?.lanes ?? [],
          await lanePhases(input.artifactRoot),
        ),
      }),
    });
    console.log(
      `refusal comment ${outcome} on ${input.repo}#${input.pullRequest}`,
    );
  } catch (error: unknown) {
    console.error(
      `refusal not reported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Deletes every comment the run opened once its review is on the pull
 * request, best effort: the review is the answer, and a comment that cannot
 * be deleted is logged and never disturbs it.
 */
async function clearRunComments(input: {
  run: RunIdentity | null;
  repo: string;
  pullRequest: number;
  token: string;
}) {
  if (!input.run) return;
  try {
    for (const comment of await runComments({
      repo: input.repo,
      pullRequest: input.pullRequest,
      token: input.token,
      runId: input.run.runId,
    })) {
      await deleteRunComment(input.repo, comment.id, input.token);
    }
  } catch (error: unknown) {
    console.error(
      `run comments not cleared: ${error instanceof Error ? error.message : String(error)}`,
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

export async function main(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
) {
  const options = parsePublishOptions(argv);
  const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"] ?? null;
  const run = runIdentity(env);
  const artifactRoot = dirname(options.receiptPath);
  const notes = await readRunNotes(artifactRoot);
  let receipt: SwarmReceipt | null = null;
  let pullRequest: number | null = options.pullRequest ?? null;
  try {
    receipt = JSON.parse(
      await readFile(options.receiptPath, "utf8"),
    ) as SwarmReceipt;
    pullRequest ??= receipt.requested.pullRequest;
    if (!pullRequest) {
      throw new Error("no pull request in the receipt; pass --pr");
    }
    const expected: ExpectedRevisions = {
      head: options.expectedHead ?? receipt.requested.head,
      mergeBase: options.expectedMergeBase ?? receipt.requested.base,
    };
    assertPublishableReceipt(receipt, expected);
    if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

    const validated = await revalidatePullRequest(
      options.repo,
      pullRequest,
      token,
      expected,
      options.allowMovedHead,
    );
    if (alreadyPublished(validated.reviews, receipt.swarmId, expected.head)) {
      // This run's review is on the pull request, so there is no refusal to
      // report; the job fails as it did before, and the comments this run
      // opened go as they would after its own publish.
      console.error(
        "a review for this run and SHA is already on the pull request",
      );
      if (options.publish) {
        await clearRunComments({
          run,
          repo: options.repo,
          pullRequest,
          token,
        });
      }
      process.exitCode = 1;
      return;
    }
    const built = buildReview(
      receipt,
      commentableLines(validated.diff),
      options.repo,
      options.minSeverity,
      notes.fork,
      notes.packedRunner,
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
    await clearRunComments({ run, repo: options.repo, pullRequest, token });
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
  } catch (error: unknown) {
    // Publishing is opt-in, and so is the report: a dry run leaves the pull
    // request as it found it. The job fails either way.
    process.exitCode = 1;
    const failure = receipt === null ? await runFailure(artifactRoot) : null;
    const reported = failure
      ? new Error(`${failure.stage}: ${failure.message}`)
      : error;
    if (options.publish) {
      await reportRefusal({
        run,
        repo: options.repo,
        pullRequest,
        token,
        receipt,
        artifactRoot,
        error: reported,
      });
    }
    throw reported;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
