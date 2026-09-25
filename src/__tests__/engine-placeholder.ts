import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";

const placeholder = "test engine bundle";

// The image build copies `context/swarm.js`, so a placeholder left behind
// would let a hand build ship it as the engine and pass the freshness gate.
// A run killed before its teardown leaves one, so the next run recognizes it
// by its bytes and takes it over instead of mistaking it for a real bundle.
export default function setup() {
  const engine = fileURLToPath(
    new URL("../../container/context/swarm.js", import.meta.url),
  );
  const context = dirname(engine);
  const createdContext = !existsSync(context);
  if (existsSync(engine)) {
    if (readFileSync(engine, "utf8") !== placeholder) return;
  } else {
    mkdirSync(context, { recursive: true });
    writeFileSync(engine, placeholder, { flag: "wx" });
  }
  const remove = () => {
    process.off("exit", remove);
    if (!existsSync(engine)) return;
    unlinkSync(engine);
    if (createdContext) rmdirSync(context);
  };
  // vitest exits on SIGINT and SIGTERM without running global teardown.
  process.once("exit", remove);
  return remove;
}
