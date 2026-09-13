/**
 * Read-only git transport for the container.
 *
 * The container has to hold the PR's own commit objects, which only a real
 * `git fetch` gives. That needs a credential, and the container is the one
 * place that must never hold one, so the credential stays in the Worker and the
 * container talks to this proxy instead.
 *
 * Two things keep it read-only. The repository is the Worker's own
 * `TARGET_REPOSITORY`, so no other repository is reachable. And git's HTTP
 * protocol has exactly one write endpoint - `git-receive-pack` - which is not
 * in the allowed set: only the `git-upload-pack` advertisement and its POST are
 * forwarded. A push has no path through here even with the capability in hand.
 *
 * The capability is derived from the control secret and the run id, so it is
 * unguessable, specific to one run, and never has to be stored.
 */

const ALLOWED = new Set(["info/refs", "git-upload-pack"]);

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function gitCapability(runId: string, secret: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${secret}:git:${runId}`),
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
  if (capability !== (await gitCapability(runId, secret))) {
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

  return fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : null,
    // Streaming a pack response back to git is the whole point: the repository
    // bytes pass through and are never held here.
    ...(request.method === "POST" ? { duplex: "half" } : {}),
  } as RequestInit);
}
