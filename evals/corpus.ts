/**
 * C0: the case inventory, its family partition and the blind packets.
 *
 * Everything downstream is only as honest as this file. A case whose commits
 * are not in the local object store cannot be replayed, two cases from one
 * incident are not two independent observations, and a case the instrument's
 * authors have already read is development material forever - relabelling it
 * later as unseen evidence is how a corpus flatters the thing it measures.
 *
 * Packets carry source identity and nothing else: no proposed label, no
 * platform, lane, provider or configuration, so an adjudicator cannot infer the
 * answer from who produced the finding.
 */

import { createHash } from "node:crypto";

/** Every case already read by this wave; none may become holdout evidence. */
export const DISPOSITIONS = ["development", "challenge"] as const;

export type CaseRecord = {
  id: string;
  incident: string;
  family: string;
  disposition: (typeof DISPOSITIONS)[number];
  pullRequest: number | null;
  head: string;
  base: string;
  /** Receipts that describe this exact checkout; a mismatch is quarantined. */
  receipts: readonly { path: string; head: string; base: string }[];
};

export type QuarantinedReceipt = {
  path: string;
  declaredCase: string;
  receiptHead: string;
  caseHead: string;
  reason: string;
};

const assertCase = (entry: CaseRecord) => {
  for (const field of ["id", "incident", "family", "head", "base"] as const) {
    if (!entry[field])
      throw new Error(`case ${entry.id}: ${field} is required`);
  }
  if (!DISPOSITIONS.includes(entry.disposition)) {
    throw new Error(
      `case ${entry.id}: disposition must be development or challenge`,
    );
  }
  if (entry.head === entry.base) {
    throw new Error(`case ${entry.id}: head and base are the same commit`);
  }
  return entry;
};

/**
 * Splits receipts into the ones that actually replay their case and the ones
 * that do not. A receipt whose head is a different commit is evidence about a
 * different change, whatever the pull request number on it says.
 */
export function partitionReceipts(cases: readonly CaseRecord[]) {
  const kept: { caseId: string; path: string }[] = [];
  const quarantined: QuarantinedReceipt[] = [];
  for (const entry of cases) {
    for (const receipt of entry.receipts) {
      if (receipt.head === entry.head && receipt.base === entry.base) {
        kept.push({ caseId: entry.id, path: receipt.path });
        continue;
      }
      quarantined.push({
        path: receipt.path,
        declaredCase: entry.id,
        receiptHead: receipt.head,
        caseHead: entry.head,
        reason:
          receipt.head === entry.head
            ? "base does not match the case checkout"
            : "head does not match the case checkout",
      });
    }
  }
  return { kept, quarantined };
}

/**
 * Groups cases into whole-family partitions.
 *
 * Before/fix pairs, neighbouring negatives, synthetic variants and several
 * defects from one pull request travel together: split them and a model that
 * has seen one half has effectively seen the other.
 */
export function familyPartition(cases: readonly CaseRecord[]) {
  const byFamily = new Map<string, CaseRecord[]>();
  for (const entry of cases) {
    assertCase(entry);
    const bucket = byFamily.get(entry.family) ?? [];
    bucket.push(entry);
    byFamily.set(entry.family, bucket);
  }
  const incidentToFamily = new Map<string, string>();
  for (const entry of cases) {
    const seen = incidentToFamily.get(entry.incident);
    if (seen && seen !== entry.family) {
      throw new Error(
        `incident ${entry.incident} is split across families ${seen} and ${entry.family}`,
      );
    }
    incidentToFamily.set(entry.incident, entry.family);
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([family, members]) => ({
      family,
      dispositions: [
        ...new Set(members.map((entry) => entry.disposition)),
      ].sort(),
      incidents: [...new Set(members.map((entry) => entry.incident))].sort(),
      cases: members.map((entry) => entry.id).sort(),
    }));
}

/**
 * Rejects a partition that cannot support the design it claims to support.
 *
 * Coverage is reported by mechanism family rather than by case count because
 * eight cases from one family answer one question eight times.
 */
export function validatePartition(
  partition: ReturnType<typeof familyPartition>,
  minimumFamilies: number,
) {
  const problems: string[] = [];
  if (partition.length < minimumFamilies) {
    problems.push(
      `${partition.length} mechanism families, fewer than the ${minimumFamilies} the design needs`,
    );
  }
  for (const group of partition) {
    if (group.dispositions.length > 1) {
      problems.push(
        `family ${group.family} spans ${group.dispositions.join(" and ")}; a family is assigned whole`,
      );
    }
  }
  return {
    families: partition.length,
    cases: partition.reduce((total, group) => total + group.cases.length, 0),
    holdoutEligibleFamilies: 0,
    problems,
  };
}

const stableOrder = (ids: readonly string[], seed: string) =>
  [...ids].sort((a, b) => {
    const keyed = (id: string) =>
      createHash("sha256").update(`${seed}:${id}`).digest("hex");
    const left = keyed(a);
    const right = keyed(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

/**
 * Builds the neutral packets an adjudicator sees.
 *
 * The order is shuffled by a recorded seed rather than by chance, so the
 * blinding is reproducible and a later reader can prove no packet was reordered
 * after the judgements came back.
 */
export function buildBlindPackets(cases: readonly CaseRecord[], seed: string) {
  const order = stableOrder(
    cases.map((entry) => entry.id),
    seed,
  );
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  return {
    seed,
    packets: order.map((id, index) => {
      const entry = byId.get(id);
      if (!entry) throw new Error(`packet ${id} has no case`);
      return {
        packetId: `packet-${String(index + 1).padStart(3, "0")}`,
        head: entry.head,
        base: entry.base,
        // Deliberately absent: case id, family, incident, disposition,
        // proposed label, platform, lane, provider and configuration.
      };
    }),
  };
}

/** Proves a packet set carries nothing an adjudicator could read the answer from. */
export function assertPacketsAreNeutral(
  packets: ReturnType<typeof buildBlindPackets>,
  cases: readonly CaseRecord[],
) {
  const forbidden = new Set<string>();
  for (const entry of cases) {
    forbidden.add(entry.id);
    forbidden.add(entry.family);
    forbidden.add(entry.incident);
    forbidden.add(entry.disposition);
  }
  const serialized = JSON.stringify(packets.packets);
  for (const value of forbidden) {
    if (serialized.includes(value)) {
      throw new Error(`blind packets leak ${value}`);
    }
  }
  if (packets.packets.length !== cases.length) {
    throw new Error("blind packets do not cover every case");
  }
  return packets;
}

export const hashArtifact = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The protocol both key adjudicators receive, and nothing else about the wave. */
export const NEUTRAL_ADJUDICATION_PROTOCOL = {
  version: 1,
  inputs: [
    "the repository AGENTS.md",
    "this protocol",
    "your assigned blinded packets",
  ],
  forbiddenInputs: [
    "the wave plan, wave state or original brief",
    "any inventory that names a case, family, incident or disposition",
    "the other adjudicator's judgements",
    "any review text, label, platform, lane, provider or configuration",
  ],
  task: "For each packet, read the base and head trees and their diff, then decide whether the change contains a defect a reviewer should have reported, and name it in your own words.",
  decisions: ["defect", "no-defect", "cannot-decide"],
  rules: [
    "Decide from the source in front of you; do not search for the change elsewhere.",
    "Record cannot-decide rather than guessing; an excluded case costs less than a wrong key.",
    "Do not read another packet's judgement before finishing your own.",
  ],
} as const;
