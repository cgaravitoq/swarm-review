import { describe, expect, it } from "vitest";
import { execute } from "../local";

describe("execute", () => {
  it("ends a hung child at the deadline", async () => {
    await expect(execute("bash", ["-c", "sleep 300"], 500)).rejects.toThrow(
      /command deadline exceeded after 500ms/,
    );
  });

  it("settles a child whose stdout splits a multibyte character", async () => {
    await expect(
      execute(
        "bash",
        ["-c", "printf 'ab'; printf '\\303'; sleep 0.05; printf '\\263\\n'"],
        5000,
      ),
    ).resolves.toBe("ab\u00f3\n");
  });
});
