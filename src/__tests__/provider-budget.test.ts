import { describe, expect, it } from "vitest";
import {
  PROVIDER_UPSTREAM,
  readLedgerUsage,
  reserveTrial,
  SESSION_CAPS,
  settleReservation,
  worstCaseSessionAllocationUsd,
  worstCaseSessionUsd,
} from "../provider-budget";

const paid = {
  billing: "paid" as const,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 10,
};

describe("worst-case pricing", () => {
  it("prices a session at its caps including the permitted retry", () => {
    // t1a: 250000 input and 16000 output per session, one retry each.
    expect(worstCaseSessionUsd(SESSION_CAPS.t1a, paid)).toBeCloseTo(
      (500000 * 1) / 1_000_000 + (32000 * 10) / 1_000_000,
      10,
    );
  });

  it("refuses to price a session whose billing basis is unknown", () => {
    expect(() =>
      worstCaseSessionUsd(SESSION_CAPS.t1a, { billing: "unknown" }),
    ).toThrow(/billing basis is unknown/);
  });

  it("charges a subscription session no cash but a computed allocation", () => {
    const rates = {
      billing: "subscription" as const,
      monthlySeatUsd: 200,
      monthlyCapacityTokens: 1_000_000_000,
    };
    expect(worstCaseSessionUsd(SESSION_CAPS.t1a, rates)).toBe(0);
    expect(worstCaseSessionAllocationUsd(SESSION_CAPS.t1a, rates)).toBeCloseTo(
      ((500000 + 32000) * 200) / 1_000_000_000,
      12,
    );
  });

  it("refuses an allocation with no declared capacity denominator", () => {
    expect(() =>
      worstCaseSessionAllocationUsd(SESSION_CAPS.t1a, {
        billing: "subscription",
        monthlySeatUsd: 200,
        monthlyCapacityTokens: 0,
      }),
    ).toThrow(/positive monthly capacity denominator/);
  });
});

describe("whole-trial reservation", () => {
  const sessions = [
    { sessionId: "reviewer-1", caps: SESSION_CAPS.t1a },
    { sessionId: "reviewer-2", caps: SESSION_CAPS.t1a },
    { sessionId: "verifier", caps: SESSION_CAPS.t1a },
  ];

  it("reserves every nested session before the first one opens", () => {
    const result = reserveTrial({
      trialId: "trial-1",
      provider: "xai",
      sessions,
      rates: paid,
      remainingSubCapUsd: 5,
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    const perSession = (500000 * 1 + 32000 * 10) / 1_000_000;
    expect(result.reservation.reservedUsd).toBeCloseTo(perSession * 3, 10);
    expect(result.reservation.sessions).toHaveLength(3);
  });

  it("refuses a trial whose combined worst case exceeds the sub-cap", () => {
    const perSession = (500000 * 1 + 32000 * 10) / 1_000_000;
    const result = reserveTrial({
      trialId: "trial-2",
      provider: "xai",
      sessions,
      rates: paid,
      // Enough for two sessions, not for the three this trial will open.
      remainingSubCapUsd: perSession * 2,
    });
    expect(result).toMatchObject({ admitted: false });
    if (result.admitted) return;
    expect(result.reason).toMatch(/exceeds the remaining/);
  });

  it("refuses a trial whose billing basis is unknown instead of reserving zero", () => {
    const result = reserveTrial({
      trialId: "trial-3",
      provider: "cloudflare-workers-ai",
      sessions,
      rates: { billing: "unknown" },
      remainingSubCapUsd: 1000,
    });
    expect(result).toMatchObject({
      admitted: false,
      reason: "billing basis for cloudflare-workers-ai is unknown",
    });
  });

  it("takes the frozen caps from the named trial kind when a session omits them", () => {
    const named = reserveTrial({
      trialId: "trial-6",
      provider: "xai",
      trialKind: "t1a",
      sessions: [{ sessionId: "reviewer-1" }, { sessionId: "verifier" }],
      rates: paid,
      remainingSubCapUsd: 5,
    });
    const explicit = reserveTrial({
      trialId: "trial-6",
      provider: "xai",
      sessions: [
        { sessionId: "reviewer-1", caps: SESSION_CAPS.t1a },
        { sessionId: "verifier", caps: SESSION_CAPS.t1a },
      ],
      rates: paid,
      remainingSubCapUsd: 5,
    });
    expect(named.admitted).toBe(true);
    if (!named.admitted || !explicit.admitted) return;
    expect(named.reservation).toEqual(explicit.reservation);
    expect(named.reservation.sessions[0]?.caps).toEqual(SESSION_CAPS.t1a);
  });

  it("refuses a session with neither caps nor a trial kind rather than pricing it at zero", () => {
    const result = reserveTrial({
      trialId: "trial-7",
      provider: "xai",
      sessions: [{ sessionId: "reviewer-1" }],
      rates: paid,
      remainingSubCapUsd: 5,
    });
    expect(result).toMatchObject({ admitted: false });
    if (result.admitted) return;
    expect(result.reason).toMatch(/neither caps nor a trial kind/);
  });

  it("refuses a trial that reserves nothing", () => {
    expect(
      reserveTrial({
        trialId: "trial-4",
        provider: "xai",
        sessions: [],
        rates: paid,
        remainingSubCapUsd: 1000,
      }),
    ).toMatchObject({ admitted: false });
  });
});

describe("actual usage accounting", () => {
  const ledger = [
    JSON.stringify({ event: "broker_start" }),
    JSON.stringify({
      event: "provider_request",
      status: 200,
      usage: { input: 1000, output: 100 },
      totals: { requests: 1, retries: 0, input: 1000, output: 100 },
    }),
    JSON.stringify({
      event: "provider_request",
      status: 200,
      usage: { input: 2000, output: 300 },
      totals: { requests: 3, retries: 1, input: 3000, output: 400, unended: 1 },
    }),
    JSON.stringify({ event: "denied", reason: "max_requests" }),
  ].join("\n");

  it("reads counts from the broker ledger rather than the reviewed run", () => {
    expect(readLedgerUsage(ledger)).toEqual({
      requests: 3,
      retries: 1,
      inputTokens: 3000,
      outputTokens: 400,
      denials: 1,
      // Three slots were spent and the ledger's last totals say one of them was
      // never seen to end: the tokens beside it are one request short, and the
      // row has to say so rather than price a request it never read.
      unended: 1,
    });
  });

  it("keeps the reservation beside the settled actual cost", () => {
    const reserved = reserveTrial({
      trialId: "trial-5",
      provider: "xai",
      sessions: [{ sessionId: "verifier", caps: SESSION_CAPS.t1a }],
      rates: paid,
      remainingSubCapUsd: 5,
    });
    expect(reserved.admitted).toBe(true);
    if (!reserved.admitted) return;
    const settled = settleReservation(
      reserved.reservation,
      readLedgerUsage(ledger),
      paid,
    );
    expect(settled.actualUsd).toBeCloseTo(
      (3000 * 1) / 1_000_000 + (400 * 10) / 1_000_000,
      12,
    );
    expect(settled.reservation.reservedUsd).toBeGreaterThan(settled.actualUsd);
    expect(settled.actual.denials).toBe(1);
  });
});

describe("upstream table", () => {
  it("routes the default provider through its account-scoped endpoint", () => {
    expect(PROVIDER_UPSTREAM.get("cloudflare-workers-ai")).toEqual({
      baseUrl:
        "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
      accountIdPlaceholder: "{CLOUDFLARE_ACCOUNT_ID}",
    });
  });
});
