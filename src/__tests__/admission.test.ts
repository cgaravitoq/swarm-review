import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_PROBE_SCRIPT,
  evaluateAdmission,
  parseAvailableBytes,
  parseEnvironmentProbe,
  REQUIRED_LANE_BYTES,
  REQUIRED_TOOLCHAINS,
} from "../admission";

const probeOutput = [
  "Filesystem     1024-blocks     Used Available Capacity Mounted on",
  "overlay           39911424 18320160  21591264      46% /",
  "tool bun 1.4.0",
  "tool git git version 2.34.1",
  "tool jq jq-1.6",
  "tool node v22.11.0",
  "tool rg ripgrep 13.0.0",
  "tool cargo cargo 1.75.0",
  "tool setpriv setpriv from util-linux 2.37.2",
].join("\n");

describe("environment probe", () => {
  it("asks the image for every tool the runner and the prompt invoke", () => {
    for (const tool of REQUIRED_TOOLCHAINS) {
      expect(ENVIRONMENT_PROBE_SCRIPT).toContain(`echo "tool ${tool} `);
    }
    expect(ENVIRONMENT_PROBE_SCRIPT).toContain("df -P /");
  });

  it("reads available bytes from the df column, not the used one", () => {
    expect(parseAvailableBytes(probeOutput.split("\n")[1] ?? "")).toBe(
      21591264 * 1024,
    );
  });

  it("refuses df output it cannot read instead of admitting on a guess", () => {
    expect(() => parseAvailableBytes("Filesystem Mounted on")).toThrow(
      /cannot read available blocks/,
    );
  });

  it("parses tool versions and marks absent ones null", () => {
    const probe = parseEnvironmentProbe(
      `${probeOutput}\ntool cargo MISSING`.replace(
        "tool cargo cargo 1.75.0\n",
        "",
      ),
    );
    expect(probe.availableBytes).toBe(21591264 * 1024);
    expect(probe.toolchains["bun"]).toBe("1.4.0");
    expect(probe.toolchains["cargo"]).toBeNull();
  });
});

describe("admission", () => {
  const probe = parseEnvironmentProbe(probeOutput);

  it("admits a single lane on the measured free space", () => {
    expect(evaluateAdmission(probe, 1)).toMatchObject({
      admitted: true,
      requiredBytes: REQUIRED_LANE_BYTES,
      reasons: [],
    });
  });

  it("scales the requirement with the lane count sharing the filesystem", () => {
    // 21591264 KiB is about 20.6 GiB: three lanes fit at 6 GiB each, four do not.
    expect(evaluateAdmission(probe, 3).admitted).toBe(true);
    const four = evaluateAdmission(probe, 4);
    expect(four.admitted).toBe(false);
    expect(four.reasons[0]).toMatch(/insufficient disk/);
  });

  it("refuses an image without the Rust toolchain the reader cases need", () => {
    const withoutCargo = {
      ...probe,
      toolchains: { ...probe.toolchains, cargo: null },
    };
    const result = evaluateAdmission(withoutCargo, 1);
    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain("missing toolchains: cargo");
  });

  it("reports every reason at once rather than the first", () => {
    const result = evaluateAdmission(
      { availableBytes: 1024, toolchains: {} },
      2,
    );
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[1]).toContain("setpriv");
  });
});
