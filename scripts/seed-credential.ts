const [origin, provider] = process.argv.slice(2);
const secret = process.env["CONTROL_SECRET"];
if (
  !origin ||
  !["openai-codex", "claude-code"].includes(provider ?? "") ||
  !secret
) {
  throw new Error(
    "usage: CONTROL_SECRET=... bun run scripts/seed-credential.ts <worker-origin> <provider> < input",
  );
}
const worker = new URL(origin);
if (worker.protocol !== "https:")
  throw new Error("worker origin must use HTTPS");

let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
input = input.trim();
const body =
  provider === "claude-code" ? JSON.stringify({ token: input }) : input;
const response = await fetch(new URL(`/credentials/${provider}`, worker), {
  method: "PUT",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  },
  body,
  redirect: "manual",
});
if (!response.ok)
  throw new Error(`credential seed failed: HTTP ${response.status}`);
process.stdout.write(`${provider} stored\n`);
