declare const Bun: {
  serve(input: {
    hostname: string;
    port: number;
    development: boolean;
    fetch(request: Request): Promise<Response>;
  }): void;
};

const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

export function createCodexRelayHandler(fetchUpstream: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== "/codex/responses" ||
      url.search !== "" ||
      request.headers.has("x-orb-upstream-url")
    ) {
      return new Response(null, { status: 404 });
    }
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    let response: Response;
    try {
      response = await fetchUpstream(UPSTREAM, {
        method: "POST",
        headers,
        body: request.body,
        duplex: "half",
        redirect: "manual",
      } as RequestInit);
    } catch {
      return Response.json(
        { error: { type: "codex_relay", reason: "upstream_failed" } },
        { status: 502 },
      );
    }
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}

if (import.meta.main) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: 3211,
    development: false,
    fetch: createCodexRelayHandler(),
  });
}
