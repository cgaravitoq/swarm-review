/**
 * Provider caps, whole-trial reservation and accounting.
 *
 * A trial is admitted before it starts or not at all: the coordinator reserves
 * the combined worst case of every nested Pi session it is about to open, so
 * neither concurrent lanes nor the last admitted session can walk past the
 * sub-cap. Rates and subscription allocation are inputs, never defaults - an
 * unpriced provider fails admission instead of reserving zero, because a
 * silently zeroed rate is how a ceiling stops being a ceiling.
 *
 * The enforcement half lives in `container/model-broker.mjs`, the only process
 * that can reach the provider. This module owns the arithmetic and the contract
 * the coordinator in `swarm.ts` calls.
 */

/** Where one provider's requests go, and what its URL still needs filled in. */
export type ProviderUpstream = {
  baseUrl: string;
  accountIdPlaceholder?: string;
  gatewayIdPlaceholder?: string;
};

/**
 * Upstream endpoints the broker may forward to, per Pi's own provider table.
 *
 * A `Map` rather than an object because the lookup key is a provider name the
 * caller supplies, and an object indexed by an open key is a dictionary whose
 * known entries the type system cannot hold on to.
 */
export const PROVIDER_UPSTREAM = new Map<string, ProviderUpstream>([
  ["openai-codex", { baseUrl: "https://chatgpt.com/backend-api" }],
  ["opencode-go", { baseUrl: "https://opencode.ai/zen/go/v1" }],
  ["xai", { baseUrl: "https://api.x.ai/v1" }],
  // The subscription is Anthropic's own, and the request shape that makes it
  // usable is built by the image's Claude Code provider, not by the broker.
  ["claude-code", { baseUrl: "https://api.anthropic.com" }],
  [
    "cloudflare-workers-ai",
    {
      baseUrl:
        "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
      accountIdPlaceholder: "{CLOUDFLARE_ACCOUNT_ID}",
    },
  ],
  // The gateway's OpenAI-compatible endpoint, where the model name carries its
  // own provider: `anthropic/claude-opus-5`, `workers-ai/@cf/...`. Which of
  // them answer depends on the keys stored in the gateway, not on this table.
  [
    "cloudflare-ai-gateway",
    {
      baseUrl:
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
      accountIdPlaceholder: "{CLOUDFLARE_ACCOUNT_ID}",
      gatewayIdPlaceholder: "{CLOUDFLARE_GATEWAY_ID}",
    },
  ],
]);

export type SessionCaps = {
  maxRequests: number;
  maxRetriesPerRequest: number;
  maxInputTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxCumulativeInputTokens: number;
  maxCumulativeOutputTokens: number;
  maxRequestBytes: number;
};

/** The frozen per-session caps from the wave plan, by trial kind. */
export const SESSION_CAPS = {
  t1a: {
    maxRequests: 8,
    maxRetriesPerRequest: 1,
    maxInputTokensPerRequest: 131072,
    maxOutputTokensPerRequest: 8192,
    maxCumulativeInputTokens: 250000,
    maxCumulativeOutputTokens: 16000,
    maxRequestBytes: 8 * 1024 * 1024,
  },
  // A reviewer that clones the repository spends its requests on tools, not on
  // one long answer: measured lanes land between 22 and 32. A ceiling at 32 is
  // not a guard against a runaway lane, it is a coin flip that throws away ten
  // minutes of finished work, so every cumulative cap here is doubled with it.
  // The input cap counts the whole context of every call, cached or not, so
  // it is sized for the request cap at a 200k window: a lane that spends its
  // 64 requests is stopped by the request cap, not by the token cap two
  // requests earlier.
  t1b: {
    maxRequests: 64,
    maxRetriesPerRequest: 1,
    maxInputTokensPerRequest: 1048576,
    maxOutputTokensPerRequest: 16384,
    maxCumulativeInputTokens: 12000000,
    maxCumulativeOutputTokens: 128000,
    maxRequestBytes: 32 * 1024 * 1024,
  },
} satisfies Record<"t1a" | "t1b", SessionCaps>;

/**
 * How a provider bills, supplied by the caller.
 *
 * `paid` needs both rates. `subscription` carries no marginal cash cost but is
 * not free: it needs the owner-supplied seat price and the predeclared monthly
 * capacity so the amortized allocation is computed rather than asserted.
 */
export type ProviderRates =
  | {
      billing: "paid";
      inputUsdPerMillionTokens: number;
      outputUsdPerMillionTokens: number;
    }
  | {
      billing: "subscription";
      monthlySeatUsd: number;
      monthlyCapacityTokens: number;
    }
  | { billing: "unknown" };

export type TrialReservationRequest = {
  trialId: string;
  provider: string;
  /** Names the frozen caps for sessions that do not carry their own. */
  trialKind?: "t1a" | "t1b";
  sessions: Array<{ sessionId: string; caps?: SessionCaps }>;
  rates: ProviderRates;
  remainingSubCapUsd: number;
};

const worstCaseTokens = (caps: SessionCaps) => ({
  input: caps.maxCumulativeInputTokens * (1 + caps.maxRetriesPerRequest),
  output: caps.maxCumulativeOutputTokens * (1 + caps.maxRetriesPerRequest),
});

/** Worst-case marginal cash for one session under its caps and the given rates. */
export function worstCaseSessionUsd(caps: SessionCaps, rates: ProviderRates) {
  if (rates.billing === "unknown") {
    throw new Error(
      "cannot price a session while the billing basis is unknown",
    );
  }
  if (rates.billing === "subscription") return 0;
  const tokens = worstCaseTokens(caps);
  return (
    (tokens.input * rates.inputUsdPerMillionTokens) / 1_000_000 +
    (tokens.output * rates.outputUsdPerMillionTokens) / 1_000_000
  );
}

/** Amortized subscription allocation for one session's worst-case token draw. */
export function worstCaseSessionAllocationUsd(
  caps: SessionCaps,
  rates: ProviderRates,
) {
  if (rates.billing !== "subscription") return 0;
  if (!(rates.monthlyCapacityTokens > 0)) {
    throw new Error(
      "subscription allocation needs a positive monthly capacity denominator",
    );
  }
  const tokens = worstCaseTokens(caps);
  return (
    ((tokens.input + tokens.output) * rates.monthlySeatUsd) /
    rates.monthlyCapacityTokens
  );
}

export type TrialReservation = {
  trialId: string;
  provider: string;
  billing: ProviderRates["billing"];
  reservedUsd: number;
  reservedAllocationUsd: number;
  sessions: Array<{
    sessionId: string;
    caps: SessionCaps;
    reservedUsd: number;
    reservedAllocationUsd: number;
  }>;
};

/**
 * Admits a whole trial, or refuses it with the reason.
 *
 * Every nested session is priced at its cap before the first of them opens,
 * because a per-session check admits the last session of a trial that the
 * remaining budget could never have covered.
 */
export function reserveTrial(request: TrialReservationRequest):
  | { admitted: true; reservation: TrialReservation }
  | {
      admitted: false;
      reason: string;
    } {
  if (request.sessions.length === 0) {
    return { admitted: false, reason: "a trial reserves at least one session" };
  }
  if (request.rates.billing === "unknown") {
    return {
      admitted: false,
      reason: `billing basis for ${request.provider} is unknown`,
    };
  }
  // The coordinator names the trial kind; the caps themselves stay frozen here,
  // so a caller cannot widen a ceiling by describing its own sessions.
  const declaredCaps = request.trialKind
    ? SESSION_CAPS[request.trialKind]
    : undefined;
  let reservedUsd = 0;
  let reservedAllocationUsd = 0;
  const sessions: TrialReservation["sessions"] = [];
  for (const session of request.sessions) {
    const caps = session.caps ?? declaredCaps;
    if (!caps) {
      return {
        admitted: false,
        reason: `session ${session.sessionId} has neither caps nor a trial kind to take them from`,
      };
    }
    const usd = worstCaseSessionUsd(caps, request.rates);
    const allocation = worstCaseSessionAllocationUsd(caps, request.rates);
    reservedUsd += usd;
    reservedAllocationUsd += allocation;
    sessions.push({
      sessionId: session.sessionId,
      caps,
      reservedUsd: usd,
      reservedAllocationUsd: allocation,
    });
  }
  if (reservedUsd > request.remainingSubCapUsd) {
    return {
      admitted: false,
      reason: `worst case ${reservedUsd.toFixed(4)} USD exceeds the remaining ${request.remainingSubCapUsd.toFixed(4)} USD sub-cap`,
    };
  }
  return {
    admitted: true,
    reservation: {
      trialId: request.trialId,
      provider: request.provider,
      billing: request.rates.billing,
      reservedUsd,
      reservedAllocationUsd,
      sessions,
    },
  };
}

export type LedgerEntry = {
  event: string;
  status?: number;
  usage?: { input: number; output: number } | null;
  totals?: { requests: number; retries: number; input: number; output: number };
};

/** Actual provider activity as the broker recorded it, never as Pi reported it. */
export function readLedgerUsage(ledger: string) {
  const entries = ledger
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
  const last = [...entries]
    .reverse()
    .find((entry) => entry.totals !== undefined);
  return {
    requests: last?.totals?.requests ?? 0,
    retries: last?.totals?.retries ?? 0,
    inputTokens: last?.totals?.input ?? 0,
    outputTokens: last?.totals?.output ?? 0,
    denials: entries.filter((entry) => entry.event === "denied").length,
  };
}

/**
 * Replaces a reservation with what the run actually spent, keeping both.
 *
 * A reservation that is never settled is still outstanding budget, so the
 * settled record carries the reservation it releases rather than overwriting it.
 */
export function settleReservation(
  reservation: TrialReservation,
  actual: ReturnType<typeof readLedgerUsage>,
  rates: ProviderRates,
) {
  const actualUsd =
    rates.billing === "paid"
      ? (actual.inputTokens * rates.inputUsdPerMillionTokens) / 1_000_000 +
        (actual.outputTokens * rates.outputUsdPerMillionTokens) / 1_000_000
      : 0;
  const actualAllocationUsd =
    rates.billing === "subscription"
      ? ((actual.inputTokens + actual.outputTokens) * rates.monthlySeatUsd) /
        rates.monthlyCapacityTokens
      : 0;
  return { reservation, actual, actualUsd, actualAllocationUsd };
}

/**
 * The coordinator contract: `reserve` prices a whole trial, `settle` closes it.
 *
 * Both read one JSON document on argv and print one JSON document, so `swarm.ts`
 * can call this through the same subprocess boundary it already uses without
 * importing the local driver.
 */
async function main() {
  const [command, payload] = process.argv.slice(2);
  if (!payload) throw new Error("a JSON payload argument is required");
  const input: unknown = JSON.parse(payload);
  if (command === "reserve") {
    console.log(
      JSON.stringify(reserveTrial(input as TrialReservationRequest), null, 2),
    );
    return;
  }
  if (command === "settle") {
    const { reservation, ledger, rates } = input as {
      reservation: TrialReservation;
      ledger: string;
      rates: ProviderRates;
    };
    console.log(
      JSON.stringify(
        settleReservation(reservation, readLedgerUsage(ledger), rates),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`unknown command: ${String(command)}`);
}

if (import.meta.main) {
  await main();
}
