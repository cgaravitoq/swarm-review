import {
  existsSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";

// The image build copies `context/swarm.js`, so a placeholder left behind
// would let a hand build ship it as the engine and pass the freshness gate.
export default function setup() {
  const engine = fileURLToPath(
    new URL("../../container/context/swarm.js", import.meta.url),
  );
  if (existsSync(engine)) return;
  const context = dirname(engine);
  const createdContext = !existsSync(context);
  mkdirSync(context, { recursive: true });
  writeFileSync(engine, "test engine bundle", { flag: "wx" });
  return () => {
    unlinkSync(engine);
    if (createdContext) rmdirSync(context);
  };
}
