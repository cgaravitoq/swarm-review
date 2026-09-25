/**
 * Model transport for the container, mirroring the git proxy.
 *
 * The sandbox SDK control API runs as root, so no container uid can hold the
 * provider bearer. The Worker Durable Object keeps the credential and the
 * usage counters; the container only receives a nonsecret handle and a
 * run-scoped URL under /model/<runId>/<capability>/.
 */

import {
  responseSealer,
  WORKER_SSE_LINE_CHARS,
} from "../container/response-seal";
import { type ModelUsage, usageReader } from "../container/response-usage";
import { assertCloudRunId } from "./isolation";

export type { ModelUsage };

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
  input: number | null;
  output: number | null;
  /**
   * Attempts admitted whose end this session has not seen.
   *
   * `recordAttempt` runs at the stream's flush, so a client that walks away
   * from a response leaves its slot spent and its end unobserved. The count is
   * the control side's own statement of that, and the totals a row reads from
   * it carry one request's tokens less than the requests it names.
   *
   * Absent on a session a Worker stored before the count existed: Durable
   * Object storage outlives a redeploy, and admissions nobody counted cannot
   * be counted down.
   */
  unended?: number;
  /**
   * Ended attempts whose response never reported that side of their usage: an
   * attempt the upstream never answered, an answer without a body or a usage
   * frame, or one whose frames this hop could not read.
   *
   * `input` and `output` add only what a provider reported, so each is short by
   * the attempts counted here, and a reader that saw only the sums would read
   * them as complete. Absent, like `unended`, on a session stored before the
   * count existed.
   */
  inputUnobserved?: number;
  outputUnobserved?: number;
};

export type ModelSession = {
  handle: string;
  upstreamBaseUrl: string;
  upstreamAuthorization?: string;
  credentialProvider?: string;
  upstreamAccountId?: string;
  caps: ModelCaps;
  totals: ModelTotals;
  /** Set once an attempt failed the way a client repeats; the next one is a retry. */
  retryPending?: boolean;
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
  input: null,
  output: null,
  unended: 0,
  inputUnobserved: 0,
  outputUnobserved: 0,
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
  if (totals.input !== null && totals.input >= caps.maxCumulativeInputTokens) {
    return "max_input_tokens";
  }
  if (
    totals.output !== null &&
    totals.output >= caps.maxCumulativeOutputTokens
  ) {
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
  if (totals.unended !== undefined) totals.unended += 1;
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

const jsonError = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { type: "review_pi_model", reason } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A status a client repeats, which makes the attempt that follows it on this
 * session a retry rather than a new request. The observed attempt is the only
 * source of that count the container cannot forge.
 */
const retryableFailure = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/**
 * The request body, or the refusal when it is over the session's byte cap.
 *
 * The declared length arrives from the container, which is the untrusted side
 * of this boundary, so the bytes are counted as they are read either way: a
 * target that understates its own `content-length` cannot carry a body past
 * the cap the broker enforces for the local path.
 */
const readBoundedBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "max_request_bytes"> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return "max_request_bytes";
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "max_request_bytes";
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

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
  open: (runId: string) => Promise<{
    handle: string;
    caps: ModelCaps;
    upstreamBaseUrl: string;
  } | null>,
  consume: (
    runId: string,
  ) => Promise<
    { ok: true; session: ModelSession } | { ok: false; reason: string }
  >,
  recordAttempt: (
    runId: string,
    usage: ModelUsage | null,
    retryable: boolean,
    seal: string | null,
  ) => Promise<void>,
  vaultCredential?: (
    provider: string,
    rejectedAccessToken?: string,
  ) => Promise<{ authorization: string; accountId?: string }>,
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
  const opened = await open(runId);
  if (!opened) return jsonError(429, "no_session");
  if (presentedHandle(request) !== opened.handle) {
    return jsonError(401, "handle_rejected");
  }
  // Every refusal comes before `consume`: a slot spent on a request that is
  // then refused is an admission no end ever records.
  let target: URL;
  try {
    target = resolveUpstreamTarget(
      `${rest}${url.search}`,
      opened.upstreamBaseUrl,
    );
  } catch (error) {
    return jsonError(
      403,
      error instanceof Error ? error.message : String(error),
    );
  }
  const method = request.method;
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : await readBoundedBody(request, opened.caps.maxRequestBytes);
  if (body === "max_request_bytes") return jsonError(413, body);
  const consumed = await consume(runId);
  if (!consumed.ok) return jsonError(429, consumed.reason);
  const headers = new Headers(request.headers);
  headers.delete("host");
  // The gateway reads this header in preference to `authorization`, so leaving
  // the target's handle on it would send the upstream a credential that is not
  // one.
  headers.delete("cf-aig-authorization");
  headers.delete("content-length");
  const provider = consumed.session.credentialProvider;
  let upstream: Response;
  try {
    let credential = provider
      ? await vaultCredential?.(provider)
      : {
          authorization: consumed.session.upstreamAuthorization ?? "",
          accountId: consumed.session.upstreamAccountId,
        };
    if (!credential) throw new Error("credential_unconfigured");
    const forward = (authorization: string, accountId?: string) => {
      headers.set("authorization", authorization);
      if (accountId) headers.set("chatgpt-account-id", accountId);
      return fetch(target, {
        method,
        headers,
        body,
        redirect: "manual",
      } as RequestInit);
    };
    upstream = await forward(credential.authorization, credential.accountId);
    if (provider === "openai-codex" && upstream.status === 401) {
      await upstream.body?.cancel();
      credential = await vaultCredential?.(
        provider,
        credential.authorization.slice("Bearer ".length),
      );
      if (!credential) throw new Error("credential_unconfigured");
      upstream = await forward(credential.authorization, credential.accountId);
    }
  } catch (error) {
    await recordAttempt(runId, null, true, null);
    if (provider) {
      const reason =
        error instanceof Error && error.message.startsWith("credential_")
          ? error.message
          : "credential_failed";
      return jsonError(502, reason);
    }
    throw error;
  }
  if (provider && upstream.status === 401) {
    await upstream.body?.cancel();
    await recordAttempt(runId, null, false, null);
    return jsonError(502, "credential_upstream_unauthorized");
  }
  const retryable = retryableFailure(upstream.status);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  if (!upstream.body) {
    await recordAttempt(runId, null, retryable, null);
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }
  const decoder = new TextDecoder();
  const sealer = responseSealer();
  const usage = usageReader({ lineChars: WORKER_SSE_LINE_CHARS });
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      sealer.write(text);
      usage.write(text);
      controller.enqueue(chunk);
    },
    async flush() {
      const text = decoder.decode();
      sealer.write(text);
      usage.write(text);
      await recordAttempt(runId, usage.read(), retryable, sealer.seal());
    },
  });
  return new Response(upstream.body.pipeThrough(stream), {
    status: upstream.status,
    headers: responseHeaders,
  });
}
