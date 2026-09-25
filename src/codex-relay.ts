export const CODEX_RELAY_ID = "swarm-review-codex-egress";
export const CODEX_RELAY_PORT = 3211;
export const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RELAY_COMMAND = "/usr/local/bun/bin/bun /opt/relay/server.ts";
const CODEX_RELAY_READY_MS = 30_000;
const refusals = new WeakMap<Response, string>();

export const relayRefusalReason = (response: Response) =>
  refusals.get(response) ?? null;

type SandboxSdk = typeof import("@cloudflare/sandbox");
type RelayNamespace = Parameters<SandboxSdk["getSandbox"]>[0];
type RelayProcess = {
  id: string;
  status: string;
  command: string;
  waitForPort(
    port: number,
    options: { mode: "tcp"; timeout: number },
  ): Promise<void>;
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
      const response = new Response(null, { status: 404 });
      refusals.set(response, "codex_relay_non_post");
      return response;
    }
    try {
      const sandbox = await factory(namespace, CODEX_RELAY_ID);
      const relays = async () =>
        (await sandbox.listProcesses()).filter(
          (process) =>
            process.status === "running" &&
            process.command === CODEX_RELAY_COMMAND,
        );
      const ready = (processes: RelayProcess[]) =>
        Promise.any(
          processes.map((process) =>
            process.waitForPort(CODEX_RELAY_PORT, {
              mode: "tcp",
              timeout: CODEX_RELAY_READY_MS,
            }),
          ),
        );
      const [running] = await relays();
      const process =
        (running && (await sandbox.getProcess(running.id))) ??
        (await sandbox.startProcess(CODEX_RELAY_COMMAND));
      // Concurrent cold attempts each start a relay and all but one exit on
      // the bound port, so a start that never gets ready waits on the winner.
      await ready([process]).catch(async () => ready(await relays()));
      return await sandbox.containerFetch(
        "http://codex-relay/codex/responses",
        init,
        CODEX_RELAY_PORT,
      );
    } catch {
      throw new Error("codex_relay_failed");
    }
  };
}
