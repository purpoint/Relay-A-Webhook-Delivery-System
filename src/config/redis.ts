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

/** Cheap round-trip used by the readiness probe. */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch (error) {
    redisLogger.error({ err: error }, "Redis health check failed");
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  redisLogger.info("Redis connection closed");
}
