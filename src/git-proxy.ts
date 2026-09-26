/**
 * Read-only git transport for the container.
 *
 * The container has to hold the PR's own commit objects, which only a real
 * `git fetch` gives. That needs a credential, and the container is the one
 * place that must never hold one, so the credential stays in the Worker and the
 * container talks to this proxy instead.
 *
 * Two things keep it read-only. The repository is the Worker's own
 * allowlist entry selected for the run, so no other repository is reachable. And git's HTTP
 * protocol has exactly one write endpoint - `git-receive-pack` - which is not
 * in the allowed set: only the `git-upload-pack` advertisement and its POST are
 * forwarded. A push has no path through here even with the capability in hand.
 *
 * The capability is derived from the control secret, run id and repository,
 * so it is specific to one run and repository and never has to be stored.
 */

const ALLOWED = new Set(["info/refs", "git-upload-pack"]);
// GitHub's edge rate-limits some of the addresses a Worker's requests leave
// from, before it reads the credential, and the next request can leave from
// another one.
const RATE_LIMIT_ATTEMPTS = 5;

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function gitCapability(
  runId: string,
  secret: string,
  repository: string,
) {
  const name = repository
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:git:${runId}:${name}`),
  );
  return hex(digest);
}

export async function proxyGitFetch(
  request: Request,
  url: URL,
  secret: string,
  token: string,
  repository: string,
): Promise<Response> {
  const [, , capability, ...rest] = url.pathname.split("/");
  const endpoint = rest.join("/");
  if (!capability || !ALLOWED.has(endpoint)) {
    return new Response("not_found", { status: 404 });
  }
  if (
    endpoint === "info/refs" &&
    url.searchParams.get("service") !== "git-upload-pack"
  ) {
    return new Response("forbidden", { status: 403 });
  }

  const runId = request.headers.get("x-review-run") ?? "";
  if (capability !== (await gitCapability(runId, secret, repository))) {
    return new Response("forbidden", { status: 403 });
  }

  const upstream = new URL(`${repository}/${endpoint}`);
  upstream.search = url.search;
  const headers = new Headers();
  headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
  headers.set("user-agent", request.headers.get("user-agent") ?? "git/2.0");
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding) headers.set("content-encoding", contentEncoding);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  const gitProtocol = request.headers.get("git-protocol");
  if (gitProtocol) headers.set("git-protocol", gitProtocol);

  // The request is want and have lines, small enough to hold and resend; the
  // pack response still streams back to git and is never held here.
  const body = request.method === "POST" ? await request.arrayBuffer() : null;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body,
    });
    if (response.status !== 429 || attempt === RATE_LIMIT_ATTEMPTS)
      return response;
    await response.body?.cancel();
  }
}
