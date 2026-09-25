declare const Bun: {
  serve(input: {
    hostname: string;
    port: number;
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
    const response = await fetchUpstream(UPSTREAM, {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual",
    } as RequestInit);
    return new Response(response.body, response);
  };
}

if (import.meta.main) {
  Bun.serve({
    hostname: "0.0.0.0",
    port: 3211,
    fetch: createCodexRelayHandler(),
  });
}
