/**
 * Disposable review-Pi control Worker.
 *
 * One sandbox per run, keyed by `runId`. The Worker is a control plane: git
 * and model bytes leave through run-scoped proxies. Usage counters live in the
 * run's Durable Object; a caller bearer lives there, and Worker credentials
 * live in the vault. Neither reaches a container uid.
 */

import { DurableObject } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy } from "@cloudflare/sandbox";

import { verificationsPerFamily } from "./prompts/hybrid";
import { createCodexRelayTransport } from "./src/codex-relay";
import { CredentialVault } from "./src/credential-vault";
import { gitCapability, proxyGitFetch } from "./src/git-proxy";
import {
  allowedRepositories,
  completeCheck,
  createCheck,
  GitHubRequestError,
  installationToken,
  offerCheck,
  openPull,
  type PullRequestEvent,
  pullRequestEvent,
  readBrief,
  rerunEvent,
  updateCheck,
  verifyWebhook,
} from "./src/github-app";
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
  RUN_ID_PATTERN,
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
  type ModelOutcome,
  type ModelSession,
  type ModelUsage,
  modelCapability,
  modelProxyBaseUrl,
  modelsJsonForProxy,
  openaiCodexBrokerHandle,
  proxyModelFetch,
  publicModelUsage,
  reserveAttempt,
} from "./src/model-proxy";
import {
  firstSourceMismatch,
  MAX_ARTIFACT_BYTES,
  parseExpectedSources,
  parseSourceFingerprint,
  REVIEW_ENGINE,
  REVIEW_RUNNER,
  runDir,
  sourceFingerprintCommand,
  sourceMismatchDetail,
} from "./src/protocol";
import { SESSION_CAPS } from "./src/provider-budget";
import {
  alreadyPublished,
  assertPublishableReceipt,
  buildReview,
  commentableLines,
  fetchMergeBase,
  githubReviewPayload,
  postReview,
  revalidatePullRequest,
  type SwarmReceipt,
  supersededBody,
  supersededReviews,
  updateReviewBody,
} from "./src/publish";

const MODEL_SESSION_KEY = "modelSession";
const PROBE_SESSIONS_KEY = "probeSessions";
const MODEL_SEALS_KEY = "modelSeals";
const COMMAND_SEQUENCE_KEY = "commandSequence";
const REVIEW_DEADLINE_MS = 8 * 60_000;
const REVIEW_ENGINE_MARGIN_MS = 90_000;
const REVIEW_FAMILIES = {
  "workers-ai": {
    provider: "cloudflare-workers-ai",
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  },
  "openai-codex": { provider: "openai-codex", model: "gpt-6-luna" },
  "claude-code": { provider: "claude-code", model: "claude-opus-5-5" },
} as const;
// Workers AI verifiers take several long thinking turns and ran out of the
// window every time it was tight, so candidates go to the families that rule
// in a few turns first.
const VERIFIER_ORDER: readonly string[] = [
  "openai-codex",
  "claude-code",
  "workers-ai",
];
// One handle serves every candidate its family rules on, each a lane of its
// own, so it carries one lane's budget per candidate the engine may hand it.
const VERIFIER_CAPS = {
  ...SESSION_CAPS.t1b,
  maxRequests: SESSION_CAPS.t1b.maxRequests * verificationsPerFamily,
  maxCumulativeInputTokens:
    SESSION_CAPS.t1b.maxCumulativeInputTokens * verificationsPerFamily,
  maxCumulativeOutputTokens:
    SESSION_CAPS.t1b.maxCumulativeOutputTokens * verificationsPerFamily,
};

type CloudReview = {
  reviewId: string;
  repository: string;
  pr: number;
  head: string;
  base: string;
  context?: string;
  origin: string;
  deadlineAt: string;
};

type AppReview = {
  event: PullRequestEvent;
  delivery: string;
  generation: number;
  reviewId: string | null;
  checkRunId: number | null;
  mergeBase: string | null;
  origin: string;
  acceptedAt: number;
  phase: "pending" | "running" | "publishing" | "done";
  outcome: string | null;
  briefNote: string | null;
  progress: string | null;
  cancelFailures?: number;
  retriedAfter?: string;
};

const plain = (value: unknown) =>
  `\`${String(value ?? "none")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .replaceAll("`", "'")
    .replaceAll("<", "‹")}\``;

const laneSummary = (receipt: SwarmReceipt) => {
  const lanes = Array.isArray(receipt.lanes) ? receipt.lanes : [];
  if (lanes.length === 0) return "The receipt names no lanes.";
  return lanes
    .map((lane: (typeof lanes)[number] | null) => {
      const error = lane?.error ?? lane?.contractError ?? lane?.blockerReason;
      return `- ${plain(lane?.role)} ${plain(lane?.family)} ${plain(lane?.model)}: ${plain(lane?.status)}${lane?.stopReason ? `, stop reason ${plain(lane.stopReason)}` : ""}${error ? `, error ${plain(error)}` : ""}`;
    })
    .join("\n");
};

const CANCEL_ATTEMPTS = 5;
const SUPERSEDED_SUMMARY = "A newer pull request event superseded this review.";

const refusedForGood = (error: unknown) =>
  error instanceof GitHubRequestError &&
  error.retryAt === null &&
  [403, 404, 422].includes(error.status);

const retryAfter = (error: unknown) =>
  error instanceof GitHubRequestError ? (error.retryAt ?? 0) : 0;

const sentence = (text: unknown) => `${text}`.replace(/\.*$/, ".");

const lostToPlatform = (message: unknown): message is string =>
  typeof message === "string" &&
  /^(interrupted$|destroy_failed$|image source |Durable Object reset because its code was updated)/.test(
    message,
  );

const withNotes = (state: AppReview, text: string) =>
  [
    text,
    state.retriedAfter &&
      `Retried once: the first attempt ended with ${plain(state.retriedAfter)}.`,
    state.briefNote,
  ]
    .filter(Boolean)
    .join("\n\n");

export class PullRequestReview extends DurableObject<ReviewPiEnv> {
  async accept(event: PullRequestEvent, delivery: string, origin: string) {
    if (await this.ctx.storage.get(`delivery:${delivery}`)) return false;
    await this.ctx.storage.put(`delivery:${delivery}`, true);
    const current = await this.ctx.storage.get<AppReview>("current");
    if (current?.checkRunId && current.phase !== "done") {
      const superseded =
        (await this.ctx.storage.get<AppReview[]>("superseded")) ?? [];
      await this.ctx.storage.put("superseded", [...superseded, current]);
    }
    const state: AppReview = {
      event,
      delivery,
      generation: (current?.generation ?? 0) + 1,
      reviewId: null,
      checkRunId: null,
      mergeBase: null,
      origin,
      acceptedAt: Date.now(),
      phase: "pending",
      outcome: null,
      briefNote: null,
      progress: null,
    };
    await this.ctx.storage.put("current", state);
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  async offer(event: PullRequestEvent, delivery: string) {
    if (await this.ctx.storage.get(`delivery:${delivery}`)) return false;
    await this.ctx.storage.put(`delivery:${delivery}`, true);
    const offers =
      (await this.ctx.storage.get<PullRequestEvent[]>("offers")) ?? [];
    await this.ctx.storage.put("offers", [...offers, event]);
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  override async alarm() {
    let wakeAt = 0;
    for (const step of [
      () => this.retireSuperseded(),
      () => this.offerReviews(),
      () => this.advance(),
    ]) {
      let retry: boolean | number;
      try {
        retry = await step();
      } catch (error) {
        retry = retryAfter(error);
      }
      if (retry !== false)
        wakeAt = Math.max(
          wakeAt,
          Date.now() + 15_000,
          retry === true ? 0 : retry,
        );
    }
    if (wakeAt) await this.ctx.storage.setAlarm(wakeAt);
  }

  private token(event: PullRequestEvent) {
    return installationToken(
      this.env.GITHUB_APP_ID,
      this.env.GITHUB_APP_PRIVATE_KEY,
      event.installationId,
      event.repository,
    );
  }

  private async save(state: AppReview) {
    if (
      (await this.ctx.storage.get<AppReview>("current"))?.generation !==
      state.generation
    )
      return false;
    await this.ctx.storage.put("current", state);
    return true;
  }

  private async retireSuperseded() {
    const superseded =
      (await this.ctx.storage.get<AppReview[]>("superseded")) ?? [];
    const retired = new Set<number>();
    let wakeAt = 0;
    const cancelFailures = new Map<number, number>();
    for (const previous of superseded) {
      try {
        let summary = SUPERSEDED_SUMMARY;
        if (previous.reviewId)
          try {
            await this.env.REVIEW_JOBS.getByName(previous.reviewId).cancel();
          } catch (error) {
            const failures = (previous.cancelFailures ?? 0) + 1;
            if (failures < CANCEL_ATTEMPTS) {
              cancelFailures.set(previous.generation, failures);
              throw error;
            }
            summary = `${SUPERSEDED_SUMMARY} Its cloud review could not be stopped after ${failures} attempts: ${sentence(messageOf(error))}`;
          }
        await completeCheck(
          await this.token(previous.event),
          previous.event.repository,
          previous.checkRunId!,
          "neutral",
          summary,
        );
        retired.add(previous.generation);
      } catch (error) {
        if (refusedForGood(error)) retired.add(previous.generation);
        else wakeAt = Math.max(wakeAt, retryAfter(error));
      }
    }
    const left = ((await this.ctx.storage.get<AppReview[]>("superseded")) ?? [])
      .filter((previous) => !retired.has(previous.generation))
      .map((previous) =>
        cancelFailures.has(previous.generation)
          ? {
              ...previous,
              cancelFailures: cancelFailures.get(previous.generation),
            }
          : previous,
      );
    await this.ctx.storage.put("superseded", left);
    return left.length > 0 && wakeAt;
  }

  private async offerReviews() {
    const offers =
      (await this.ctx.storage.get<PullRequestEvent[]>("offers")) ?? [];
    const offered = new Set<string>();
    let wakeAt = 0;
    for (const offer of offers) {
      try {
        await offerCheck(await this.token(offer), offer);
        offered.add(offer.head);
      } catch (error) {
        if (refusedForGood(error)) offered.add(offer.head);
        else wakeAt = Math.max(wakeAt, retryAfter(error));
      }
    }
    const left = (
      (await this.ctx.storage.get<PullRequestEvent[]>("offers")) ?? []
    ).filter((offer) => !offered.has(offer.head));
    await this.ctx.storage.put("offers", left);
    return left.length > 0 && wakeAt;
  }

  private async advance(): Promise<boolean | number> {
    const state = await this.ctx.storage.get<AppReview>("current");
    if (!state || state.phase === "done") return false;
    try {
      const token = await this.token(state.event);
      const { repository } = state.event;
      if (state.phase === "pending") {
        state.checkRunId ??= await createCheck(token, state.event);
        if (!(await this.save(state))) {
          await completeCheck(
            token,
            repository,
            state.checkRunId,
            "neutral",
            SUPERSEDED_SUMMARY,
          );
          return false;
        }
        state.mergeBase ??= await fetchMergeBase(
          repository,
          state.event.base,
          state.event.head,
          token,
        );
        if (!(await this.save(state))) return false;
        const brief = await readBrief(token, repository, state.event.base);
        state.briefNote = brief.note ?? null;
        state.reviewId ??= assertCloudRunId(`review-${crypto.randomUUID()}`);
        const reviewId = state.reviewId;
        await putReviewJson(this.env, reviewId, "git", {
          repository,
          installationId: state.event.installationId,
        });
        if (!(await this.save(state))) return false;
        await startReview(this.env, {
          reviewId,
          repository,
          pr: state.event.number,
          head: state.event.head,
          base: state.mergeBase,
          ...(brief.context ? { context: brief.context } : {}),
          origin: state.origin,
          deadlineAt: new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString(),
        });
        state.phase = "running";
        if (!(await this.save(state))) return false;
      }
      const receiptObject = await this.env.PROBE_RESULTS.get(
        reviewKey(state.reviewId!, "receipt"),
      );
      if (state.phase === "running") {
        if (
          !receiptObject ||
          !(await this.env.REVIEW_JOBS.getByName(state.reviewId!).isDone())
        ) {
          if (Date.now() <= state.acceptedAt + REVIEW_DEADLINE_MS + 120_000) {
            await this.reportProgress(token, state);
            return true;
          }
          await this.finish(
            token,
            state,
            "neutral",
            "Review did not produce a final receipt before the deadline.",
          );
          return false;
        }
        state.phase = "publishing";
        if (!(await this.save(state))) return false;
      }
      const receipt = await receiptObject!
        .json<SwarmReceipt | null>()
        .catch(() => null);
      if (typeof receipt !== "object" || receipt === null) {
        await this.finish(
          token,
          state,
          "neutral",
          "Review not published: the receipt is not a JSON object.",
        );
        return false;
      }
      if (receipt.status !== "completed" && receipt.status !== "partial") {
        const failure = receipt.failure?.message;
        let notRetried = "";
        if (state.retriedAfter === undefined && lostToPlatform(failure)) {
          const shutdown = await destroySandbox(
            getSandbox(this.env.REVIEW_SANDBOX, state.reviewId!),
          );
          if (shutdown.acknowledged) {
            state.retriedAfter = failure;
            state.reviewId = null;
            state.acceptedAt = Date.now();
            state.progress = null;
            state.phase = "pending";
            return await this.save(state);
          }
          notRetried = ` Not retried, because its sandbox could not be stopped: ${sentence(shutdown.error)}`;
        }
        await this.finish(
          token,
          state,
          "neutral",
          `Review could not complete: ${sentence(receipt.failure?.message ?? `receipt status ${plain(receipt.status)}`)}${notRetried}\n\n${laneSummary(receipt)}`,
        );
        return false;
      }
      const published = await this.publish(token, state, receipt);
      if (published)
        await this.finish(
          token,
          state,
          published[0],
          receipt.status === "partial"
            ? `${published[1]}\n\n${laneSummary(receipt)}`
            : published[1],
        );
      return false;
    } catch (error) {
      if (!refusedForGood(error)) return retryAfter(error);
      if (state.checkRunId === null) {
        state.phase = "done";
        state.outcome = messageOf(error);
        await this.save(state);
        return false;
      }
      try {
        await this.finish(
          await this.token(state.event),
          state,
          "neutral",
          `Review could not complete: ${sentence(messageOf(error))}`,
        );
      } catch (completion) {
        if (!refusedForGood(completion)) return retryAfter(completion);
        state.phase = "done";
        state.outcome = messageOf(error);
        await this.save(state);
      }
      return false;
    }
  }

  private async reportProgress(token: string, state: AppReview) {
    const status = await (
      await this.env.PROBE_RESULTS.get(reviewKey(state.reviewId!, "status"))
    )
      ?.json<Record<string, unknown> | null>()
      .catch(() => null);
    if (typeof status !== "object" || status === null) return;
    const reviewers = Array.isArray(status["reviewers"])
      ? (status["reviewers"] as (Record<string, unknown> | null)[])
      : [];
    const progress = [
      `Phase: ${plain(status["phase"])}.`,
      ...reviewers.map(
        (reviewer) =>
          `- ${plain(reviewer?.["family"])} ${plain(reviewer?.["model"])}: ${plain(reviewer?.["state"])}`,
      ),
    ].join("\n");
    if (
      progress === state.progress ||
      (await this.ctx.storage.get<AppReview>("current"))?.generation !==
        state.generation
    )
      return;
    try {
      await updateCheck(
        token,
        state.event.repository,
        state.checkRunId!,
        withNotes(state, progress),
      );
    } catch {
      return;
    }
    state.progress = progress;
    await this.save(state);
  }

  private async publish(
    token: string,
    state: AppReview,
    receipt: SwarmReceipt,
  ): Promise<["success" | "neutral", string] | null> {
    const { repository, number } = state.event;
    const expected = { head: state.event.head, mergeBase: state.mergeBase! };
    let confirmed: number;
    try {
      assertPublishableReceipt(receipt, expected);
      buildReview(receipt, new Map(), repository);
      confirmed = receipt.findings.filter(
        (finding) => finding.status === "confirmed",
      ).length;
    } catch (error) {
      return ["neutral", `Review not published: ${sentence(messageOf(error))}`];
    }
    try {
      const validated = await revalidatePullRequest(
        repository,
        number,
        token,
        expected,
        true,
      );
      const summary = `Review published at ${expected.head.slice(0, 7)}. ${confirmed} confirmed finding(s).`;
      if (alreadyPublished(validated.reviews, receipt.swarmId, expected.head))
        return ["success", summary];
      if (
        (await this.ctx.storage.get<AppReview>("current"))?.generation !==
        state.generation
      )
        return null;
      const posted = await postReview(
        repository,
        number,
        token,
        githubReviewPayload(
          buildReview(receipt, commentableLines(validated.diff), repository),
        ),
      );
      for (const older of supersededReviews(validated.reviews))
        await updateReviewBody(
          repository,
          number,
          older.id,
          token,
          supersededBody(older.body ?? "", {
            swarmId: receipt.swarmId,
            head: expected.head,
            url: posted.html_url,
          }),
        ).catch(() => undefined);
      return ["success", summary];
    } catch (error) {
      if (
        error instanceof GitHubRequestError
          ? !refusedForGood(error)
          : error instanceof TypeError
      )
        throw error;
      return ["neutral", `Review not published: ${sentence(messageOf(error))}`];
    }
  }

  private async finish(
    token: string,
    state: AppReview,
    conclusion: "success" | "neutral",
    summary: string,
  ) {
    if (
      (await this.ctx.storage.get<AppReview>("current"))?.generation !==
      state.generation
    )
      return;
    await completeCheck(
      token,
      state.event.repository,
      state.checkRunId!,
      conclusion,
      withNotes(state, summary),
    );
    state.phase = "done";
    state.outcome = summary;
    await this.save(state);
  }
}

export class ReviewJob extends DurableObject<ReviewPiEnv> {
  async start(review: CloudReview) {
    await this.ctx.storage.put("review", review);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async isDone() {
    return (await this.ctx.storage.get<string>("state")) === "done";
  }

  async cancel() {
    const review = await this.ctx.storage.get<CloudReview>("review");
    if (!review || (await this.ctx.storage.get<string>("state")) === "done")
      return;
    await this.ctx.storage.deleteAlarm();
    const shutdown = await destroySandbox(
      getSandbox(this.env.REVIEW_SANDBOX, review.reviewId),
    );
    if (!shutdown.acknowledged)
      throw new Error(`destroy_failed: ${shutdown.error}`);
    await this.ctx.storage.put("state", "done");
    await finishReview(this.env, review, "superseded", null);
  }

  override async alarm() {
    const review = await this.ctx.storage.get<CloudReview>("review");
    if (!review) return;
    const state = await this.ctx.storage.get<string>("state");
    if (state === "done") return;
    if (state === "running") {
      const shutdown = await destroySandbox(
        getSandbox(this.env.REVIEW_SANDBOX, review.reviewId),
      );
      const receipt = await this.env.PROBE_RESULTS.head(
        reviewKey(review.reviewId, "receipt"),
      );
      if (!shutdown.acknowledged || !receipt) {
        await finishReview(
          this.env,
          review,
          shutdown.acknowledged ? "interrupted" : "destroy_failed",
          null,
        );
      }
      await this.ctx.storage.put("state", "done");
      return;
    }
    await this.ctx.storage.put("state", "running");
    await runCloudReview(this.env, review);
    await this.ctx.storage.put("state", "done");
  }
}

export class CredentialVaultObject extends DurableObject<unknown> {
  private readonly vault: CredentialVault;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.vault = new CredentialVault(state.storage);
  }

  seed(provider: string, value: unknown) {
    return this.vault.seed(provider, value);
  }
  status() {
    return this.vault.status();
  }
  credential(provider: string, rejectedAccessToken?: string) {
    return this.vault.credential(provider, rejectedAccessToken);
  }
}

export class ReviewSandbox extends Sandbox<ReviewPiEnv> {
  async putProbeSessions(sessions: Record<string, ModelSession>) {
    await this.ctx.storage.put(PROBE_SESSIONS_KEY, sessions);
  }

  async probeOutcome(handle: string) {
    const { session } = await this.sessionFor(handle);
    return session?.lastOutcome ?? null;
  }

  async recordModelOutcome(handle: string, outcome: ModelOutcome) {
    const { session, probes } = await this.sessionFor(handle);
    if (!session || !probes) return;
    session.lastOutcome = outcome;
    await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
  }

  async clearProbeSessions() {
    await this.ctx.storage.delete(PROBE_SESSIONS_KEY);
  }

  private async sessionFor(handle?: string) {
    const probes =
      await this.ctx.storage.get<Record<string, ModelSession>>(
        PROBE_SESSIONS_KEY,
      );
    if (probes) return { session: probes[handle ?? ""], probes };
    return {
      session: await this.ctx.storage.get<ModelSession>(MODEL_SESSION_KEY),
      probes: null,
    };
  }

  async putModelSession(session: ModelSession) {
    await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    await this.ctx.storage.put(MODEL_SEALS_KEY, []);
  }

  async consumeModelAttempt(handle?: string) {
    const { session, probes } = await this.sessionFor(handle);
    if (!session) return { ok: false as const, reason: "no_session" };
    const refusal = reserveAttempt(
      session.totals,
      session.caps,
      session.retryPending === true,
    );
    if (refusal) {
      if (probes) {
        session.lastOutcome = { httpStatus: 429, reason: refusal };
        await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
      }
      return { ok: false as const, reason: refusal };
    }
    session.retryPending = false;
    if (probes) await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
    else await this.ctx.storage.put(MODEL_SESSION_KEY, session);
    return { ok: true as const, session };
  }

  async recordModelAttempt(
    usage: ModelUsage | null,
    retryable: boolean,
    seal: string | null,
    handle: string,
    outcome: ModelOutcome,
  ) {
    const { session, probes } = await this.sessionFor(handle);
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
    if (probes) {
      session.lastOutcome = outcome;
      await this.ctx.storage.put(PROBE_SESSIONS_KEY, probes);
      return;
    }
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
  async openModelSession(handle?: string) {
    const { session } = await this.sessionFor(handle);
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

export class CodexRelaySandbox extends Sandbox<ReviewPiEnv> {
  override enableInternet = true;
  override allowedHosts = ["chatgpt.com"];
  override interceptHttps = false;
}

type ReviewPiEnv = Record<
  "REVIEW_SANDBOX",
  DurableObjectNamespace<ReviewSandbox>
> &
  Record<"CREDENTIAL_VAULT", DurableObjectNamespace<CredentialVaultObject>> &
  Record<"CODEX_RELAY", DurableObjectNamespace<CodexRelaySandbox>> &
  Record<"PROBE_RESULTS", R2Bucket> &
  Record<"REVIEW_JOBS", DurableObjectNamespace<ReviewJob>> &
  Record<"PULL_REQUEST_REVIEWS", DurableObjectNamespace<PullRequestReview>> &
  Record<
    | "CONTROL_SECRET"
    | "GITHUB_APP_ID"
    | "GITHUB_APP_PRIVATE_KEY"
    | "GITHUB_WEBHOOK_SECRET",
    string
  > & {
    /** https clone URL the run's containers fetch through the Git proxy. */
    TARGET_REPOSITORIES?: string;
    GITHUB_READ_TOKEN?: string;
    IMAGE_SOURCE_HASHES?: string;
    WORKERS_AI_API_KEY?: string;
    WORKERS_AI_ACCOUNT_ID?: string;
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
const REVIEW_SESSION_CLEAR_MS = 5_000;

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

type ProbePhase = {
  status: "ok" | "failed" | "unobserved";
  durationMs: number | null;
  durationReason: string | null;
  phase: string | null;
  httpStatus: number | null;
  reason: string | null;
};

const unobserved = (): ProbePhase => ({
  status: "unobserved",
  durationMs: null,
  durationReason: "not_started",
  phase: null,
  httpStatus: null,
  reason: "not_started",
});

// A Worker's clock only advances across I/O, so a phase that ends before any
// has no duration to observe.
const elapsed = (start: number) => {
  const durationMs = Math.round((performance.now() - start) * 1000) / 1000;
  return durationMs > 0
    ? { durationMs, durationReason: null }
    : { durationMs: null, durationReason: "no_clock_delta" };
};

// Pi sends a lane's whole request, tools and system prompt included, so the
// probe spends a lane's caps. Two requests cover Pi's openai-codex transport,
// which tries a WebSocket before it falls back to a streamed POST; Pi's own
// retries are off, so a retry never spends the slot that names the failure.
const probeCaps = { ...SESSION_CAPS.t1b, maxRequests: 2 };
const PI_PROBE_SETTINGS = JSON.stringify({
  retry: { enabled: false, provider: { maxRetries: 0 } },
});
// A review lane retries a transient stream failure at the agent level, where
// the proxy admits each attempt as a request. Two retries back off 1 s then
// 2 s, which leaves a verifier's 120 s window room to finish.
const PI_REVIEW_SETTINGS = JSON.stringify({
  retry: {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 1000,
    provider: { maxRetries: 0 },
  },
});

const PI_PROBE_FAMILIES = {
  "workers-ai": {
    provider: "cloudflare-workers-ai",
    model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  },
  "openai-codex": { provider: "openai-codex", model: "gpt-5.6-sol" },
  "claude-code": { provider: "claude-code", model: "claude-opus-5" },
} as const;

const PI_PROBE_SECONDS = 100;
const PI_MODELS_PATH = "/opt/review/pi-config/models.json";
const CLAUDE_CODE_EXTENSION = "/opt/review/extensions/claude-code-provider.js";

const asTarget = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups`;

const piProbeCommand = (
  directory: string,
  family: keyof typeof PI_PROBE_FAMILIES,
  accountId: string,
) => {
  const { provider, model } = PI_PROBE_FAMILIES[family];
  const account =
    family === "workers-ai"
      ? `CLOUDFLARE_ACCOUNT_ID=${posixQuote(accountId)} `
      : "";
  const extension =
    family === "claude-code" ? ` -e ${posixQuote(CLAUDE_CODE_EXTENSION)}` : "";
  return `cd ${posixQuote(directory)} && ${asTarget} env HOME=/home/review-target PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 ${account}PI_CODING_AGENT_DIR=${posixQuote(directory)} timeout -k 5 ${PI_PROBE_SECONDS} pi --provider ${posixQuote(provider)} --model ${posixQuote(model)} --thinking high --mode json --print --no-session --no-extensions --no-skills --no-prompt-templates --approve${extension} -- ${posixQuote("Reply with exactly pong and nothing else.")} < /dev/null > events.jsonl 2> pi.stderr`;
};

// The same reading `validate_review_events` gives a lane's stream.
const PI_SUMMARY = `([.[] | select(.type == "turn_end")] | last | .message) as $m
| {stopReason: ($m.stopReason // null),
   hasFinal: (([.[] | select(.type == "agent_end")] | last | (.messages // [])
     | map(select(.role == "assistant")) | last | (.content // [])
     | map(select(.type == "text") | .text) | join("\\n") | test("\\\\S")) // false)}`;

const piSummaryCommand = (directory: string) =>
  `${asTarget} jq -sc ${posixQuote(PI_SUMMARY)} ${posixQuote(`${directory}/events.jsonl`)}`;

const parsePiSummary = (stdout: string) => {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null) return null;
    const summary = value as Record<string, unknown>;
    return {
      stopReason:
        typeof summary["stopReason"] === "string"
          ? summary["stopReason"]
          : null,
      hasFinal: summary["hasFinal"] === true,
    };
  } catch {
    return null;
  }
};

const reviewKey = (reviewId: string, name: string) =>
  `reviews/${reviewId}/${name}.json`;

const putReviewJson = (
  env: ReviewPiEnv,
  reviewId: string,
  name: string,
  value: unknown,
) =>
  env.PROBE_RESULTS.put(reviewKey(reviewId, name), JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });

async function startReview(env: ReviewPiEnv, review: CloudReview) {
  await putReviewJson(env, review.reviewId, "status", {
    phase: "reviewing",
    reviewers: [],
    candidates: 0,
    verified: 0,
    deadlineAt: review.deadlineAt,
  });
  await env.REVIEW_JOBS.getByName(review.reviewId).start(review);
}

type EngineFailure = { exitCode: number | null; stderr: string | null };

const CLONE_STEPS = [
  "clone",
  "fetch_head",
  "head_mismatch",
  "fetch_base",
  "merge_base",
] as const;

type CloneFailure = {
  step: (typeof CLONE_STEPS)[number] | null;
  exitCode: number;
  stderr: string;
};

type FailureDetail = { engine: EngineFailure } | { clone: CloneFailure };

const ENGINE_STDERR_TAIL = 4096;

const cloneFailure = (
  result: { stdout: string; stderr: string; exitCode: number },
  secrets: string[],
): CloneFailure => {
  const lastStep = result.stdout.trim().split("\n").at(-1);
  return {
    step: CLONE_STEPS.find((step) => step === lastStep) ?? null,
    exitCode: result.exitCode,
    stderr: secrets
      .reduce(
        (stderr, secret) => stderr.replaceAll(secret, "[redacted]"),
        result.stderr,
      )
      .slice(-ENGINE_STDERR_TAIL),
  };
};

const failedReviewStatus = (
  review: CloudReview,
  reason: string,
  detail: FailureDetail | null,
  observed: Record<string, unknown> | null,
) => ({
  ...observed,
  phase: "failed",
  reviewers:
    observed?.["reviewers"] ??
    Object.entries(REVIEW_FAMILIES).map(([family, { model }]) => ({
      family,
      model,
      state: "unobserved",
    })),
  candidates: observed?.["candidates"] ?? 0,
  verified: observed?.["verified"] ?? 0,
  deadlineAt: review.deadlineAt,
  reason,
  ...detail,
});

async function finishReview(
  env: ReviewPiEnv,
  review: CloudReview,
  reason: string,
  receipt: unknown,
  detail: FailureDetail | null = null,
) {
  const status = await env.PROBE_RESULTS.get(
    reviewKey(review.reviewId, "status"),
  );
  const observed = status ? await status.json<Record<string, unknown>>() : null;
  await putReviewJson(
    env,
    review.reviewId,
    "status",
    failedReviewStatus(review, reason, detail, observed),
  );
  const existingReceipt = await env.PROBE_RESULTS.head(
    reviewKey(review.reviewId, "receipt"),
  );
  if (existingReceipt) return;
  if (receipt !== null) {
    await putReviewJson(env, review.reviewId, "receipt", receipt);
    return;
  }
  await putReviewJson(env, review.reviewId, "receipt", {
    swarmId: review.reviewId,
    requested: {
      head: review.head,
      base: review.base,
      pullRequest: review.pr,
    },
    findings: [],
    status: "failed",
    failure: {
      stage: reason.startsWith("deadline") ? "deadline" : "cloud_review",
      message: reason,
      ...detail,
    },
  });
}

const reviewRemaining = (review: CloudReview) => {
  const remaining = Date.parse(review.deadlineAt) - Date.now();
  if (remaining <= 0) throw new Error("deadline");
  return remaining;
};

const reviewWorkingRemaining = (review: CloudReview) => {
  const remaining =
    reviewRemaining(review) - RPC_TIMEOUT_MS - REVIEW_SESSION_CLEAR_MS;
  if (remaining <= 0) throw new Error("deadline");
  return remaining;
};

const reviewStep = <T>(review: CloudReview, label: string, work: Promise<T>) =>
  bounded(
    label,
    work,
    Math.min(reviewWorkingRemaining(review), RPC_TIMEOUT_MS),
  );

async function runCloudReview(env: ReviewPiEnv, review: CloudReview) {
  const sandbox = getSandbox(env.REVIEW_SANDBOX, review.reviewId);
  const directory = runDir(review.reviewId);
  // What a lane can read it can also write into a finding or an error, so no
  // per-run credential leaves the sandbox in text the Worker stores.
  const secrets: string[] = [];
  const redact = (text: string) =>
    secrets.reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
      text,
    );
  let reason: string | null = null;
  let receipt: Record<string, unknown> | null = null;
  let failureDetail: FailureDetail | null = null;
  try {
    reviewRemaining(review);
    if (!env.WORKERS_AI_API_KEY || !env.WORKERS_AI_ACCOUNT_ID) {
      throw new Error("credential_unconfigured");
    }
    const expected = parseExpectedSources(
      JSON.parse(env.IMAGE_SOURCE_HASHES ?? "null"),
    );
    const fingerprint = await reviewStep(
      review,
      "review fingerprint",
      sandbox.exec(sourceFingerprintCommand()),
    );
    const mismatch = firstSourceMismatch(
      expected,
      parseSourceFingerprint(fingerprint.stdout).sources,
    );
    if (mismatch) throw new Error(sourceMismatchDetail(mismatch));

    await reviewStep(
      review,
      "review directory",
      sandbox.mkdir(directory, { recursive: true }),
    );
    await reviewStep(
      review,
      "review ownership",
      sandbox.exec(targetChownCommand(directory)),
    );
    const gitRemoteCapability = await gitCapability(
      review.reviewId,
      env.CONTROL_SECRET,
      review.repository,
    );
    secrets.push(gitRemoteCapability);
    const remote = `${review.origin}/git/${gitRemoteCapability}`;
    const gitHeader = posixQuote(
      `http.extraHeader=x-review-run: ${review.reviewId}`,
    );
    const clone = `${directory}/clone`;
    const pullRef = posixQuote(`pull/${review.pr}/head`);
    const base = posixQuote(review.base);
    const cloneCommand = `echo clone && ${asTarget} git -c ${gitHeader} clone --depth 1 --no-tags --quiet ${posixQuote(remote)} ${posixQuote(clone)} && echo fetch_head && cd ${posixQuote(clone)} && ${asTarget} git -c ${gitHeader} fetch --depth 1 origin ${pullRef} && echo head_mismatch && ${asTarget} git checkout --quiet --detach ${posixQuote(review.head)} && test "$(${asTarget} git rev-parse HEAD)" = ${posixQuote(review.head)} && echo fetch_base && ${asTarget} git -c ${gitHeader} fetch --depth 1 origin ${base} && echo merge_base && { while ! ${asTarget} git merge-base ${base} HEAD >/dev/null; do test "$(${asTarget} git rev-parse --is-shallow-repository)" = true || exit 1; ${asTarget} git -c ${gitHeader} fetch --deepen=64 origin ${pullRef} ${base} || exit 1; done; }`;
    const cloned = await reviewStep(
      review,
      "review clone",
      sandbox.exec(cloneCommand),
    );
    if (cloned.exitCode !== 0) {
      failureDetail = {
        clone: cloneFailure(cloned, [
          remote,
          gitRemoteCapability,
          review.reviewId,
        ]),
      };
      throw new Error("clone_failed");
    }

    const laneModels = await reviewStep(
      review,
      "review models file",
      readArtifact(sandbox, PI_MODELS_PATH),
    );
    if (!laneModels.exists || laneModels.truncated)
      throw new Error("models_unavailable");
    const capability = await modelCapability(
      review.reviewId,
      env.CONTROL_SECRET,
    );
    secrets.push(capability);
    const baseUrl = modelProxyBaseUrl(
      review.origin,
      review.reviewId,
      capability,
    );
    const handles = Object.fromEntries(
      Object.keys(REVIEW_FAMILIES).flatMap((family) => [
        [
          `${family}-reviewer`,
          family === "openai-codex"
            ? openaiCodexBrokerHandle(crypto.randomUUID())
            : `review-pi-${crypto.randomUUID()}`,
        ],
        [
          `${family}-verifier`,
          family === "openai-codex"
            ? openaiCodexBrokerHandle(crypto.randomUUID())
            : `review-pi-${crypto.randomUUID()}`,
        ],
      ]),
    );
    secrets.push(...Object.values(handles));
    const sessions: Record<string, ModelSession> = {};
    type ReviewLane = {
      family: string;
      provider: string;
      model: string;
      piDir: string;
      extensions: string[];
      env: Record<string, string | undefined>;
    };
    const reviewers: ReviewLane[] = [];
    const verifiers: ReviewLane[] = [];
    for (const [family, { provider, model }] of Object.entries(
      REVIEW_FAMILIES,
    )) {
      for (const role of ["reviewer", "verifier"] as const) {
        const handle = handles[`${family}-${role}`];
        if (!handle) throw new Error("missing_handle");
        sessions[handle] = {
          handle,
          upstreamBaseUrl:
            family === "workers-ai"
              ? `https://api.cloudflare.com/client/v4/accounts/${env.WORKERS_AI_ACCOUNT_ID}/ai/v1`
              : family === "openai-codex"
                ? "https://chatgpt.com/backend-api"
                : "https://api.anthropic.com",
          ...(family === "workers-ai"
            ? { upstreamAuthorization: `Bearer ${env.WORKERS_AI_API_KEY}` }
            : { credentialProvider: family }),
          caps:
            role === "verifier"
              ? { ...VERIFIER_CAPS }
              : { ...SESSION_CAPS.t1b },
          totals: emptyModelTotals(),
        };
        const piDir = `${directory}/pi-${family}-${role}`;
        await reviewStep(
          review,
          "review pi directory",
          sandbox.mkdir(piDir, { recursive: true }),
        );
        await reviewStep(
          review,
          "review models",
          sandbox.writeFile(
            `${piDir}/models.json`,
            modelsJsonForProxy(laneModels.content, provider, handle, baseUrl),
          ),
        );
        await reviewStep(
          review,
          "review settings",
          sandbox.writeFile(`${piDir}/settings.json`, PI_REVIEW_SETTINGS),
        );
        const lane = {
          family,
          provider,
          model,
          piDir,
          extensions: family === "claude-code" ? [CLAUDE_CODE_EXTENSION] : [],
          env:
            family === "workers-ai"
              ? { CLOUDFLARE_ACCOUNT_ID: env.WORKERS_AI_ACCOUNT_ID }
              : {},
        };
        (role === "reviewer" ? reviewers : verifiers).push(lane);
      }
    }
    await reviewStep(
      review,
      "review sessions",
      sandbox.putProbeSessions(sessions),
    );
    await reviewStep(
      review,
      "review lanes",
      sandbox.writeFile(
        `${directory}/lanes.json`,
        JSON.stringify({
          reviewers,
          verifiers: verifiers.sort(
            (a, b) =>
              VERIFIER_ORDER.indexOf(a.family) -
              VERIFIER_ORDER.indexOf(b.family),
          ),
        }),
      ),
    );
    if (review.context)
      await reviewStep(
        review,
        "review context",
        sandbox.writeFile(`${directory}/context.txt`, review.context),
      );
    await reviewStep(
      review,
      "review ownership",
      sandbox.exec(targetChownCommand(directory)),
    );

    const engineSeconds = Math.floor(
      (reviewRemaining(review) - REVIEW_ENGINE_MARGIN_MS) / 1000,
    );
    if (engineSeconds < 1) throw new Error("deadline");
    const args = [
      REVIEW_ENGINE,
      "--hybrid",
      "--repo",
      review.repository,
      "--source",
      clone,
      "--pr",
      String(review.pr),
      "--head",
      review.head,
      "--base",
      review.base,
      "--lanes",
      `${directory}/lanes.json`,
      "--total-timeout",
      String(engineSeconds),
      "--out",
      `${directory}/out`,
    ];
    if (review.context) args.push("--context", `${directory}/context.txt`);
    const command = `cd ${posixQuote(clone)} && ${asTarget} env -i HOME=/home/review-target PATH=/usr/local/bun/bin:/usr/local/bin:/usr/bin:/bin bun ${args.map(posixQuote).join(" ")}`;
    const process = await reviewStep(
      review,
      "review engine",
      sandbox.startProcess(command, { autoCleanup: false }),
    );
    let terminalStatus = "running";
    for (;;) {
      const status = await reviewStep(
        review,
        "review engine status",
        process.getStatus(),
      );
      const statusFile = await reviewStep(
        review,
        "review status file",
        readArtifact(sandbox, `${directory}/out/status.json`),
      );
      if (statusFile.exists && !statusFile.truncated) {
        await putReviewJson(
          env,
          review.reviewId,
          "status",
          JSON.parse(redact(statusFile.content)),
        );
      }
      if (status !== "running" && status !== "starting") {
        terminalStatus = status;
        break;
      }
      await new Promise((wake) =>
        setTimeout(wake, Math.min(5_000, reviewWorkingRemaining(review))),
      );
    }
    if (terminalStatus !== "completed") {
      const [exit, logs] = await Promise.allSettled([
        reviewStep(review, "review engine exit", process.waitForExit()),
        reviewStep(review, "review engine logs", process.getLogs()),
      ]);
      failureDetail = {
        engine: {
          exitCode: exit.status === "fulfilled" ? exit.value.exitCode : null,
          stderr:
            logs.status === "fulfilled"
              ? redact(logs.value.stderr).slice(-ENGINE_STDERR_TAIL)
              : null,
        },
      };
      throw new Error("engine_failed");
    }
    const finalStatus = await reviewStep(
      review,
      "review final status",
      readArtifact(sandbox, `${directory}/out/status.json`),
    );
    if (!finalStatus.exists || finalStatus.truncated)
      throw new Error("status_unavailable");
    await putReviewJson(
      env,
      review.reviewId,
      "status",
      JSON.parse(redact(finalStatus.content)),
    );
    const output = await reviewStep(
      review,
      "review receipt",
      readArtifact(sandbox, `${directory}/out/receipt.json`),
    );
    if (!output.exists || output.truncated)
      throw new Error("receipt_unavailable");
    receipt = JSON.parse(redact(output.content));
    await putReviewJson(env, review.reviewId, "receipt", receipt);
  } catch (error) {
    reason =
      Date.now() >= Date.parse(review.deadlineAt)
        ? "deadline"
        : messageOf(error);
  } finally {
    await bounded(
      "review clear sessions",
      sandbox.clearProbeSessions(),
      REVIEW_SESSION_CLEAR_MS,
    ).catch(() => undefined);
    const shutdown = await destroySandbox(sandbox);
    if (!shutdown.acknowledged)
      reason = [
        reason?.replace(/\.+$/, ""),
        `destroy_failed: ${shutdown.error}`,
      ]
        .filter(Boolean)
        .join("; ");
    if (reason)
      await finishReview(env, review, redact(reason), receipt, failureDetail);
  }
}

async function operatorProbe(
  request: Request,
  env: ReviewPiEnv,
  origin: string,
) {
  if (!env.TARGET_REPOSITORIES) {
    return json({ error: "target_repository_unset" }, 400);
  }
  if (allowedRepositories(env.TARGET_REPOSITORIES).size !== 1)
    return json({ error: "repository_ambiguous" }, 400);
  let expectedSources: Record<string, string>;
  let accountId: string;
  let workersBearer: string;
  try {
    const input: unknown = await request.json();
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new Error();
    const body = input as Record<string, unknown>;
    expectedSources = parseExpectedSources(body["expectedSources"]);
    const workers = body["workersAi"];
    if (
      typeof workers !== "object" ||
      workers === null ||
      Array.isArray(workers)
    )
      throw new Error();
    const ai = workers as Record<string, unknown>;
    if (
      typeof ai["accountId"] !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(ai["accountId"]) ||
      typeof ai["bearer"] !== "string" ||
      !ai["bearer"] ||
      /[\r\n]/.test(ai["bearer"])
    )
      throw new Error();
    accountId = ai["accountId"];
    workersBearer = ai["bearer"];
  } catch {
    return json({ error: "invalid_probe" }, 400);
  }

  const runId = assertCloudRunId(`probe-${crypto.randomUUID()}`);
  const key = `probes/${runId}.json`;
  if (await env.PROBE_RESULTS.head(key))
    return json({ error: "probe_exists" }, 409);
  const sandbox = getSandbox(env.REVIEW_SANDBOX, runId);
  const directory = runDir(runId);
  const families = ["workers-ai", "openai-codex", "claude-code"] as const;
  type Family = (typeof families)[number];
  const models: Record<Family, ProbePhase> = {
    "workers-ai": unobserved(),
    "openai-codex": unobserved(),
    "claude-code": unobserved(),
  };
  const receipt = {
    runId,
    clock: "worker.performance.now",
    startedAt: new Date().toISOString(),
    coldStart: unobserved(),
    clone: unobserved(),
    sessionSetup: unobserved(),
    models,
    sessionClear: unobserved(),
    shutdown: unobserved(),
  };
  let stored = true;
  try {
    let start = performance.now();
    try {
      const fingerprint = await bounded(
        "probe cold start",
        sandbox.exec(sourceFingerprintCommand()),
      );
      const mismatch = firstSourceMismatch(
        expectedSources,
        parseSourceFingerprint(fingerprint.stdout).sources,
      );
      receipt.coldStart = mismatch
        ? {
            status: "failed",
            ...elapsed(start),
            phase: "source_fingerprint",
            httpStatus: null,
            reason: `source_mismatch:${mismatch.file}`,
          }
        : {
            status: "ok",
            ...elapsed(start),
            phase: "source_fingerprint",
            httpStatus: null,
            reason: null,
          };
    } catch {
      receipt.coldStart = {
        status: "failed",
        ...elapsed(start),
        phase: "source_fingerprint",
        httpStatus: null,
        reason: "sandbox_exec_failed",
      };
    }
    if (receipt.coldStart.status === "ok") {
      start = performance.now();
      try {
        await bounded(
          "probe directory",
          sandbox.mkdir(directory, { recursive: true }),
        );
        await bounded(
          "probe ownership",
          sandbox.exec(targetChownCommand(directory)),
        );
        const repository =
          [...allowedRepositories(env.TARGET_REPOSITORIES).keys()][0] ?? "";
        const remote = `${origin}/git/${await gitCapability(runId, env.CONTROL_SECRET, repository)}`;
        const command = `setpriv --reuid=${TARGET_UID} --regid=${TARGET_UID} --clear-groups git -c ${posixQuote(`http.extraHeader=x-review-run: ${runId}`)} clone --depth 1 --no-tags --quiet ${posixQuote(remote)} ${posixQuote(`${directory}/clone`)}`;
        const result = await bounded("probe clone", sandbox.exec(command));
        receipt.clone =
          result.exitCode === 0
            ? {
                status: "ok",
                ...elapsed(start),
                phase: "git_clone",
                httpStatus: null,
                reason: null,
              }
            : {
                status: "failed",
                ...elapsed(start),
                phase: "git_clone",
                httpStatus: null,
                reason: "nonzero_exit",
              };
      } catch {
        receipt.clone = {
          status: "failed",
          ...elapsed(start),
          phase: "git_clone",
          httpStatus: null,
          reason: "sandbox_exec_failed",
        };
      }

      const capability = await modelCapability(runId, env.CONTROL_SECRET);
      const base = modelProxyBaseUrl(origin, runId, capability);
      const handles = {
        "workers-ai": `review-pi-${crypto.randomUUID()}`,
        "openai-codex": openaiCodexBrokerHandle(crypto.randomUUID()),
        "claude-code": `review-pi-${crypto.randomUUID()}`,
      } satisfies Record<Family, string>;
      const sessions = {
        [handles["workers-ai"]]: {
          handle: handles["workers-ai"],
          upstreamBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
          upstreamAuthorization: `Bearer ${workersBearer}`,
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
        [handles["openai-codex"]]: {
          handle: handles["openai-codex"],
          upstreamBaseUrl: "https://chatgpt.com/backend-api",
          credentialProvider: "openai-codex",
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
        [handles["claude-code"]]: {
          handle: handles["claude-code"],
          upstreamBaseUrl: "https://api.anthropic.com",
          credentialProvider: "claude-code",
          caps: probeCaps,
          totals: emptyModelTotals(),
        },
      } satisfies Record<string, ModelSession>;
      start = performance.now();
      try {
        const laneModels = await readArtifact(sandbox, PI_MODELS_PATH);
        if (!laneModels.exists || laneModels.truncated) throw new Error();
        await bounded("probe sessions", sandbox.putProbeSessions(sessions));
        receipt.sessionSetup = {
          status: "ok",
          ...elapsed(start),
          phase: "session_setup",
          httpStatus: null,
          reason: null,
        };
        for (const family of families) {
          const { provider } = PI_PROBE_FAMILIES[family];
          const piDirectory = `${directory}/pi-${family}`;
          start = performance.now();
          let phase = "config_write";
          try {
            await bounded(
              "probe pi directory",
              sandbox.mkdir(piDirectory, { recursive: true }),
            );
            await bounded(
              "probe models",
              sandbox.writeFile(
                `${piDirectory}/models.json`,
                modelsJsonForProxy(
                  laneModels.content,
                  provider,
                  handles[family],
                  base,
                ),
              ),
            );
            await bounded(
              "probe pi settings",
              sandbox.writeFile(
                `${piDirectory}/settings.json`,
                PI_PROBE_SETTINGS,
              ),
            );
            await bounded(
              "probe pi ownership",
              sandbox.exec(targetChownCommand(piDirectory)),
            );
            phase = "model_request";
            const pi = await bounded(
              "probe pi",
              sandbox.exec(piProbeCommand(piDirectory, family, accountId)),
              (PI_PROBE_SECONDS + 15) * 1000,
            );
            const observed = await bounded(
              "probe outcome",
              sandbox.probeOutcome(handles[family]),
            );
            if (pi.exitCode !== 0) {
              models[family] = {
                status: "failed",
                ...elapsed(start),
                phase,
                httpStatus: observed?.httpStatus ?? null,
                reason:
                  pi.exitCode === 124 || pi.exitCode === 137
                    ? "pi_timeout"
                    : "pi_exit",
              };
              continue;
            }
            phase = "response_read";
            const summary = await bounded(
              "probe pi summary",
              sandbox.exec(piSummaryCommand(piDirectory)),
            );
            const outcome = parsePiSummary(summary.stdout);
            if (summary.exitCode !== 0 || !outcome) {
              models[family] = {
                status: "failed",
                ...elapsed(start),
                phase,
                httpStatus: null,
                reason: "invalid_event_stream",
              };
              continue;
            }
            const refused =
              outcome.stopReason === "error" ||
              outcome.stopReason === "aborted";
            const reason = refused
              ? (observed?.reason ?? "model_error")
              : outcome.stopReason !== "stop"
                ? "incomplete_result"
                : outcome.hasFinal
                  ? null
                  : "empty_result";
            models[family] = {
              status: reason ? "failed" : "ok",
              ...elapsed(start),
              phase: refused ? "model_request" : "response_interpret",
              httpStatus: observed?.httpStatus ?? null,
              reason,
            };
          } catch {
            models[family] = {
              status: "failed",
              ...elapsed(start),
              phase,
              httpStatus: null,
              reason: "probe_step_failed",
            };
          }
        }
      } catch {
        receipt.sessionSetup = {
          status: "failed",
          ...elapsed(start),
          phase: "session_setup",
          httpStatus: null,
          reason: "session_setup_failed",
        };
      }
    }
  } finally {
    let start = performance.now();
    try {
      await bounded("probe session clear", sandbox.clearProbeSessions());
      receipt.sessionClear = {
        status: "ok",
        ...elapsed(start),
        phase: "session_clear",
        httpStatus: null,
        reason: null,
      };
    } catch {
      receipt.sessionClear = {
        status: "failed",
        ...elapsed(start),
        phase: "session_clear",
        httpStatus: null,
        reason: "clear_failed",
      };
    }
    start = performance.now();
    const shutdown = await destroySandbox(sandbox);
    receipt.shutdown = {
      status: shutdown.acknowledged ? "ok" : "failed",
      ...elapsed(start),
      phase: "sandbox_destroy",
      httpStatus: null,
      reason: shutdown.acknowledged ? null : "destroy_failed",
    };
    try {
      await env.PROBE_RESULTS.put(key, JSON.stringify(receipt), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      stored = false;
    }
  }
  if (!stored) return json({ error: "r2_put_failed", runId }, 500);
  return json({
    key,
    runId,
    status:
      receipt.coldStart.status === "ok" &&
      receipt.clone.status === "ok" &&
      receipt.sessionSetup.status === "ok" &&
      families.every((family) => models[family].status === "ok") &&
      receipt.sessionClear.status === "ok" &&
      receipt.shutdown.status === "ok"
        ? "ok"
        : "failed",
  });
}

export default {
  async fetch(request: Request, env: ReviewPiEnv) {
    const url0 = new URL(request.url);
    if (url0.pathname === "/github/webhook" && request.method === "POST") {
      if (!(await verifyWebhook(request, env.GITHUB_WEBHOOK_SECRET)))
        return json({ error: "unauthorized" }, 401);
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
        return json({ error: "github_app_unconfigured" }, 503);
      const kind = request.headers.get("x-github-event");
      if (
        kind !== "pull_request" &&
        kind !== "check_run" &&
        kind !== "check_suite"
      )
        return json({ ignored: true });
      const delivery = request.headers.get("x-github-delivery");
      if (!delivery || !/^[a-fA-F0-9-]{36}$/.test(delivery))
        return json({ error: "invalid_delivery" }, 400);
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid_webhook" }, 400);
      }
      const allowed = allowedRepositories(env.TARGET_REPOSITORIES);
      if (kind === "pull_request") {
        const parsed = pullRequestEvent(payload);
        if (!parsed) return json({ ignored: true });
        if (!allowed.has(parsed.event.repository.toLowerCase()))
          return json({ error: "repository_mismatch" }, 403);
        const review = env.PULL_REQUEST_REVIEWS.getByName(
          `${parsed.event.repository.toLowerCase()}#${parsed.event.number}`,
        );
        const accepted =
          parsed.action === "review"
            ? await review.accept(parsed.event, delivery, url0.origin)
            : await review.offer(parsed.event, delivery);
        return json({ accepted }, 202);
      }
      const rerun = rerunEvent(kind, payload, env.GITHUB_APP_ID);
      if (!rerun) return json({ ignored: true });
      if (!allowed.has(rerun.repository.toLowerCase()))
        return json({ error: "repository_mismatch" }, 403);
      let event: PullRequestEvent | null;
      try {
        event = await openPull(
          await installationToken(
            env.GITHUB_APP_ID,
            env.GITHUB_APP_PRIVATE_KEY,
            rerun.installationId,
            rerun.repository,
          ),
          rerun.repository,
          rerun.number,
          rerun.installationId,
        );
      } catch (error) {
        return json(
          { error: "github_unavailable", detail: messageOf(error) },
          502,
        );
      }
      if (event?.head !== rerun.head)
        return json({
          ignored: true,
          reason: event ? "head_moved" : "not_reviewable",
        });
      const accepted = await env.PULL_REQUEST_REVIEWS.getByName(
        `${event.repository.toLowerCase()}#${event.number}`,
      ).accept(event, delivery, url0.origin);
      return json({ accepted }, 202);
    }
    if (url0.pathname.startsWith("/git/")) {
      const allowed = allowedRepositories(env.TARGET_REPOSITORIES);
      if (!allowed.size) {
        return json({ error: "target_repository_unset" }, 400);
      }
      const runId = request.headers.get("x-review-run") ?? "";
      if (!RUN_ID_PATTERN.test(runId)) return json({ error: "forbidden" }, 403);
      const metadata = runId.startsWith("review-")
        ? await env.PROBE_RESULTS.get(reviewKey(runId, "git"))
        : null;
      const app = metadata
        ? ((await metadata.json()) as {
            repository: string;
            installationId?: number;
          })
        : null;
      const repository = app
        ? allowed.get(app.repository.toLowerCase())
        : allowed.size === 1
          ? [...allowed.values()][0]
          : undefined;
      if (!repository) return json({ error: "repository_mismatch" }, 403);
      if (
        url0.pathname.split("/")[2] !==
        (await gitCapability(runId, env.CONTROL_SECRET, repository))
      )
        return json({ error: "forbidden" }, 403);
      const token = app?.installationId
        ? await installationToken(
            env.GITHUB_APP_ID,
            env.GITHUB_APP_PRIVATE_KEY,
            app.installationId,
            app.repository,
          )
        : env.GITHUB_READ_TOKEN;
      if (!token) return json({ error: "git_unconfigured" }, 503);
      return proxyGitFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        token,
        repository,
      );
    }

    if (url0.pathname.startsWith("/model/")) {
      return proxyModelFetch(
        request,
        url0,
        env.CONTROL_SECRET,
        async (runId, handle) =>
          getSandbox(env.REVIEW_SANDBOX, runId).openModelSession(handle),
        async (runId, handle) =>
          getSandbox(env.REVIEW_SANDBOX, runId).consumeModelAttempt(handle),
        async (runId, usage, retryable, seal, handle, outcome) =>
          getSandbox(env.REVIEW_SANDBOX, runId).recordModelAttempt(
            usage,
            retryable,
            seal,
            handle,
            outcome,
          ),
        (provider, rejectedAccessToken) =>
          env.CREDENTIAL_VAULT.getByName("worker").credential(
            provider,
            rejectedAccessToken,
          ),
        createCodexRelayTransport(env.CODEX_RELAY),
        async (runId, handle, outcome) =>
          getSandbox(env.REVIEW_SANDBOX, runId).recordModelOutcome(
            handle,
            outcome,
          ),
      );
    }

    if (!authorized(request, env.CONTROL_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = url0;
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      segments[0] === "probe" &&
      segments.length === 1 &&
      request.method === "POST"
    ) {
      return operatorProbe(request, env, url.origin);
    }

    if (
      segments[0] === "reviews" &&
      request.method === "POST" &&
      segments.length === 1
    ) {
      if (!env.TARGET_REPOSITORIES)
        return json({ error: "target_repository_unset" }, 400);
      if (
        !env.WORKERS_AI_API_KEY ||
        !env.WORKERS_AI_ACCOUNT_ID ||
        !/^[a-zA-Z0-9_-]+$/.test(env.WORKERS_AI_ACCOUNT_ID) ||
        !env.IMAGE_SOURCE_HASHES
      )
        return json({ error: "review_unconfigured" }, 400);
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = await request.json();
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        )
          throw new Error();
        input = parsed as Record<string, unknown>;
        parseExpectedSources(JSON.parse(env.IMAGE_SOURCE_HASHES));
        const repository = input["repository"];
        const configured = allowedRepositories(env.TARGET_REPOSITORIES);
        if (
          typeof repository !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
          !configured.has(repository.toLowerCase())
        )
          return json({ error: "repository_mismatch" }, 403);
        if (
          !Number.isSafeInteger(input["pr"]) ||
          Number(input["pr"]) <= 0 ||
          typeof input["head"] !== "string" ||
          !/^[0-9a-f]{40}$/.test(input["head"]) ||
          typeof input["base"] !== "string" ||
          !/^[0-9a-f]{40}$/.test(input["base"]) ||
          (input["context"] !== undefined &&
            (typeof input["context"] !== "string" ||
              input["context"].length > 64_000))
        )
          throw new Error();
      } catch {
        return json({ error: "invalid_review" }, 400);
      }
      const reviewId = assertCloudRunId(`review-${crypto.randomUUID()}`);
      const review: CloudReview = {
        reviewId,
        repository: input["repository"] as string,
        pr: input["pr"] as number,
        head: input["head"] as string,
        base: input["base"] as string,
        ...(typeof input["context"] === "string"
          ? { context: input["context"] }
          : {}),
        origin: url.origin,
        deadlineAt: new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString(),
      };
      await putReviewJson(env, reviewId, "git", {
        repository: review.repository,
      });
      await startReview(env, review);
      return json({ reviewId }, 202);
    }

    if (
      segments[0] === "reviews" &&
      request.method === "GET" &&
      segments.length === 2
    ) {
      let reviewId: string;
      try {
        reviewId = assertCloudRunId(segments[1] ?? "");
      } catch {
        return json({ error: "not_found" }, 404);
      }
      const status = await env.PROBE_RESULTS.get(reviewKey(reviewId, "status"));
      if (!status) return json({ error: "not_found" }, 404);
      const receipt = await env.PROBE_RESULTS.get(
        reviewKey(reviewId, "receipt"),
      );
      return json({
        status: await status.json(),
        ...(receipt ? { receipt: await receipt.json() } : {}),
      });
    }

    if (segments[0] === "credentials") {
      const vault = env.CREDENTIAL_VAULT.getByName("worker");
      if (request.method === "GET" && segments.length === 1) {
        return json({ credentials: await vault.status() });
      }
      if (request.method === "PUT" && segments.length === 2) {
        try {
          await vault.seed(segments[1] ?? "", await request.json());
          return json({ provider: segments[1], stored: true });
        } catch (error) {
          const reason =
            error instanceof Error &&
            [
              "invalid_credential",
              "invalid_codex_access_token",
              "unsupported_provider",
            ].includes(error.message)
              ? error.message
              : "credential_store_failed";
          return json(
            { error: reason },
            reason === "unsupported_provider" ? 404 : 400,
          );
        }
      }
      return json({ error: "not_found" }, 404);
    }

    if (segments[0] !== "runs" || segments.length < 1) {
      return json({ error: "not_found" }, 404);
    }

    if (request.method === "POST" && segments.length === 1) {
      // A run that does not name the repository its lanes clone cannot be
      // served: every container fetches through this Worker's Git proxy, and
      // there is no upstream to fall back to.
      if (!env.TARGET_REPOSITORIES) {
        return json(
          {
            error: "target_repository_unset",
            detail: "TARGET_REPOSITORIES is unset",
          },
          400,
        );
      }
      if (allowedRepositories(env.TARGET_REPOSITORIES).size !== 1)
        return json({ error: "repository_ambiguous" }, 400);
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
      if (parsed.credentialProvider) {
        const credentials =
          await env.CREDENTIAL_VAULT.getByName("worker").status();
        if (
          !credentials.some(
            (entry) => entry.provider === parsed.credentialProvider,
          )
        ) {
          return json({ error: "credential_unconfigured" }, 400);
        }
      }
      const job = {
        ...parsed.job,
        expectedSources,
        gitRemote: `${url.origin}/git/${await gitCapability(parsed.job.runId, env.CONTROL_SECRET, [...allowedRepositories(env.TARGET_REPOSITORIES).keys()][0] ?? "")}`,
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
            ...(parsed.broker.upstreamAuthorization
              ? { upstreamAuthorization: parsed.broker.upstreamAuthorization }
              : {}),
            ...(parsed.credentialProvider
              ? { credentialProvider: parsed.credentialProvider }
              : {}),
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
