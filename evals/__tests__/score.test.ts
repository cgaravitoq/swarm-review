import { describe, expect, it } from "vitest";
import {
  type CandidateKey,
  compareEconomics,
  pairByIncident,
  rate,
  scoreT1a,
  scoreT1b,
  type T1aScoredTrial,
  type T1bScoredTrial,
} from "../score";

const KEYS: CandidateKey[] = [
  { candidateId: "c1", expected: "confirmed", family: "F1", incident: "i1" },
  { candidateId: "c2", expected: "rejected", family: "F2", incident: "i1" },
  { candidateId: "c3", expected: "confirmed", family: "F1", incident: "i1" },
];

const t1aTrial = (
  attemptId: string,
  outcome: T1aScoredTrial["outcome"],
  decisions: T1aScoredTrial["decisions"],
): T1aScoredTrial => ({
  attemptId,
  batchId: "batch-1",
  caseId: "case-1",
  configuration: "S2",
  outcome,
  candidateIds: ["c1", "c2", "c3"],
  decisions,
  usage: { inputTokens: 100, outputTokens: 10 },
});

describe("scoreT1a", () => {
  const scored = scoreT1a(
    [
      t1aTrial("a", "completed", [
        { candidateId: "c1", status: "confirmed" },
        { candidateId: "c2", status: "confirmed" },
        { candidateId: "c3", status: "rejected" },
      ]),
      t1aTrial("b", "completed", [
        { candidateId: "c1", status: "confirmed" },
        { candidateId: "c2", status: "rejected" },
        { candidateId: "c3", status: "confirmed" },
      ]),
      t1aTrial("c", "failed", []),
    ],
    KEYS,
  );

  it("reproduces the hand-computed confusion matrix", () => {
    expect(scored.confusion).toEqual({ tp: 3, fp: 1, tn: 1, fn: 1 });
    expect(scored.undecided).toEqual({ positives: 2, negatives: 1 });
  });

  it("reproduces the hand-computed rates", () => {
    expect(scored.precision).toEqual(rate(3, 4));
    expect(scored.candidateFpr).toEqual(rate(1, 2));
    expect(scored.conditionalRecall).toEqual(rate(3, 4));
    expect(scored.intentRecall).toEqual(rate(3, 6));
    expect(scored.conservativeCandidateFpr).toEqual(rate(2, 3));
    expect(scored.completion).toEqual(rate(2, 3));
  });

  it("keeps the failed trial in the intent denominator", () => {
    expect(scored.scheduledTrials).toBe(3);
    expect(scored.opportunities).toEqual({ positives: 6, negatives: 3 });
  });

  it("reports coverage by mechanism family", () => {
    expect(scored.byFamily).toEqual({
      F1: { tp: 3, fn: 1, fp: 0, tn: 0 },
      F2: { tp: 0, fn: 0, fp: 1, tn: 1 },
    });
  });

  it("sums usage over every scheduled trial", () => {
    expect(scored.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it("leaves a usage total unobserved when one trial left its count unobserved", () => {
    const partial = scoreT1a(
      [
        {
          ...t1aTrial("u1", "completed", []),
          usage: { inputTokens: 100, unended: null },
        },
        {
          ...t1aTrial("u2", "completed", []),
          usage: { inputTokens: 200, unended: 0 },
        },
      ],
      KEYS,
    );

    expect(partial.usage).toEqual({ inputTokens: 300, unended: null });
  });

  it("treats a duplicate verdict as no decision at all", () => {
    const duplicated = scoreT1a(
      [
        t1aTrial("d", "completed", [
          { candidateId: "c1", status: "duplicate" },
          { candidateId: "c2", status: "rejected" },
          { candidateId: "c3", status: "confirmed" },
        ]),
      ],
      KEYS,
    );
    expect(duplicated.confusion).toEqual({ tp: 1, fp: 0, tn: 1, fn: 0 });
    expect(duplicated.undecided.positives).toBe(1);
    expect(duplicated.intentRecall).toEqual(rate(1, 2));
  });

  it("refuses a candidate with no sealed key", () => {
    expect(() =>
      scoreT1a([t1aTrial("e", "completed", [])], KEYS.slice(0, 2)),
    ).toThrow(/no sealed key for candidate c3/);
  });

  it("refuses a trial with no outcome", () => {
    const broken = {
      ...t1aTrial("f", "completed", []),
    } as Partial<T1aScoredTrial>;
    delete broken.outcome;
    expect(() => scoreT1a([broken as T1aScoredTrial], KEYS)).toThrow(
      /outcome is required/,
    );
  });
});

const subscription = {
  basis: "subscription" as const,
  marginalUsd: 0,
  amortizedUsd: 1.5,
};

const T1B: T1bScoredTrial[] = [
  {
    attemptId: "t1",
    caseId: "case-A",
    configuration: "S2",
    incident: "i-A",
    family: "F1",
    outcome: "completed",
    publishable: true,
    cleanControl: false,
    keyedDefectIds: ["d1", "d2"],
    reviewerMatches: ["d1", "d2"],
    confirmedMatches: ["d1"],
    unresolvedMatches: ["d2"],
    confirmedFindings: [
      { id: "f1", severity: "P1", judgment: "keyed-match" },
      { id: "f2", severity: "P0", judgment: "invalid" },
    ],
    cost: subscription,
  },
  {
    attemptId: "t2",
    caseId: "case-A",
    configuration: "S2",
    incident: "i-A",
    family: "F1",
    outcome: "partial",
    publishable: true,
    cleanControl: false,
    keyedDefectIds: ["d1", "d2"],
    reviewerMatches: ["d1"],
    confirmedMatches: ["d1"],
    unresolvedMatches: [],
    confirmedFindings: [
      { id: "f3", severity: "P1", judgment: "keyed-match" },
      { id: "f4", severity: "P2", judgment: "novel-valid" },
      { id: "f5", severity: "P2", judgment: "unresolved" },
    ],
    cost: subscription,
  },
  {
    attemptId: "t3",
    caseId: "case-B",
    configuration: "S2",
    incident: "i-B",
    family: "F2",
    outcome: "completed",
    publishable: true,
    cleanControl: true,
    keyedDefectIds: [],
    reviewerMatches: [],
    confirmedMatches: [],
    unresolvedMatches: [],
    confirmedFindings: [],
    cost: subscription,
  },
  {
    attemptId: "t4",
    caseId: "case-C",
    configuration: "S2",
    incident: "i-C",
    family: "F3",
    outcome: "failed",
    publishable: false,
    cleanControl: false,
    keyedDefectIds: ["d3"],
    reviewerMatches: [],
    confirmedMatches: [],
    unresolvedMatches: [],
    confirmedFindings: [],
    cost: { basis: "unknown", marginalUsd: null, amortizedUsd: null },
  },
];

describe("scoreT1b", () => {
  const scored = scoreT1b(T1B);

  it("reproduces the hand-computed recall figures", () => {
    expect(scored.rawReviewerRecall).toEqual(rate(3, 5));
    expect(scored.confirmedIntentRecall).toEqual(rate(2, 5));
    expect(scored.conservativeIntentRecall).toEqual(rate(2, 5));
    expect(scored.optimisticIntentRecall).toEqual(rate(3, 5));
    expect(scored.confirmedConditionalRecall).toEqual(rate(2, 4));
    expect(scored.unresolvedMatches).toBe(1);
  });

  it("reproduces the hand-computed false-positive rates", () => {
    expect(scored.reviewFpr).toEqual(rate(1, 3));
    expect(scored.conservativeReviewFpr).toEqual(rate(2, 3));
    expect(scored.cleanControlFpr).toEqual(rate(0, 1));
    expect(scored.severeInvalidFindings).toBe(1);
    expect(scored.novelValidFindings).toBe(1);
  });

  it("keeps the failed trial out of the FPR denominator and inside the rest", () => {
    expect(scored.scheduledTrials).toBe(4);
    expect(scored.publishableReviews).toBe(3);
    expect(scored.completion).toEqual(rate(2, 4));
  });

  it("refuses to total a cost whose billing basis is unknown", () => {
    expect(scored.cost).toEqual({
      trialsWithUnknownBilling: 1,
      marginalUsd: null,
      amortizedUsd: null,
    });
    expect(() =>
      compareEconomics(
        { label: "S2", cost: scored.cost },
        { label: "W2", cost: scored.cost },
      ),
    ).toThrow(/unknown billing/);
  });

  it("totals cost once every trial is priced", () => {
    const priced = scoreT1b(T1B.slice(0, 3));
    expect(priced.cost).toEqual({
      trialsWithUnknownBilling: 0,
      marginalUsd: 0,
      amortizedUsd: 4.5,
    });
    expect(
      compareEconomics(
        { label: "S2", cost: priced.cost },
        { label: "S3", cost: priced.cost },
      ),
    ).toEqual({ marginalDeltaUsd: 0, amortizedDeltaUsd: 0 });
  });

  it("refuses a clean control that carries keyed defects", () => {
    const broken = { ...T1B[2], keyedDefectIds: ["d9"] } as T1bScoredTrial;
    expect(() => scoreT1b([broken])).toThrow(/clean control cannot carry/);
  });

  it("refuses a match that is not a keyed defect of its case", () => {
    const broken = { ...T1B[0], confirmedMatches: ["d9"] } as T1bScoredTrial;
    expect(() => scoreT1b([broken])).toThrow(/d9 is not a keyed defect/);
  });
});

describe("pairByIncident", () => {
  it("collapses repeats of one incident into a single paired unit", () => {
    const paired = pairByIncident(
      { baselineId: "base-1", trials: [T1B[0] as T1bScoredTrial] },
      { baselineId: "base-1", trials: [T1B[1] as T1bScoredTrial] },
    );
    expect(paired).toEqual([
      { incident: "i-A", left: rate(1, 2), right: rate(1, 2), delta: 0 },
    ]);
  });

  it("refuses a comparison across two baselines", () => {
    expect(() =>
      pairByIncident(
        { baselineId: "base-1", trials: [T1B[0] as T1bScoredTrial] },
        { baselineId: "base-2", trials: [T1B[1] as T1bScoredTrial] },
      ),
    ).toThrow(/across baselines/);
  });

  it("refuses a pair missing one side", () => {
    expect(() =>
      pairByIncident(
        { baselineId: "base-1", trials: [T1B[0] as T1bScoredTrial] },
        { baselineId: "base-1", trials: [T1B[2] as T1bScoredTrial] },
      ),
    ).toThrow(/missing from one side/);
  });
});
