/**
 * Turns sealed keys and swarm receipts into a labelling sheet, and labelled
 * sheets back into T1b trials.
 *
 * `scoreT1b` computes recall and the false-positive rate, but nothing built its
 * input: there was no key and no place to record which confirmed finding was a
 * keyed match, a novel valid defect or an invalid one. The sheet is the one
 * artifact a human edits, so every row carries the candidate, the verifier's
 * ruling on it and the nearby keyed and known-false entries as hints. Scoring
 * reads the labels back and refuses any that contradicts the key, because a
 * keyed match to a defect the key does not name is a labelling mistake, not a
 * finding.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { scoreT1b, type T1bScoredTrial } from "./score";

export const LABELS = [
  "keyed-match",
  "novel-valid",
  "invalid",
  "unresolved",
] as const;

export type Label = (typeof LABELS)[number];

export type KeyDefect = {
  id: string;
  file: string;
  lines: [number, number];
  summary: string;
};

export type KeyLocation = {
  id: string;
  file: string;
  line: number;
  summary: string;
};

export type KeyCase = {
  id: string;
  pr: number | null;
  head: string;
  base: string;
  family: string;
  incident: string;
  cleanControl: boolean;
  defects: readonly KeyDefect[];
  knownFalse: readonly KeyLocation[];
  unresolved: readonly KeyLocation[];
};

export type AnswerKey = { cases: readonly KeyCase[] };

export type SheetLane = {
  laneId: string;
  role: string;
  model: string | null;
  status: string;
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export type SheetReceipt = {
  receiptPath: string;
  swarmId: string;
  caseId: string;
  status: string;
  wallSeconds: number | null;
  lanes: readonly SheetLane[];
};

export type SheetRow = {
  receiptPath: string;
  swarmId: string;
  caseId: string;
  candidateId: string;
  file: string;
  line: number;
  severity: string;
  status: string;
  publication: string | null;
  evidenceStrength: string | null;
  declaredIntent: string | null;
  reportedBy: readonly string[];
  mechanism: string;
  affectedBehavior: string | null;
  verifierReason: string | null;
  nearKeyed: readonly string[];
  nearFalse: readonly string[];
  defectId: string | null;
  label: Label | null;
  note: string | null;
};

export type Sheet = {
  version: 1;
  configuration: string;
  receipts: readonly SheetReceipt[];
  rows: readonly SheetRow[];
};

/** The part of a labelled sheet scoring reads; the rest is a hint for the labeler. */
export type ScoringSheet = {
  configuration: string;
  receipts: readonly {
    receiptPath: string;
    swarmId: string;
    caseId: string;
    status: string;
    wallSeconds: number | null;
    lanes: readonly {
      role: string;
      status: string;
      usage: { inputTokens: number; outputTokens: number } | null;
    }[];
  }[];
  rows: readonly {
    receiptPath: string;
    swarmId: string;
    candidateId: string;
    status: string;
    publication: string | null;
    severity: string | null;
    label: Label | null;
    defectId: string | null;
  }[];
};

const record = (value: unknown, where: string) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const array = (value: unknown, where: string) => {
  if (!Array.isArray(value)) throw new Error(`${where}: expected an array`);
  return value as readonly unknown[];
};

const text = (value: unknown, where: string) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: expected a non-empty string`);
  }
  return value;
};

const integer = (value: unknown, where: string) => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${where}: expected an integer`);
  }
  return value;
};

const optionalText = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : null;

/**
 * The lane receipt's usage in either shape: the host's own `inputTokens` and
 * `outputTokens`, or the Pi receipt's `input`, `output`, `turns`, `cacheRead`,
 * `totalTokens` and `costUsd`. A shape neither reader understands is unknown
 * spend, not a broken run, so it reads as absent instead of failing the sheet.
 */
const optionalUsage = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const usage = value as Readonly<Record<string, unknown>>;
  const input = usage["inputTokens"] ?? usage["input"];
  const output = usage["outputTokens"] ?? usage["output"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  if (!Number.isInteger(input) || !Number.isInteger(output)) return null;
  return { inputTokens: input, outputTokens: output };
};

const readLocations = (value: unknown, where: string): KeyLocation[] =>
  array(value, where).map((entry, index) => {
    const item = record(entry, `${where}[${index}]`);
    return {
      id: text(item["id"], `${where}[${index}].id`),
      file: text(item["file"], `${where}[${index}].file`),
      line: integer(item["line"], `${where}[${index}].line`),
      summary: text(item["summary"], `${where}[${index}].summary`),
    };
  });

const readKey = (raw: unknown): AnswerKey => {
  const root = record(raw, "answer key");
  return {
    cases: array(root["cases"], "answer key cases").map(
      (entry, index): KeyCase => {
        const where = `answer key cases[${index}]`;
        const item = record(entry, where);
        const cleanControl = item["cleanControl"];
        if (typeof cleanControl !== "boolean") {
          throw new Error(`${where}.cleanControl: expected a boolean`);
        }
        return {
          id: text(item["id"], `${where}.id`),
          pr: optionalNumber(item["pr"]),
          head: text(item["head"], `${where}.head`),
          base: text(item["base"], `${where}.base`),
          family: text(item["family"], `${where}.family`),
          incident: text(item["incident"], `${where}.incident`),
          cleanControl,
          defects: array(item["defects"], `${where}.defects`).map(
            (defect, defectIndex): KeyDefect => {
              const at = `${where}.defects[${defectIndex}]`;
              const value = record(defect, at);
              const lines = array(value["lines"], `${at}.lines`);
              if (lines.length !== 2) {
                throw new Error(`${at}.lines: expected two line numbers`);
              }
              return {
                id: text(value["id"], `${at}.id`),
                file: text(value["file"], `${at}.file`),
                lines: [
                  integer(lines[0], `${at}.lines[0]`),
                  integer(lines[1], `${at}.lines[1]`),
                ],
                summary: text(value["summary"], `${at}.summary`),
              };
            },
          ),
          knownFalse: readLocations(item["knownFalse"], `${where}.knownFalse`),
          unresolved:
            item["unresolved"] === undefined
              ? []
              : readLocations(item["unresolved"], `${where}.unresolved`),
        };
      },
    ),
  };
};

const readReceipt = (raw: unknown, receiptPath: string) => {
  const where = `receipt ${receiptPath}`;
  const entry = record(raw, where);
  const requested = record(entry["requested"], `${where} requested`);
  return {
    swarmId: text(entry["swarmId"], `${where} swarmId`),
    status: text(entry["status"], `${where} status`),
    wallSeconds: optionalNumber(entry["wallSeconds"]),
    head: text(requested["head"], `${where} requested.head`),
    base: text(requested["base"], `${where} requested.base`),
    candidates: array(entry["candidates"], `${where} candidates`).map(
      (candidate, index) => {
        const at = `${where} candidates[${index}]`;
        const value = record(candidate, at);
        return {
          id: text(value["id"], `${at}.id`),
          severity: text(value["severity"], `${at}.severity`),
          file: text(value["file"], `${at}.file`),
          line: integer(value["line"], `${at}.line`),
          mechanism: text(value["mechanism"], `${at}.mechanism`),
          affectedBehavior: optionalText(value["affectedBehavior"]),
          reportedBy: array(value["reportedBy"], `${at}.reportedBy`).map(
            (lane, laneIndex) => text(lane, `${at}.reportedBy[${laneIndex}]`),
          ),
        };
      },
    ),
    findings: array(entry["findings"], `${where} findings`).map(
      (finding, index) => {
        const at = `${where} findings[${index}]`;
        const value = record(finding, at);
        return {
          id: text(value["id"], `${at}.id`),
          severity: text(value["severity"], `${at}.severity`),
          status: text(value["status"], `${at}.status`),
          publication: optionalText(value["publication"]),
          evidenceStrength: optionalText(value["evidenceStrength"]),
          declaredIntent: optionalText(value["declaredIntent"]),
          verifierReason: optionalText(value["verifierReason"]),
        };
      },
    ),
    duplicates: array(entry["duplicates"] ?? [], `${where} duplicates`).map(
      (duplicate, index) =>
        text(
          record(duplicate, `${where} duplicates[${index}]`)["id"],
          `${where} duplicates[${index}].id`,
        ),
    ),
    lanes: array(entry["lanes"], `${where} lanes`).map(
      (lane, index): SheetLane => {
        const at = `${where} lanes[${index}]`;
        const value = record(lane, at);
        return {
          laneId: text(value["laneId"], `${at}.laneId`),
          role: text(value["role"], `${at}.role`),
          model: optionalText(value["model"]),
          status: text(value["status"], `${at}.status`),
          finishReason: optionalText(value["finishReason"]),
          usage: optionalUsage(value["usage"]),
        };
      },
    ),
  };
};

export function buildSheet(
  key: AnswerKey,
  configuration: string,
  receipts: readonly { receiptPath: string; receipt: unknown }[],
): Sheet {
  const sheetReceipts: SheetReceipt[] = [];
  const rows: SheetRow[] = [];
  for (const { receiptPath, receipt } of receipts) {
    const parsed = readReceipt(receipt, receiptPath);
    const keyCase = key.cases.find(
      (entry) => entry.head === parsed.head && entry.base === parsed.base,
    );
    if (!keyCase) {
      throw new Error(`receipt ${receiptPath} matches no case in the key`);
    }
    sheetReceipts.push({
      receiptPath,
      swarmId: parsed.swarmId,
      caseId: keyCase.id,
      status: parsed.status,
      wallSeconds: parsed.wallSeconds,
      lanes: parsed.lanes,
    });
    const findings = new Map(
      parsed.findings.map((finding) => [finding.id, finding]),
    );
    const duplicates = new Set(parsed.duplicates);
    for (const candidate of parsed.candidates) {
      const finding = findings.get(candidate.id);
      rows.push({
        receiptPath,
        swarmId: parsed.swarmId,
        caseId: keyCase.id,
        candidateId: candidate.id,
        file: candidate.file,
        line: candidate.line,
        severity: finding ? finding.severity : candidate.severity,
        status: finding
          ? finding.status
          : duplicates.has(candidate.id)
            ? "duplicate"
            : "unverified",
        publication: finding?.publication ?? null,
        evidenceStrength: finding?.evidenceStrength ?? null,
        declaredIntent: finding?.declaredIntent ?? null,
        reportedBy: candidate.reportedBy,
        mechanism: candidate.mechanism,
        affectedBehavior: candidate.affectedBehavior,
        verifierReason: finding?.verifierReason ?? null,
        nearKeyed: keyCase.defects
          .filter(
            (defect) =>
              defect.file === candidate.file &&
              candidate.line >= defect.lines[0] &&
              candidate.line <= defect.lines[1],
          )
          .map((defect) => defect.id),
        nearFalse: [...keyCase.knownFalse, ...keyCase.unresolved]
          .filter(
            (entry) =>
              entry.file === candidate.file &&
              Math.abs(entry.line - candidate.line) <= 30,
          )
          .map((entry) => entry.id),
        defectId: null,
        label: null,
        note: null,
      });
    }
  }
  return { version: 1, configuration, receipts: sheetReceipts, rows };
}

const readLabel = (value: unknown, where: string): Label | null => {
  if (value === null || value === undefined) return null;
  const label = LABELS.find((known) => known === value);
  if (!label) throw new Error(`${where}: ${String(value)} is not a label`);
  return label;
};

const readDefectId = (value: unknown, where: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${where}: defectId must be a string or null`);
  }
  return value;
};

const readScoringSheet = (raw: unknown, where: string): ScoringSheet => {
  const entry = record(raw, where);
  return {
    configuration: text(entry["configuration"], `${where}.configuration`),
    receipts: array(entry["receipts"], `${where}.receipts`).map(
      (receipt, index) => {
        const at = `${where}.receipts[${index}]`;
        const item = record(receipt, at);
        return {
          receiptPath: text(item["receiptPath"], `${at}.receiptPath`),
          swarmId: text(item["swarmId"], `${at}.swarmId`),
          caseId: text(item["caseId"], `${at}.caseId`),
          status: text(item["status"], `${at}.status`),
          wallSeconds: optionalNumber(item["wallSeconds"]),
          lanes: array(item["lanes"], `${at}.lanes`).map((lane, laneIndex) => {
            const laneAt = `${at}.lanes[${laneIndex}]`;
            const value = record(lane, laneAt);
            return {
              role: text(value["role"], `${laneAt}.role`),
              status: text(value["status"], `${laneAt}.status`),
              usage: optionalUsage(value["usage"]),
            };
          }),
        };
      },
    ),
    rows: array(entry["rows"], `${where}.rows`).map((row, index) => {
      const item = record(row, `${where}.rows[${index}]`);
      const swarmId = text(item["swarmId"], `${where}.rows[${index}].swarmId`);
      const candidateId = text(
        item["candidateId"],
        `${where}.rows[${index}].candidateId`,
      );
      const at = `row ${swarmId}/${candidateId}`;
      return {
        receiptPath: text(
          item["receiptPath"],
          `${at}: receiptPath is required`,
        ),
        swarmId,
        candidateId,
        status: text(item["status"], `${at}: status is required`),
        publication: optionalText(item["publication"]),
        severity: optionalText(item["severity"]),
        label: readLabel(item["label"], at),
        defectId: readDefectId(item["defectId"], at),
      };
    }),
  };
};

const isSevere = (severity: string | null): severity is "P0" | "P1" | "P2" =>
  severity === "P0" || severity === "P1" || severity === "P2";

export function buildTrials(
  key: AnswerKey,
  sheet: ScoringSheet,
): T1bScoredTrial[] {
  const cases = new Map(key.cases.map((entry) => [entry.id, entry]));
  return sheet.receipts.map((receipt) => {
    const keyCase = cases.get(receipt.caseId);
    if (!keyCase) {
      throw new Error(
        `receipt ${receipt.receiptPath} matches no case in the key`,
      );
    }
    const keyedDefectIds = keyCase.defects.map((defect) => defect.id);
    const defectIds = new Set(keyedDefectIds);
    const reviewerMatches: string[] = [];
    const confirmedMatches: string[] = [];
    const unresolvedMatches: string[] = [];
    const confirmedFindings: {
      id: string;
      severity: "P0" | "P1" | "P2";
      judgment: Label;
    }[] = [];
    const rows = sheet.rows.filter(
      (row) =>
        row.receiptPath === receipt.receiptPath &&
        row.swarmId === receipt.swarmId,
    );
    for (const row of rows) {
      const where = `row ${row.swarmId}/${row.candidateId}`;
      if (row.defectId !== null) {
        if (row.label !== "keyed-match" && row.label !== "unresolved") {
          throw new Error(
            `${where}: a row with a defectId must be labeled keyed-match or unresolved`,
          );
        }
        if (!defectIds.has(row.defectId)) {
          throw new Error(
            `${where}: ${row.defectId} is not a keyed defect of this case`,
          );
        }
        if (row.label === "keyed-match") {
          reviewerMatches.push(row.defectId);
          if (row.status === "confirmed") confirmedMatches.push(row.defectId);
        } else if (row.status === "confirmed") {
          unresolvedMatches.push(row.defectId);
        }
      }
      if (
        row.status === "confirmed" &&
        row.publication === "publishable" &&
        isSevere(row.severity)
      ) {
        if (row.label === null) {
          throw new Error(
            `${where}: a publishable confirmed finding needs a label`,
          );
        }
        confirmedFindings.push({
          id: row.candidateId,
          severity: row.severity,
          judgment: row.label,
        });
      }
    }
    const usage = receipt.lanes.reduce(
      (total, lane) => ({
        inputTokens: total.inputTokens + (lane.usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + (lane.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    return {
      attemptId: receipt.swarmId,
      caseId: keyCase.id,
      configuration: sheet.configuration,
      incident: keyCase.incident,
      family: keyCase.family,
      outcome:
        receipt.status === "completed"
          ? ("completed" as const)
          : receipt.status === "partial"
            ? ("partial" as const)
            : ("failed" as const),
      publishable: receipt.status === "completed",
      cleanControl: keyCase.cleanControl,
      keyedDefectIds,
      reviewerMatches: [...new Set(reviewerMatches)],
      confirmedMatches: [...new Set(confirmedMatches)],
      unresolvedMatches: [...new Set(unresolvedMatches)],
      confirmedFindings,
      usage,
      wallSeconds: receipt.wallSeconds,
      cost: null,
    };
  });
}

const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const flags = (argv: string[], name: string) =>
  argv.flatMap((argument, index) => {
    const value = argv[index + 1];
    return argument === `--${name}` && value !== undefined ? [value] : [];
  });

const sheetCommand = async (argv: string[]) => {
  const keyPath = flag(argv, "key");
  if (!keyPath) throw new Error("--key is required");
  const configuration = flag(argv, "configuration");
  if (!configuration) throw new Error("--configuration is required");
  const receiptPaths = flags(argv, "receipt");
  if (receiptPaths.length === 0) throw new Error("--receipt is required");
  const out = flag(argv, "out");
  if (!out) throw new Error("--out is required");
  if (existsSync(out)) {
    throw new Error(`sheet ${out} exists; label it or remove it`);
  }
  const key = readKey(JSON.parse(await readFile(keyPath, "utf8")));
  const receipts = await Promise.all(
    receiptPaths.map(async (receiptPath) => ({
      receiptPath,
      receipt: JSON.parse(await readFile(receiptPath, "utf8")) as unknown,
    })),
  );
  const sheet = buildSheet(key, configuration, receipts);
  await writeFile(out, `${JSON.stringify(sheet, null, 2)}\n`);
  console.log(`sheet: ${out}`);
};

const scoreCommand = async (argv: string[]) => {
  const keyPath = flag(argv, "key");
  if (!keyPath) throw new Error("--key is required");
  const sheetPaths = flags(argv, "sheet");
  if (sheetPaths.length === 0) throw new Error("--sheet is required");
  const key = readKey(JSON.parse(await readFile(keyPath, "utf8")));
  const sheets = await Promise.all(
    sheetPaths.map(async (sheetPath) =>
      readScoringSheet(
        JSON.parse(await readFile(sheetPath, "utf8")),
        `sheet ${sheetPath}`,
      ),
    ),
  );
  const trials = new Map<string, T1bScoredTrial[]>();
  const laneFailures = new Map<string, number>();
  const advisories = new Map<string, number>();
  const advisoryMatches = new Map<string, number>();
  for (const sheet of sheets) {
    const configuration = sheet.configuration;
    const bucket = trials.get(configuration) ?? [];
    bucket.push(...buildTrials(key, sheet));
    trials.set(configuration, bucket);
    const reviewerLanes = sheet.receipts
      .flatMap((receipt) => receipt.lanes)
      .filter(
        (lane) => lane.role === "reviewer" && lane.status !== "completed",
      );
    laneFailures.set(
      configuration,
      (laneFailures.get(configuration) ?? 0) + reviewerLanes.length,
    );
    const advisory = sheet.rows.filter(
      (row) => row.status === "confirmed" && row.publication === "advisory",
    );
    advisories.set(
      configuration,
      (advisories.get(configuration) ?? 0) + advisory.length,
    );
    advisoryMatches.set(
      configuration,
      (advisoryMatches.get(configuration) ?? 0) +
        advisory.filter((row) => row.defectId !== null).length,
    );
  }
  const report = Object.fromEntries(
    [...trials.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([configuration, entries]) => [
        configuration,
        {
          trials: entries.length,
          completed: entries.filter((entry) => entry.outcome === "completed")
            .length,
          partial: entries.filter((entry) => entry.outcome === "partial")
            .length,
          failed: entries.filter((entry) => entry.outcome === "failed").length,
          laneFailures: laneFailures.get(configuration) ?? 0,
          advisories: advisories.get(configuration) ?? 0,
          advisoryMatches: advisoryMatches.get(configuration) ?? 0,
          score: scoreT1b(entries),
        },
      ]),
  );
  console.log(JSON.stringify(report));
};

const main = async () => {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "sheet") return sheetCommand(argv);
  if (command === "score") return scoreCommand(argv);
  throw new Error(`unknown command ${command ?? ""}`);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  });
}
