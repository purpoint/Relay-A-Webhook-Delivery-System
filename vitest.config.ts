import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    // Unit tests are pure and parallel-safe. Integration tests share one
    // Postgres database and one Redis instance, so running them concurrently
    // would have them truncating tables out from under each other.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],

    setupFiles: ["tests/setup.ts"],

    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      exclude: [
        "src/generated/**",
        "src/**/*.test.ts",
        "tests/**",
        "**/*.config.ts",
      ],
    },
  },
});
