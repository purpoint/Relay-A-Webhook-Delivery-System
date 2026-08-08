import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],

    /**
     * Run test files one at a time.
     *
     * Vitest parallelises across files by default, which is right for pure
     * unit tests and wrong here: the integration suites share a single
     * Postgres database, and each clears the users table in `beforeEach`.
     * Run concurrently, they delete each other's fixtures mid-test and
     * collide on the same seeded email address — producing failures that
     * look like application bugs and move around between runs.
     *
     * The alternative, a separate database per worker, is worth doing if the
     * suite ever grows slow enough to need it. At under a second, it isn't.
     */
    fileParallelism: false,

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
