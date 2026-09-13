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
  },
});
