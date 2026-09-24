import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  adaptModelsConfig,
  assertRunId,
  BROKER_PORT,
  brokerInstallCommands,
  CLOUD_MODEL,
  CLOUD_PROVIDER,
  type ClaudeCodeTokens,
  CONTROL_DIR,
  CONTROL_UID,
  containerRunArgs,
  createBudget,
  defaultContextPath,
  mintRunId,
  modelCredentials,
  openaiCodexBrokerHandle,
  parseCandidateIds,
  parseOptions,
  planBroker,
  prepareTransport,
  readLaneReceipt,
  readLocalReceipt,
  redactArgs,
  redactValues,
  resolveClaudeCodeTokens,
  resolveRunCredentials,
  resolveUpstream,
  TARGET_UID,
  TEARDOWN_BUDGET_SECONDS,
  targetProviderEnv,
  writeLocalReceipt,
} from "../local";
import { SESSION_CAPS } from "../provider-budget";
import { neverReachedModel } from "../swarm";

const temporaryDirectories: string[] = [];
const runOutputs = new Map<number, () => string>();

// A failed test keeps its scratch (the fake docker's log lives there) and
// prints what each CLI it ran had said, since a timeout shows neither.
afterEach(async (context) => {
  if (context.task.result?.state === "fail") {
    for (const [pid, output] of runOutputs) {
      console.error(`local CLI pid ${pid} said:\n${output()}`);
    }
    console.error(`scratch kept: ${temporaryDirectories.splice(0).join(" ")}`);
    runOutputs.clear();
    return;
  }
  runOutputs.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const commit = (repo: string, message: string) =>
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=review-pi-test",
    "-c",
    "user.email=review-pi-test@invalid",
    "commit",
    "-q",
    "-m",
    message,
  ]);

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The checkout the CLI reviews: a throwaway repository that carries the
 * commits, named by `--source` rather than assumed to be three levels above
 * the driver's own source file.
 */
const repoRoot = await mkdtemp(join(tmpdir(), "review-pi-repo-"));
afterAll(() => rm(repoRoot, { recursive: true }));
execFileSync("git", ["init", "-q", repoRoot]);
await writeFile(join(repoRoot, "tracked.txt"), "only commit\n");
execFileSync("git", ["-C", repoRoot, "add", "."]);
commit(repoRoot, "base");
const localScript = join(packageRoot, "src/local.ts");
const promptPath = join(packageRoot, "prompts", "review-prompt-local.txt");
const runnerSha = createHash("sha256")
  .update(readFileSync(join(packageRoot, "container/review-run.sh")))
  .digest("hex");

const installedOpenaiCodexAdapter = () => {
  const tried: string[] = [];
  const consider = (adapter: string) => {
    tried.push(adapter);
    return existsSync(adapter) ? adapter : null;
  };
  try {
    const pkg = join(
      dirname(
        realpathSync(
          execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
        ),
      ),
      "..",
      "..",
    );
    const nested = consider(
      join(
        pkg,
        "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
      ),
    );
    if (nested) return nested;
    try {
      const resolved = consider(
        createRequire(join(pkg, "package.json")).resolve(
          "@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
        ),
      );
      if (resolved) return resolved;
    } catch {}
  } catch {}
  const homebrew = consider(
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
  );
  if (homebrew) return homebrew;
  throw new Error(
    `installed openai-codex adapter missing; tried ${tried.join(", ")}`,
  );
};

const adapterInstalled = (() => {
  try {
    installedOpenaiCodexAdapter();
    return true;
  } catch {
    return false;
  }
})();

const writeExecutable = async (path: string, content: string) => {
  await writeFile(path, content);
  await chmod(path, 0o755);
};

const writeCredentialStore = async (root: string, value: unknown) => {
  await mkdir(root);
  await writeFile(join(root, "auth.json"), JSON.stringify(value), {
    mode: 0o600,
  });
};

const revision = (format: string) => {
  const sha = execFileSync("git", ["log", "-1", `--format=${format}`], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split(" ")[0];
  if (!sha) throw new Error(`git log returned no ${format}`);
  return sha;
};

// A stalled run has to end through its own receipt, which names the phase that
// hung, before vitest gives up on the test: the run budget, then the teardown's
// own budget, then a margin for the receipt write.
const RUN_BUDGET_SECONDS = 20;
const LIFECYCLE_TEST_TIMEOUT_MS =
  (RUN_BUDGET_SECONDS + TEARDOWN_BUDGET_SECONDS + 10) * 1000;

const localArguments = (out: string, runId: string) => [
  localScript,
  "--head",
  revision("%H"),
  "--base",
  revision("%H"),
  "--prompt",
  promptPath,
  "--out",
  out,
  "--run-id",
  runId,
  "--repo",
  "acme/demo",
  "--source",
  repoRoot,
  "--total-timeout",
  String(RUN_BUDGET_SECONDS),
];

const runLocalCli = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; output: string }>((resolvePromise) => {
    let output = "";
    const child = spawn("bun", args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    if (child.pid) runOutputs.set(child.pid, () => output);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });

const fakeDockerScript = `#!/bin/bash
set -u
state="\${FAKE_STATE:?}"
root="\${FAKE_CONTAINER_ROOT:?}"
joined=" $* "
echo "$*" >> "$state/docker.log"
if [[ "$1" == "ps" ]]; then
  if [[ ("$joined" == *" label=review-pi.ownership="* || "$joined" == *" name=^"*) && -f "$state/created" ]]; then
    echo fake-container-id
  fi
  exit 0
fi
if [[ "$1 $2" == "image inspect" ]]; then
  echo sha256:fake-image
  exit 0
fi
if [[ "$1" == "run" && "$joined" == *" --rm "* ]]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  echo "overlay 39911424 18320160 21591264 46% /"
  for tool in bun git jq node rg cargo setpriv; do
    if [[ "\${FAKE_MISSING_TOOL:-}" == "$tool" ]]; then
      echo "tool $tool MISSING"
    else
      echo "tool $tool 1.0.0"
    fi
  done
  exit 0
fi
if [[ "$1" == "run" ]]; then
  touch "$state/created"
  if [[ "\${FAKE_MODE:-}" == "uncertain" ]]; then
    echo "daemon created container but client response was lost" >&2
    exit 124
  fi
  echo fake-container-id
  exit 0
fi
if [[ "$1" == "cp" ]]; then
  if [[ "$3" == *"/auth.json" ]]; then
    /bin/cp "$2" "$root/auth.json"
    /bin/cp "$2" "$root/copied-auth.json"
    printf '%s' "$2" > "$state/auth-source-path"
  fi
  if [[ "$3" == *"/broker.json" ]]; then
    /bin/cp "$2" "$root/broker.json"
    /bin/cp "$2" "$root/copied-broker.json"
    printf '%s' "$2" > "$state/auth-source-path"
  fi
  if [[ "$3" == *"/models.json" ]]; then
    /bin/cp "$2" "$root/models.json"
    /bin/cp "$2" "$root/copied-models.json"
  fi
  if [[ "$3" == *"/job.json" ]]; then
    /bin/cp "$2" "$root/job.json"
    /bin/cp "$2" "$root/copied-job.json"
  fi
  exit 0
fi
if [[ "$joined" == *"rm --force "* && ("$joined" == *"/auth.json"* || "$joined" == *"/broker.json"*) ]]; then
  if [[ "\${FAKE_AUTH_REMOVE_FAILURE:-}" == "1" ]]; then
    echo "cannot remove auth" >&2
    exit 43
  fi
  /bin/rm -f "$root/auth.json" "$root/broker.json"
  touch "$state/auth-removed"
  exit 0
fi
if [[ "$joined" == *" setpriv "* ]]; then
  touch "$state/broker-started"
  printf '%s\\n' "$*" > "$state/broker-start-argv"
  exit 0
fi
if [[ "$joined" == *"cat /opt/review/control/provider-usage.jsonl"* ]]; then
  /bin/cat "$root/provider-usage.jsonl" 2>/dev/null
  exit $?
fi
if [[ "$joined" == *"cat /opt/review/pi-config/models.json"* ]]; then
  if [[ "\${FAKE_MODE:-}" == "models-read-failure" ]]; then
    echo "cannot read models.json" >&2
    exit 1
  fi
  printf '{"providers":{"cloudflare-workers-ai":{"modelOverrides":{"@cf/deepseek-ai/deepseek-v4-flash-0731":{"contextWindow":1048576}}}}}\n'
  exit 0
fi
if [[ "$joined" == *" mkdir -p "* || "$joined" == *" chmod "* || "$joined" == *" chown "* ]]; then
  exit 0
fi
if [[ "$joined" == *" sha256sum "* ]]; then
  echo "\${FAKE_RUNNER_SHA:?}"
  exit 0
fi
if [[ "$joined" == *" --detach "* ]]; then
  if [[ "\${FAKE_MODE:-}" == "secret-error" ]]; then
    echo "credential failure: \${WORKERS_AI_API_KEY:?}" >&2
    exit 42
  fi
  if [[ "\${FAKE_MODE:-}" == "review-failure" ]]; then
    echo "review failed" >&2
    exit 42
  fi
  mkdir -p "$root"
  observed_head="\${FAKE_HEAD_SHA:?}"
  observed_base="\${FAKE_BASE_SHA:?}"
  fixture_applied=false
  if [[ "\${FAKE_MODE:-}" == "fixture-success" ]]; then
    observed_head=1111111111111111111111111111111111111111
    observed_base="\${FAKE_HEAD_SHA:?}"
    fixture_applied=true
  elif [[ "\${FAKE_MODE:-}" == "invalid-identity" ]]; then
    observed_head=0000000000000000000000000000000000000000
  fi
  printf '{"runId":"%s","phase":"complete","state":"done","detail":""}\\n' "\${FAKE_RUN_ID:?}" > "$root/status.json"
  printf '{"checkout":{"commitIdentityPreserved":true,"requestedHeadSha":"%s","requestedBaseSha":"%s","checkedOutHead":"%s","checkedOutBase":"%s","fixtureCommitApplied":"%s"},"install":{"status":"installed","manifest":"bun.lock","reason":null},"usage":{"totalTokens":1},"piVersion":"0.85.0","finalText":"VERDICT: safe. CONSUMERS READ: none. CHECK RUN: bun test, exit 0."}\\n' "\${FAKE_HEAD_SHA:?}" "\${FAKE_BASE_SHA:?}" "$observed_head" "$observed_base" "$fixture_applied" > "$root/report.json"
  if [ "$FAKE_MODE" = "install-skipped" ]; then
    jq '.install={status:"skipped",manifest:null,reason:"the checkout root has no package.json"}' "$root/report.json" > "$root/report.json.tmp"
    mv "$root/report.json.tmp" "$root/report.json"
  fi
  printf '{"type":"turn_end","stopReason":"stop"}\\n' > "$root/trace.jsonl"
  if [[ "\${FAKE_MODE:-}" == "oversize-trace" ]]; then
    head -c 600000 /dev/zero | tr '\\0' 'x' >> "$root/trace.jsonl"
  fi
  exit 0
fi
if [[ "$1" == "exec" && "$joined" == *" --send "* ]]; then
  payload="\${@: -1}"
  cmd_type=$(printf '%s' "$payload" | /usr/bin/sed -n 's/.*"type":"\\([a-z_]*\\)".*/\\1/p')
  if [[ -z "$cmd_type" ]]; then
    echo "bridge request without a type: $payload" >&2
    exit 2
  fi
  if [[ "\${FAKE_BRIDGE:-}" == "unavailable" ]]; then
    echo "no such file or directory: rpc.sock" >&2
    exit 1
  fi
  if [[ -n "\${FAKE_BRIDGE_FLAKY:-}" ]]; then
    flaky=0
    [[ -f "$state/bridge-flaky" ]] && flaky=$(cat "$state/bridge-flaky")
    if [[ "$flaky" -lt "\${FAKE_BRIDGE_FLAKY}" ]]; then
      echo $(( flaky + 1 )) > "$state/bridge-flaky"
      echo "no such file or directory: rpc.sock" >&2
      exit 1
    fi
  fi
  case "$cmd_type" in
    inspect)
      step=0
      [[ -f "$state/bridge-step" ]] && step=$(cat "$state/bridge-step")
      IFS=',' read -r -a states <<< "\${FAKE_BRIDGE_STATES:-done}"
      last=$(( \${#states[@]} - 1 ))
      index=$step
      [[ $index -gt $last ]] && index=$last
      current="\${states[$index]}"
      echo $(( step + 1 )) > "$state/bridge-step"
      candidate=""
      idle=false
      if [[ "$current" == "idle" ]]; then
        idle=true
        candidate="\${FAKE_CANDIDATE:-}"
        if [[ -f "$state/corrected" ]]; then
          candidate="\${FAKE_CANDIDATE_CORRECTED:-$candidate}"
        fi
      fi
      printf '{"type":"response","command":"inspect","success":true,"data":{"runId":"%s","phase":"review","state":"%s","detail":"","childIdle":%s,"isStreaming":false,"inFlightTool":null,"terminalReason":"%s","lastCandidateResult":%s,"process":{"alive":true,"pid":4242},"session":{"sessionId":"fake-session","sessionFile":"/dev/null"}}}\\n' \\
        "\${FAKE_RUN_ID:?}" "$current" "$idle" "\${FAKE_TERMINAL_REASON:-}" "$(printf '%s' "$candidate" | /usr/bin/python3 -c 'import json,sys; print(json.dumps(sys.stdin.read() or None))')"
      exit 0
      ;;
    prompt)
      touch "$state/corrected"
      printf '%s\\n' "$payload" >> "$state/bridge-prompts"
      printf '{"type":"response","command":"prompt","success":true,"data":{}}\\n'
      exit 0
      ;;
    steer)
      printf '%s\\n' "$payload" >> "$state/bridge-steers"
      printf '{"type":"response","command":"steer","success":true,"data":{}}\\n'
      exit 0
      ;;
    accept)
      touch "$state/accepted"
      printf '{"type":"response","command":"accept","success":true,"data":{}}\\n'
      exit 0
      ;;
    cancel)
      touch "$state/cancelled"
      if [[ "\${FAKE_CANCEL:-}" == "unreachable" ]]; then
        echo "bridge is gone" >&2
        exit 1
      fi
      printf '{"type":"response","command":"cancel","success":true,"data":{}}\\n'
      exit 0
      ;;
    restart_process)
      touch "$state/restarted"
      printf '{"type":"response","command":"restart_process","success":true,"data":{}}\\n'
      exit 0
      ;;
    *)
      echo "unknown bridge command: $cmd_type" >&2
      exit 2
      ;;
  esac
fi
if [[ "$1" == "exec" && "\${@: -2:1}" == "cat" ]]; then
  if [[ -n "\${FAKE_PREPARATION_STATUS:-}" && "\${@: -1}" == *"/status.json" ]]; then
    printf '%s\\n' "\${FAKE_PREPARATION_STATUS}"
    exit 0
  fi
  target=$(printf '%s' "\${@: -1}" | /usr/bin/sed "s#/workspace/runs/\${FAKE_RUN_ID:?}#$root#g")
  /bin/cat "$target" 2>/dev/null
  exit $?
fi
if [[ "$1" == "exec" ]]; then
  command="\${@: -1}"
  if [[ "\${FAKE_MODE:-}" == "split-utf8" && "$joined" == *"review-pi-present"* && "$joined" == *"/trace.jsonl"* ]]; then
    printf 'review-pi-present\\n{"type":"turn_end","stopReason":"st'
    printf '\\303'
    sleep 0.1
    printf '\\263p"}\\n'
    exit 0
  fi
  rewritten=$(printf '%s' "$command" | /usr/bin/sed "s#/workspace/runs/\${FAKE_RUN_ID:?}#$root#g")
  /bin/sh -c "$rewritten"
  exit $?
fi
if [[ "$1" == "rm" ]]; then
  rm -f "$state/created"
  echo fake-container-id
  exit 0
fi
exit 0
`;

describe("reviewer context", () => {
  const base = ["--pr", "6633", "--out", "/tmp/out", "--prompt", "/p.txt"];

  it("ships a brief that says nothing about the repository under review", async () => {
    const path = defaultContextPath();
    expect(existsSync(path)).toBe(true);
    const brief = await readFile(path, "utf8");
    // The whole point of the default: it neutralizes the checkout's own
    // contributor guide without asserting anything about the tree.
    expect(brief).toContain("not contributing to it");
    expect(brief).toContain("AGENTS.md");
  });

  it("takes the caller's brief when one is named", () => {
    expect(parseOptions(base).contextPath).toBeUndefined();
    expect(
      parseOptions([...base, "--context", "/briefs/demo.md"]).contextPath,
    ).toBe("/briefs/demo.md");
  });
});

describe("credential boundary", () => {
  it("injects only the selected route's credential", () => {
    const env = {
      OPENCODE_API_KEY: "opencode-secret",
      CLOUDFLARE_AIG_TOKEN: "workers-ai-secret",
      CLOUDFLARE_ACCOUNT_ID: "account",
      GITHUB_TOKEN: "github-secret",
    };

    expect(modelCredentials("cloudflare-workers-ai", env)).toEqual({
      CLOUDFLARE_API_KEY: "workers-ai-secret",
      CLOUDFLARE_ACCOUNT_ID: "account",
    });
    expect(modelCredentials("opencode-go", env)).toEqual({
      OPENCODE_API_KEY: "opencode-secret",
    });
    expect(modelCredentials("unknown-provider", env)).toEqual({});
  });

  it("reads candidate ids however the caller spelled them", () => {
    // The swarm emits JSON; a driver that only split on commas would hold the
    // literal `["c1"]` and call every verdict an unknown candidate.
    expect(parseCandidateIds(JSON.stringify(["c1", "c2"]))).toEqual([
      "c1",
      "c2",
    ]);
    expect(parseCandidateIds("c1, c2")).toEqual(["c1", "c2"]);
    expect(parseCandidateIds("c1")).toEqual(["c1"]);
  });

  it("routes the gateway through its own account and gateway path", () => {
    const credentials = {
      authRoute: "api-key" as const,
      accessToken: undefined,
      authJson: null,
      env: {
        CLOUDFLARE_API_KEY: "aig-secret",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_GATEWAY_ID: "default",
      },
      redactions: ["aig-secret"],
    };
    expect(resolveUpstream("cloudflare-ai-gateway", credentials)).toEqual({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/account/default/compat",
      bearer: "aig-secret",
    });
    // Pi will not configure the gateway without both ids, and neither is a
    // credential: the key it needs stays with the broker.
    expect(targetProviderEnv("cloudflare-ai-gateway", credentials)).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_GATEWAY_ID: "default",
    });
    expect(() =>
      resolveUpstream("cloudflare-ai-gateway", {
        ...credentials,
        env: {
          CLOUDFLARE_API_KEY: "aig-secret",
          CLOUDFLARE_ACCOUNT_ID: "account",
        },
      }),
    ).toThrow(/CLOUDFLARE_GATEWAY_ID/);
    // The gateway routes on a provider prefix the model id carries, so a bare
    // Workers AI id is a 404 the default would hand every cloud lane that
    // named no model of its own.
    expect(CLOUD_PROVIDER).toBe("cloudflare-ai-gateway");
    expect(CLOUD_MODEL).toMatch(/^[a-z-]+\//);
    expect(resolveUpstream(CLOUD_PROVIDER, credentials).baseUrl).toContain(
      "gateway.ai.cloudflare.com",
    );
  });

  it("creates the container without host state or a credential", () => {
    const args = containerRunArgs("review-pi-local-x", "review-pi-b5-local");

    expect(args).not.toContain("--volume");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--env-file");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("--env");
    expect(args).toContain("review-pi-local-x");
  });

  it("selects only the OpenAI Codex OAuth entry as access-only credential without refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "openai-access",
        refresh: "openai-refresh",
        expires: Date.now() + 2_000_000,
        accountId: "account-id",
        identity: "must-not-cross",
      },
      anthropic: { type: "oauth", access: "other-provider-secret" },
    });

    const resolved = await resolveRunCredentials("openai-codex", 600, {
      PI_CODING_AGENT_DIR: piDir,
      OPENAI_API_KEY: "ambient-api-key",
    });
    expect(resolved).toMatchObject({
      authRoute: "subscription-oauth",
      accessToken: "openai-access",
      accountId: "account-id",
      authJson: null,
      env: {},
    });
    expect(resolved.redactions).toContain("openai-access");
    expect(resolved.redactions).toContain("openai-refresh");
    expect(JSON.stringify(resolved)).not.toContain("must-not-cross");
    expect(JSON.stringify(resolved)).not.toContain("other-provider-secret");
    expect((resolved as Record<string, unknown>)["refresh"]).toBeUndefined();
  });

  it("maps only a native xAI OIDC credential as access-only without refresh token", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    const grokDir = join(root, "grok");
    await writeCredentialStore(piDir, {
      "openai-codex": { type: "oauth", access: "other-provider-secret" },
    });
    await writeCredentialStore(grokDir, {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        auth_mode: "oidc",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        key: "xai-access",
        refresh_token: "xai-refresh",
        expires_at: new Date(Date.now() + 2_000_000).toISOString(),
        email: "identity-must-not-cross",
        team_id: "team-must-not-cross",
      },
    });

    const resolved = await resolveRunCredentials("xai", 600, {
      PI_CODING_AGENT_DIR: piDir,
      GROK_AUTH_DIR: grokDir,
      XAI_API_KEY: "api-fallback-must-not-cross",
    });

    expect(resolved).toMatchObject({
      authRoute: "subscription-oauth",
      accessToken: "xai-access",
      authJson: null,
      env: {},
    });
    expect(resolved.redactions).toContain("xai-access");
    expect(resolved.redactions).toContain("xai-refresh");
    expect((resolved as Record<string, unknown>)["refresh"]).toBeUndefined();
    expect(
      (resolved as Record<string, unknown>)["refresh_token"],
    ).toBeUndefined();
  });

  it("prefers an existing selected xAI entry in Pi auth as access-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      xai: {
        type: "oauth",
        access: "pi-xai-access",
        refresh: "pi-xai-refresh",
        expires: Date.now() + 2_000_000,
        identity: "must-not-cross",
      },
      "openai-codex": { type: "oauth", access: "other-provider-secret" },
    });

    const resolved = await resolveRunCredentials("xai", 600, {
      PI_CODING_AGENT_DIR: piDir,
      GROK_AUTH_DIR: join(root, "missing-native-store"),
    });

    expect(resolved).toMatchObject({
      authRoute: "subscription-oauth",
      accessToken: "pi-xai-access",
      authJson: null,
      expires: expect.any(Number),
    });
    expect((resolved as Record<string, unknown>)["refresh"]).toBeUndefined();
  });

  it("rejects API fallbacks and invalid native xAI metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const missing = join(root, "missing");
    const invalid = join(root, "invalid");
    await writeCredentialStore(invalid, {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        auth_mode: "api_key",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        key: "xai-access",
        refresh_token: "xai-refresh",
        expires_at: new Date(Date.now() + 2_000_000).toISOString(),
      },
    });

    await expect(
      resolveRunCredentials("xai", 600, {
        PI_CODING_AGENT_DIR: join(root, "missing-pi"),
        GROK_AUTH_DIR: missing,
        XAI_API_KEY: "forbidden-fallback",
      }),
    ).rejects.toThrow(/no model credential available for xai/);
    await expect(
      resolveRunCredentials("xai", 600, {
        PI_CODING_AGENT_DIR: join(root, "missing-pi"),
        GROK_AUTH_DIR: invalid,
      }),
    ).rejects.toThrow(/no model credential available for xai/);
    await expect(
      resolveRunCredentials("unknown-provider", 600, {
        UNKNOWN_PROVIDER_API_KEY: "forbidden-generic-fallback",
      }),
    ).rejects.toThrow(/no model credential available for unknown-provider/);
  });

  it("admits a valid credential without whole-review duration and rejects expired credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    const grokDir = join(root, "grok");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "openai-access",
        refresh: "openai-refresh",
        expires: Date.now() + 120_000,
      },
    });
    await writeCredentialStore(grokDir, {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        auth_mode: "oidc",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        key: "xai-access",
        refresh_token: "xai-refresh",
        expires_at: new Date(Date.now() - 5000).toISOString(),
      },
    });

    const resolved = await resolveRunCredentials("openai-codex", 600, {
      PI_CODING_AGENT_DIR: piDir,
    });
    expect(resolved.authRoute).toBe("subscription-oauth");
    expect(resolved.accessToken).toBe("openai-access");
    expect(resolved.authJson).toBeNull();

    await expect(
      resolveRunCredentials("xai", 600, {
        PI_CODING_AGENT_DIR: join(root, "missing-pi"),
        GROK_AUTH_DIR: grokDir,
      }),
    ).rejects.toThrow(/expired model credential for xai/);
  });

  it("serves a Claude Code subscription token that can still outlive the next request", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    const expires = Date.now() + 3_600_000;
    const stored = {
      "claude-code": {
        type: "oauth",
        access: "cc-access",
        refresh: "cc-refresh",
        expires,
      },
    };
    await writeCredentialStore(piDir, stored);
    let refreshed = 0;

    const tokens = await resolveClaudeCodeTokens(
      { PI_CODING_AGENT_DIR: piDir },
      async (current) => {
        refreshed += 1;
        return current;
      },
    );

    expect(tokens).toEqual({
      access: "cc-access",
      refresh: "cc-refresh",
      expires,
    });
    expect(refreshed).toBe(0);
    expect(
      JSON.parse(await readFile(join(piDir, "auth.json"), "utf8")),
    ).toEqual(stored);
  });

  it("replaces an expiring Claude Code token and persists the rotated pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    const stored = {
      "claude-code": {
        type: "oauth",
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() + 60_000,
      },
      "openai-codex": {
        type: "oauth",
        access: "other-access",
        refresh: "other-refresh",
        expires: Date.now() + 3_600_000,
      },
    };
    await writeCredentialStore(piDir, stored);
    const rotated = {
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 3_600_000,
    };
    const seen: ClaudeCodeTokens[] = [];

    const tokens = await resolveClaudeCodeTokens(
      { PI_CODING_AGENT_DIR: piDir },
      async (current) => {
        seen.push(current);
        return rotated;
      },
    );

    expect(seen).toEqual([
      {
        access: "stale-access",
        refresh: "stale-refresh",
        expires: stored["claude-code"].expires,
      },
    ]);
    expect(tokens).toEqual(rotated);
    const written = JSON.parse(
      await readFile(join(piDir, "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written["claude-code"]).toEqual({ type: "oauth", ...rotated });
    expect(written["openai-codex"]).toEqual(stored["openai-codex"]);
    expect((await stat(join(piDir, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  it("leaves the store untouched when the subscription refresh fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    const stored = {
      "claude-code": {
        type: "oauth",
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() + 60_000,
      },
    };
    await writeCredentialStore(piDir, stored);

    await expect(
      resolveClaudeCodeTokens({ PI_CODING_AGENT_DIR: piDir }, async () => {
        throw new Error("invalid_grant");
      }),
    ).rejects.toThrow(/invalid_grant/);
    expect(
      JSON.parse(await readFile(join(piDir, "auth.json"), "utf8")),
    ).toEqual(stored);
  });

  it("reads the Claude Code subscription from Pi's store and never from an API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "claude-code": {
        type: "oauth",
        access: "cc-access",
        refresh: "cc-refresh",
        expires: Date.now() + 3_600_000,
        identity: "must-not-cross",
      },
      anthropic: { type: "oauth", access: "other-provider-secret" },
    });

    const resolved = await resolveRunCredentials("claude-code", 600, {
      PI_CODING_AGENT_DIR: piDir,
      ANTHROPIC_API_KEY: "ambient-api-key",
    });

    expect(resolved).toMatchObject({
      authRoute: "subscription-oauth",
      accessToken: "cc-access",
      authJson: null,
      env: {},
    });
    expect(resolved.redactions).toEqual(["cc-access", "cc-refresh"]);
    expect(JSON.stringify(resolved)).not.toContain("must-not-cross");
    expect(JSON.stringify(resolved)).not.toContain("other-provider-secret");
    expect((resolved as Record<string, unknown>)["refresh"]).toBeUndefined();
  });

  it("refuses a Claude Code lane with no subscription credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-auth-"));
    temporaryDirectories.push(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      anthropic: { type: "oauth", access: "other-provider-secret" },
    });

    await expect(
      resolveRunCredentials("claude-code", 600, {
        PI_CODING_AGENT_DIR: piDir,
        ANTHROPIC_API_KEY: "ambient-api-key",
      }),
    ).rejects.toThrow(/no Claude Code subscription credential/);
    await expect(
      resolveRunCredentials("claude-code", 600, {
        PI_CODING_AGENT_DIR: join(root, "missing-pi"),
      }),
    ).rejects.toThrow(/login claude-code/);
  });

  it("adapts models.json to add provider apiKey command while preserving unrelated config", () => {
    const existing = JSON.stringify({
      providers: {
        "cloudflare-workers-ai": {
          modelOverrides: {
            "@cf/deepseek-ai/deepseek-v4-flash-0731": {
              contextWindow: 1048576,
              maxTokens: 65536,
            },
          },
        },
      },
    });
    const adaptedCodex = adaptModelsConfig(existing, "openai-codex", {
      apiKey: "review-pi-handle-1",
      baseUrl: "http://127.0.0.1:8317",
    });
    const parsedCodex = JSON.parse(adaptedCodex);
    expect(
      parsedCodex.providers["cloudflare-workers-ai"].modelOverrides[
        "@cf/deepseek-ai/deepseek-v4-flash-0731"
      ].contextWindow,
    ).toBe(1048576);
    expect(parsedCodex.providers["openai-codex"]).toMatchObject({
      apiKey: "review-pi-handle-1",
      baseUrl: "http://127.0.0.1:8317",
    });

    const adaptedXai = adaptModelsConfig(adaptedCodex, "xai", {
      apiKey: "review-pi-handle-2",
      baseUrl: "http://127.0.0.1:8317",
    });
    const parsedXai = JSON.parse(adaptedXai);
    expect(parsedXai.providers["openai-codex"].apiKey).toBe(
      "review-pi-handle-1",
    );
    expect(parsedXai.providers["xai"].apiKey).toBe("review-pi-handle-2");
  });

  it("rejects malformed models.json instead of silently replacing with empty config", () => {
    const handle = { apiKey: "cmd" };
    expect(() => adaptModelsConfig("not-json", "xai", handle)).toThrow();
    expect(() => adaptModelsConfig("[]", "xai", handle)).toThrow(
      /models.json: expected a JSON object/,
    );
    expect(() => adaptModelsConfig("null", "xai", handle)).toThrow(
      /models.json: expected a JSON object/,
    );
  });
});

describe("credential isolation", () => {
  const caps = {
    maxRequests: 8,
    maxRetriesPerRequest: 1,
    maxInputTokensPerRequest: 131072,
    maxOutputTokensPerRequest: 8192,
    maxCumulativeInputTokens: 250000,
    maxCumulativeOutputTokens: 16000,
    maxRequestBytes: 1024,
  };
  const ledger = "/opt/review/control/provider-usage.jsonl";

  it("points Pi at the loopback broker and hands it a handle, not the bearer", () => {
    const plan = planBroker(
      "cloudflare-workers-ai",
      {
        authRoute: "api-key",
        accessToken: undefined,
        authJson: null,
        env: {
          CLOUDFLARE_API_KEY: "cf-secret",
          CLOUDFLARE_ACCOUNT_ID: "acct-9",
        },
        redactions: ["cf-secret"],
      },
      caps,
      ledger,
    );

    expect(plan.baseUrl).toBe(`http://127.0.0.1:${BROKER_PORT}`);
    expect(plan.handle).toMatch(/^review-pi-/);
    expect(plan.handle).not.toContain("cf-secret");
    expect(plan.config.upstreamBaseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-9/ai/v1",
    );
    expect(plan.config.upstreamAuthorization).toBe("Bearer cf-secret");
  });

  it("carries a subscription bearer the same way an API key travels", () => {
    const plan = planBroker(
      "xai",
      {
        authRoute: "subscription-oauth",
        accessToken: "xai-access",
        expires: Date.now() + 60_000,
        authJson: null,
        env: {},
        redactions: ["xai-access", "xai-refresh"],
      },
      caps,
      ledger,
    );

    expect(plan.config.upstreamBaseUrl).toBe("https://api.x.ai/v1");
    expect(plan.config.upstreamAuthorization).toBe("Bearer xai-access");
  });

  it("gives openai-codex a JWT-shaped handle and keeps the real account id on the broker", () => {
    const bearer = "codex-access-token-not-a-jwt";
    const plan = planBroker(
      "openai-codex",
      {
        authRoute: "subscription-oauth",
        accessToken: bearer,
        accountId: "acct-real",
        expires: Date.now() + 60_000,
        authJson: null,
        env: {},
        redactions: [bearer],
      },
      caps,
      ledger,
    );

    expect(plan.handle.split(".")).toHaveLength(3);
    expect(plan.handle).not.toContain(bearer);
    expect(plan.handle).not.toContain("acct-real");
    expect(plan.config.upstreamAuthorization).toBe(`Bearer ${bearer}`);
    expect(plan.config.upstreamAccountId).toBe("acct-real");
    const payload = JSON.parse(
      Buffer.from(plan.handle.split(".")[1] ?? "", "base64").toString("utf8"),
    );
    expect(payload["https://api.openai.com/auth"].chatgpt_account_id).toBe(
      "review-pi",
    );
  });

  it("reads chatgpt_account_id from the real token when auth.json omitted it", () => {
    const accountId = "acct-from-jwt";
    const bearer = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64"),
      Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
      ).toString("base64"),
      "sig",
    ].join(".");
    const plan = planBroker(
      "openai-codex",
      {
        authRoute: "subscription-oauth",
        accessToken: bearer,
        expires: Date.now() + 60_000,
        authJson: null,
        env: {},
        redactions: [bearer],
      },
      caps,
      ledger,
    );

    expect(plan.config.upstreamAccountId).toBe(accountId);
    expect(plan.handle).not.toContain(accountId);
    expect(plan.handle).not.toContain(bearer);
  });

  it("refuses openai-codex when no account id can be recovered without handing Pi the bearer", () => {
    expect(() =>
      planBroker(
        "openai-codex",
        {
          authRoute: "subscription-oauth",
          accessToken: "not-a-jwt",
          expires: Date.now() + 60_000,
          authJson: null,
          env: {},
          redactions: ["not-a-jwt"],
        },
        caps,
        ledger,
      ),
    ).toThrow(/Failed to extract accountId from token/);
  });

  it("refuses a provider with no single brokered upstream instead of leaking the key", () => {
    expect(() =>
      planBroker(
        "mistral",
        {
          authRoute: "api-key",
          accessToken: undefined,
          authJson: null,
          env: { MISTRAL_API_KEY: "ms-secret" },
          redactions: ["ms-secret"],
        },
        caps,
        ledger,
      ),
    ).toThrow(/has no brokered upstream/);
  });

  it("brokers opencode-go at its Go endpoint with the API key as the bearer", () => {
    const plan = planBroker(
      "opencode-go",
      {
        authRoute: "api-key",
        accessToken: undefined,
        authJson: null,
        env: { OPENCODE_API_KEY: "oc-secret" },
        redactions: ["oc-secret"],
      },
      caps,
      ledger,
    );
    expect(plan.config.upstreamBaseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(plan.config.upstreamAuthorization).toBe("Bearer oc-secret");
    expect(plan.handle).not.toContain("oc-secret");
  });

  it("brokers the Claude Code subscription at Anthropic with its OAuth token as the bearer", () => {
    const plan = planBroker(
      "claude-code",
      {
        authRoute: "subscription-oauth",
        accessToken: "cc-access",
        expires: Date.now() + 600_000,
        authJson: null,
        env: {},
        redactions: ["cc-access", "cc-refresh"],
      },
      caps,
      ledger,
    );

    expect(plan.baseUrl).toBe(`http://127.0.0.1:${BROKER_PORT}`);
    expect(plan.config.upstreamBaseUrl).toBe("https://api.anthropic.com");
    expect(plan.config.upstreamAuthorization).toBe("Bearer cc-access");
    expect(plan.handle).not.toContain("cc-access");
  });

  it("keeps the bearer out of every docker argument that installs it", () => {
    const plan = planBroker(
      "xai",
      {
        authRoute: "subscription-oauth",
        accessToken: "xai-access",
        expires: Date.now() + 60_000,
        authJson: null,
        env: {},
        redactions: ["xai-access"],
      },
      caps,
      ledger,
    );
    const commands = brokerInstallCommands("box", "/stage/broker.json");
    const argv = [
      ...commands.prepare,
      ...commands.copy,
      ...commands.secure,
      ...commands.start,
    ];

    expect(argv.join(" ")).not.toContain("xai-access");
    expect(argv.join(" ")).not.toContain(plan.config.upstreamAuthorization);
    // The credential reaches the container as a file, and only the control uid
    // can open it.
    expect(commands.secure.at(-1)).toContain(`chmod 0600 ${CONTROL_DIR}`);
    expect(commands.start).toContain(`--reuid=${CONTROL_UID}`);
    expect(commands.start).toContain("--clear-groups");
  });

  it("starts the reviewed code as a different uid from the one holding the credential", () => {
    expect(TARGET_UID).not.toBe(CONTROL_UID);
  });
});

const driveInstalledCodex = async (apiKey: string) => {
  const { stream } = await import(
    pathToFileURL(installedOpenaiCodexAdapter()).href
  );
  const calls: { url: string; accountId: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      accountId: new Headers(init?.headers).get("chatgpt-account-id"),
    });
    return new Response("no", { status: 500 });
  };
  const events = stream(
    {
      id: "gpt-5.6-sol",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "http://127.0.0.1:9",
      input: ["text"],
    },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    },
    {
      apiKey,
      transport: "sse",
      fetch,
    },
  );
  let error: string | undefined;
  for await (const event of events) {
    if (event.type === "error") {
      error = event.error?.errorMessage ?? String(event.error);
    }
  }
  return { calls, error };
};

describe("openai-codex broker handle through the installed Pi adapter", () => {
  it.skipIf(!adapterInstalled)(
    "rejects a uuid handle before any request, and accepts the JWT-shaped handle",
    async () => {
      const rejected = await driveInstalledCodex(
        "review-pi-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      );
      expect(rejected.calls).toEqual([]);
      expect(rejected.error).toBe("Failed to extract accountId from token");

      const accepted = await driveInstalledCodex(openaiCodexBrokerHandle("n1"));
      expect(accepted.calls).toEqual([
        {
          url: "http://127.0.0.1:9/codex/responses",
          accountId: "review-pi",
        },
      ]);
      expect(accepted.error).not.toBe("Failed to extract accountId from token");
    },
  );
});

describe("deadline and redaction", () => {
  it("refuses every later phase once the shared deadline has passed", () => {
    const spent = createBudget(Date.now() - 700_000, 600);
    const live = createBudget(Date.now(), 600);

    expect(() => spent.take("transport fetch")).toThrow(
      /total deadline exceeded before transport fetch/,
    );
    expect(live.take("transport fetch")).toBeGreaterThan(0);
    expect(live.remainingMs()).toBeLessThanOrEqual(600_000);
  });

  it("rejects host work after the deadline", async () => {
    const budget = createBudget(Date.now(), 600);

    expect(budget.take("clone")).toBeLessThanOrEqual(600_000);
    await expect(
      prepareTransport(
        "/nonexistent-source",
        "/nonexistent-target",
        "0".repeat(40),
        "0".repeat(40),
        createBudget(Date.now() - 601_000, 600),
      ),
    ).rejects.toThrow(/total deadline exceeded/);
  });

  it("keeps credential values out of argv and messages", () => {
    const secret = "cfut_super_secret_value";

    expect(
      redactArgs(["exec", "--env", `CLOUDFLARE_API_KEY=${secret}`, "box"]),
    ).toEqual(["exec", "--env", "CLOUDFLARE_API_KEY=[redacted]", "box"]);
    expect(
      redactValues(`docker failed using ${secret} twice: ${secret}`, [secret]),
    ).toBe("docker failed using [redacted] twice: [redacted]");
  });

  it("only accepts a run id safe as a container and path name", () => {
    expect(assertRunId("p2-e2e-4")).toBe("p2-e2e-4");
    expect(() => assertRunId("../escape")).toThrow(/--run-id/);
    expect(() => assertRunId("run id")).toThrow(/--run-id/);
    expect(() => assertRunId("")).toThrow(/--run-id/);
  });

  it("reads a cloud receipt when local-receipt.json is absent", async () => {
    const directory = join(tmpdir(), `review-pi-cloud-receipt-${Date.now()}`);
    await mkdir(directory);
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        runId: "lane-1",
        provider: "xai",
        model: "grok-4.6",
        wallSeconds: 12,
        runError: null,
        usage: { requests: 1, retries: 0, inputTokens: 9, outputTokens: 2 },
      }),
    );
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify({
        usage: { input: 400, output: 500 },
        install: {
          status: "skipped",
          manifest: null,
          reason: "the checkout root has no package.json",
        },
      }),
    );
    await expect(readLaneReceipt(directory)).resolves.toMatchObject({
      runId: "lane-1",
      attemptId: "lane-1",
      outcome: "completed",
      // The Worker's session totals, never the numbers the target wrote into
      // its own report: the report is the uid the checkout runs as.
      usage: { requests: 1, retries: 0, inputTokens: 9, outputTokens: 2 },
      installSkipped: true,
      installSkipReason: "the checkout root has no package.json",
    });
  });

  it("reads a cloud lane's usage as unobserved when no session recorded one", async () => {
    const directory = join(tmpdir(), `review-pi-cloud-no-usage-${Date.now()}`);
    await mkdir(directory);
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        runId: "lane-1",
        provider: "xai",
        model: "grok-4.6",
        wallSeconds: 12,
        runError: null,
      }),
    );
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify({ usage: { input: 400, output: 500 } }),
    );

    // The report claims tokens and no control-side session recorded any, so
    // the lane's spend is unknown rather than the target's number.
    await expect(readLaneReceipt(directory)).resolves.toMatchObject({
      usage: null,
    });
  });

  it("leaves the install unobserved when the cloud lane wrote no report", async () => {
    const directory = join(tmpdir(), `review-pi-no-report-${Date.now()}`);
    await mkdir(directory);
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify({
        runId: "lane-1",
        provider: "xai",
        model: "grok-4.6",
        wallSeconds: 12,
        runError: "killed at clone",
      }),
    );
    const receipt = await readLaneReceipt(directory);

    // A lane that never reported is not a lane that installed: false would
    // read as an install that ran, and true as a skip nobody recorded.
    expect(receipt.installSkipped).toBeNull();
    expect(receipt.installSkipReason).toBeNull();
  });
});

describe("public local CLI lifecycle", {
  timeout: LIFECYCLE_TEST_TIMEOUT_MS,
}, () => {
  const arrangeFakeDocker = async (root: string) => {
    const bin = join(root, "bin");
    const state = join(root, "state");
    const container = join(root, "container");
    await mkdir(bin);
    await mkdir(state);
    await mkdir(container);
    await writeExecutable(join(bin, "docker"), fakeDockerScript);
    return { bin, state, container };
  };

  const fakeEnvironment = (
    arranged: Awaited<ReturnType<typeof arrangeFakeDocker>>,
    runId: string,
    mode: string,
  ) => ({
    ...process.env,
    PATH: `${arranged.bin}:${process.env["PATH"] ?? ""}`,
    FAKE_STATE: arranged.state,
    FAKE_CONTAINER_ROOT: arranged.container,
    FAKE_RUN_ID: runId,
    FAKE_MODE: mode,
    FAKE_RUNNER_SHA: runnerSha,
    FAKE_HEAD_SHA: revision("%H"),
    FAKE_BASE_SHA: revision("%H"),
    WORKERS_AI_API_KEY: "public-cli-secret",
    CLOUDFLARE_ACCOUNT_ID: "account",
  });

  it("hands the runner the caps and window its budget notice is measured against", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "budget-in-job";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "success"),
    );
    const job = JSON.parse(
      await readFile(join(arranged.container, "copied-job.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.code, result.output).toBe(0);
    // The same numbers the broker enforces, so the notice fires before the
    // cap rather than after a denial nothing can recover from.
    expect(job["budget"]).toEqual({
      requests: SESSION_CAPS.t1b.maxRequests,
      inputTokens: SESSION_CAPS.t1b.maxCumulativeInputTokens,
    });
    expect(job["totalTimeoutSeconds"]).toBe(RUN_BUDGET_SECONDS);
  });

  it("accepts a missing optional artifact and requires report plus trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "optional-absent";
    const out = join(root, "new", "nested", "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "success"),
    );
    expect(result.code, result.output).toBe(0);
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(receipt).toContain('"outcome": "completed"');
    // The identity the run was given is the one it records, not this
    // package's own repository.
    expect(receipt).toContain('"repo": "acme/demo"');
    expect(receipt).toContain('"review-error.json"');
    expect(receipt).toContain('"absentArtifacts"');
    // The runner installed in this lane, which is not the same evidence as a
    // lane that ran without dependencies.
    expect(receipt).toContain('"installSkipped": false');
  });

  it("reads a skipped install back out of the lane receipt with its reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "install-skipped";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "install-skipped"),
    );
    const receipt = await readLocalReceipt(join(out, runId));

    expect(result.code, result.output).toBe(0);
    // The install step's exit code is zero either way; the receipt is where a
    // lane that ran without dependencies is readable as such.
    expect(receipt.installSkipped).toBe(true);
    expect(receipt.installSkipReason).toBe(
      "the checkout root has no package.json",
    );
  });

  it("leaves the install unobserved when the runner never reported", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "install-unobserved";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "review-failure"),
    );
    const receipt = await readLocalReceipt(join(out, runId));

    expect(result.code).toBe(1);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.installSkipped).toBeNull();
    expect(receipt.installSkipReason).toBeNull();
  });

  it("refuses a run that names no target repository or checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "unset-target";
    const run = [
      localScript,
      "--head",
      revision("%H"),
      "--base",
      revision("%H"),
      "--prompt",
      promptPath,
      "--out",
      join(root, "out"),
      "--run-id",
      runId,
    ];
    const environment = fakeEnvironment(arranged, runId, "success");

    const repository = await runLocalCli(run, environment);
    expect(repository.code, repository.output).toBe(1);
    expect(repository.output).toContain("--repo is required");

    const checkout = await runLocalCli(
      [...run, "--repo", "acme/demo"],
      environment,
    );
    expect(checkout.code, checkout.output).toBe(1);
    expect(checkout.output).toContain("--source is required");
  });

  it("stages the bearer into the control-only broker config, never into Pi or argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    const grokDir = join(root, "grok");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "other-provider-secret",
        refresh: "other-provider-refresh",
        expires: Date.now() + 2_000_000,
      },
    });
    await writeCredentialStore(grokDir, {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        auth_mode: "oidc",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        key: "selected-xai-access",
        refresh_token: "selected-xai-refresh",
        expires_at: new Date(Date.now() + 2_000_000).toISOString(),
        email: "identity-must-not-cross",
      },
    });
    const originalGrokAuth = await readFile(join(grokDir, "auth.json"), "utf8");
    const runId = "oauth-wire";
    const out = join(root, "out");

    const result = await runLocalCli(
      [...localArguments(out, runId), "--provider", "xai", "--model", "grok"],
      {
        ...fakeEnvironment(arranged, runId, "success"),
        PI_CODING_AGENT_DIR: piDir,
        GROK_AUTH_DIR: grokDir,
        XAI_API_KEY: "forbidden-api-fallback",
      },
    );
    const copiedBroker = JSON.parse(
      await readFile(join(arranged.container, "copied-broker.json"), "utf8"),
    );
    const copiedModels = await readFile(
      join(arranged.container, "copied-models.json"),
      "utf8",
    );
    const dockerLog = await readFile(
      join(arranged.state, "docker.log"),
      "utf8",
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code, result.output).toBe(0);
    expect(copiedBroker.upstreamAuthorization).toBe(
      "Bearer selected-xai-access",
    );
    expect(copiedBroker.upstreamBaseUrl).toBe("https://api.x.ai/v1");
    const parsedModels = JSON.parse(copiedModels);
    // Pi holds a handle and a loopback endpoint; the bearer stays with the
    // broker, which runs as a uid the reviewed code never executes as.
    expect(parsedModels.providers.xai.apiKey).toMatch(/^review-pi-/);
    expect(parsedModels.providers.xai.baseUrl).toBe("http://127.0.0.1:8317");
    expect(copiedModels).not.toContain("selected-xai-access");
    expect(
      parsedModels.providers["cloudflare-workers-ai"].modelOverrides[
        "@cf/deepseek-ai/deepseek-v4-flash-0731"
      ].contextWindow,
    ).toBe(1048576);
    expect(dockerLog).toContain("chmod 0600 /opt/review/control/broker.json");
    expect(dockerLog).toContain("setpriv --reuid=1101 --regid=1101");
    expect(dockerLog).toContain("--user 1102:1102");
    expect(dockerLog).toContain(`chown -R 1102:1102 /workspace/runs/${runId}`);
    expect(dockerLog).toContain(`PI_CODING_AGENT_DIR=/workspace/runs/${runId}`);
    expect(dockerLog).not.toContain("selected-xai-access");
    expect(dockerLog).not.toContain("selected-xai-refresh");
    expect(dockerLog).not.toContain("XAI_API_KEY");
    await expect(
      readFile(join(arranged.container, "copied-auth.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(arranged.container, "auth.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(out, runId, "auth.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(out, runId, "broker.json"), "utf8"),
    ).rejects.toThrow();

    expect(receipt).toContain('"authRoute": "subscription-oauth"');
    expect(receipt).not.toContain("selected-xai-access");
    expect(receipt).not.toContain("selected-xai-refresh");
    expect(receipt).toContain('"thinking": "high"');
    expect(receipt).toContain(
      `"promptSha": "${createHash("sha256").update(readFileSync(promptPath)).digest("hex")}"`,
    );
    expect(await readFile(join(grokDir, "auth.json"), "utf8")).toBe(
      originalGrokAuth,
    );
    const stagedAuthPath = await readFile(
      join(arranged.state, "auth-source-path"),
      "utf8",
    );
    await expect(readFile(stagedAuthPath, "utf8")).rejects.toThrow();
  });

  it("rejects expired OAuth before starting a container", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 5000,
      },
    });
    const runId = "oauth-expired";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
      ],
      {
        ...fakeEnvironment(arranged, runId, "success"),
        PI_CODING_AGENT_DIR: piDir,
        OPENAI_API_KEY: "forbidden-api-fallback",
      },
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code).toBe(1);
    expect(receipt).toContain("expired model credential for openai-codex");
    expect(receipt).not.toContain("expired-access");
    await expect(
      readFile(join(arranged.state, "created"), "utf8"),
    ).rejects.toThrow();
  });

  it("unlinks run-owned OAuth while retaining a --keep container", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "keep-access",
        refresh: "keep-refresh",
        expires: Date.now() + 2_000_000,
        accountId: "acct-test",
      },
    });
    const originalAuth = await readFile(join(piDir, "auth.json"), "utf8");
    const runId = "oauth-keep";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
        "--keep",
      ],
      {
        ...fakeEnvironment(arranged, runId, "success"),
        PI_CODING_AGENT_DIR: piDir,
      },
    );
    const dockerLog = await readFile(
      join(arranged.state, "docker.log"),
      "utf8",
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );
    const stagedAuthPath = await readFile(
      join(arranged.state, "auth-source-path"),
      "utf8",
    );

    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(arranged.state, "created"), "utf8")).toBe("");
    expect(await readFile(join(arranged.state, "auth-removed"), "utf8")).toBe(
      "",
    );
    expect(dockerLog).toContain("rm --force /opt/review/control/broker.json");
    expect(dockerLog).toContain("pkill --uid 1101");
    expect(dockerLog).not.toContain(
      `rm --force --volumes review-pi-local-${runId}`,
    );
    expect(receipt).toContain('"authRemoved": true');
    expect(receipt).toContain('"containerRemoved": false');
    expect(await readFile(join(piDir, "auth.json"), "utf8")).toBe(originalAuth);
    await expect(
      readFile(join(arranged.container, "access.token"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(arranged.container, "auth.json"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(stagedAuthPath, "utf8")).rejects.toThrow();
  });

  // A reader that opened the previous file keeps its inode. A write through
  // the file's own name rewrites that inode under the reader; a rename swaps a
  // whole new one in and leaves the held one as it was.
  const holdPrevious = async (root: string, path: string) => {
    const held = join(root, `held-${basename(path)}`);
    await rm(path, { force: true });
    await writeFile(held, "previous");
    await link(held, path);
    return held;
  };

  it("swaps its metadata and receipt in by rename, never through their names", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "atomic-receipts";
    const out = join(root, "out");
    await mkdir(join(out, runId), { recursive: true });
    const metadata = await holdPrevious(
      root,
      join(out, runId, "metadata.json"),
    );
    const receipt = await holdPrevious(
      root,
      join(out, runId, "local-receipt.json"),
    );

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "success"),
    );

    expect(result.code, result.output).toBe(0);
    expect(await readFile(metadata, "utf8")).toBe("previous");
    expect(await readFile(receipt, "utf8")).toBe("previous");
    expect(
      JSON.parse(await readFile(join(out, runId, "metadata.json"), "utf8")),
    ).toMatchObject({ runId });
    await expect(readLocalReceipt(join(out, runId))).resolves.toMatchObject({
      runId,
      outcome: "completed",
    });
  });

  it("swaps a cancelled run's receipt in by rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "atomic-cancel";
    const out = join(root, "out");
    const environment = fakeEnvironment(arranged, runId, "success");
    const kept = await runLocalCli(
      [...localArguments(out, runId), "--keep"],
      environment,
    );
    expect(kept.code, kept.output).toBe(0);
    const receipt = await holdPrevious(
      root,
      join(out, runId, "local-receipt.json"),
    );

    const result = await runLocalCli(
      [localScript, "--out", out, "--run-id", runId, "--cancel"],
      environment,
    );

    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(arranged.state, "cancelled"), "utf8")).toBe("");
    expect(await readFile(receipt, "utf8")).toBe("previous");
    await expect(readLocalReceipt(join(out, runId))).resolves.toMatchObject({
      runId,
      outcome: "cancelled",
    });
  });

  it("collects a lane that died before the bridge existed", async () => {
    // The real hang: bun install failed at 21:56:49Z, status.json said failed
    // with a dead process from that second on, and the coordinator waited
    // twelve more minutes because the bridge it was polling never existed.
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "install-failure";
    const out = join(root, "out");
    const startedAt = Date.now();

    const result = await runLocalCli(localArguments(out, runId), {
      ...fakeEnvironment(arranged, runId, "success"),
      FAKE_BRIDGE: "unavailable",
      FAKE_PREPARATION_STATUS: JSON.stringify({
        runId,
        phase: "install",
        state: "failed",
        detail: "exit 1",
        terminalReason: "exit 1",
        process: { alive: false, pid: 50 },
      }),
    });

    expect(result.code).toBe(1);
    // It ends on the terminal state, not on a clock and not on a signal.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(result.output).toContain("run failed at install");
    // The runner's own reason survives instead of being replaced by whatever
    // stops the lane later.
    expect(result.output).toContain("exit 1");
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );
    expect(receipt).not.toContain('"outcome": "cancelled"');
    expect(receipt).not.toContain("interrupted");
  });

  it("keeps waiting when the bridge is briefly unreachable but the run is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "transient-bridge";
    const out = join(root, "out");

    const result = await runLocalCli(localArguments(out, runId), {
      ...fakeEnvironment(arranged, runId, "success"),
      FAKE_BRIDGE_FLAKY: "2",
      FAKE_BRIDGE_STATES: "running,done",
    });

    // A failed observation is uncertainty about the run, never its end.
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("status observation uncertain");
  });

  it("removes the staged token from a failed run whose container it keeps", async () => {
    // The real loss: a lane whose subscription token expired mid-review kept
    // its container alive with access.token still inside it, and the receipt
    // said containerRemoved false with removeError null, so nothing recorded
    // that removal was never attempted.
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "blocked-access",
        refresh: "blocked-refresh",
        expires: Date.now() + 2_000_000,
        accountId: "acct-test",
      },
    });
    const runId = "auth-blocked-lane";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
      ],
      {
        ...fakeEnvironment(arranged, runId, "success"),
        FAKE_BRIDGE_STATES: "running,blocked",
        FAKE_TERMINAL_REASON: "auth_blocked",
        PI_CODING_AGENT_DIR: piDir,
      },
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code, result.output).toBe(1);
    expect(receipt).toContain("auth_blocked");
    // The bearer never outlives the run, even when the container does.
    expect(receipt).toContain('"authRemoved": true');
    expect(receipt).toContain('"authRemoveError": null');
    await expect(
      readFile(join(arranged.container, "access.token"), "utf8"),
    ).rejects.toThrow();
    // The container is kept on purpose, and the receipt says so instead of
    // leaving a silent false.
    expect(receipt).toContain('"containerRemoved": false');
    expect(receipt).toContain('"removalSkippedReason"');
    expect(receipt).toContain("resume");
    expect(receipt).not.toContain("blocked-access");
    expect(receipt).not.toContain("blocked-refresh");
  });

  it("counts the requests a blocked lane spent so the swarm does not buy them twice", async () => {
    // The real loss: a lane the broker cut at its cumulative cap had made 62
    // requests, but its receipt carried no count, so the swarm relaunched it
    // twice as a lane that never reached the model.
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    await writeFile(
      join(arranged.container, "provider-usage.jsonl"),
      [
        JSON.stringify({
          event: "provider_request",
          status: 200,
          totals: { requests: 62, retries: 0, input: 5122797, output: 29802 },
        }),
        JSON.stringify({ event: "denied", reason: "max_input_tokens" }),
        "",
      ].join("\n"),
    );
    const runId = "quota-blocked-lane";
    const out = join(root, "out");

    const result = await runLocalCli(localArguments(out, runId), {
      ...fakeEnvironment(arranged, runId, "success"),
      FAKE_BRIDGE_STATES: "running,blocked",
      FAKE_TERMINAL_REASON: "quota_blocked",
    });
    const receipt = await readLocalReceipt(join(out, runId));
    const dockerLog = await readFile(
      join(arranged.state, "docker.log"),
      "utf8",
    );

    expect(result.code, result.output).toBe(1);
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.error).toContain("quota_blocked");
    expect(receipt.modelRequests).toBe(62);
    expect(neverReachedModel({ receipt, damage: null })).toBe(false);
    // The runner was seen ending and nothing can resume a quota-blocked run,
    // so the container goes with it: three of these at 2 GiB each were left
    // running beside the relaunches that replaced them.
    expect(dockerLog).toContain(
      `rm --force --volumes review-pi-local-${runId}`,
    );
    expect(receipt.error).not.toContain("teardown failed");
  });

  it("prices a lane from the broker ledger, not from the report the target wrote", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    // The fake report.json claims `totalTokens: 1`; the ledger says otherwise.
    // A row priced from the report would carry the target's number.
    await writeFile(
      join(arranged.container, "provider-usage.jsonl"),
      [
        JSON.stringify({ event: "broker_start" }),
        JSON.stringify({
          event: "provider_admitted",
          attemptId: 1,
          attempt: 0,
          totals: {
            requests: 1,
            retries: 0,
            input: 0,
            output: 0,
            unended: 1,
            inputUnobserved: 0,
            outputUnobserved: 0,
          },
        }),
        JSON.stringify({
          event: "provider_request",
          status: 200,
          usage: { input: 111, output: 222 },
          totals: {
            requests: 1,
            retries: 0,
            input: 111,
            output: 222,
            unended: 0,
            inputUnobserved: 0,
            outputUnobserved: 0,
          },
        }),
        "",
      ].join("\n"),
    );
    const runId = "ledger-priced-lane";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "success"),
    );
    const receipt = await readLocalReceipt(join(out, runId));

    expect(result.code, result.output).toBe(0);
    expect(receipt.usage).toEqual({
      requests: 1,
      retries: 0,
      inputTokens: 111,
      outputTokens: 222,
      denials: 0,
      unended: 0,
      inputUnobserved: 0,
      outputUnobserved: 0,
    });
    expect(receipt.modelRequests).toBe(1);
  });

  it("removes staged OAuth after a review-start failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "failure-access",
        refresh: "failure-refresh",
        expires: Date.now() + 2_000_000,
        accountId: "acct-test",
      },
    });
    const originalAuth = await readFile(join(piDir, "auth.json"), "utf8");
    const runId = "oauth-failure";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
      ],
      {
        ...fakeEnvironment(arranged, runId, "review-failure"),
        FAKE_AUTH_REMOVE_FAILURE: "1",
        PI_CODING_AGENT_DIR: piDir,
      },
    );
    const stagedAuthPath = await readFile(
      join(arranged.state, "auth-source-path"),
      "utf8",
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code).toBe(1);
    expect(receipt).toContain('"authRemoved": false');
    expect(receipt).toContain('"containerRemoved": true');
    expect(receipt).toContain("teardown failed");
    expect(receipt).toContain("cannot remove auth");
    expect(receipt).not.toContain("failure-access");
    expect(await readFile(join(piDir, "auth.json"), "utf8")).toBe(originalAuth);
    await expect(readFile(stagedAuthPath, "utf8")).rejects.toThrow();
  });

  it("fails and prevents review start when model config read fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const piDir = join(root, "pi");
    await writeCredentialStore(piDir, {
      "openai-codex": {
        type: "oauth",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 2_000_000,
        accountId: "acct-test",
      },
    });
    const runId = "models-failure";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
      ],
      {
        ...fakeEnvironment(arranged, runId, "models-read-failure"),
        PI_CODING_AGENT_DIR: piDir,
      },
    );
    const dockerLog = await readFile(
      join(arranged.state, "docker.log"),
      "utf8",
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code).toBe(1);
    expect(dockerLog).not.toContain("review-run.sh");
    expect(receipt).toContain("model config read failed");
  });

  it("accepts the trusted runner identity produced by a fixture commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "fixture-identity";
    const out = join(root, "out");

    const result = await runLocalCli(
      [
        ...localArguments(out, runId),
        "--fixture",
        join(packageRoot, "fixtures/duplicate-name-length.patch"),
      ],
      fakeEnvironment(arranged, runId, "fixture-success"),
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code, result.output).toBe(0);
    expect(receipt).toContain('"outcome": "completed"');
  });

  it("rejects a normal run whose report claims another checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "invalid-identity";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "invalid-identity"),
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code).toBe(1);
    expect(receipt).toContain("missing valid report.json or trace.jsonl");
  });

  it("removes a labeled container after its start response is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "uncertain-start";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "uncertain"),
    );
    expect(result.code, result.output).toBe(1);
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(receipt).toContain('"containerRemoved": true');
    expect(() =>
      execFileSync("test", ["-e", join(arranged.state, "created")]),
    ).toThrow();
  });

  it("reports a clipped artifact as truncated instead of as complete evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "oversize-trace";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "oversize-trace"),
    );
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(result.code, result.output).toBe(1);
    expect(receipt).toContain("evidence truncated at 512000 bytes");
    expect(receipt).toContain("trace.jsonl");
    expect(receipt).not.toContain('"outcome": "completed"');
  });

  it("preserves a multibyte character split across stdout chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "split-utf8";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "split-utf8"),
    );

    expect(result.code, result.output).toBe(0);
    expect(await readFile(join(out, runId, "trace.jsonl"), "utf8")).toBe(
      '{"type":"turn_end","stopReason":"stóp"}\n',
    );
  });

  it("redacts a credential-bearing command failure from output and receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    const runId = "secret-error";
    const out = join(root, "out");

    const result = await runLocalCli(
      localArguments(out, runId),
      fakeEnvironment(arranged, runId, "secret-error"),
    );
    expect(result.code, result.output).toBe(1);
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );

    expect(`${result.output}\n${receipt}`).not.toContain("public-cli-secret");
    expect(receipt).toContain("[redacted]");
  });

  it("propagates SIGINT to a running host command", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-cli-"));
    temporaryDirectories.push(root);
    const arranged = await arrangeFakeDocker(root);
    await writeExecutable(
      join(arranged.bin, "git"),
      `#!/bin/bash
if [[ " $* " == *" --depth=1 "* ]]; then
  echo "$$" > "\${FAKE_STATE:?}/host.pid"
  trap 'exit 143' TERM
  while true; do sleep 1; done
fi
exec /usr/bin/git "$@"
`,
    );
    const runId = "setup-sigint";
    const out = join(root, "out");
    const child = spawn("bun", localArguments(out, runId), {
      cwd: repoRoot,
      env: fakeEnvironment(arranged, runId, "setup-hang"),
      stdio: ["ignore", "ignore", "ignore"],
    });
    let hostPid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      hostPid = await readFile(join(arranged.state, "host.pid"), "utf8")
        .then(Number)
        .catch(() => undefined);
      if (hostPid) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(hostPid).toBeDefined();
    const exited = new Promise<number>((resolvePromise) => {
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    child.kill("SIGINT");
    expect(await exited).toBe(1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    expect(() => process.kill(hostPid ?? 0, 0)).toThrow();
    const receipt = await readFile(
      join(out, runId, "local-receipt.json"),
      "utf8",
    );
    expect(receipt).toContain('"outcome": "interrupted"');
  });
});

describe("commit transport", () => {
  it("serves one shallow checkout commit as both requested refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-local-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    await mkdir(source);
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "tracked.txt"), "only commit\n");
    execFileSync("git", ["-C", source, "add", "."]);
    commit(source, "only");
    const revision = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    await expect(
      prepareTransport(
        source,
        join(root, "origin.git"),
        revision,
        revision,
        createBudget(Date.now(), 30),
      ),
    ).resolves.toEqual({ head: revision, base: revision });
  });

  it("serves the exact requested commits and drives the runner clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-local-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const run = join(root, "run");
    await mkdir(join(source, "packages"), { recursive: true });
    await mkdir(run);
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "packages/base.txt"), "base\n");
    execFileSync("git", ["-C", source, "add", "."]);
    commit(source, "base");
    const base = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(join(source, "packages/base.txt"), "head\n");
    execFileSync("git", ["-C", source, "add", "."]);
    commit(source, "head");
    const head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const served = await prepareTransport(
      source,
      join(root, "origin.git"),
      head,
      base,
      createBudget(Date.now(), 600),
    );
    await writeFile(
      join(run, "job.json"),
      JSON.stringify({
        runId: "transport",
        gitRemote: `file://${join(root, "origin.git")}`,
        head: { sha: head },
        base: { sha: base },
      }),
    );
    const runner = fileURLToPath(
      new URL("../../container/review-run.sh", import.meta.url),
    );
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1" "$2"; do_clone', "runner-test", runner, run],
      { encoding: "utf8" },
    );

    expect(served).toEqual({ head, base });
    expect(result.status).toBe(0);
    expect(
      execFileSync("git", ["-C", join(run, "work/repo"), "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(head);
    expect(
      execFileSync(
        "git",
        ["-C", join(run, "work/repo"), "diff", "--name-only", "base..HEAD"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("packages/base.txt");
  });

  it("refuses to serve a commit the host clone does not hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-pi-local-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    execFileSync("git", ["init", "-q", source]);
    await writeFile(join(source, "tracked.txt"), "base\n");
    execFileSync("git", ["-C", source, "add", "."]);
    commit(source, "base");
    const base = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    await expect(
      prepareTransport(
        source,
        join(root, "origin.git"),
        "0".repeat(40),
        base,
        createBudget(Date.now(), 600),
      ),
    ).rejects.toThrow();
  });
});

describe("mintRunId", () => {
  it("mints ids two launches in the same millisecond do not share", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_757_856_171_000);
    try {
      const ids = new Set(Array.from({ length: 50 }, () => mintRunId("swarm")));
      // Two swarms launched in the same millisecond once shared every lane
      // id on the Worker; the clock alone does not name a run.
      expect(ids.size).toBe(50);
      for (const id of ids) expect(() => assertRunId(id)).not.toThrow();
    } finally {
      now.mockRestore();
    }
  });
});

describe("writeLocalReceipt", () => {
  it("never lets a reader observe a partial receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-pi-receipt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "local-receipt.json");
    const receipt = {
      runId: "run-1",
      probe: "x".repeat(8 * 1024 * 1024),
    };
    const body = JSON.stringify(receipt, null, 2);
    const state = { writing: true, absent: false, torn: false };
    const readers = Array.from({ length: 4 }, () =>
      (async () => {
        while (state.writing) {
          const raw = await readFile(path, "utf8").catch(() => null);
          if (raw === null) state.absent = true;
          else if (raw !== body) state.torn = true;
        }
      })(),
    );
    try {
      await writeLocalReceipt(directory, receipt);
    } finally {
      state.writing = false;
    }
    await Promise.all(readers);

    expect(state.absent).toBe(true);
    expect(state.torn).toBe(false);
    expect(await readFile(path, "utf8")).toBe(body);
  });
});
