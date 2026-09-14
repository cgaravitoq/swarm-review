// The only process in the container that holds a model credential.
//
// It runs as `review-control`, a uid the reviewed repository never executes as.
// Pi, its tools, the install and the check command all run as `review-target`,
// which reaches the provider only through this loopback endpoint and never sees
// the bearer: the credential lives in this process's memory and in a 0600 file
// owned by `review-control`, so a target read of the environment, the run
// directory or /proc of this pid is denied by the kernel rather than by
// convention.
//
// It is also the trusted model-call boundary, so the request, retry and token
// caps are enforced here - before the upstream call - and the usage ledger it
// appends to lives in a directory only `review-control` can write. Target code
// can lie in report.json; it cannot lie about what the provider was asked.

import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

/** The cap that would be broken by admitting one more request, or null. */
export type BrokerCaps = {
  maxRequests: number;
  maxRetriesPerRequest: number;
  maxCumulativeInputTokens: number;
  maxCumulativeOutputTokens: number;
  maxRequestBytes: number;
};

export type BrokerTotals = {
  requests: number;
  retries: number;
  input: number;
  output: number;
};

export type BrokerConfig = {
  port: number;
  handle: string;
  upstreamBaseUrl: string;
  upstreamAuthorization: string;
  upstreamAccountId?: string;
  caps: BrokerCaps;
  ledgerPath: string;
};

export const capViolation = (totals: BrokerTotals, caps: BrokerCaps) => {
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

/**
 * Takes the slot one upstream attempt will consume, or refuses it.
 *
 * Checking a cap and then awaiting anything before spending it is not
 * enforcement: two concurrent requests both read the same pre-await totals, and
 * a retry loop that only checked once spends as many slots as it likes. The
 * reservation is therefore synchronous - the counter moves in the same tick it
 * is tested in, before the first await of the attempt - so what a caller can
 * overshoot by is one in-flight response, never a second request.
 */
export function reserveAttempt(
  totals: BrokerTotals,
  caps: BrokerCaps,
  isRetry: boolean,
) {
  const violation = capViolation(totals, caps);
  if (violation) return violation;
  totals.requests += 1;
  if (isRetry) totals.retries += 1;
  return null;
}

/**
 * The one upstream URL this broker is allowed to reach.
 *
 * The bearer is attached by this process, so whatever this function returns is
 * where the credential goes. An HTTP request line may legally carry an absolute
 * form (`POST https://elsewhere/v1 HTTP/1.1`), and `new URL(target, base)`
 * honours it and silently drops the base - which is a target-controlled process
 * choosing the server that receives the key. So only an origin-form path is
 * accepted, it is joined under the configured base path rather than replacing
 * it, and the result must still sit inside that base.
 */
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
  // `new URL` normalises `..`, so a path that climbs out of the base is caught
  // by the prefix test below rather than reaching the provider.
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

/**
 * Provider-reported usage, whether the response was one JSON body or an SSE
 * stream. Only the last usage object in a stream is authoritative, so the scan
 * keeps overwriting rather than summing.
 */
/**
 * Provider-reported usage, whether the response was one JSON body or an SSE
 * stream. A frame updates the fields it carries and the last value of each one
 * wins, rather than the last frame replacing the whole reading: Anthropic opens
 * with the input and closes with the output, so replacing would keep one and
 * lose the other.
 *
 * Anthropic also reports the cached halves of a prompt apart from
 * `input_tokens`, and a review that caches its context spends most of its input
 * there. Counting only `input_tokens` would show a lane sitting against its
 * token ceiling as having spent almost nothing. OpenAI-style usage already folds
 * cache reads into `prompt_tokens`, so the cache fields are added only where a
 * provider reports them on their own.
 */
export const readUsage = (
  body: string,
): { input: number; output: number } | null => {
  const totals = { input: 0, output: 0 };
  let seen = false;
  const numberAt = (record: Record<string, unknown>, key: string) => {
    const value = record[key];
    return typeof value === "number" ? value : 0;
  };
  const consider = (candidate: Record<string, unknown> | undefined) => {
    if (!candidate || typeof candidate !== "object") return;
    const anthropicInput = candidate["input_tokens"];
    const input =
      anthropicInput ?? candidate["prompt_tokens"] ?? candidate["inputTokens"];
    const output =
      candidate["output_tokens"] ??
      candidate["completion_tokens"] ??
      candidate["outputTokens"];
    if (typeof input !== "number" && typeof output !== "number") return;
    seen = true;
    if (typeof input === "number") {
      totals.input =
        input +
        (typeof anthropicInput === "number"
          ? numberAt(candidate, "cache_read_input_tokens") +
            numberAt(candidate, "cache_creation_input_tokens")
          : 0);
    }
    if (typeof output === "number") totals.output = output;
  };
  for (const line of body.split("\n")) {
    const payload = line.startsWith("data:")
      ? line.slice(5).trim()
      : line.trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const nestedUsage = (key: string) => {
        const container = parsed[key];
        return typeof container === "object" && container !== null
          ? (container as Record<string, unknown>)["usage"]
          : undefined;
      };
      consider(
        (parsed["usage"] as Record<string, unknown> | undefined) ??
          // OpenAI's Responses API nests it under the response, Anthropic's
          // Messages API under the message it opens with.
          (nestedUsage("response") as Record<string, unknown> | undefined) ??
          (nestedUsage("message") as Record<string, unknown> | undefined) ??
          parsed,
      );
    } catch {}
  }
  return seen ? totals : null;
};

/** Enough tail to hold a provider's final usage frame, never the transcript. */
const USAGE_TAIL_BYTES = 65_536;

const readBody = (stream: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

export function createBrokerServer(config: BrokerConfig) {
  const caps = config.caps;
  const ledgerPath = config.ledgerPath;
  const totals = { requests: 0, retries: 0, input: 0, output: 0 };

  const record = (entry: Record<string, unknown>) => {
    appendFileSync(
      ledgerPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  };

  const deny = (res: ServerResponse, status: number, reason: string) => {
    record({ event: "denied", reason, totals: { ...totals } });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "review_pi_broker", reason } }));
  };

  const server = createServer(async (req, res) => {
    // The handle is not a secret - target code can read it out of models.json.
    // It only pins this endpoint to the configured run so an unrelated process in
    // the container cannot quietly spend the run's budget.
    //
    // Pi presents it on `cf-aig-authorization` for the AI Gateway provider and
    // blanks `authorization` there, so a broker that read one header only would
    // reject its own handle for that provider alone.
    const presented = (
      req.headers.authorization ??
      req.headers["cf-aig-authorization"] ??
      ""
    )
      .toString()
      .replace(/^Bearer\s+/i, "");
    if (presented !== config.handle) {
      deny(res, 401, "handle_rejected");
      return;
    }
    const violation = capViolation(totals, caps);
    if (violation) {
      deny(res, 429, violation);
      return;
    }

    let target: URL;
    try {
      target = resolveUpstreamTarget(req.url ?? "/", config.upstreamBaseUrl);
    } catch (error) {
      // The bearer is never attached to a request whose destination this
      // process did not choose.
      deny(res, 403, error instanceof Error ? error.message : String(error));
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      deny(
        res,
        400,
        `request_body_unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (body.length > caps.maxRequestBytes) {
      deny(res, 413, "max_request_bytes");
      return;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "host" || name === "content-length") continue;
      // The handle the target presented never travels: the gateway reads this
      // header in preference to `authorization`, so forwarding it would send
      // the upstream a credential that is not one.
      if (name === "cf-aig-authorization") continue;
      if (typeof value === "string") headers[name] = value;
    }
    headers["authorization"] = config.upstreamAuthorization;
    if (config.upstreamAccountId) {
      headers["chatgpt-account-id"] = config.upstreamAccountId;
    }

    let attempt = 0;
    let lastError = "";
    while (attempt <= caps.maxRetriesPerRequest) {
      // The slot is taken here, synchronously, in the same tick it is tested:
      // the caps bound what is actually sent, not what was intended when the
      // handler started.
      const refusal = reserveAttempt(totals, caps, attempt > 0);
      if (refusal) {
        deny(res, 429, refusal);
        return;
      }
      try {
        const upstream = await fetch(target, {
          method: req.method ?? "POST",
          headers,
          // A redirect is another server asking for the bearer. It is returned
          // to the caller as the provider's own answer, never followed.
          redirect: "manual",
          ...(req.method === "GET" || req.method === "HEAD"
            ? {}
            : { body, duplex: "half" }),
        });
        if (upstream.status >= 500 && attempt < caps.maxRetriesPerRequest) {
          attempt += 1;
          lastError = `upstream ${upstream.status}`;
          record({ event: "provider_retry", status: upstream.status, attempt });
          continue;
        }
        for (const [name, value] of upstream.headers) {
          if (name !== "content-encoding" && name !== "content-length") {
            res.setHeader(name, value);
          }
        }
        res.writeHead(upstream.status);
        // Pi streams, so the answer is forwarded chunk by chunk. Buffering the
        // whole body here would turn a streamed review into one long silence
        // and break the activity the run is watched through. Only a bounded
        // tail is retained, which is where a provider's final usage object is.
        let tail = "";
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            const buffer = Buffer.from(chunk);
            tail = (tail + buffer.toString()).slice(-USAGE_TAIL_BYTES);
            res.write(buffer);
          }
        }
        res.end();
        const usage = readUsage(tail);
        if (usage) {
          totals.input += usage.input;
          totals.output += usage.output;
        }
        record({
          event: "provider_request",
          status: upstream.status,
          attempt,
          path: target.pathname,
          usage,
          totals: { ...totals },
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        record({ event: "provider_error", attempt, message: lastError });
        attempt += 1;
      }
    }
    deny(res, 502, `upstream_unreachable: ${lastError}`);
  });

  record({ event: "broker_start", upstream: config.upstreamBaseUrl, caps });
  return { server, totals };
}

if (process.argv[2]) {
  const config = JSON.parse(
    readFileSync(process.argv[2] ?? "", "utf8"),
  ) as BrokerConfig;
  const { server } = createBrokerServer(config);
  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`broker listening on ${config.port}\n`);
  });
}
