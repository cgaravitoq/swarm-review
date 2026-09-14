/**
 * The Claude Code subscription's provider, served through the run's own model
 * transport.
 *
 * `@cgaravitoq/pi-claude-code-auth` reshapes every Anthropic Messages request
 * into the one Anthropic answers a subscription token for; that reshaping is
 * the whole reason this provider exists. Its own registration, though, hardcodes
 * `https://api.anthropic.com` as the base URL, and pi lets an extension's base
 * URL win over the one `models.json` configures - so a lane would post to
 * Anthropic directly and present the per-run handle where a bearer belongs.
 *
 * Registering the same stream without a base URL and without a model list of
 * its own leaves both to `models.json`, which every run rewrites to point at the
 * transport that holds the credential: the loopback broker on this host, or the
 * Worker's proxy in a cloud run.
 *
 * It holds no credential and reads none. The target sees a handle, never the
 * subscription's token.
 *
 * Plain JavaScript on purpose: it runs inside pi, whose types this repository
 * does not depend on.
 */
import { streamClaudeCodeAnthropic } from "@cgaravitoq/pi-claude-code-auth/src/anthropic-stream.ts";

export default function (pi) {
  pi.registerProvider("claude-code", {
    name: "Claude Code (subscription)",
    api: "anthropic-messages",
    streamSimple: streamClaudeCodeAnthropic,
  });
}
