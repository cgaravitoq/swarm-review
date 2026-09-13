import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";

// The five rules this package turns off all ask a codebase to stop parsing at
// its boundary, and this one is a boundary parser end to end: model answers,
// Worker payloads, container artifacts and GitHub responses all arrive as
// `unknown` and are narrowed by hand.
export default defineConfig({
  extends: [antiSlop],
  rules: {
    // `exactOptionalPropertyTypes` makes the conditional spread the clearest
    // way to leave an optional field out instead of setting it to undefined.
    "anti-slop/no-conditional-empty-object-spread": "off",
    // The repository validity checks are `typeof` on a parsed payload, which is
    // the same boundary the rule wants the parsing moved to.
    "anti-slop/no-runtime-typeof": "off",
    // A parser's parameter is `unknown` until it has parsed it.
    "anti-slop/no-unknown-parameters": "off",
    // `Record<string, unknown>` is what an unparsed payload is before the
    // decoder names its fields.
    "anti-slop/no-unsafe-dictionary-type": "off",
    // Asserting SAFETY before each of the repository's assertions would add
    // more comment lines than the assertions themselves.
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    // The two sites are `new Array(n)` preallocating a result array that is
    // then filled by index, where the argument is unambiguously a length.
    "unicorn/no-new-array": "off",
  },
  overrides: [
    {
      files: ["src/__tests__/worker.test.ts"],
      rules: {
        // A Worker's export is its module, and the entry point imports the
        // sandbox SDK's Durable Object class at load time, so there is no seam
        // to inject through: the SDK has to be the mock.
        "anti-slop/no-module-mocking": "off",
      },
    },
  ],
});
