# swarm-review

A code review that runs like a review: several models read a change in parallel, a verifier tries to break what they found, and only what survives is published as a pull request review.

It is not a diff summarizer. Every reviewer gets a full checkout of the repository at the pull request's own head commit, installs it, and can run the project's real typecheck or test command to prove what it claims.

## What it does

A review is a bounded run with a fixed wall clock.

Reviewer lanes read the change from independent angles, each with its own model and its own assignment.
A verifier then takes every candidate finding the reviewers raised and rules on it: confirmed, rejected, duplicate, or unverified.
A finding is confirmed only when its location, a concrete reachable input and an observable harm all hold, and the verifier sets the severity the harm deserves.
The published review carries a merge confidence score, a findings table, and one inline comment per confirmed finding, each headed by the mechanism rather than the symptom.

A finding the change's own description declares as intended is published as an advisory rather than a defect, and a defect the change never reaches is kept out of the score and reported as pre-existing.

## Running it

You need Docker, [Bun](https://bun.sh), and a model credential for at least one provider.
```sh
bun install

# One review in one disposable container, against a pull request.
bun run src/local.ts \
  --repo owner/name \
  --source /path/to/your/checkout \
  --pr 1234 \
  --prompt prompts/review-prompt-local.txt \
  --out /tmp/review-1234
```

`--repo` is the GitHub identity the run resolves revisions against, and `--source` is the checkout on this host it reads their objects out of: a pull request head that was never pushed to a fetchable ref only exists locally.
The command writes a receipt, a trace and a report into `--out` and prints nothing else.

To run the full swarm instead of a single lane:

```sh
bun run src/swarm.ts \
  --repo owner/name \
  --source /path/to/your/checkout \
  --pr 1234 \
  --reviewers 3 \
  --out /tmp/swarm-1234
```

### GitHub Action

The composite action reviews a pull request on the job's Docker host and publishes confirmed findings.
It needs a Workers AI API key, a GitHub token with pull request review access, and package write access when it must build and push a missing sandbox image.
The `mode` input defaults to `auto`: pull requests from this repository use three sandbox reviewer lanes, while forks, and runners whose `RUNNER_ARCH` cannot run the `linux/amd64` sandbox image, use packed lanes and carry that limit in the review's Coverage section.
Set `mode: packed` or `mode: sandbox` to choose explicitly; `mode: sandbox` needs an `X64` runner and refuses any other before the registry login.
The action pulls the image tagged from its container sources and the pull request head's lockfile, or builds and pushes it when absent.

A run acknowledges itself in that pull request.
The `comment-id` input defaults to `github.event.comment.id`, and the action's first step reacts with an eyes reaction to that comment, which the calling workflow grants with `issues: write`; a run with no comment to acknowledge, such as a scheduled one, skips it.
Once the mode is chosen the action opens one status comment for the run and links the run's artifact page.
Publishing is its own step and runs whatever the review step did: a submitted review deletes the run's comment, and a run with no review turns it into the stage the run died in.

## A Claude Code subscription lane

A lane can review on a Claude Code subscription instead of a provider API key, which is the only route to the Opus models here.
It is opt-in per run, and it needs two things on this host: `claude` logged in at least once, and Pi's own store holding the subscription - run `pi`, then `/login claude-code`.

```sh
bun run src/swarm.ts \
  --repo owner/name \
  --source /path/to/your/checkout \
  --pr 1234 \
  --provider claude-code \
  --model claude-opus-5 \
  --rates rates.json \
  --out /tmp/swarm-1234
```

The subscription bills a seat rather than a token, so `--rates` carries the plan's own numbers: `{"billing":"subscription","monthlySeatUsd":200,"monthlyCapacityTokens":100000000}`.
Without it nothing is priced and the receipt says so.

The lane reads the token from Pi's store, replaces it in place when it is within five minutes of expiring, and hands it to the broker; the container sees a handle, never the token.
A run that outlives the remaining token fails that lane with an auth error, so a long swarm is worth starting on a fresh one.

What makes a subscription token usable is the request shape Claude Code sends, which `@cgaravitoq/pi-claude-code-auth` builds inside the lane's container.
It is pinned in `container/Dockerfile` because Anthropic moves that shape without notice, and an upstream change that moves the module the provider imports fails the image build rather than a review.

The packed path (`--fast`) calls the provider from this process and cannot build that shape, so it refuses a `claude-code` lane by name.

## Pointing it at your repository

Two things are yours to supply, and neither is in the source.

**A brief.** `--context <path>` replaces the default reviewer brief with one written for the repository under review: its vocabulary, its data model, where its boundaries live, which areas carry blast radius.
The default brief carries only the framing that a reviewer is not a contributor, and says nothing about the tree.
A brief written for one repository is wrong for the next one, so the repository being reviewed is the right place to keep it.

**A target.** A deployed Worker clones through its own read-only Git proxy, and `TARGET_REPOSITORY` names the repository it serves.
It is deliberately unset in `wrangler.jsonc`: a Worker deployed without it refuses every run that needs an upstream instead of silently reviewing the wrong tree.

```sh
bun run deploy --target /path/to/checkout --var TARGET_REPOSITORY:https://github.com/owner/name.git
```

`--target` is read locally, to bake the target's lockfile into the image; every other flag goes to `wrangler deploy`.

The Worker can hold its own `openai-codex` and `claude-code` subscription credentials in the `CREDENTIAL_VAULT` Durable Object.
After deployment, an operator exports `WORKER_ORIGIN` and `CONTROL_SECRET` (`export CONTROL_SECRET=...`) so the script's environment carries them, authenticates a separate `CODEX_HOME` with `codex login`, then sends its `auth.json` directly to the Worker through stdin:

```sh
bun run scripts/seed-credential.ts "$WORKER_ORIGIN" openai-codex < "$CODEX_HOME/auth.json"
```

For Claude, obtain a token with `claude setup-token` and provide the token text on stdin to the same script with `claude-code` as the provider.
The script sends credentials only in the authenticated HTTPS request body and prints only the provider and storage result.
`GET /credentials` with `Authorization: Bearer <CONTROL_SECRET>` returns configured providers, expiry and last refresh without token values.
Runs that omit `broker.upstreamAuthorization` use the matching vault credential on each model attempt; runs carrying it retain their existing behavior.
Codex refreshes before expiry and after an upstream 401, with the rotated pair stored before the next request.
The Worker sends `chatgpt.com` model requests through a separate relay sandbox that accepts only `POST /codex/responses` and forwards to a fixed `https://chatgpt.com/backend-api/codex/responses` URL.
The relay image adds only Bun and its server to the Sandbox runtime, and the review container has no binding to it.
The relay uses direct HTTPS because intercepted HTTPS returns a Worker-side 403 from `chatgpt.com`.
`allowedHosts` filters intercepted HTTP here, but does not restrict direct HTTPS in the current Containers SDK; the fixed URL in relay code is the enforced outbound destination for relay requests.

## Operator probe

The authenticated `POST /probe` route starts one fresh review Sandbox, measures its first image fingerprint command, clones the configured repository with `--depth 1` through the read-only git proxy, and runs Pi once per model family as the target user.
Each family gets the image's own `models.json` pointed at `/model/` with that family's handle, exactly as a cloud lane is configured, so each request is the one a lane's Pi sends: `cloudflare-workers-ai` with `@cf/deepseek-ai/deepseek-v4-flash-0731`, `openai-codex` with `gpt-5.6-sol`, and `claude-code` with `claude-opus-5` through the lanes' Claude Code extension.
A family passes when Pi exits 0 and its last turn stops with text, the reading a lane's stream gets.
The Worker stores `probes/<runId>.json` in the `PROBE_RESULTS` R2 bucket and returns only its key and overall status.
Each phase records a status, failure phase, HTTP status when observed, and milliseconds from the Worker's monotonic `performance.now()` clock.
A skipped phase has `durationMs: null`.
The receipt does not contain request bodies, provider output, handles or credentials.
The Sandbox is destroyed after the probe, including failed phases.

The operator supplies a Workers AI bearer and account ID; the Worker uses its credential vault for openai-codex and claude-code.
Set `WORKER_ORIGIN`, `CONTROL_SECRET`, `CLOUDFLARE_ACCOUNT_ID`, and `WORKERS_AI_API_KEY` in the shell environment, then run:

```sh
bun run scripts/probe.ts "$WORKER_ORIGIN" 1
bun run scripts/probe.ts "$WORKER_ORIGIN" 5
bunx wrangler r2 object get "swarm-review-probes/probes/<runId>.json" --remote --pipe
```

The script starts all probes in a burst concurrently and prints every R2 key.
The bucket must exist before deployment; this repository only declares its binding.
The local tests prove request routing, isolation and receipt shape with fakes; real provider responses, cold start timings and R2 persistence require a deployed probe.

## Commands

| Command | What it runs |
| --- | --- |
| `bun run src/local.ts` | One review lane in one disposable container, on this host |
| `bun run src/swarm.ts` | Reviewer lanes plus a verifier, adjudicated into one review |
| `bun run src/publish.ts` | One swarm receipt into one GitHub pull request review |
| `bun run evals/run.ts` | A manifest of cases, run end to end and recorded |
| `bun run deploy` | The Worker and its container image |
| `bun run test` | The test suite |

`src/publish.ts` is opt-in and dry by default: it prints the review it would post.

## How the isolation works

The reviewed repository is untrusted input, and it runs real commands.

`git-proxy.ts` is the only way the container reaches a repository.
It forwards `git-upload-pack` and nothing else, so there is no write path even with the capability in hand, and the GitHub credential stays in the Worker.

Inside the image there are two identities.
For local lanes, `review-control` holds the model credential and runs the broker; for cloud lanes, the run's Durable Object or the Worker's credential vault holds it.
`review-target` runs the checkout, the install, the project's checks, and every tool they spawn.
The credential is never in the target's environment, its files, or its process table.
Lanes talk to the model through a loopback broker and hold a per-run handle rather than the bearer.

## The eval harness

`evals/` measures the review itself, which is a different job from doing it.

A sealed answer key names the defects a change actually introduced; the harness replays cases against pinned commits, matches what each configuration confirmed against that key, and reports recall and the review false-positive rate.
`evals/fixtures/eval-manifest.example.json` is the shape of a case manifest.

## Development

```sh
bun run typecheck   # tsgo --noEmit
bun run lint        # oxlint, with the anti-slop plugin
bun run biome       # biome check .
bun run test        # vitest
```

Git hooks run secretlint, biome, typecheck and the anti-slop lint on every commit, and CI runs the same four plus the tests.

## License

MIT.
