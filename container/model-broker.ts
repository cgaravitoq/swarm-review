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
import { CONTAINER_SSE_LINE_CHARS, responseSealer } from "./response-seal";
import { type ModelUsage, usageReader } from "./response-usage";

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
  /**
   * Attempts admitted whose end this broker has not seen.
   *
   * The slot is spent the moment the attempt is reserved, so an attempt that
   * never ends - an upgrade this HTTP-only hop cannot complete, a provider that
   * accepts and never answers - is counted here and nowhere else. A reader that
   * only saw the settled lines would read a request no record names.
   */
  unended: number;
  /**
   * Ended attempts whose response never reported that side of their usage: a
   * retried or failed attempt, an answer without a usage frame, or one whose
   * frames this hop could not read.
   *
   * `input` and `output` add only what a provider reported, so each is short by
   * the attempts counted here, and a reader that saw only the sums would read
   * them as complete.
   */
  inputUnobserved: number;
  outputUnobserved: number;
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
  totals.unended += 1;
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

/** The ledger line that ends one admitted attempt, before its id and totals. */
type AttemptEnd =
  | { event: "provider_retry"; status: number; attempt: number }
  | {
      event: "provider_request";
      status: number;
      attempt: number;
      path: string;
      usage: ModelUsage;
      seal: string | null;
    }
  | { event: "provider_error"; attempt: number; message: string };

const UNREPORTED: ModelUsage = { input: null, output: null };

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
  const totals: BrokerTotals = {
    requests: 0,
    retries: 0,
    input: 0,
    output: 0,
    unended: 0,
    inputUnobserved: 0,
    outputUnobserved: 0,
  };
  // Numbered across the broker's whole run, not per HTTP request: the id is
  // what pairs an admission with its end, and pi sends many requests a lane.
  let admitted = 0;

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
      // The admission is written before the attempt is sent, so the ledger
      // names every request the caps counted. What follows the admission is
      // this attempt's outcome, and one that never arrives leaves the request
      // recorded as admitted and unended rather than as nothing at all.
      admitted += 1;
      const attemptId = admitted;
      record({
        event: "provider_admitted",
        attemptId,
        attempt,
        path: target.pathname,
        totals: { ...totals },
      });
      // What the attempt came to is recorded once, after the try: a ledger
      // write that throws there cannot end the attempt a second time, or send
      // a request the lane already holds the answer to again.
      let outcome: AttemptEnd;
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
          lastError = `upstream ${upstream.status}`;
          outcome = {
            event: "provider_retry",
            status: upstream.status,
            attempt: attempt + 1,
          };
        } else {
          for (const [name, value] of upstream.headers) {
            if (name !== "content-encoding" && name !== "content-length") {
              res.setHeader(name, value);
            }
          }
          res.writeHead(upstream.status);
          // Pi streams, so the answer is forwarded chunk by chunk. Buffering
          // the whole body here would turn a streamed review into one long
          // silence and break the activity the run is watched through. The
          // sealer hashes the answer as it passes, and the usage reader reads
          // every frame as it passes rather than the tail the answer ends on.
          const decoder = new TextDecoder();
          const sealer = responseSealer({
            lineChars: CONTAINER_SSE_LINE_CHARS,
          });
          const usage = usageReader({ lineChars: CONTAINER_SSE_LINE_CHARS });
          if (upstream.body) {
            for await (const chunk of upstream.body) {
              const text = decoder.decode(chunk, { stream: true });
              sealer.write(text);
              usage.write(text);
              res.write(Buffer.from(chunk));
            }
            const text = decoder.decode();
            sealer.write(text);
            usage.write(text);
          }
          res.end();
          outcome = {
            event: "provider_request",
            status: upstream.status,
            attempt,
            path: target.pathname,
            usage: usage.read(),
            seal: upstream.body ? sealer.seal() : null,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        outcome = { event: "provider_error", attempt, message: lastError };
      }
      const reported =
        outcome.event === "provider_request" ? outcome.usage : UNREPORTED;
      if (reported.input === null) totals.inputUnobserved += 1;
      else totals.input += reported.input;
      if (reported.output === null) totals.outputUnobserved += 1;
      else totals.output += reported.output;
      totals.unended -= 1;
      record({ ...outcome, attemptId, totals: { ...totals } });
      if (outcome.event === "provider_request") return;
      attempt += 1;
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
