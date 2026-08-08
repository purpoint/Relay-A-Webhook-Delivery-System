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

/**
 * Pin the webhook URL policy for tests.
 *
 * Test webhooks target 127.0.0.1, which the SSRF guard blocks by default. Set
 * here rather than inherited from a developer's .env so the suite behaves the
 * same on every machine — otherwise the URL-validation tests would pass or
 * fail depending on local configuration.
 *
 * dotenv does not overwrite variables that already exist, and this file runs
 * before src/config/env.ts is imported, so these values win.
 */
process.env["ALLOW_PRIVATE_WEBHOOK_URLS"] ??= "true";
process.env["REQUIRE_HTTPS_WEBHOOKS"] ??= "false";
