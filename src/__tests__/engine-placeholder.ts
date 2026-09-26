import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const placeholder = "test engine bundle";
const HEARTBEAT_MS = 10_000;

// The image build copies `context/swarm.js`, so a placeholder left behind
// would let a hand build ship it as the engine and pass the freshness gate.
// A run killed before its teardown leaves one, so the next run recognizes it
// by its bytes and takes it over instead of mistaking it for a real bundle.
// Runs in one checkout share it, so each keeps a marker fresh outside the
// build context and only the last run with a fresh marker removes it; a
// killed run's marker goes stale however its pid is reused.
export default function setup() {
  const engine = fileURLToPath(
    new URL("../../container/context/swarm.js", import.meta.url),
  );
  const context = dirname(engine);
  mkdirSync(context, { recursive: true });
  try {
    writeFileSync(engine, placeholder, { flag: "wx" });
  } catch {
    if (readFileSync(engine, "utf8") !== placeholder) return;
  }
  const users = join(tmpdir(), "swarm-review-engine-users");
  const checkout = `${createHash("sha256").update(engine).digest("hex").slice(0, 16)}-`;
  mkdirSync(users, { recursive: true });
  const mine = join(users, `${checkout}${process.pid}`);
  writeFileSync(mine, "");
  const heartbeat = setInterval(() => writeFileSync(mine, ""), HEARTBEAT_MS);
  heartbeat.unref();
  const remove = () => {
    process.off("exit", remove);
    clearInterval(heartbeat);
    rmSync(mine, { force: true });
    for (const user of readdirSync(users)) {
      if (!user.startsWith(checkout)) continue;
      const marker = join(users, user);
      const beat = statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (Date.now() - beat < 3 * HEARTBEAT_MS) return;
      rmSync(marker, { force: true });
    }
    rmSync(engine, { force: true });
    try {
      rmdirSync(context);
    } catch {}
  };
  // vitest exits on SIGINT and SIGTERM without running global teardown.
  process.once("exit", remove);
  return remove;
}
