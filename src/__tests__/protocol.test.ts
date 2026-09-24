import { describe, expect, it } from "vitest";
import { firstSourceMismatch, IMAGE_SOURCES, REVIEW_RUNNER } from "../protocol";

const sha64 = "b".repeat(64);
const everySource = Object.fromEntries(
  Object.keys(IMAGE_SOURCES).map((path) => [path, sha64]),
);

describe("firstSourceMismatch", () => {
  it("refuses a source the expectation never recorded instead of skipping it", () => {
    // A lane recorded by a driver that compared fewer files: agreeing on
    // every file both sides hold is not agreeing on the image.
    const { "/opt/review/Dockerfile": _unrecorded, ...partial } = everySource;

    expect(firstSourceMismatch(partial, everySource)).toEqual({
      file: "/opt/review/Dockerfile",
      expected: "unrecorded",
      observed: sha64,
    });
    expect(firstSourceMismatch(undefined, everySource)).toEqual({
      file: REVIEW_RUNNER,
      expected: "unrecorded",
      observed: sha64,
    });
  });
});
