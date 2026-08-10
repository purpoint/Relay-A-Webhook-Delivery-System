import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { createBlockingClient, disconnectRedis, redis } from "../config/redis.js";
import { disconnectDatabase } from "../config/database.js";
import { RedisWindowQueue } from "../queue/RedisWindowQueue.js";
import { WorkerPool } from "./worker.js";

/**
 * Worker process entrypoint.
 *
 * This is the tier you scale. More inbound traffic wants more API servers;
 * a growing backlog wants more of these. Workers hold no state between jobs,
 * so running twenty is exactly like running one, twenty times over.
 */
async function main(): Promise<void> {
  const queue = new RedisWindowQueue(redis, env.EXECUTION_WINDOW_SIZE);

  const pool = new WorkerPool(queue, {
    concurrency: env.WORKER_CONCURRENCY,
    deliveryTimeoutMs: env.DELIVERY_TIMEOUT_MS,
    maxAttempts: env.MAX_ATTEMPTS,
    retryBaseMs: env.RETRY_BASE_MS,
    retryMaxMs: env.RETRY_MAX_MS,

    /**
     * One Redis connection per worker loop.
     *
     * BLMOVE holds its connection for the whole of its timeout, so loops
     * sharing a client would wait in a queue rather than in parallel and the
     * configured concurrency would be fictional — one delivery at a time, no
     * matter the number.
     */
    createBlockingClient,
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Worker pool shutting down");

    /**
     * The watchdog allows for in-flight deliveries to finish. It must exceed
     * DELIVERY_TIMEOUT_MS, or a deploy landing during a slow delivery would
     * kill the request just before it was going to time out anyway — leaving
     * the row PROCESSING until the lease expires.
     */
    const watchdog = setTimeout(() => {
      logger.error("Worker shutdown timed out, forcing exit");
      process.exit(1);
    }, env.DELIVERY_TIMEOUT_MS + 10_000);
    watchdog.unref();

    try {
      // pool.stop() waits for in-flight deliveries and closes the per-loop
      // connections it created.
      await pool.stop();
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      clearTimeout(watchdog);
      logger.info("Worker shutdown complete");
      process.exit(0);
    } catch (error) {
      clearTimeout(watchdog);
      logger.error({ err: error }, "Error during worker shutdown");
      process.exit(1);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  pool.start();

  logger.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      deliveryTimeoutMs: env.DELIVERY_TIMEOUT_MS,
      maxAttempts: env.MAX_ATTEMPTS,
    },
    "Relay worker running",
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start worker");
  process.exit(1);
});
