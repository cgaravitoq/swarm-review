/**
 * Deterministic scorer for T1a and T1b.
 *
 * It has no model, no network, no repository and no filesystem: it consumes
 * finished trial rows, sealed keys and already-reconciled judgements, and turns
 * them into counts. That is the point - a scorer that could re-run anything
 * could also re-run the cell that came out badly.
 *
 * Two rules shape every number here. Every scheduled trial stays in the
 * intent-to-test denominator, so a preparation failure is a miss rather than a
 * disappearance; and every ambiguity resolves against the configuration, so an
 * unresolved match cannot lift recall and an unresolved finding cannot lower
 * the false-positive rate.
 */

/** A count and the denominator it came from, so a fixture can be checked by hand. */
export const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

export type Rate = ReturnType<typeof rate>;

const requireField = <T>(value: T | undefined | null, where: string) => {
  if (value === undefined || value === null) {
    throw new Error(`${where} is required`);
  }
  return value;
};

const requireArray = (value: unknown, where: string) => {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value as readonly unknown[];
};

export type CandidateKey = {
  candidateId: string;
  expected: "confirmed" | "rejected";
  family: string;
  incident: string;
};

export type T1aScoredTrial = {
  attemptId: string;
  batchId: string;
  caseId: string;
  configuration: string;
  outcome: "completed" | "invalid" | "failed" | "preparation-failed";
  candidateIds: readonly string[];
  decisions: readonly {
    candidateId: string;
    status: "confirmed" | "rejected" | "duplicate" | null;
  }[];
  usage?: Readonly<Record<string, number>> | null;
  wallSeconds?: number | null;
  cost?: TrialCost | null;
};

export type TrialCost = {
  basis: "paid" | "subscription" | "unknown";
  marginalUsd: number | null;
  amortizedUsd: number | null;
};

const assertT1aTrial = (trial: T1aScoredTrial, index: number) => {
  const where = `t1a trial ${index}`;
  requireField(trial.attemptId, `${where}.attemptId`);
  requireField(trial.caseId, `${where}.caseId`);
  requireField(trial.configuration, `${where}.configuration`);
  requireField(trial.outcome, `${where}.outcome`);
  requireArray(trial.candidateIds, `${where}.candidateIds`);
  requireArray(trial.decisions, `${where}.decisions`);
  return trial;
};

/**
 * Scores T1a over every scheduled trial.
 *
 * A `duplicate` verdict and an absent verdict are the same thing here: the
 * candidate was never ruled on. It leaves the conditional confusion matrix and
 * stays a miss in intent-to-test recall, because the question the batch asked
 * went unanswered.
 */
export function scoreT1a(
  trials: readonly T1aScoredTrial[],
  keys: readonly CandidateKey[],
) {
  const keyed = new Map(keys.map((key) => [key.candidateId, key]));
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let positiveOpportunities = 0;
  let negativeOpportunities = 0;
  let undecidedPositives = 0;
  let undecidedNegatives = 0;
  const byFamily = new Map<
    string,
    { tp: number; fn: number; fp: number; tn: number }
  >();

  trials.forEach((trial, index) => {
    assertT1aTrial(trial, index);
    const decided = new Map(
      trial.decisions.map((decision) => [
        decision.candidateId,
        decision.status,
      ]),
    );
    const usable = trial.outcome === "completed";
    for (const candidateId of trial.candidateIds) {
      const key = keyed.get(candidateId);
      if (!key) throw new Error(`no sealed key for candidate ${candidateId}`);
      const bucket = byFamily.get(key.family) ?? { tp: 0, fn: 0, fp: 0, tn: 0 };
      byFamily.set(key.family, bucket);
      if (key.expected === "confirmed") positiveOpportunities += 1;
      else negativeOpportunities += 1;
      const status = usable ? decided.get(candidateId) : undefined;
      if (status !== "confirmed" && status !== "rejected") {
        if (key.expected === "confirmed") undecidedPositives += 1;
        else undecidedNegatives += 1;
        continue;
      }
      if (key.expected === "confirmed") {
        if (status === "confirmed") {
          tp += 1;
          bucket.tp += 1;
        } else {
          fn += 1;
          bucket.fn += 1;
        }
      } else if (status === "confirmed") {
        fp += 1;
        bucket.fp += 1;
      } else {
        tn += 1;
        bucket.tn += 1;
      }
    }
  });

  const completed = trials.filter((trial) => trial.outcome === "completed");
  return {
    scheduledTrials: trials.length,
    completedTrials: completed.length,
    completion: rate(completed.length, trials.length),
    contractValidity: rate(completed.length, trials.length),
    confusion: { tp, fp, tn, fn },
    undecided: {
      positives: undecidedPositives,
      negatives: undecidedNegatives,
    },
    precision: rate(tp, tp + fp),
    candidateFpr: rate(fp, fp + tn),
    conditionalRecall: rate(tp, tp + fn),
    intentRecall: rate(tp, positiveOpportunities),
    /** Every undecided negative is charged as a false positive. */
    conservativeCandidateFpr: rate(
      fp + undecidedNegatives,
      negativeOpportunities,
    ),
    opportunities: {
      positives: positiveOpportunities,
      negatives: negativeOpportunities,
    },
    byFamily: Object.fromEntries(
      [...byFamily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    usage: totalUsage(trials),
    cost: totalCost(trials),
  };
}

export type T1bScoredTrial = {
  attemptId: string;
  caseId: string;
  configuration: string;
  incident: string;
  family: string;
  outcome: "completed" | "partial" | "failed";
  /** A review a human could have been shown; a dead trial publishes nothing. */
  publishable: boolean;
  cleanControl: boolean;
  keyedDefectIds: readonly string[];
  /** Keyed defects a reviewer proposed, before the verifier ruled. */
  reviewerMatches: readonly string[];
  /** Keyed defects still standing after verification, adjudicated as matches. */
  confirmedMatches: readonly string[];
  /** Matches an adjudicator could not resolve; they never count as found. */
  unresolvedMatches: readonly string[];
  confirmedFindings: readonly {
    id: string;
    severity: "P0" | "P1" | "P2";
    judgment: "keyed-match" | "novel-valid" | "invalid" | "unresolved";
  }[];
  usage?: Readonly<Record<string, number>> | null;
  wallSeconds?: number | null;
  cost?: TrialCost | null;
};

const assertT1bTrial = (trial: T1bScoredTrial, index: number) => {
  const where = `t1b trial ${index}`;
  requireField(trial.attemptId, `${where}.attemptId`);
  requireField(trial.caseId, `${where}.caseId`);
  requireField(trial.configuration, `${where}.configuration`);
  requireField(trial.family, `${where}.family`);
  requireField(trial.incident, `${where}.incident`);
  requireField(trial.outcome, `${where}.outcome`);
  if (typeof trial.publishable !== "boolean") {
    throw new Error(`${where}.publishable is required`);
  }
  if (typeof trial.cleanControl !== "boolean") {
    throw new Error(`${where}.cleanControl is required`);
  }
  requireArray(trial.keyedDefectIds, `${where}.keyedDefectIds`);
  requireArray(trial.reviewerMatches, `${where}.reviewerMatches`);
  requireArray(trial.confirmedMatches, `${where}.confirmedMatches`);
  requireArray(trial.unresolvedMatches, `${where}.unresolvedMatches`);
  requireArray(trial.confirmedFindings, `${where}.confirmedFindings`);
  if (trial.cleanControl && trial.keyedDefectIds.length > 0) {
    throw new Error(`${where}: a clean control cannot carry keyed defects`);
  }
  return trial;
};

const onlyKeyed = (
  matches: readonly string[],
  keyed: readonly string[],
  where: string,
) => {
  for (const id of matches) {
    if (!keyed.includes(id)) {
      throw new Error(`${where}: ${id} is not a keyed defect of this case`);
    }
  }
  return new Set(matches);
};

/**
 * Scores T1b.
 *
 * The primary false-positive rate is per review, not per finding: one review
 * carrying three invalid findings costs a reviewer one act of trust, and the
 * product question is how often a published review is wrong at all.
 */
export function scoreT1b(trials: readonly T1bScoredTrial[]) {
  let opportunities = 0;
  let reviewerFound = 0;
  let confirmedFound = 0;
  let unresolvedMatchCount = 0;
  let conditionalOpportunities = 0;
  let conditionalConfirmed = 0;
  let publishable = 0;
  let publishableWithInvalid = 0;
  let publishableWithUnresolved = 0;
  let cleanControls = 0;
  let cleanControlsWithInvalid = 0;
  let novelValid = 0;
  let severeInvalid = 0;

  trials.forEach((trial, index) => {
    assertT1bTrial(trial, index);
    const where = `t1b trial ${index}`;
    const reviewer = onlyKeyed(
      trial.reviewerMatches,
      trial.keyedDefectIds,
      where,
    );
    const confirmed = onlyKeyed(
      trial.confirmedMatches,
      trial.keyedDefectIds,
      where,
    );
    const unresolved = onlyKeyed(
      trial.unresolvedMatches,
      trial.keyedDefectIds,
      where,
    );
    opportunities += trial.keyedDefectIds.length;
    reviewerFound += reviewer.size;
    confirmedFound += confirmed.size;
    unresolvedMatchCount += unresolved.size;
    if (trial.publishable) {
      publishable += 1;
      conditionalOpportunities += trial.keyedDefectIds.length;
      conditionalConfirmed += confirmed.size;
      const judgments = trial.confirmedFindings.map(
        (finding) => finding.judgment,
      );
      if (judgments.includes("invalid")) publishableWithInvalid += 1;
      if (judgments.includes("unresolved")) publishableWithUnresolved += 1;
      novelValid += judgments.filter(
        (judgment) => judgment === "novel-valid",
      ).length;
      severeInvalid += trial.confirmedFindings.filter(
        (finding) =>
          finding.judgment === "invalid" &&
          (finding.severity === "P0" || finding.severity === "P1"),
      ).length;
      if (trial.cleanControl) {
        cleanControls += 1;
        if (judgments.includes("invalid")) cleanControlsWithInvalid += 1;
      }
    }
  });

  const completed = trials.filter((trial) => trial.outcome === "completed");
  return {
    scheduledTrials: trials.length,
    completedTrials: completed.length,
    completion: rate(completed.length, trials.length),
    publishableReviews: publishable,
    rawReviewerRecall: rate(reviewerFound, opportunities),
    confirmedIntentRecall: rate(confirmedFound, opportunities),
    confirmedConditionalRecall: rate(
      conditionalConfirmed,
      conditionalOpportunities,
    ),
    /** Unresolved matches were already excluded from `confirmedMatches`. */
    conservativeIntentRecall: rate(confirmedFound, opportunities),
    optimisticIntentRecall: rate(
      confirmedFound + unresolvedMatchCount,
      opportunities,
    ),
    unresolvedMatches: unresolvedMatchCount,
    reviewFpr: rate(publishableWithInvalid, publishable),
    conservativeReviewFpr: rate(
      publishableWithInvalid + publishableWithUnresolved,
      publishable,
    ),
    cleanControlFpr: rate(cleanControlsWithInvalid, cleanControls),
    novelValidFindings: novelValid,
    severeInvalidFindings: severeInvalid,
    usage: totalUsage(trials),
    cost: totalCost(trials),
  };
}

const totalUsage = (
  trials: readonly { usage?: Readonly<Record<string, number>> | null }[],
) => {
  const totals: Record<string, number> = {};
  for (const trial of trials) {
    for (const [key, value] of Object.entries(trial.usage ?? {})) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
};

/**
 * Sums cost without inventing one. A trial whose billing basis is unknown
 * poisons the total on purpose, so the number cannot be quoted as if it were
 * measured.
 */
const totalCost = (trials: readonly { cost?: TrialCost | null }[]) => {
  let marginalUsd = 0;
  let amortizedUsd = 0;
  let unknown = 0;
  for (const trial of trials) {
    const cost = trial.cost;
    if (!cost || cost.basis === "unknown") {
      unknown += 1;
      continue;
    }
    marginalUsd += cost.marginalUsd ?? 0;
    amortizedUsd += cost.amortizedUsd ?? 0;
  }
  return {
    trialsWithUnknownBilling: unknown,
    marginalUsd: unknown > 0 ? null : marginalUsd,
    amortizedUsd: unknown > 0 ? null : amortizedUsd,
  };
};

/**
 * Refuses an economic comparison whose billing basis is not established for
 * both sides. An unpriced run is not a cheap run.
 */
export function compareEconomics(
  a: { label: string; cost: ReturnType<typeof totalCost> },
  b: { label: string; cost: ReturnType<typeof totalCost> },
) {
  for (const side of [a, b]) {
    if (side.cost.trialsWithUnknownBilling > 0) {
      throw new Error(
        `${side.label}: ${side.cost.trialsWithUnknownBilling} trials have unknown billing`,
      );
    }
  }
  return {
    marginalDeltaUsd: (b.cost.marginalUsd ?? 0) - (a.cost.marginalUsd ?? 0),
    amortizedDeltaUsd: (b.cost.amortizedUsd ?? 0) - (a.cost.amortizedUsd ?? 0),
  };
}

/**
 * Pairs two configurations at the incident level.
 *
 * Repeated runs of one incident are not independent cases, so they collapse
 * into one paired unit before any delta is taken, and a pair whose two sides
 * did not run against the same baseline identity is refused rather than
 * silently compared.
 */
export function pairByIncident(
  left: { baselineId: string; trials: readonly T1bScoredTrial[] },
  right: { baselineId: string; trials: readonly T1bScoredTrial[] },
) {
  if (left.baselineId !== right.baselineId) {
    throw new Error(
      `paired comparison across baselines ${left.baselineId} and ${right.baselineId}`,
    );
  }
  const group = (trials: readonly T1bScoredTrial[]) => {
    const byIncident = new Map<
      string,
      { found: number; opportunities: number }
    >();
    for (const trial of trials) {
      const bucket = byIncident.get(trial.incident) ?? {
        found: 0,
        opportunities: 0,
      };
      bucket.found += new Set(trial.confirmedMatches).size;
      bucket.opportunities += trial.keyedDefectIds.length;
      byIncident.set(trial.incident, bucket);
    }
    return byIncident;
  };
  const a = group(left.trials);
  const b = group(right.trials);
  const incidents = [...new Set([...a.keys(), ...b.keys()])].sort();
  return incidents.map((incident) => {
    const leftSide = a.get(incident);
    const rightSide = b.get(incident);
    if (!leftSide || !rightSide) {
      throw new Error(
        `incident ${incident} is missing from one side of the pair`,
      );
    }
    return {
      incident,
      left: rate(leftSide.found, leftSide.opportunities),
      right: rate(rightSide.found, rightSide.opportunities),
      delta:
        (rightSide.opportunities === 0
          ? 0
          : rightSide.found / rightSide.opportunities) -
        (leftSide.opportunities === 0
          ? 0
          : leftSide.found / leftSide.opportunities),
    };
  });
}
