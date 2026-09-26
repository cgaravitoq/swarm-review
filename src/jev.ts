import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const TIERS = {
  light:
    "A trivial change: documentation, comments, formatting, a rename, a version bump, or tests only, with no change to behavior that users or other systems rely on.",
  standard:
    "An ordinary feature or fix whose risk stays inside one area of the code.",
  deep: "A change to authentication, authorization, payments, secrets, infrastructure or deployment, data migrations or storage formats, or concurrency, or a large change across many areas.",
};
type JevTier = keyof typeof TIERS;

const JEV_CONFIDENCE = 0.55;
const JEV_TIMEOUT_MS = 15_000;

export type PullRequestMetadata = {
  title: string;
  description: string;
  files: { path: string; additions: number; deletions: number }[];
  totalFiles: number;
};

/** The review tier for a pull request, judged by Jev from its metadata alone. */
export async function pickTier(
  apiKey: string,
  metadata: PullRequestMetadata,
): Promise<{ tier: JevTier; note: string }> {
  try {
    const client = new TypeSafeClient({
      apiKey,
      timeout: JEV_TIMEOUT_MS,
      retry: { maxRetries: 1 },
    });
    const { answers } = await client.systemOne({
      model: "jev-latest",
      state: metadata,
      questions: {
        tier: choice(
          "Pick how deeply to review this pull request from its metadata alone: its title, its description, and each changed file's path with the lines added and removed.",
          TIERS,
        ),
      },
    });
    const { choice: tier, confidence } = answers.tier;
    return confidence < JEV_CONFIDENCE
      ? {
          tier: "standard",
          note: `Tier standard: Jev leaned ${tier} with confidence ${confidence.toFixed(2)}, under ${JEV_CONFIDENCE}.`,
        }
      : {
          tier,
          note: `Tier ${tier}, picked by Jev from the pull request's metadata with confidence ${confidence.toFixed(2)}: ${TIERS[tier]}`,
        };
  } catch (error) {
    return {
      tier: "standard",
      note: `Tier standard: Jev did not answer (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}
