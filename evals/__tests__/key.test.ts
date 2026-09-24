import { describe, expect, it } from "vitest";
import {
  type AnswerKey,
  buildSheet,
  buildTrials,
  type ScoringSheet,
} from "../key";
import { rate, scoreT1b } from "../score";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const KEY: AnswerKey = {
  cases: [
    {
      id: "case-1",
      pr: 12,
      head: HEAD,
      base: BASE,
      family: "F1",
      incident: "i1",
      cleanControl: false,
      defects: [
        { id: "d1", file: "src/a.ts", lines: [10, 20], summary: "off by one" },
        { id: "d2", file: "src/b.ts", lines: [40, 45], summary: "leak" },
      ],
      knownFalse: [
        { id: "f1", file: "src/a.ts", line: 30, summary: "declared" },
        { id: "f2", file: "src/a.ts", line: 45, summary: "far" },
        { id: "f3", file: "src/a.ts", line: 46, summary: "farther" },
      ],
      unresolved: [
        { id: "u1", file: "src/c.ts", line: 100, summary: "unknown" },
        { id: "u2", file: "src/a.ts", line: 10, summary: "unsettled" },
      ],
    },
  ],
};

const swarmReceipt = (overrides: Record<string, unknown> = {}) => ({
  swarmId: "sw1",
  status: "completed",
  wallSeconds: 120,
  requested: { head: HEAD, base: BASE },
  candidates: [
    {
      id: "c1",
      severity: "P1",
      file: "src/a.ts",
      line: 15,
      mechanism: "reads one past the end",
      affectedBehavior: "returns garbage",
      reportedBy: ["reviewer-1"],
    },
  ],
  findings: [
    {
      id: "c1",
      severity: "P1",
      status: "confirmed",
      publication: "publishable",
      evidenceStrength: "executable",
      declaredIntent: null,
      verifierReason: "reproduced",
    },
  ],
  lanes: [
    {
      laneId: "reviewer-1",
      role: "reviewer",
      model: "m",
      status: "completed",
      finishReason: null,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  ],
  ...overrides,
});

const scoringReceipt = (
  overrides: Partial<ScoringSheet["receipts"][number]> = {},
): ScoringSheet["receipts"][number] => ({
  receiptPath: "r1.json",
  swarmId: "sw1",
  caseId: "case-1",
  status: "completed",
  wallSeconds: 120,
  lanes: [
    {
      role: "reviewer",
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  ],
  ...overrides,
});

const scoringRow = (
  overrides: Partial<ScoringSheet["rows"][number]> = {},
): ScoringSheet["rows"][number] => ({
  receiptPath: "r1.json",
  swarmId: "sw1",
  candidateId: "c1",
  status: "confirmed",
  publication: "publishable",
  severity: "P1",
  label: null,
  defectId: null,
  ...overrides,
});

const scoringSheet = (
  receipts: ScoringSheet["receipts"],
  rows: ScoringSheet["rows"],
  configuration = "W2",
): ScoringSheet => ({ configuration, receipts, rows });

describe("buildSheet", () => {
  it("joins each candidate with its finding and hints the keyed and false entries", () => {
    const sheet = buildSheet(KEY, "W2", [
      { receiptPath: "r1.json", receipt: swarmReceipt() },
    ]);

    expect(sheet.version).toBe(1);
    expect(sheet.configuration).toBe("W2");
    expect(sheet.receipts).toEqual([
      {
        receiptPath: "r1.json",
        swarmId: "sw1",
        caseId: "case-1",
        status: "completed",
        wallSeconds: 120,
        lanes: [
          {
            laneId: "reviewer-1",
            role: "reviewer",
            model: "m",
            status: "completed",
            finishReason: null,
            usage: { inputTokens: 100, outputTokens: 10 },
          },
        ],
      },
    ]);
    expect(sheet.rows).toEqual([
      {
        receiptPath: "r1.json",
        swarmId: "sw1",
        caseId: "case-1",
        candidateId: "c1",
        file: "src/a.ts",
        line: 15,
        severity: "P1",
        status: "confirmed",
        publication: "publishable",
        evidenceStrength: "executable",
        declaredIntent: null,
        reportedBy: ["reviewer-1"],
        mechanism: "reads one past the end",
        affectedBehavior: "returns garbage",
        verifierReason: "reproduced",
        nearKeyed: ["d1"],
        nearFalse: ["f1", "f2", "u2"],
        defectId: null,
        label: null,
        note: null,
      },
    ]);
  });

  it("leaves a candidate the verifier never ruled on unverified", () => {
    const sheet = buildSheet(KEY, "W2", [
      { receiptPath: "r1.json", receipt: swarmReceipt({ findings: [] }) },
    ]);

    expect(
      sheet.rows.map((row) => ({
        status: row.status,
        severity: row.severity,
        publication: row.publication,
        evidenceStrength: row.evidenceStrength,
        verifierReason: row.verifierReason,
      })),
    ).toEqual([
      {
        status: "unverified",
        severity: "P1",
        publication: null,
        evidenceStrength: null,
        verifierReason: null,
      },
    ]);
  });

  it("takes the severity the verifier ruled, not the reviewer's", () => {
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({
          findings: [
            {
              id: "c1",
              severity: "P3",
              status: "confirmed",
              publication: "advisory",
              evidenceStrength: "static",
              declaredIntent: "meant to",
              verifierReason: "declared",
            },
          ],
        }),
      },
    ]);

    expect(sheet.rows[0]?.severity).toBe("P3");
    expect(sheet.rows[0]?.publication).toBe("advisory");
    expect(sheet.rows[0]?.declaredIntent).toBe("meant to");
  });

  it("hints only the keyed defect whose range contains the line", () => {
    const candidates = [
      {
        id: "c1",
        severity: "P1",
        file: "src/b.ts",
        line: 45,
        mechanism: "leak",
        affectedBehavior: null,
        reportedBy: ["reviewer-1"],
      },
      {
        id: "c2",
        severity: "P1",
        file: "src/b.ts",
        line: 46,
        mechanism: "leak",
        affectedBehavior: null,
        reportedBy: ["reviewer-1"],
      },
    ];
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({ candidates, findings: [] }),
      },
    ]);

    expect(sheet.rows.map((row) => row.nearKeyed)).toEqual([["d2"], []]);
  });

  it("hints known-false entries up to thirty lines away and no further", () => {
    const sheet = buildSheet(KEY, "W2", [
      { receiptPath: "r1.json", receipt: swarmReceipt() },
    ]);

    expect(sheet.rows[0]?.nearFalse).toEqual(["f1", "f2", "u2"]);
  });

  it("reads a lane usage written in the Pi receipt shape", () => {
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({
          lanes: [
            {
              laneId: "verifier",
              role: "verifier",
              model: "m",
              status: "completed",
              finishReason: "stop",
              usage: {
                turns: 3,
                input: 40,
                output: 5,
                cacheRead: 0,
                totalTokens: 45,
                costUsd: 0.02,
              },
            },
            {
              laneId: "reviewer-1",
              role: "reviewer",
              model: "m",
              status: "failed",
              finishReason: null,
              usage: "no usage at all",
            },
          ],
        }),
      },
    ]);

    expect(sheet.receipts[0]?.lanes.map((lane) => lane.usage)).toEqual([
      { inputTokens: 40, outputTokens: 5 },
      null,
    ]);
  });

  it("marks a candidate the verifier folded into another as duplicate", () => {
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({
          candidates: [
            ...swarmReceipt().candidates,
            {
              id: "c2",
              severity: "P1",
              file: "src/a.ts",
              line: 16,
              mechanism: "reads one past the end, again",
              affectedBehavior: null,
              reportedBy: ["reviewer-2"],
            },
          ],
          duplicates: [{ id: "c2", duplicateOf: "c1" }],
        }),
      },
    ]);

    expect(sheet.rows.map((row) => row.status)).toEqual([
      "confirmed",
      "duplicate",
    ]);
  });

  it("throws for a receipt whose head matches no case", () => {
    expect(() =>
      buildSheet(KEY, "W2", [
        {
          receiptPath: "r9.json",
          receipt: swarmReceipt({
            requested: { head: "c".repeat(40), base: BASE },
          }),
        },
      ]),
    ).toThrow("receipt r9.json matches no case in the key");
  });
});

describe("buildTrials", () => {
  it("publishes a completed receipt and nothing else", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [
          scoringReceipt({ status: "partial" }),
          scoringReceipt({ receiptPath: "r2.json", swarmId: "sw2" }),
        ],
        [],
      ),
    );

    expect(
      trials.map((trial) => ({
        outcome: trial.outcome,
        publishable: trial.publishable,
      })),
    ).toEqual([
      { outcome: "partial", publishable: false },
      { outcome: "completed", publishable: true },
    ]);
  });

  it("counts a keyed match the verifier rejected as proposed but not confirmed", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [scoringReceipt()],
        [
          scoringRow({
            status: "rejected",
            label: "keyed-match",
            defectId: "d1",
          }),
        ],
      ),
    );

    expect(trials[0]?.reviewerMatches).toEqual(["d1"]);
    expect(trials[0]?.confirmedMatches).toEqual([]);
  });

  it("counts a confirmed advisory keyed match as confirmed", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [scoringReceipt()],
        [
          scoringRow({
            publication: "advisory",
            severity: "P3",
            label: "keyed-match",
            defectId: "d1",
          }),
        ],
      ),
    );

    expect(trials[0]?.confirmedMatches).toEqual(["d1"]);
    expect(trials[0]?.confirmedFindings).toEqual([]);
  });

  it("counts an unresolved match only when the row is confirmed", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [scoringReceipt()],
        [
          scoringRow({ label: "unresolved", defectId: "d2" }),
          scoringRow({
            candidateId: "c2",
            status: "rejected",
            label: "unresolved",
            defectId: "d1",
          }),
        ],
      ),
    );

    expect(trials[0]?.unresolvedMatches).toEqual(["d2"]);
  });

  it("keeps advisory, P3 and unverified rows out of the confirmed findings", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [scoringReceipt()],
        [
          scoringRow({ publication: "advisory", severity: "P1" }),
          scoringRow({
            candidateId: "c2",
            publication: "publishable",
            severity: "P3",
          }),
          scoringRow({
            candidateId: "c3",
            status: "unverified",
            publication: null,
            severity: "P0",
          }),
        ],
      ),
    );

    expect(trials[0]?.confirmedFindings).toEqual([]);
  });

  it("needs a label for a publishable confirmed P2 finding", () => {
    expect(() =>
      buildTrials(
        KEY,
        scoringSheet([scoringReceipt()], [scoringRow({ severity: "P2" })]),
      ),
    ).toThrow("row sw1/c1: a publishable confirmed finding needs a label");
  });

  it("rejects a defectId the case does not key", () => {
    expect(() =>
      buildTrials(
        KEY,
        scoringSheet(
          [scoringReceipt()],
          [scoringRow({ label: "keyed-match", defectId: "d9" })],
        ),
      ),
    ).toThrow("row sw1/c1: d9 is not a keyed defect of this case");
  });

  it("rejects a row that carries a defectId without a match label", () => {
    expect(() =>
      buildTrials(
        KEY,
        scoringSheet(
          [scoringReceipt()],
          [scoringRow({ label: "invalid", defectId: "d1" })],
        ),
      ),
    ).toThrow(
      "row sw1/c1: a row with a defectId must be labeled keyed-match or unresolved",
    );
  });

  it("sums a reviewer lane and a verifier lane written in the Pi shape", () => {
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({
          candidates: [],
          findings: [],
          lanes: [
            {
              laneId: "reviewer-1",
              role: "reviewer",
              model: "m",
              status: "completed",
              finishReason: "stop",
              usage: { inputTokens: 100, outputTokens: 10 },
            },
            {
              laneId: "verifier",
              role: "verifier",
              model: "m",
              status: "completed",
              finishReason: "stop",
              usage: {
                turns: 3,
                input: 40,
                output: 5,
                cacheRead: 0,
                totalTokens: 45,
                costUsd: 0.02,
              },
            },
            {
              laneId: "reviewer-2",
              role: "reviewer",
              model: "m",
              status: "failed",
              finishReason: null,
              usage: null,
            },
          ],
        }),
      },
    ]);

    const trials = buildTrials(KEY, sheet);

    expect(trials[0]?.usage).toEqual({ inputTokens: 140, outputTokens: 15 });
  });

  it("leaves a trial's token sum unobserved when a lane left its count unobserved", () => {
    const sheet = buildSheet(KEY, "W2", [
      {
        receiptPath: "r1.json",
        receipt: swarmReceipt({
          candidates: [],
          findings: [],
          lanes: [
            {
              laneId: "reviewer-1",
              role: "reviewer",
              model: "m",
              status: "completed",
              finishReason: "stop",
              usage: { inputTokens: null, outputTokens: 5, unended: 1 },
            },
            {
              laneId: "verifier",
              role: "verifier",
              model: "m",
              status: "completed",
              finishReason: "stop",
              usage: {
                inputTokens: 100,
                outputTokens: 10,
                inputUnobserved: 0,
                outputUnobserved: 1,
              },
            },
          ],
        }),
      },
    ]);

    // One lane never observed its input and the other's output sum is a
    // request short, so neither side of the trial is a number to quote.
    expect(sheet.receipts[0]?.lanes.map((lane) => lane.usage)).toEqual([
      { inputTokens: null, outputTokens: 5 },
      { inputTokens: 100, outputTokens: null },
    ]);
    expect(buildTrials(KEY, sheet)[0]?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("deduplicates a defect two rows name", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [scoringReceipt()],
        [
          scoringRow({ label: "keyed-match", defectId: "d1" }),
          scoringRow({
            candidateId: "c2",
            label: "keyed-match",
            defectId: "d1",
          }),
        ],
      ),
    );

    expect(trials[0]?.confirmedMatches).toEqual(["d1"]);
  });

  it("scores a two-receipt sheet through scoreT1b", () => {
    const trials = buildTrials(
      KEY,
      scoringSheet(
        [
          scoringReceipt(),
          scoringReceipt({ receiptPath: "r2.json", swarmId: "sw2" }),
        ],
        [
          scoringRow({
            severity: "P1",
            label: "keyed-match",
            defectId: "d1",
          }),
          scoringRow({ candidateId: "c2", severity: "P2", label: "invalid" }),
          scoringRow({
            receiptPath: "r2.json",
            swarmId: "sw2",
            candidateId: "c3",
            severity: "P1",
            label: "keyed-match",
            defectId: "d2",
          }),
        ],
      ),
    );

    const scored = scoreT1b(trials);
    expect(scored.scheduledTrials).toBe(2);
    expect(scored.confirmedIntentRecall).toEqual(rate(2, 4));
    expect(scored.reviewFpr).toEqual(rate(1, 2));
  });
});
