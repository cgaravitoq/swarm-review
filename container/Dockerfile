# Disposable review-Pi container image.
#
# The build context is this directory (`image_build_context` in wrangler.jsonc),
# so every COPY path below is relative to it. Its `context/` subdirectory is
# generated, never committed: `bun run deploy --target <checkout>` materializes
# the target repository's manifests there.
#
# The tag MUST equal the @cloudflare/sandbox version in package.json: the SDK in
# the Worker and the control server baked into this image speak a versioned
# protocol and a mismatch fails at runtime, not at build time.
#
# The base (Ubuntu 22.04) already ships git, curl, jq, unzip, procps and the
# control server on port 3000; its ENTRYPOINT/CMD/EXPOSE are left alone because
# overriding them detaches the container from the SDK.
ARG SANDBOX_VERSION=0.12.9

FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION} AS bun

# The base boots warm code-interpreter pools for an API no route here calls.
# Six Node processes racing a monorepo install for the container's CPU is pure
# cold-start cost for this workload.
ENV JAVASCRIPT_POOL_MIN_SIZE=0 \
    TYPESCRIPT_POOL_MIN_SIZE=0 \
    PYTHON_POOL_MIN_SIZE=0

# Pinned to the repository's own packageManager version: a review that installs
# with a different Bun is not a review of what CI builds.
ARG BUN_VERSION=1.4.0

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:$PATH \
    BUN_INSTALL_CACHE_DIR=/opt/review/bun-cache

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && bun --version | grep -qx "${BUN_VERSION}"

# The build context also carries the runner, the broker and the models, so a
# `COPY .` would key the bake on their content. Copying only the generated
# manifest tree keeps it keyed on the lockfile, and a runner or broker edit
# reuses it.
FROM bun AS bun-cache

COPY context /opt/review/lockfile
RUN cd /opt/review/lockfile \
  && bun install --frozen-lockfile --ignore-scripts

FROM bun

ARG PI_VERSION=0.85.1

ENV PI_CODING_AGENT_DIR=/opt/review/pi-config

RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && pi --version | grep -qx "${PI_VERSION}"

# The review prompt asks for `rg`; the base image has no ripgrep, so every
# search silently degraded to repeated grep/find sweeps of the whole monorepo.
# It sits after the Bun and Pi install so adding it reuses those cached layers.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && rg --version

# A Claude Code subscription is not an API key, and Anthropic answers one only
# to requests shaped the way its own CLI sends them. That reshaping lives in a
# pi extension, pinned because it speaks an unpublished protocol that Anthropic
# moves: a newer one changes the shape, and this is the version the image was
# built against. Peer dependencies are skipped on purpose - pi resolves the
# `@earendil-works/pi-ai` an extension imports through its own loader, so a
# second copy in here would be a second stream implementation, not a second
# protocol.
#
# The build asserts the module the provider file imports is still published: a
# version that moves it must fail here, not mid-review.
ARG CLAUDE_CODE_AUTH_VERSION=2.5.2

RUN mkdir -p /opt/review/extensions \
  && cd /opt/review/extensions \
  && npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
    "@cgaravitoq/pi-claude-code-auth@${CLAUDE_CODE_AUTH_VERSION}" \
  && test -f node_modules/@cgaravitoq/pi-claude-code-auth/src/anthropic-stream.ts

# The provider seam: registered with the extension's stream and with neither a
# base URL nor a model list of its own, so the run's own models.json decides
# where a lane's requests go. Its own registration would send them straight to
# api.anthropic.com with a handle that is not a credential, which is exactly
# what the broker exists to prevent.
COPY claude-code-provider.js /opt/review/extensions/claude-code-provider.js

COPY models.json /opt/review/pi-config/models.json
COPY review-run.sh /opt/review/review-run.sh
RUN chmod 0755 /opt/review/review-run.sh

# Reader cases build and test Rust crates in this repository, so a review that
# cannot run `cargo` silently degrades to reading the diff. Admission refuses a
# run whose image lacks it rather than letting that degradation pass as a review.
RUN apt-get update \
  && apt-get install --no-install-recommends -y cargo util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && cargo --version \
  && setpriv --help > /dev/null

# Two identities, because one is not a boundary.
#
# `review-control` holds the model credential and runs the broker; nothing the
# reviewed repository can reach executes as it. `review-target` runs the runner,
# the install, the check command, Pi and every tool Pi spawns, so a malicious or
# merely curious target reading the environment, the run directory or /proc of
# the broker is refused by the kernel. Root exists here only to create them and
# to hand each directory to its owner at setup.
RUN groupadd --gid 1101 review-control \
  && useradd --uid 1101 --gid 1101 --create-home --shell /usr/sbin/nologin review-control \
  && groupadd --gid 1102 review-target \
  && useradd --uid 1102 --gid 1102 --create-home --shell /bin/bash review-target

COPY model-broker.ts /opt/review/model-broker.ts
COPY response-seal.ts /opt/review/response-seal.ts
COPY response-usage.ts /opt/review/response-usage.ts
RUN chmod 0755 /opt/review/model-broker.ts

# Last, so a runner or broker edit reuses every layer above it. The install runs
# as `review-target`, and Bun writes into its cache while linking.
COPY --from=bun-cache --chown=1102:1102 /opt/review/bun-cache /opt/review/bun-cache
