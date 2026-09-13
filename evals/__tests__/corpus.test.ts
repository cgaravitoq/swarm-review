import { describe, expect, it } from "vitest";
import {
  assertPacketsAreNeutral,
  buildBlindPackets,
  type CaseRecord,
  familyPartition,
  hashArtifact,
  NEUTRAL_ADJUDICATION_PROTOCOL,
  partitionReceipts,
  validatePartition,
} from "../corpus";

/** The real wave cases, including the #6545 receipt whose head does not match. */
const CASES: CaseRecord[] = [
  {
    id: "case-6515-reader-cli",
    incident: "pr-6515",
    family: "reader-toolchain",
    disposition: "development",
    pullRequest: 6515,
    head: "ff3583b499e7a3349c9538fef82ab71662cdb5ca",
    base: "c80f49e5f83910a136406cf202b7cda2965b8b9a",
    receipts: [
      {
        path: "real-swarm-6515/p5-6515-gpt-grok/swarm-receipt.json",
        head: "ff3583b499e7a3349c9538fef82ab71662cdb5ca",
        base: "c80f49e5f83910a136406cf202b7cda2965b8b9a",
      },
    ],
  },
  {
    id: "case-6520-preview-egress",
    incident: "pr-6520",
    family: "rollout-and-egress",
    disposition: "development",
    pullRequest: 6520,
    head: "e1eda051981b48094c27ec348a12e7cde238167b",
    base: "01fd39f2ed915750933510730241b03c3dd5560c",
    receipts: [
      {
        path: "real-swarm-6520/p5-6520-gpt-grok/swarm-receipt.json",
        head: "e1eda051981b48094c27ec348a12e7cde238167b",
        base: "01fd39f2ed915750933510730241b03c3dd5560c",
      },
    ],
  },
  {
    id: "case-6545-migration",
    incident: "pr-6545",
    family: "migration-coexistence",
    disposition: "challenge",
    pullRequest: 6545,
    head: "aad3d974a5d49b9b26bd98fe4146317d2cd69ca8",
    base: "25e6dc1399d2ab9b4641416aae2a73864e790c25",
    receipts: [
      {
        path: "real-swarm-6545b/pr6545b/swarm-receipt.json",
        head: "aad3d974a5d49b9b26bd98fe4146317d2cd69ca8",
        base: "25e6dc1399d2ab9b4641416aae2a73864e790c25",
      },
      {
        path: "real-swarm-6545/pr6545/swarm-receipt.json",
        head: "8d77356ccb228b9407e00086b145583256221c2b",
        base: "63f7d2d574d350a35d8ca04f10a25c9774c8915a",
      },
    ],
  },
  {
    id: "case-6537-logger",
    incident: "pr-6537",
    family: "observability",
    disposition: "development",
    pullRequest: 6537,
    head: "f94a3e1920e557ed74963fd44f69855956e1cd47",
    base: "5284963b3db7e3411edc5ea9dff3656feae4366f",
    receipts: [],
  },
];

describe("partitionReceipts", () => {
  it("quarantines the #6545 receipt whose head is a different commit", () => {
    const { kept, quarantined } = partitionReceipts(CASES);

    expect(kept.map((entry) => entry.path)).toEqual([
      "real-swarm-6515/p5-6515-gpt-grok/swarm-receipt.json",
      "real-swarm-6520/p5-6520-gpt-grok/swarm-receipt.json",
      "real-swarm-6545b/pr6545b/swarm-receipt.json",
    ]);
    expect(quarantined).toEqual([
      {
        path: "real-swarm-6545/pr6545/swarm-receipt.json",
        declaredCase: "case-6545-migration",
        receiptHead: "8d77356ccb228b9407e00086b145583256221c2b",
        caseHead: "aad3d974a5d49b9b26bd98fe4146317d2cd69ca8",
        reason: "head does not match the case checkout",
      },
    ]);
  });
});

describe("familyPartition", () => {
  it("groups whole families and reports mechanism coverage", () => {
    const partition = familyPartition(CASES);

    expect(partition.map((group) => group.family)).toEqual([
      "migration-coexistence",
      "observability",
      "reader-toolchain",
      "rollout-and-egress",
    ]);
    expect(validatePartition(partition, 4)).toEqual({
      families: 4,
      cases: 4,
      holdoutEligibleFamilies: 0,
      problems: [],
    });
  });

  it("refuses an incident split across two families", () => {
    expect(() =>
      familyPartition([
        ...CASES,
        { ...(CASES[0] as CaseRecord), id: "case-6515-b", family: "other" },
      ]),
    ).toThrow(/split across families/);
  });

  it("refuses a case relabelled as unseen holdout evidence", () => {
    expect(() =>
      familyPartition([
        { ...(CASES[0] as CaseRecord), disposition: "holdout" as never },
      ]),
    ).toThrow(/development or challenge/);
  });

  it("reports too few mechanism families as a problem, not a pass", () => {
    const partition = familyPartition(CASES.slice(0, 2));
    expect(validatePartition(partition, 4).problems).toEqual([
      "2 mechanism families, fewer than the 4 the design needs",
    ]);
  });
});

describe("buildBlindPackets", () => {
  it("hides every label an adjudicator could read the answer from", () => {
    const packets = assertPacketsAreNeutral(
      buildBlindPackets(CASES, "seed-2026-09-08"),
      CASES,
    );

    expect(packets.packets).toHaveLength(4);
    expect(Object.keys(packets.packets[0] ?? {})).toEqual([
      "packetId",
      "head",
      "base",
    ]);
  });

  it("shuffles reproducibly from the recorded seed", () => {
    const first = buildBlindPackets(CASES, "seed-a");
    const second = buildBlindPackets(CASES, "seed-a");
    const other = buildBlindPackets(CASES, "seed-b");

    expect(first).toEqual(second);
    expect(first.packets.map((packet) => packet.head)).not.toEqual(
      other.packets.map((packet) => packet.head),
    );
  });

  it("rejects a packet set that leaked a case identifier", () => {
    const leaked = buildBlindPackets(CASES, "seed-a");
    const packets = {
      ...leaked,
      packets: leaked.packets.map((packet) => ({
        ...packet,
        note: "case-6537-logger",
      })),
    };
    expect(() => assertPacketsAreNeutral(packets, CASES)).toThrow(
      /leak case-6537-logger/,
    );
  });
});

describe("NEUTRAL_ADJUDICATION_PROTOCOL", () => {
  it("names the wave documents an adjudicator must not read", () => {
    expect(NEUTRAL_ADJUDICATION_PROTOCOL.forbiddenInputs).toContain(
      "the wave plan, wave state or original brief",
    );
    expect(NEUTRAL_ADJUDICATION_PROTOCOL.decisions).toContain("cannot-decide");
    expect(hashArtifact(NEUTRAL_ADJUDICATION_PROTOCOL)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
