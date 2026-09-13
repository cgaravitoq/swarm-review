/**
 * Environment admission for a local run.
 *
 * A lane that starts without the disk to finish its install, or without a
 * toolchain the reviewed code needs, does not fail honestly: it produces a
 * review of a repository it could not build. Both are decided here, before the
 * container exists, so a swarm refuses whole rather than half-running.
 */

/**
 * Per-lane writable-layer requirement.
 *
 * Measured on the delivered three-lane #6563 run: its two surviving lane
 * containers hold 3.86 GB and 3.78 GB of writable layer after clone, install
 * and checks. The threshold is that observed peak plus headroom for install
 * churn and the Rust target directory, which the observed run never built.
 */
export const REQUIRED_LANE_BYTES = 6 * 1024 ** 3;

/**
 * Commands the runner and the review prompt actually invoke.
 *
 * `cargo` is here because the reader cases in the corpus build Rust crates, and
 * `setpriv` because the credential boundary is created with it.
 */
export const REQUIRED_TOOLCHAINS = [
  "bun",
  "git",
  "jq",
  "node",
  "rg",
  "cargo",
  "setpriv",
] as const;

export type EnvironmentProbe = {
  availableBytes: number;
  toolchains: Readonly<Record<string, string | null>>;
};

/** `df -P` output for one filesystem, in bytes available to the run. */
export function parseAvailableBytes(dfOutput: string) {
  const line = dfOutput.trim().split("\n").at(-1) ?? "";
  const available = line.trim().split(/\s+/)[3];
  if (available === undefined || !/^\d+$/.test(available)) {
    throw new Error(`cannot read available blocks from df output: ${dfOutput}`);
  }
  return Number(available) * 1024;
}

/**
 * The probe script the image runs, and the parser for what it prints.
 *
 * One `docker run --rm` answers both questions, so admission costs one
 * container start rather than one per tool.
 */
export const ENVIRONMENT_PROBE_SCRIPT = [
  "df -P /",
  ...REQUIRED_TOOLCHAINS.map(
    (tool) =>
      `echo "tool ${tool} $(command -v ${tool} > /dev/null 2>&1 && ${tool} --version 2>&1 | head -n1 || echo MISSING)"`,
  ),
].join("; ");

export function parseEnvironmentProbe(output: string): EnvironmentProbe {
  const lines = output.trim().split("\n");
  const toolLines = lines.filter((line) => line.startsWith("tool "));
  const toolchains: Record<string, string | null> = {};
  for (const line of toolLines) {
    const [, name, ...rest] = line.split(/\s+/);
    if (!name) continue;
    const value = rest.join(" ").trim();
    toolchains[name] = value === "MISSING" || value === "" ? null : value;
  }
  return {
    availableBytes: parseAvailableBytes(
      lines.filter((line) => !line.startsWith("tool ")).join("\n"),
    ),
    toolchains,
  };
}

/**
 * Admits a set of lanes, or refuses with every reason at once.
 *
 * Lanes share one filesystem, so the requirement scales with the lane count:
 * admitting three lanes against one lane's worth of free space is how a swarm
 * dies in its second install.
 */
export function evaluateAdmission(
  probe: EnvironmentProbe,
  lanes: number,
  requiredLaneBytes = REQUIRED_LANE_BYTES,
) {
  const requiredBytes = requiredLaneBytes * lanes;
  const reasons: string[] = [];
  if (probe.availableBytes < requiredBytes) {
    reasons.push(
      `insufficient disk: ${probe.availableBytes} bytes available, ${requiredBytes} required for ${lanes} lane(s)`,
    );
  }
  const missing = REQUIRED_TOOLCHAINS.filter((tool) => !probe.toolchains[tool]);
  if (missing.length > 0) {
    reasons.push(`missing toolchains: ${missing.join(", ")}`);
  }
  return {
    admitted: reasons.length === 0,
    requiredBytes,
    availableBytes: probe.availableBytes,
    toolchains: probe.toolchains,
    reasons,
  };
}
