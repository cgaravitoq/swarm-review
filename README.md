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

## Commands

| Command | What it runs |
| --- | --- |
| `bun run src/local.ts` | One review lane in one disposable container, on this host |
| `bun run src/swarm.ts` | Reviewer lanes plus a verifier, adjudicated into one review |
| `bun run src/publish.ts` | One swarm receipt into one GitHub pull request review |
| `bun run evals/run.ts` | A manifest of cases, run end to end and recorded |
| `bun run deploy` | The Worker and its container image |
| `bun test` | The test suite |

`src/publish.ts` is opt-in and dry by default: it prints the review it would post.

## How the isolation works

The reviewed repository is untrusted input, and it runs real commands.

`git-proxy.ts` is the only way the container reaches a repository.
It forwards `git-upload-pack` and nothing else, so there is no write path even with the capability in hand, and the GitHub credential stays in the Worker.

Inside the image there are two identities.
`review-control` holds the model credential and runs the broker; `review-target` runs the checkout, the install, the project's checks, and every tool they spawn.
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
bun test            # vitest
```

Git hooks run secretlint, biome, typecheck and the anti-slop lint on every commit, and CI runs the same four plus the tests.

## License

MIT.
