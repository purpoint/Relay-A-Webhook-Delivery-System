import "dotenv/config";
import { z } from "zod";

/**
 * Every environment variable Relay reads, parsed and validated exactly once at
 * import time.
 *
 * The point of doing this here rather than reaching for `process.env` at the
 * call site is failure timing: a typo'd or missing variable should stop the
 * process from booting, not surface as `undefined` three hours later inside a
 * worker that is halfway through a delivery.
 */

/** Coerce a decimal string into a positive integer, rejecting junk like "10abc". */
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ── API server ────────────────────────────────────────────────────────────
  PORT: positiveInt.max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),

  // ── Datastores ────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1),

  /**
   * Postgres pool size for this process. Workers contend for connections while
   * reading deliveries and writing results, so this wants to be at least
   * WORKER_CONCURRENCY plus headroom for the scheduler's claim transaction.
   */
  DATABASE_POOL_SIZE: positiveInt.default(15),

  REDIS_URL: z.string().min(1),

  // ── Auth ──────────────────────────────────────────────────────────────────
  // 32 chars is the floor for an HMAC-SHA256 signing key to carry its full
  // security margin. Shorter secrets are a silent downgrade, so reject them.
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().min(1).default("1h"),

  // ── Rate limits (requests per minute) ─────────────────────────────────────
  /**
   * Management endpoints — projects, webhooks, keys. A person clicking around
   * a dashboard, so a low ceiling is generous.
   */
  RATE_LIMIT_MAX: positiveInt.default(100),

  /**
   * Auth endpoints. Deliberately far tighter: these are the target for
   * credential stuffing, and every attempt costs us an Argon2 hash, so an
   * unthrottled login is also a way to exhaust our own CPU.
   */
  AUTH_RATE_LIMIT_MAX: positiveInt.default(10),

  /**
   * Event ingest. This one is a machine publishing in bulk, not a person, and
   * it needs a completely different order of magnitude — the default here is
   * 100/second. Applying the management limit to ingest would cap a customer
   * at 100 events a minute, which for a webhook platform is no rate limit at
   * all, it is an outage.
   */
  INGEST_RATE_LIMIT_MAX: positiveInt.default(6000),

  // ── Webhook URL policy ────────────────────────────────────────────────────
  /**
   * Permit webhook URLs pointing at loopback or private addresses.
   *
   * Needed for local development, where the delivery target is a receiver on
   * 127.0.0.1. In production this must stay false: enabling it lets a customer
   * aim our own workers at internal services or the cloud metadata endpoint —
   * a Server-Side Request Forgery. See utils/url-safety.ts.
   *
   * A cross-field check below refuses to boot if this is true in production.
   */
  ALLOW_PRIVATE_WEBHOOK_URLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /** Require webhook URLs to use HTTPS. Relaxed locally for plain-HTTP receivers. */
  REQUIRE_HTTPS_WEBHOOKS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // ── Execution window ──────────────────────────────────────────────────────
  /**
   * The hard cap on delivery jobs resident in Redis. Postgres holds every
   * pending delivery; Redis holds only the slice that is executable right now.
   * This single number is what keeps Redis memory flat under a multi-million
   * event backlog.
   */
  EXECUTION_WINDOW_SIZE: positiveInt.default(5000),
  SCHEDULER_POLL_MS: positiveInt.default(2000),

  /**
   * How long a delivery may sit in PROCESSING before the scheduler's reaper
   * presumes the worker holding it has died and returns it to WAITING.
   * Must comfortably exceed DELIVERY_TIMEOUT_MS or healthy in-flight
   * deliveries will be reclaimed out from under their workers.
   */
  LEASE_TIMEOUT_MS: positiveInt.default(60_000),

  // ── Workers ───────────────────────────────────────────────────────────────
  WORKER_CONCURRENCY: positiveInt.default(10),
  MAX_ATTEMPTS: positiveInt.default(8),
  DELIVERY_TIMEOUT_MS: positiveInt.default(10_000),

  RETRY_BASE_MS: positiveInt.default(5_000),
  RETRY_MAX_MS: positiveInt.default(3_600_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Logging isn't configured yet at this point in the boot sequence, so this
    // writes to stderr directly. Report every problem at once — fixing config
    // one error per restart is miserable.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    process.stderr.write(
      `\nInvalid environment configuration:\n${issues}\n\n` +
        `See .env.example for the full list of expected variables.\n\n`,
    );
    process.exit(1);
  }

  const env = parsed.data;

  // Cross-field constraint Zod can't express per-field: reclaiming a lease
  // before the delivery it guards has timed out would duplicate in-flight work.
  if (env.LEASE_TIMEOUT_MS <= env.DELIVERY_TIMEOUT_MS) {
    process.stderr.write(
      `\nInvalid environment configuration:\n` +
        `  - LEASE_TIMEOUT_MS (${env.LEASE_TIMEOUT_MS}) must be greater than ` +
        `DELIVERY_TIMEOUT_MS (${env.DELIVERY_TIMEOUT_MS}), otherwise the scheduler ` +
        `will reclaim deliveries that are still in flight.\n\n`,
    );
    process.exit(1);
  }

  /**
   * Refuse to start a production server that would accept webhook URLs
   * pointing into our own network. This is a misconfiguration serious enough
   * to be worth failing the boot over — silently allowing it would leave an
   * SSRF hole open with nothing in the logs to suggest anything was wrong.
   */
  if (env.NODE_ENV === "production" && env.ALLOW_PRIVATE_WEBHOOK_URLS) {
    process.stderr.write(
      `\nInvalid environment configuration:\n` +
        `  - ALLOW_PRIVATE_WEBHOOK_URLS must be false in production. Enabling it ` +
        `permits customers to register webhook URLs targeting internal services ` +
        `or the cloud metadata endpoint, turning delivery workers into an SSRF ` +
        `vector.\n\n`,
    );
    process.exit(1);
  }

  return env;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
