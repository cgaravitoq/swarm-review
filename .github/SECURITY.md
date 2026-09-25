# Security policy

## Reporting a vulnerability

Report privately through this repository's Security tab, using GitHub's private vulnerability reporting.
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected.
A proof of concept helps more than a description, and a failing test is better than either.

This is a personal project, so expect a first reply within a week rather than within hours.

## Scope

The parts worth attacking are the ones that hold authority over something:

- the container boundary, which is what keeps the reviewed repository away from the model credential
- the Git proxy, which is the only path from a container to a repository
- the credential handling in `src/local.ts` and `container/model-broker.ts`, which is where a bearer could leak into an environment, an argument list, or a log
- the admission and budget code, since a ceiling that can be walked past is not a ceiling

A finding in a reviewer's output is not a security report.
A model that reaches a wrong conclusion is the thing the eval harness measures, not a vulnerability.

## What is already assumed

The repository under review is untrusted, and the review runs its install and its check commands on purpose.
A report that amount of trust being granted is not a finding; a report that a lane can reach past it is.

`TARGET_REPOSITORIES` is unset by default, and a Worker deployed without it refuses every run rather than falling back to some other repository.
