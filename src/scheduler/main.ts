import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { redis, disconnectRedis } from "../config/redis.js";
import { disconnectDatabase } from "../config/database.js";
import { RedisWindowQueue } from "../queue/RedisWindowQueue.js";
import { Scheduler } from "./scheduler.js";

/**
 * Scheduler process entrypoint.
 *
 * Runs as its own process, separate from the API and the workers, because the
 * three scale on different axes: you add API servers for more inbound traffic
 * and workers for more delivery throughput, but one scheduler is enough to
 * keep a 5,000-slot window full.
 *
 * More than one is safe regardless — FOR UPDATE SKIP LOCKED means two
 * schedulers claim disjoint sets of deliveries rather than colliding.
 */
async function main(): Promise<void> {
  const queue = new RedisWindowQueue(redis, env.EXECUTION_WINDOW_SIZE);

  const scheduler = new Scheduler(queue, {
    windowSize: env.EXECUTION_WINDOW_SIZE,
    pollIntervalMs: env.SCHEDULER_POLL_MS,
    leaseTimeoutMs: env.LEASE_TIMEOUT_MS,
  });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Scheduler shutting down");

    const watchdog = setTimeout(() => {
      logger.error("Scheduler shutdown timed out, forcing exit");
      process.exit(1);
    }, 15_000);
    watchdog.unref();

    try {
      // Finish the tick in progress before closing the connections it is
      // using — a tick killed mid-transaction would roll back anyway, but
      // waiting avoids a spurious error in the logs on every deploy.
      await scheduler.stop();
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      clearTimeout(watchdog);
      logger.info("Scheduler shutdown complete");
      process.exit(0);
    } catch (error) {
      clearTimeout(watchdog);
      logger.error({ err: error }, "Error during scheduler shutdown");
      process.exit(1);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  scheduler.start();

  logger.info(
    {
      windowSize: env.EXECUTION_WINDOW_SIZE,
      pollIntervalMs: env.SCHEDULER_POLL_MS,
    },
    "Relay scheduler running",
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start scheduler");
  process.exit(1);
});
