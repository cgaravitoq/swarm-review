# Working in this repository

`CLAUDE.md` is a symlink to this file, so both names resolve to the same guide.

## What this is

A code review system. Reviewer lanes read a change in parallel inside disposable Cloudflare Sandbox containers, a verifier rules on what they found, and only confirmed findings are published as a pull request review.

`README.md` explains the product. This file is what you need before editing it.

## Commands

Everything runs through Bun.

```sh
bun run typecheck   # tsgo --noEmit
bun run lint        # oxlint, with the anti-slop plugin
bun run biome       # biome check .
bun test            # vitest run
```

`lefthook` gates every commit on secretlint, biome, typecheck and the anti-slop lint; CI runs the same four plus the tests.
A commit that fails a gate is not committed, so fix the cause rather than bypassing it.

## Layout

| Path | What it holds |
| --- | --- |
| `worker.ts` | The Cloudflare Worker and the `ReviewSandbox` Durable Object |
| `src/local.ts` | The local driver: one review in one container, on this host |
| `src/swarm.ts` | Lane assignment, reviewer and verifier orchestration, adjudication |
| `src/drive.ts` | The cloud driver: one lane driven through the Worker |
| `src/publish.ts` | One swarm receipt into one GitHub pull request review |
| `src/isolation.ts` | Credential isolation, broker staging, container argv |
| `src/provider-budget.ts` | Provider caps, reservation and accounting |
| `src/pack-context.ts` | The host-side context pack for a packed lane |
| `src/git-proxy.ts` | The read-only git transport the container clones through |
| `evals/` | The harness that measures the review, not the review itself |
| `prompts/` | The reviewer, verifier and context prompts |
| `container/` | The Dockerfile, the in-container runner, the model broker |

`src/__tests__/` and `evals/__tests__/` sit beside what they test.

## Invariants

These are the things a change must not quietly break.

**The model credential never reaches the target.** `review-target` (uid 1102) runs the checkout, the install, the project's checks and every tool they spawn.
`review-control` (uid 1101) holds the credential and runs the broker.
A lane gets a per-run handle over loopback, never the bearer, and the bearer must not appear in the target's environment, files or argv.

**The container cannot write to a repository.** `git-proxy.ts` forwards `git-upload-pack` and the ref advertisement, and nothing else.
A push has no path through it even with the capability in hand.

**A deployed Worker serves exactly one repository.** `TARGET_REPOSITORY` is unset in `wrangler.jsonc` on purpose, and a Worker deployed without it refuses every run rather than falling back.
Do not give it a default.

**The image and the SDK move together.** `SANDBOX_VERSION` in `container/Dockerfile` must equal `@cloudflare/sandbox` in `package.json`.
They speak a versioned protocol and a mismatch fails at runtime, not at build time.

**A stale image fails loudly.** The driver hashes `container/review-run.sh` into the job and the container compares its own copy, so an image built from an older runner ends the run with `container runner mismatch`.

**A subscription lane's provider is the one extension a job names.** `claude-code` reaches Anthropic through `container/claude-code-provider.js`, which registers the provider with neither a base URL nor a model list so the run's own `models.json` points it at the broker.
Extension discovery stays off, and the provider's own registration would send the request straight to Anthropic with a handle instead of a bearer, which is what the broker exists to prevent.

**A receipt is evidence.** Status, stop reason, usage, lane identities and the runner hash are what a run is judged by.
A field that cannot be observed is recorded as such: never as a passing zero, and never as a lane that found nothing wrong.

## Conventions

Conventional commits, one concern per commit, and a commit that leaves the tree green.

Nothing in this repository may name the repository under review.
That is an input: `--repo` for the GitHub identity, `--source` for the local checkout, and `--context` for the brief written for the tree being reviewed.
The default brief in `prompts/review-context.md` stays free of any particular repository, because a brief written for one is wrong for the next one.

The five `anti-slop` rules turned off in `oxlint.config.mts` are off because this package parses untrusted input at every seam, not because the rules are wrong.
If you remove a parser, remove the exception that covered it.

## Tests

Tests never reach the network. `fetch` is stubbed and Pi is a fake binary that logs its argv.

Assert the mechanism at the hop it names.
A test whose result can be produced by another path does not prove the path it names, and this suite is the only thing standing between a lane and a published review.
