import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, parseOptions } from "../../scripts/create-app";

const decode = (value: string) =>
  value.replace(
    /&quot;|&#39;|&lt;|&gt;|&amp;/g,
    (entity) =>
      ({
        "&quot;": '"',
        "&#39;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&amp;": "&",
      })[entity] ?? entity,
  );

const form = async (url: string) => {
  const response = await fetch(url);
  const html = await response.text();
  const action = decode(html.match(/action="([^"]+)"/)?.[1] ?? "");
  const manifest = JSON.parse(
    decode(html.match(/name="manifest" value="([^"]+)"/)?.[1] ?? ""),
  );
  return { action: new URL(action), manifest };
};

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = key.export({ type: "pkcs1", format: "pem" }).toString();
const credentials = {
  id: 12345,
  slug: "review-example",
  pem,
  webhook_secret: "webhook-sentinel",
};

let scratch: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("create-app", () => {
  it("submits the exact manifest and stores each converted credential on wrangler stdin", async () => {
    scratch = await mkdtemp(join(tmpdir(), "create-app-test-"));
    const bin = join(scratch, "wrangler");
    const log = join(scratch, "calls.jsonl");
    await writeFile(
      bin,
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
process.stdout.write("wrangler-output-sentinel " + input);
process.stderr.write("wrangler-error-sentinel " + input);
`,
      { mode: 0o700 },
    );
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(credentials), { status: 201 }),
    );
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let localUrl = "";
    let output = "";
    const running = createApp(
      parseOptions([
        "--name",
        "Review <App>",
        "--worker",
        "https://review.example",
        "--org",
        "example-org",
        "--config",
        "test-wrangler.jsonc",
      ]),
      (url) => {
        localUrl = url;
        output += url;
      },
      fetcher,
      bin,
    );
    await vi.waitFor(() => expect(localUrl).not.toBe(""));
    const { action, manifest } = await form(localUrl);
    expect(action.origin + action.pathname).toBe(
      "https://github.com/organizations/example-org/settings/apps/new",
    );
    expect(action.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest).toEqual({
      name: "Review <App>",
      url: "https://review.example",
      redirect_url: `${localUrl}callback`,
      hook_attributes: {
        url: "https://review.example/github/webhook",
        active: true,
      },
      public: false,
      default_permissions: {
        checks: "write",
        pull_requests: "write",
        contents: "read",
        metadata: "read",
      },
      default_events: ["pull_request", "check_run"],
    });
    const state = action.searchParams.get("state");
    expect(
      (await fetch(`${localUrl}callback?code=wrong&state=wrong`)).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const callbackRequest = fetch(
      `${localUrl}callback?code=conversion-code&state=${state}`,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(
      (await fetch(`${localUrl}callback?code=second-code&state=${state}`))
        .status,
    ).toBe(409);
    const callback = await callbackRequest;
    expect(callback.status).toBe(200);
    expect(await running).toEqual({
      slug: credentials.slug,
      id: credentials.id,
      installationUrl:
        "https://github.com/apps/review-example/installations/new",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/app-manifests/conversion-code/conversions",
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "manual",
      },
    );
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; input: string });
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["secret", "put", "GITHUB_APP_ID", "--config", "test-wrangler.jsonc"],
      [
        "secret",
        "put",
        "GITHUB_APP_PRIVATE_KEY",
        "--config",
        "test-wrangler.jsonc",
      ],
      [
        "secret",
        "put",
        "GITHUB_WEBHOOK_SECRET",
        "--config",
        "test-wrangler.jsonc",
      ],
    ]);
    expect(calls[0]?.input).toBe("12345");
    expect(calls[2]?.input).toBe(credentials.webhook_secret);
    expect(calls[1]?.input).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const der = Buffer.from(
      calls[1]?.input.replace(/-----[^-]+-----|\s/g, "") ?? "",
      "base64",
    );
    await expect(
      webcrypto.subtle.importKey(
        "pkcs8",
        der,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    ).resolves.toBeDefined();
    const exposed =
      JSON.stringify(calls.map(({ argv }) => argv)) +
      output +
      (await callback.text());
    for (const secret of [pem, credentials.webhook_secret, calls[1]?.input]) {
      expect(exposed).not.toContain(secret);
    }
    expect(exposed).not.toContain("wrangler-output-sentinel");
    expect(exposed).not.toContain("wrangler-error-sentinel");
    const processOutput = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([chunk]) => String(chunk))
      .join("");
    expect(processOutput).not.toContain("wrangler-output-sentinel");
    expect(processOutput).not.toContain("wrangler-error-sentinel");
    expect(processOutput).not.toContain(credentials.webhook_secret);
    expect(processOutput).not.toContain(pem);
    expect(processOutput).not.toContain(calls[1]?.input);
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("uses the personal registration endpoint when no organization is given", async () => {
    let localUrl = "";
    const running = createApp(
      parseOptions([
        "--name",
        "Review App",
        "--worker",
        "https://review.example",
      ]),
      (url) => {
        localUrl = url;
      },
      async () => new Response("{}", { status: 500 }),
      "/missing/wrangler",
    );
    const rejected = expect(running).rejects.toThrow(
      "GitHub App conversion or secret storage failed",
    );
    await vi.waitFor(() => expect(localUrl).not.toBe(""));
    const { action } = await form(localUrl);
    expect(action.origin + action.pathname).toBe(
      "https://github.com/settings/apps/new",
    );
    await fetch(
      `${localUrl}callback?code=failure&state=${action.searchParams.get("state")}`,
    );
    await rejected;
  });
});
