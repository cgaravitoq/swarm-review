const RUN_ROOT = "/workspace/runs";

export const REVIEW_RUNNER = "/opt/review/review-run.sh";

/** Ceiling for every bounded artifact the Worker hands back to the driver. */
export const MAX_ARTIFACT_BYTES = 512_000;

export const runDir = (runId: string) => `${RUN_ROOT}/${runId}`;

export type ReviewJob = {
  runId: string;
  /** sha256 of the runner the driver built this job for; a rollout mismatch must fail loudly. */
  expectedRunnerSha: string;
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
