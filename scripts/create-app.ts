import { spawn } from "node:child_process";
import { createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wranglerBin = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".bin",
  "wrangler",
);

type Options = { name: string; worker: string; org?: string; config?: string };
type App = { id: number; slug: string; pem: string; webhook_secret: string };

export const parseOptions = (args: string[]): Options => {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !["--name", "--worker", "--org", "--config"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error(
        "usage: bun run create-app --name <name> --worker <https origin> [--org <org>] [--config <wrangler config>]",
      );
    }
    values.set(key, value);
  }
  const name = values.get("--name");
  const worker = values.get("--worker");
  if (!name || !worker) throw new Error("--name and --worker are required");
  const origin = new URL(worker);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== worker ||
    origin.username ||
    origin.password
  ) {
    throw new Error("--worker must be an HTTPS origin");
  }
  const org = values.get("--org");
  if (org && !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(org)) {
    throw new Error("--org must be a GitHub organization name");
  }
  const config = values.get("--config");
  return {
    name,
    worker,
    ...(org ? { org } : {}),
    ...(config ? { config } : {}),
  };
};

export const manifestFor = (options: Options, redirectUrl: string) => ({
  name: options.name,
  url: options.worker,
  redirect_url: redirectUrl,
  hook_attributes: { url: `${options.worker}/github/webhook`, active: true },
  public: false,
  default_permissions: {
    checks: "write",
    pull_requests: "write",
    contents: "read",
    metadata: "read",
  },
  default_events: ["pull_request", "check_run"],
});

const putSecret = (bin: string, name: string, value: string, config?: string) =>
  new Promise<void>((resolve, reject) => {
    const args = [
      "secret",
      "put",
      name,
      ...(config ? ["--config", config] : []),
    ];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", () =>
      reject(new Error(`could not start wrangler for ${name}`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`wrangler secret put ${name} failed (exit ${code})`),
          ),
    );
    child.stdin.on("error", () =>
      reject(new Error(`could not write ${name} to wrangler`)),
    );
    child.stdin.end(value);
  });

const convert = async (code: string, fetcher: typeof fetch): Promise<App> => {
  const response = await fetcher(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub manifest conversion failed (HTTP ${response.status})`,
    );
  const app: unknown = await response.json();
  if (
    !app ||
    typeof app !== "object" ||
    !("id" in app) ||
    typeof app.id !== "number" ||
    !("slug" in app) ||
    typeof app.slug !== "string" ||
    !("pem" in app) ||
    typeof app.pem !== "string" ||
    !("webhook_secret" in app) ||
    typeof app.webhook_secret !== "string"
  )
    throw new Error(
      "GitHub manifest conversion returned incomplete credentials",
    );
  return app as App;
};

const htmlEscape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

export const createApp = async (
  options: Options,
  onReady: (url: string) => void,
  fetcher: typeof fetch = fetch,
  bin = wranglerBin,
): Promise<{ slug: string; id: number; installationUrl: string }> => {
  const state = Buffer.from(randomBytes(32)).toString("hex");
  let claimed = false;
  let finish: (result: {
    slug: string;
    id: number;
    installationUrl: string;
  }) => void;
  let fail: (error: Error) => void;
  const result = new Promise<{
    slug: string;
    id: number;
    installationUrl: string;
  }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let localUrl = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", localUrl);
    if (request.method === "GET" && url.pathname === "/") {
      const github = options.org
        ? `https://github.com/organizations/${options.org}/settings/apps/new`
        : "https://github.com/settings/apps/new";
      const action = `${github}?state=${state}`;
      const manifest = JSON.stringify(
        manifestFor(options, `${localUrl}callback`),
      );
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<form id="create" method="post" action="${htmlEscape(action)}"><input type="hidden" name="manifest" value="${htmlEscape(manifest)}"></form><script>document.getElementById("create").submit()</script>`,
      );
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      response.writeHead(403).end("Invalid state");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || claimed) {
      response.writeHead(409).end("Code missing or already used");
      return;
    }
    claimed = true;
    try {
      const app = await convert(code, fetcher);
      const privateKey = createPrivateKey(app.pem)
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      await putSecret(bin, "GITHUB_APP_ID", String(app.id), options.config);
      await putSecret(
        bin,
        "GITHUB_APP_PRIVATE_KEY",
        privateKey,
        options.config,
      );
      await putSecret(
        bin,
        "GITHUB_WEBHOOK_SECRET",
        app.webhook_secret,
        options.config,
      );
      const installationUrl = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("GitHub App credentials stored. You can close this tab.\n");
      finish({ slug: app.slug, id: app.id, installationUrl });
    } catch {
      response
        .writeHead(500, { "cache-control": "no-store" })
        .end("GitHub App setup failed. Check the terminal.\n");
      fail(new Error("GitHub App conversion or secret storage failed"));
    } finally {
      server.close();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local callback did not start");
    localUrl = `http://127.0.0.1:${address.port}/`;
    onReady(localUrl);
    return await result;
  } finally {
    server.close();
  }
};

if (import.meta.main) {
  createApp(parseOptions(process.argv.slice(2)), (url) =>
    process.stdout.write(`${url}\n`),
  )
    .then(({ slug, id, installationUrl }) => {
      process.stdout.write(
        `slug: ${slug}\nid: ${id}\ninstallation: ${installationUrl}\n`,
      );
    })
    .catch(() => {
      process.stderr.write("GitHub App setup failed.\n");
      process.exitCode = 1;
    });
}
