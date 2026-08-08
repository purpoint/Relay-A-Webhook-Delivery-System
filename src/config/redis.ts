import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

const redisLogger = logger.child({ component: "redis" });

function buildClient(label: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    /**
     * Commands issued while Redis is unreachable queue rather than reject.
     * The scheduler and workers are long-lived loops that should ride out a
     * brief Redis blip instead of crashing; `null` disables the retry ceiling
     * that would otherwise start failing those queued commands.
     */
    maxRetriesPerRequest: null,

    /**
     * Connect on first use rather than at import. Without this, importing any
     * module that touches Redis would open a socket as a side effect — which
     * makes unit tests that only need the queue's pure logic require a live
     * Redis.
     */
    lazyConnect: true,

    retryStrategy(times) {
      // Back off up to 3s between reconnection attempts, then hold there.
      const delay = Math.min(times * 200, 3000);
      redisLogger.warn({ label, attempt: times, delay }, "Redis reconnecting");
      return delay;
    },
  });

  client.on("error", (err: Error) => {
    redisLogger.error({ label, err }, "Redis connection error");
  });

  client.on("connect", () => {
    redisLogger.info({ label }, "Redis connected");
  });

  return client;
}

/**
 * The shared connection, used for everything except blocking reads.
 */
export const redis = buildClient("main");

/**
 * A dedicated connection for blocking commands.
 *
 * BLMOVE occupies its connection for the whole of its timeout, so a worker
 * that shared the main client would stall every other command in the process
 * behind it. Each worker gets its own.
 */
export function createBlockingClient(label: string): Redis {
  return buildClient(label);
}

/**
 * How long the readiness probe waits for Redis before calling it unavailable.
 */
const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * Cheap round-trip used by the readiness probe.
 *
 * The timeout is essential rather than defensive. `maxRetriesPerRequest: null`
 * is right for the scheduler and workers — they should ride out a Redis blip
 * rather than crash — but it means a command issued while Redis is down waits
 * forever instead of rejecting. Without a bound here, /readyz would hang open
 * rather than answer, and a probe that never responds is no more useful than
 * one that lies.
 */
export async function checkRedisConnection(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis ping timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`)),
        HEALTH_CHECK_TIMEOUT_MS,
      );
    });

    const ping = redis.ping();

    // Once the timeout wins the race, nothing is left awaiting this promise.
    // Attach a no-op catch so its eventual rejection isn't reported as an
    // unhandled rejection — which the server treats as fatal.
    ping.catch(() => undefined);

    const pong = await Promise.race([ping, timeout]);
    return pong === "PONG";
  } catch (error) {
    redisLogger.error({ err: error }, "Redis health check failed");
    return false;
  } finally {
    // Leaving this pending would hold the event loop open and delay shutdown.
    if (timer) clearTimeout(timer);
  }
}

/** Grace period for a clean QUIT before the socket is torn down regardless. */
const QUIT_TIMEOUT_MS = 2000;

export async function disconnectRedis(): Promise<void> {
  try {
    /**
     * QUIT drains in-flight commands before closing, which is what we want on
     * a healthy connection. But if Redis is already unreachable that drain can
     * never complete and — because retries are unbounded — QUIT neither
     * resolves nor rejects. Waiting on it would hang shutdown until the
     * orchestrator lost patience and sent SIGKILL, so bound it and tear the
     * socket down by force if it doesn't finish.
     */
    await Promise.race([
      redis.quit(),
      new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS).unref()),
    ]);
  } catch {
    // QUIT failing is expected when Redis is already gone.
  } finally {
    redis.disconnect();
  }
  redisLogger.info("Redis connection closed");
}
