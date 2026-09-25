const encoder = new TextEncoder();
const api = "https://api.github.com";
const headers = (authorization: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${authorization}`,
  "content-type": "application/json",
  "user-agent": "swarm-review",
  "x-github-api-version": "2022-11-28",
});

export type PullRequestEvent = {
  repository: string;
  number: number;
  head: string;
  base: string;
  installationId: number;
};

export function allowedRepositories(value?: string): Map<string, string> {
  const repositories = new Map<string, string>();
  if (!value) return repositories;
  for (const entry of value.split(",")) {
    const clone = entry.trim();
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        clone,
      )
    )
      throw new Error("invalid_target_repositories");
    const name = new URL(clone).pathname.slice(1, -4).toLowerCase();
    repositories.set(name, clone);
  }
  return repositories;
}

export async function verifyWebhook(
  request: Request,
  secret: string,
): Promise<boolean> {
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const offered = /^sha256=([a-f0-9]{64})$/.exec(signature)?.[1];
  if (!offered || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const actual = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, await request.clone().arrayBuffer()),
  );
  const expected = Uint8Array.from(offered.match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index += 1)
    mismatch |= actual[index]! ^ (expected[index] ?? 0);
  return mismatch === 0;
}

export function pullRequestEvent(value: unknown): PullRequestEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const body = value as Record<string, unknown>;
  if (
    !["opened", "reopened", "ready_for_review"].includes(String(body["action"]))
  )
    return null;
  const repository = body["repository"] as Record<string, unknown> | undefined;
  const pull = body["pull_request"] as Record<string, unknown> | undefined;
  const installation = body["installation"] as
    | Record<string, unknown>
    | undefined;
  const head = pull?.["head"] as Record<string, unknown> | undefined;
  const base = pull?.["base"] as Record<string, unknown> | undefined;
  if (
    pull?.["draft"] !== false ||
    !["OWNER", "MEMBER", "COLLABORATOR"].includes(
      String(pull?.["author_association"]),
    )
  )
    return null;
  if (
    typeof repository?.["full_name"] !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository["full_name"]) ||
    !Number.isSafeInteger(body["number"]) ||
    Number(body["number"]) <= 0 ||
    typeof head?.["sha"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(head["sha"]) ||
    typeof base?.["sha"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(base["sha"]) ||
    !Number.isSafeInteger(installation?.["id"]) ||
    Number(installation?.["id"]) <= 0
  )
    return null;
  return {
    repository: repository["full_name"],
    number: Number(body["number"]),
    head: head["sha"],
    base: base["sha"],
    installationId: Number(installation?.["id"]),
  };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function appJwt(
  appId: string,
  privateKey: string,
  now = Date.now(),
): Promise<string> {
  const body = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })))}`;
  const der = Uint8Array.from(
    atob(privateKey.replace(/-----[^-]+-----|\s/g, "")),
    (character) => character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(body))))}`;
}

export async function installationToken(
  appId: string,
  privateKey: string,
  installationId: number,
  repository: string,
): Promise<string> {
  const cacheKey = `${installationId}:${repository.toLowerCase()}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const response = await fetch(
    `${api}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: headers(await appJwt(appId, privateKey)),
      body: JSON.stringify({
        repositories: [repository.split("/")[1]],
        permissions: {
          contents: "read",
          checks: "write",
          pull_requests: "write",
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`installation_token_${response.status}`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { token?: unknown }).token !== "string"
  )
    throw new Error("invalid_installation_token");
  const token = (value as { token: string }).token;
  const expiresAt = Date.parse(
    (value as { expires_at?: string }).expires_at ?? "",
  );
  if (Number.isFinite(expiresAt))
    tokenCache.set(cacheKey, { token, expiresAt });
  return token;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function createCheck(
  token: string,
  event: PullRequestEvent,
): Promise<number> {
  const response = await fetch(`${api}/repos/${event.repository}/check-runs`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      name: "swarm-review",
      head_sha: event.head,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: "Swarm review in progress",
        summary: "Reviewing the pull request head.",
      },
    }),
  });
  if (!response.ok) throw new Error(`create_check_${response.status}`);
  const value: unknown = await response.json();
  const id = (value as { id?: unknown })?.id;
  if (!Number.isSafeInteger(id)) throw new Error("invalid_check_run");
  return id as number;
}

export async function completeCheck(
  token: string,
  repository: string,
  checkRunId: number,
  conclusion: "success" | "neutral",
  summary: string,
): Promise<void> {
  const response = await fetch(
    `${api}/repos/${repository}/check-runs/${checkRunId}`,
    {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title:
            conclusion === "success"
              ? "Swarm review completed"
              : "Swarm review could not complete",
          summary,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`update_check_${response.status}`);
}
