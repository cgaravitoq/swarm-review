export const CODEX_RELAY_ID = "swarm-review-codex-egress";
export const CODEX_RELAY_PORT = 3211;
export const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

type SandboxSdk = typeof import("@cloudflare/sandbox");
type RelayNamespace = Parameters<SandboxSdk["getSandbox"]>[0];
type RelayProcess = {
  id: string;
  status: string;
  command: string;
  waitForPort(port: number, options: { mode: "tcp" }): Promise<void>;
};
type RelaySandbox = {
  listProcesses(): Promise<RelayProcess[]>;
  getProcess(id: string): Promise<RelayProcess | null>;
  startProcess(command: string): Promise<RelayProcess>;
  containerFetch(
    url: string,
    init: RequestInit,
    port: number,
  ): Promise<Response>;
};
type RelayFactory = (
  namespace: RelayNamespace,
  id: string,
) => RelaySandbox | Promise<RelaySandbox>;

const lazyGetSandbox: RelayFactory = async (namespace, id) => {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox(namespace, id);
};

export function createCodexRelayTransport(
  namespace: RelayNamespace,
  factory: RelayFactory = lazyGetSandbox,
): typeof fetch {
  return async (input, init) => {
    if (String(input) !== CODEX_UPSTREAM || init?.method !== "POST") {
      return new Response(null, { status: 404 });
    }
    const sandbox = await factory(namespace, CODEX_RELAY_ID);
    const command = "/usr/local/bun/bin/bun /opt/relay/server.ts";
    const running = (await sandbox.listProcesses()).find(
      (process) => process.status === "running" && process.command === command,
    );
    const process =
      (running && (await sandbox.getProcess(running.id))) ??
      (await sandbox.startProcess(command));
    await process.waitForPort(CODEX_RELAY_PORT, { mode: "tcp" });
    return sandbox.containerFetch(
      "http://codex-relay/codex/responses",
      init,
      CODEX_RELAY_PORT,
    );
  };
}
