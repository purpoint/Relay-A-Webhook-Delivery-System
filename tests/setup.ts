/**
 * Loaded before every test file.
 *
 * Forces NODE_ENV=test ahead of any import of src/config/env.ts, which reads
 * process.env once at module load. Setting it here rather than relying on the
 * caller's shell keeps `vitest` and `npm test` behaving identically, and
 * silences the logger for the duration of the run.
 */
process.env["NODE_ENV"] = "test";

// Point tests at the throwaway database unless the caller has already chosen
// one, so a stray `npm test` can never truncate the development data.
process.env["DATABASE_URL"] ??=
  "postgresql://localhost:5432/relay_test?schema=public";

process.env["JWT_SECRET"] ??= "test-secret-that-is-at-least-32-characters-long";
