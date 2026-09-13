import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "swarm-review",
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ["default"],
    pool: "threads",
    isolate: true,
    // The reaper every test file inherits from `setupFiles` has to run before
    // that file's own `afterEach` removes the scratch a leak would still be
    // writing into.
    sequence: { hooks: "list" },
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
