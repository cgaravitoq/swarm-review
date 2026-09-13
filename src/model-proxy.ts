/**
 * Model transport for the container, mirroring the git proxy.
 *
 * The sandbox SDK control API runs as root, so no container uid can hold the
 * provider bearer. The Worker Durable Object keeps the credential and the
 * usage counters; the container only receives a nonsecret handle and a
 * run-scoped URL under /model/<runId>/<capability>/.
 */

import { assertCloudRunId } from "./isolation";

export type ModelCaps = {
  maxRequests: number;
  maxRetriesPerRequest: number;
  maxCumulativeInputTokens: number;
  maxCumulativeOutputTokens: number;
  maxRequestBytes: number;
};

export type ModelTotals = {
  requests: number;
  retries: number;
  input: number;
  output: number;
};

export type ModelSession = {
  handle: string;
  upstreamBaseUrl: string;
  upstreamAuthorization: string;
  upstreamAccountId?: string;
  caps: ModelCaps;
  totals: ModelTotals;
};

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function modelCapability(runId: string, secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:model:${runId}`),
  );
  return hex(digest);
}

export function modelProxyBaseUrl(
  origin: string,
  runId: string,
  capability: string,
) {
  return `${origin}/model/${runId}/${capability}`;
}

export function modelsJsonForProxy(
  modelsJson: string,
  provider: string,
  handle: string,
  baseUrl: string,
) {
  const parsed: unknown = JSON.parse(modelsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("models.json: expected a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  const providers = (
    typeof config["providers"] === "object" &&
    config["providers"] !== null &&
    !Array.isArray(config["providers"])
      ? { ...(config["providers"] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const current = (
    typeof providers[provider] === "object" &&
    providers[provider] !== null &&
    !Array.isArray(providers[provider])
      ? { ...(providers[provider] as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  providers[provider] = { ...current, apiKey: handle, baseUrl };
  return JSON.stringify({ ...config, providers });
}

export const emptyModelTotals = (): ModelTotals => ({
  requests: 0,
  retries: 0,
  input: 0,
  output: 0,
});

export function publicModelUsage(session: ModelSession | undefined) {
  if (!session) return null;
  return {
    handle: session.handle,
    caps: session.caps,
    totals: session.totals,
  };
}

export const capViolation = (totals: ModelTotals, caps: ModelCaps) => {
  if (totals.requests >= caps.maxRequests) return "max_requests";
  if (totals.retries >= caps.maxRetriesPerRequest * caps.maxRequests) {
    return "max_retries";
  }
  if (totals.input >= caps.maxCumulativeInputTokens) return "max_input_tokens";
  if (totals.output >= caps.maxCumulativeOutputTokens) {
    return "max_output_tokens";
  }
  return null;
};

export function reserveAttempt(
  totals: ModelTotals,
  caps: ModelCaps,
  isRetry: boolean,
) {
  const violation = capViolation(totals, caps);
  if (violation) return violation;
  totals.requests += 1;
  if (isRetry) totals.retries += 1;
  return null;
}

export function resolveUpstreamTarget(requestUrl: string, baseUrl: string) {
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) {
    throw new Error(`non_origin_form_target: ${requestUrl.slice(0, 80)}`);
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const requested = new URL(requestUrl, "http://broker.invalid");
  if (requested.origin !== "http://broker.invalid") {
    throw new Error(`non_origin_form_target: ${requestUrl.slice(0, 80)}`);
  }
  const target = new URL(
    `${basePath}${requested.pathname}${requested.search}`,
    base.origin,
  );
  const inside =
    target.pathname === basePath ||
    target.pathname.startsWith(basePath === "" ? "/" : `${basePath}/`);
  if (target.origin !== base.origin || !inside) {
    throw new Error(`upstream_out_of_scope: ${target.href.slice(0, 120)}`);
  }
  return target;
}

export const readUsage = (
  body: string,
): { input: number; output: number } | null => {
  let usage: { input: number; output: number } | null = null;
  const consider = (candidate: Record<string, unknown> | undefined) => {
    if (!candidate || typeof candidate !== "object") return;
    const input =
      candidate["input_tokens"] ??
      candidate["prompt_tokens"] ??
      candidate["inputTokens"];
    const output =
      candidate["output_tokens"] ??
      candidate["completion_tokens"] ??
      candidate["outputTokens"];
    if (typeof input === "number" || typeof output === "number") {
      usage = {
        input: typeof input === "number" ? input : 0,
        output: typeof output === "number" ? output : 0,
      };
    }
  };
  for (const line of body.split("\n")) {
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const nested = parsed["response"] as Record<string, unknown> | undefined;
      consider(
        (parsed["usage"] as Record<string, unknown> | undefined) ??
          (nested?.["usage"] as Record<string, unknown> | undefined) ??
          parsed,
      );
    } catch {}
  }
  return usage;
};

const jsonError = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { type: "review_pi_model", reason } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The handle the target presented, from either header it may arrive on.
 *
 * Pi blanks `authorization` and signs with `cf-aig-authorization` for the AI
 * Gateway provider, so reading one header only would reject the run's own
 * handle for that provider alone.
 */
const presentedHandle = (request: Request) =>
  (
    request.headers.get("authorization") ??
    request.headers.get("cf-aig-authorization") ??
    ""
  ).replace(/^Bearer\s+/i, "");

export async function proxyModelFetch(
  request: Request,
  url: URL,
  secret: string,
  consume: (
    runId: string,
  ) => Promise<
    { ok: true; session: ModelSession } | { ok: false; reason: string }
  >,
  recordUsage: (
    runId: string,
    usage: { input: number; output: number } | null,
  ) => Promise<void>,
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const runIdRaw = segments[1];
  const capability = segments[2];
  const rest = `/${segments.slice(3).join("/")}`;
  if (!runIdRaw || !capability || segments.slice(3).length === 0) {
    return jsonError(404, "not_found");
  }
  let runId: string;
  try {
    runId = assertCloudRunId(runIdRaw);
  } catch {
    return jsonError(400, "invalid_run");
  }
  if (capability !== (await modelCapability(runId, secret))) {
    return jsonError(403, "capability_rejected");
  }
  const consumed = await consume(runId);
  if (!consumed.ok) return jsonError(429, consumed.reason);
  if (presentedHandle(request) !== consumed.session.handle) {
    return jsonError(401, "handle_rejected");
  }
  let target: URL;
  try {
    target = resolveUpstreamTarget(
      `${rest}${url.search}`,
      consumed.session.upstreamBaseUrl,
    );
  } catch (error) {
    return jsonError(
      403,
      error instanceof Error ? error.message : String(error),
    );
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", consumed.session.upstreamAuthorization);
  headers.delete("host");
  // The gateway reads this header in preference to `authorization`, so leaving
  // the target's handle on it would send the upstream a credential that is not
  // one.
  headers.delete("cf-aig-authorization");
  if (consumed.session.upstreamAccountId) {
    headers.set("chatgpt-account-id", consumed.session.upstreamAccountId);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : request.body,
    redirect: "manual",
    ...(request.method === "POST" ? { duplex: "half" } : {}),
  } as RequestInit);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  if (!upstream.body) {
    await recordUsage(runId, null);
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
  let tail = "";
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      tail = (tail + new TextDecoder().decode(chunk)).slice(-65_536);
      controller.enqueue(chunk);
    },
    async flush() {
      await recordUsage(runId, readUsage(tail));
    },
  });
  return new Response(upstream.body.pipeThrough(stream), {
    status: upstream.status,
    headers: responseHeaders,
  });
}
