/**
 * Disposable review-Pi control Worker.
 *
 * One sandbox per run, keyed by `runId`. The Worker is a control plane: git
 * and model bytes leave through run-scoped proxies. The provider bearer and
 * usage counters live in this Durable Object, never in any container uid.
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import { gitCapability, proxyGitFetch } from "./src/git-proxy";
import {
  assertCloudRunId,
  BRIDGE_COMMAND_MAX_BYTES,
  bridgeCommandFile,
  bridgeCommandPayload,
  CANARY_MAX_BYTES,
  CONTROL_API_PROBE_PATH,
  CONTROL_UID,
  interpretControlApiProbe,
  interpretProviderCanary,
  parseBridgeCommand,
  parseCloudRunRequest,
  posixQuote,
  TARGET_UID,
  targetCanaryCommand,
  targetChownCommand,
  targetControlApiProbe,
  targetReviewCommand,
  targetSendCommand,
  targetSendFileCommand,
} from "./src/isolation";
import {
  emptyModelTotals,
  type ModelSession,
  type ModelUsage,
  modelCapability,
  modelProxyBaseUrl,
  modelsJsonForProxy,
  proxyModelFetch,
  publicModelUsage,
  reserveAttempt,
} from "./src/model-proxy";
import {
  firstSourceMismatch,
  MAX_ARTIFACT_BYTES,
  parseExpectedSources,
  parseSourceFingerprint,
  REVIEW_RUNNER,
  runDir,
  sourceFingerprintCommand,
  sourceMismatchDetail,
} from "./src/protocol";

const MODEL_SESSION_KEY = "modelSession";
const MODEL_SEALS_KEY = "modelSeals";
const COMMAND_SEQUENCE_KEY = "commandSequence";

export class ReviewSandbox extends Sandbox<ReviewPiEnv> {
  async putModelSession(session: ModelSession) {
    await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    await this.ctx.storage.put(MODEL_SEALS_KEY, []);
  }

  async consumeModelAttempt() {
    const session = await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY);
    if (!session) return { ok: false as const, reason: "no_session" };
    const refusal = reserveAttempt(
      session.totals,
      session.caps,
      session.retryPending === true,
    );
    if (refusal) return { ok: false as const, reason: refusal };
    session.retryPending = false;
    await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    return { ok: true as const, session };
  }

  async recordModelAttempt(
    usage: ModelUsage | null,
    retryable: boolean,
    seal: string | null,
  ) {
    const session = await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY);
    if (!session) return;
    const input = usage?.input ?? null;
    if (input !== null) {
      session.totals.input = (session.totals.input ?? 0) + input;
    } else if (session.totals.inputUnobserved !== undefined) {
      session.totals.inputUnobserved += 1;
    }
    const output = usage?.output ?? null;
    if (output !== null) {
      session.totals.output = (session.totals.output ?? 0) + output;
    } else if (session.totals.outputUnobserved !== undefined) {
      session.totals.outputUnobserved += 1;
    }
    if (session.totals.unended !== undefined) session.totals.unended -= 1;
    session.retryPending = retryable;
    await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    await this.ctx.storage.put(MODEL_SEALS_KEY, [
      ...((await this.modelSeals()) ?? []),
      seal,
    ]);
  }

  /**
   * Kept apart from the session, so clearing the credential at stop leaves
   * the record a repeated stop has to answer with.
   */
  async modelSeals() {
    return (
      (await this.ctx.storage.get<(string | null)[]>(MODEL_SEALS_KEY)) ?? null
    );
  }

  async modelUsage() {
    return publicModelUsage(
      await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY),
    );
  }

  /** What the proxy checks a request against before it spends a slot on it. */
  async openModelSession() {
    const session = await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY);
    if (!session) return null;
    return {
      handle: session.handle,
      caps: session.caps,
      upstreamBaseUrl: session.upstreamBaseUrl,
    };
  }

  async clearModelSession() {
    await this.ctx.storage.delete(MODEL_SESSION_KEY);
  }

  async nextCommandSequence() {
    const sequence =
      ((await this.ctx.storage.get<number>(COMMAND_SEQUENCE_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(COMMAND_SEQUENCE_KEY, sequence);
    return sequence;
  }
}

type ReviewPiEnv = Record<
  "REVIEW_SANDBOX",
  DurableObjectNamespace<ReviewSandbox>
> &
  Record<"CONTROL_SECRET" | "GITHUB_READ_TOKEN", string> & {
    /** https clone URL the run's containers fetch through the Git proxy. */
    TARGET_REPOSITORY?: string;
  };

const ARTIFACTS = [
  "status.json",
  "steps.jsonl",
  "report.json",
  "trace.jsonl",
  "review-error.json",
  "run.log",
  "install.log",
] as const;
const RPC_TIMEOUT_MS = 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const authorized = (request: Request, secret: string) => {
  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered.length !== secret.length) return false;
  let mismatch = 0;
  for (let index = 0; index < secret.length; index += 1) {
    mismatch |= offered.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return mismatch === 0;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function bounded<T>(
  label: string,
  work: Promise<T>,
  timeoutMs = RPC_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function destroySandbox(sandbox: ReturnType<typeof getSandbox>) {
  try {
    await bounded("sandbox.destroy", sandbox.destroy());
    return {
      attempted: true as const,
      acknowledged: true as const,
      error: null,
    };
  } catch (error) {
    return {
      attempted: true as const,
      acknowledged: false as const,
      error: messageOf(error),
    };
  }
}

/** Read one bounded file, reporting its real size so truncation is never silent. */
async function readArtifact(
  sandbox: ReturnType<typeof getSandbox>,
  path: string,
) {
  const quoted = posixQuote(path);
  const size = await bounded(
    `artifact stat ${path}`,
    sandbox.exec(`stat -c %s ${quoted} 2>/dev/null || echo -1`),
  );
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes < 0)
    return { path, exists: false as const };
  const head = await bounded(
    `artifact read ${path}`,
    sandbox.exec(`head -c ${MAX_ARTIFACT_BYTES} ${quoted}`),
  );
  return {
    path,
    exists: true as const,
    bytes,
    truncated: bytes > MAX_ARTIFACT_BYTES,
    content: head.stdout,
  };
}

const readArtifacts = (
  sandbox: ReturnType<typeof getSandbox>,
  directory: string,
) =>
  Promise.all(
    ARTIFACTS.map(async (name) => {
      const path = `${directory}/${name}`;
      try {
        return await readArtifact(sandbox, path);
      } catch (error) {
        return { path, exists: false as const, error: messageOf(error) };
      }
    }),
  );

const isolation = {
  mode: "worker-proxy" as const,
  controlUid: CONTROL_UID,
  targetUid: TARGET_UID,
};

export default {
  async fetch(request: Request, env: ReviewPiEnv) {
    const url0 = new URL(request.url);
    if (url0.pathname.startsWith("/git/")) {
      if (!env.TARGET_REPOSITORY) {
        return json({ error: "target_repository_unset" }, 400);
      }
      return proxyGitFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        env.GITHUB_READ_TOKEN,
        env.TARGET_REPOSITORY,
      );
    }

    if (url0.pathname.startsWith("/model/")) {
      return proxyModelFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        async (runId) =>
          getSandbox(env.REVIEW_SANDBOX, runId).openModelSession(),
        async (runId) =>
          getSandbox(env.REVIEW_SANDBOX, runId).consumeModelAttempt(),
        async (runId, usage, retryable, seal) =>
          getSandbox(env.REVIEW_SANDBOX, runId).recordModelAttempt(
            usage,
            retryable,
            seal,
          ),
      );
    }

    if (!authorized(request, env.CONTROL_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = url0;
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[0] !== "runs" || segments.length < 1) {
      return json({ error: "not_found" }, 404);
    }

    if (request.method === "POST" && segments.length === 1) {
      // A run that does not name the repository its lanes clone cannot be
      // served: every container fetches through this Worker's Git proxy, and
      // there is no upstream to fall back to.
      if (!env.TARGET_REPOSITORY) {
        return json(
          {
            error: "target_repository_unset",
            detail: "TARGET_REPOSITORY is unset",
          },
          400,
        );
      }
      let parsed: ReturnType<typeof parseCloudRunRequest>;
      let expectedSources: Record<string, string>;
      try {
        const body: unknown = await request.json();
        parsed = parseCloudRunRequest(body);
        expectedSources = parseExpectedSources(
          (body as { job?: { expectedSources?: unknown } }).job
            ?.expectedSources,
        );
      } catch (error) {
        return json({ error: "invalid_run", detail: messageOf(error) }, 400);
      }
      const job = {
        ...parsed.job,
        expectedSources,
        gitRemote: `${url.origin}/git/${await gitCapability(parsed.job.runId, env.CONTROL_SECRET)}`,
      };
      const sandbox = getSandbox(env.REVIEW_SANDBOX, job.runId);
      const directory = runDir(job.runId);
      try {
        const fingerprint = await bounded(
          "source fingerprint",
          sandbox.exec(
            `${sourceFingerprintCommand()}; pi --version; bun --version; git --version`,
          ),
        );
        const { sources: observedSources, versions } = parseSourceFingerprint(
          fingerprint.stdout,
        );
        const [piVersion = "", bunVersion = "", gitVersion = ""] = versions;
        const mismatch = firstSourceMismatch(
          job.expectedSources,
          observedSources,
        );
        if (mismatch) {
          return json(
            {
              error: "source_mismatch",
              file: mismatch.file,
              expected: mismatch.expected,
              observed: mismatch.observed,
              detail: sourceMismatchDetail(mismatch),
              shutdown: { destroy: await destroySandbox(sandbox) },
            },
            409,
          );
        }
        const runnerSha = observedSources[REVIEW_RUNNER] ?? "";
        await bounded(
          "model session",
          sandbox.putModelSession({
            handle: parsed.broker.handle,
            upstreamBaseUrl: parsed.broker.upstreamBaseUrl,
            upstreamAuthorization: parsed.broker.upstreamAuthorization,
            ...(parsed.broker.upstreamAccountId
              ? { upstreamAccountId: parsed.broker.upstreamAccountId }
              : {}),
            caps: parsed.broker.caps,
            totals: emptyModelTotals(),
          }),
        );
        const controlApiHttp = await bounded(
          "control api probe",
          sandbox.exec(targetControlApiProbe),
        );
        const controlApiStatus = Number.parseInt(
          controlApiHttp.stdout.trim(),
          10,
        );
        const controlApiArtifact = await readArtifact(
          sandbox,
          CONTROL_API_PROBE_PATH,
        );
        const controlApiBody =
          controlApiArtifact.exists && "content" in controlApiArtifact
            ? controlApiArtifact.content.slice(0, CANARY_MAX_BYTES)
            : "";
        const controlApi = interpretControlApiProbe(
          Number.isInteger(controlApiStatus) ? controlApiStatus : 0,
          controlApiBody,
        );
        const probes = {
          // The bearer stays in this Durable Object, so no broker config is
          // ever staged in the container: a probe here would answer DENIED for
          // the life of the image and report containment nobody measured.
          targetReadBroker: {
            verdict: null,
            reason: "broker_config_not_staged",
          },
          controlApi: {
            httpStatus: Number.isInteger(controlApiStatus)
              ? controlApiStatus
              : null,
            uid: controlApi.uid,
            reason: controlApi.reason,
            escaped: controlApi.escaped,
          },
        };
        const capability = await modelCapability(job.runId, env.CONTROL_SECRET);
        const modelsJson = modelsJsonForProxy(
          parsed.modelsJson,
          job.provider,
          parsed.broker.handle,
          modelProxyBaseUrl(url.origin, job.runId, capability),
        );
        await bounded(
          "run directory creation",
          sandbox.mkdir(directory, { recursive: true }),
        );
        await bounded(
          "job write",
          sandbox.writeFile(`${directory}/job.json`, JSON.stringify(job)),
        );
        await bounded(
          "models write",
          sandbox.writeFile(`${directory}/models.json`, modelsJson),
        );
        await bounded(
          "run directory ownership",
          sandbox.exec(targetChownCommand(directory)),
        );
        const container = { runnerSha, piVersion, bunVersion, gitVersion };
        const placementId = await bounded(
          "placement lookup",
          sandbox.getContainerPlacementId(),
        );

        if (parsed.canary) {
          let provider = null;
          if (parsed.canaryRequest) {
            await bounded(
              "canary body",
              sandbox.writeFile(
                `${directory}/canary-request.json`,
                parsed.canaryRequest.body,
              ),
            );
            await bounded(
              "canary body ownership",
              sandbox.exec(targetChownCommand(directory)),
            );
            const completion = await bounded(
              "canary provider",
              sandbox.exec(
                targetCanaryCommand(
                  directory,
                  parsed.broker.handle,
                  `${modelProxyBaseUrl(url.origin, job.runId, capability)}${parsed.canaryRequest.path}`,
                ),
              ),
            );
            const httpStatus = Number.parseInt(completion.stdout.trim(), 10);
            const artifact = await readArtifact(
              sandbox,
              `${directory}/canary-response.txt`,
            );
            const body =
              artifact.exists && "content" in artifact
                ? artifact.content.slice(0, CANARY_MAX_BYTES)
                : "";
            const interpreted = interpretProviderCanary(
              Number.isInteger(httpStatus) ? httpStatus : 0,
              body,
            );
            provider = {
              httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
              bytes: artifact.exists ? artifact.bytes : 0,
              truncated: artifact.exists ? artifact.truncated : false,
              ...interpreted,
            };
            if (!interpreted.completed) {
              return json(
                {
                  error: "canary_incomplete",
                  probes: { ...probes, provider },
                  shutdown: { destroy: await destroySandbox(sandbox) },
                },
                409,
              );
            }
          }
          return json({
            runId: job.runId,
            processId: null,
            startedAt: new Date().toISOString(),
            canary: true,
            placementId,
            container,
            credentialIsolation: isolation,
            probes: { ...probes, provider },
          });
        }

        const process = await bounded(
          "review process start",
          sandbox.startProcess(
            targetReviewCommand(
              directory,
              job.totalTimeoutSeconds,
              REVIEW_RUNNER,
              job.targetEnv,
            ),
            { autoCleanup: false },
          ),
        );
        return json({
          runId: job.runId,
          processId: process.id,
          startedAt: new Date().toISOString(),
          placementId,
          container,
          credentialIsolation: isolation,
          probes,
        });
      } catch (error) {
        return json(
          {
            error: "start_failed",
            detail: messageOf(error),
            shutdown: { destroy: await destroySandbox(sandbox) },
          },
          500,
        );
      }
    }

    const runIdRaw = segments[1];
    if (!runIdRaw) return json({ error: "not_found" }, 404);
    let runId: string;
    try {
      runId = assertCloudRunId(runIdRaw);
    } catch (error) {
      return json({ error: "invalid_run", detail: messageOf(error) }, 400);
    }
    const sandbox = getSandbox(env.REVIEW_SANDBOX, runId);
    const directory = runDir(runId);

    if (request.method === "GET" && segments[2] === "state") {
      const artifacts = await readArtifacts(sandbox, directory);
      let processes: { id: string; command: string; status: string }[] = [];
      let processesError: string | null = null;
      try {
        const listed = await bounded("process list", sandbox.listProcesses());
        processes = listed.map((process) => ({
          id: process.id,
          command: process.command,
          status: process.status,
        }));
      } catch (error) {
        processesError = messageOf(error);
      }
      let modelUsage = null;
      try {
        modelUsage = await bounded("model usage", sandbox.modelUsage());
      } catch (error) {
        processesError = processesError ?? messageOf(error);
      }
      return json({
        runId,
        observedAt: new Date().toISOString(),
        placementId: await bounded(
          "placement lookup",
          sandbox.getContainerPlacementId(),
        ),
        processes,
        processesError,
        control: { modelUsage },
        artifacts,
      });
    }

    if (request.method === "POST" && segments[2] === "command") {
      let command: ReturnType<typeof parseBridgeCommand>;
      try {
        command = parseBridgeCommand(await request.json());
      } catch (error) {
        return json(
          { error: "invalid_command", detail: messageOf(error) },
          400,
        );
      }
      try {
        const payload = bridgeCommandPayload(command);
        const path =
          payload.length > BRIDGE_COMMAND_MAX_BYTES
            ? bridgeCommandFile(
                directory,
                await bounded(
                  "command sequence",
                  sandbox.nextCommandSequence(),
                ),
              )
            : null;
        if (path) {
          await bounded("command write", sandbox.writeFile(path, payload));
        }
        const sent = await bounded(
          "bridge command",
          sandbox.exec(
            path
              ? targetSendFileCommand(directory, REVIEW_RUNNER, path)
              : targetSendCommand(directory, REVIEW_RUNNER, command),
          ),
        );
        const raw = sent.stdout.trim();
        try {
          return json(JSON.parse(raw) as unknown);
        } catch {
          return json(
            { error: "bridge_unparsed", detail: raw.slice(0, 400) },
            502,
          );
        }
      } catch (error) {
        return json({ error: "bridge_failed", detail: messageOf(error) }, 502);
      }
    }

    if (request.method === "POST" && segments[2] === "stop") {
      let killed: number | null = null;
      let killError: string | null = null;
      // This is the only control-side record of what the model channel
      // carried, and the artifacts this response ships beside it are
      // target-writable.
      let modelSeals: (string | null)[] | null = null;
      try {
        modelSeals = await bounded("model seals", sandbox.modelSeals());
      } catch (error) {
        killError = killError ?? messageOf(error);
      }
      try {
        killed = await bounded("process cleanup", sandbox.killAllProcesses());
      } catch (error) {
        killError = messageOf(error);
      }
      const artifacts = await readArtifacts(sandbox, directory);
      try {
        await bounded("clear model session", sandbox.clearModelSession());
      } catch (error) {
        killError = killError ?? messageOf(error);
      }
      const destroy = await destroySandbox(sandbox);
      return json({
        runId,
        killed,
        killError,
        destroyedAt: destroy.acknowledged ? new Date().toISOString() : null,
        control: { modelSeals },
        artifacts,
        shutdown: { destroy },
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
