const RUN_ROOT = "/workspace/runs";

export const REVIEW_RUNNER = "/opt/review/review-run.sh";

/**
 * Every file the image copies out of `container/` and the lane executes or
 * reads: container path to build-context name. The freshness gate compares
 * exactly this set, so a new COPY in the Dockerfile belongs here first.
 */
export const IMAGE_SOURCES = {
  [REVIEW_RUNNER]: "review-run.sh",
  "/opt/review/model-broker.ts": "model-broker.ts",
  "/opt/review/response-seal.ts": "response-seal.ts",
  "/opt/review/extensions/claude-code-provider.js": "claude-code-provider.js",
  "/opt/review/pi-config/models.json": "models.json",
} satisfies Readonly<Record<string, string>>;

const SHA_64 = /^[0-9a-f]{64}$/;
const FINGERPRINT_LINE = /^([0-9a-f]{64})\s+(\S+)$/;

/**
 * The one fingerprint command both transports run against the lane image.
 * A source the image does not carry yields no line and is refused as absent
 * rather than missing from the comparison.
 */
export const sourceFingerprintCommand = () =>
  `for f in ${Object.keys(IMAGE_SOURCES).join(" ")}; do sha256sum "$f" 2>/dev/null || true; done`;

/**
 * Fingerprint lines split from the version lines that follow them: container
 * path to observed sha256, and the versions in order.
 */
export function parseSourceFingerprint(stdout: string) {
  const sources: Record<string, string> = {};
  const versions: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = FINGERPRINT_LINE.exec(trimmed);
    if (match) {
      const [sha, path] = [match[1], match[2]];
      if (sha && path) sources[path] = sha;
      else versions.push(trimmed);
    } else {
      versions.push(trimmed);
    }
  }
  return { sources, versions };
}

export type SourceMismatch = {
  file: string;
  expected: string;
  observed: string;
};

/**
 * The first image source whose observed hash is not the expected one, in
 * canonical order, or null. An expected map without the record (an unread
 * receipt, a partial payload) is itself a mismatch: the comparison never
 * silently narrows to the subset both sides happen to hold.
 */
export function firstSourceMismatch(
  expected: Readonly<Record<string, string>> | null | undefined,
  observed: Readonly<Record<string, string>>,
): SourceMismatch | null {
  for (const file of Object.keys(IMAGE_SOURCES)) {
    const want = expected?.[file];
    const got = observed[file];
    if (!want) {
      return { file, expected: "unrecorded", observed: got ?? "absent" };
    }
    if (got !== want) {
      return { file, expected: want, observed: got ?? "absent" };
    }
  }
  return null;
}

export const sourceMismatchDetail = (mismatch: SourceMismatch) =>
  `image source ${mismatch.file} differs from the host's copy: expected ${mismatch.expected}, observed ${mismatch.observed}`;

/** The payload's source expectations, or a refusal naming what is wrong with it. */
export function parseExpectedSources(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "expectedSources must map every image source to its sha256",
    );
  }
  const sources = value as Record<string, unknown>;
  const files = Object.keys(IMAGE_SOURCES);
  if (
    Object.keys(sources).length !== files.length ||
    files.some((file) => !(file in sources))
  ) {
    throw new Error(
      `expectedSources must cover exactly the image's sources: ${files.join(", ")}`,
    );
  }
  for (const file of files) {
    const sha = sources[file];
    if (typeof sha !== "string" || !SHA_64.test(sha)) {
      throw new Error(
        `expectedSources must carry a sha256 hex digest for ${file}`,
      );
    }
  }
  return sources as Record<string, string>;
}

/** Ceiling for every bounded artifact the Worker hands back to the driver. */
export const MAX_ARTIFACT_BYTES = 512_000;

export const runDir = (runId: string) => `${RUN_ROOT}/${runId}`;

export type ReviewJob = {
  runId: string;
  /** sha256 of the runner the driver built this job for; a rollout mismatch must fail loudly. */
  expectedRunnerSha: string;
  /** sha256 of every file the image executes or reads, keyed by container path; the freshness gate refuses a differing one by name before the first model request. */
  expectedSources: Readonly<Record<string, string>>;
  head: { sha: string };
  base: { sha: string };
  /** Pull request number, when the head commit is only reachable from its PR ref. */
  pullRequest?: number;
  /** Read-only git endpoint, filled in by the Worker; never a credential. */
  gitRemote?: string;
  provider: string;
  model: string;
  thinking: string;
  prompt: string;
  /** Applied on top of the head tree; the diff Pi reviews is this patch when set. */
  fixturePatch?: string;
  checkCommand: string;
  installTimeoutSeconds: number;
  piTimeoutSeconds: number;
  totalTimeoutSeconds: number;
  /** Forces the named step to fail, for the explicit-failure lifecycle case. */
  failStep?: "clone" | "install" | "check" | "review";
  /** Addressing a provider needs in the target's own environment, never a credential. */
  targetEnv?: Record<string, string>;
  /** Selects the brokered RPC runner; the legacy key-in-env path is not used. */
  supervised?: boolean;
  reviewerContext?: string;
  /** The broker's caps, so the runner can tell the model to finish before one, or `totalTimeoutSeconds`, is reached. */
  budget?: { requests: number; inputTokens: number };
};
