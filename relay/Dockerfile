FROM docker.io/cloudflare/sandbox:0.12.9

ENV BUN_INSTALL=/usr/local/bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0" \
  && /usr/local/bun/bin/bun --version | grep -qx "1.4.0"

COPY server.ts /opt/relay/server.ts

EXPOSE 3211
