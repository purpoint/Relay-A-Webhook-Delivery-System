import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { buildApp } from "./app.js";
import { redis, createBlockingClient, disconnectRedis } from "./config/redis.js";
import { disconnectDatabase } from "./config/database.js";
import { RedisWindowQueue } from "./queue/RedisWindowQueue.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { WorkerPool } from "./workers/worker.js";

/**
 * One entrypoint, four roles.
 *
 * Relay is three tiers that scale on different axes: API servers for inbound
 * traffic, workers for delivery throughput, and a scheduler that one instance
 * can generally handle. Running them as separate processes is the right shape
 * for production, and docker-compose still does exactly that.
 *
 * But separate processes are not free. In development they mean three
 * terminals to keep track of, and in a small deployment they mean three
 * services to pay for and supervise when one machine would comfortably do.
 *
 * `RELAY_ROLE` lets the same binary run any subset:
 *
 *   api        just the HTTP server
 *   scheduler  just the execution-window manager
 *   worker     just the delivery pool
 *   all        all three in one process
 *
 * The separation stays real — the roles share no state and communicate only
 * through Postgres and Redis, exactly as they do across machines. `all` merely
 * co-locates them. Being able to say when *not* to split processes is worth
 * more than splitting them reflexively.
 */

type Role = "api" | "scheduler" | "worker" | "all";

interface Runnable {
  name: string;
  stop: () => Promise<void>;
}

async function main(): Promise<void> {
  const role = env.RELAY_ROLE;
  const running: Runnable[] = [];

  if (role === "api" || role === "all") {
    const app = await buildApp();
    await app.listen({ port: env.PORT, host: env.HOST });

    running.push({ name: "api", stop: () => app.close() });

    logger.info({ port: env.PORT, url: `http://localhost:${String(env.PORT)}` }, "API listening");
  }

  if (role === "scheduler" || role === "all") {
    const queue = new RedisWindowQueue(redis, env.EXECUTION_WINDOW_SIZE);
    const scheduler = new Scheduler(queue, {
      windowSize: env.EXECUTION_WINDOW_SIZE,
      pollIntervalMs: env.SCHEDULER_POLL_MS,
      leaseTimeoutMs: env.LEASE_TIMEOUT_MS,
    });

    scheduler.start();
    running.push({ name: "scheduler", stop: () => scheduler.stop() });
  }

  if (role === "worker" || role === "all") {
    const queue = new RedisWindowQueue(redis, env.EXECUTION_WINDOW_SIZE);
    const pool = new WorkerPool(queue, {
      concurrency: env.WORKER_CONCURRENCY,
      deliveryTimeoutMs: env.DELIVERY_TIMEOUT_MS,
      maxAttempts: env.MAX_ATTEMPTS,
      retryBaseMs: env.RETRY_BASE_MS,
      retryMaxMs: env.RETRY_MAX_MS,
      // Each worker loop needs its own connection: BLMOVE holds one for the
      // whole of its timeout, so a shared client would serialise the pool.
      createBlockingClient,
    });

    pool.start();
    running.push({ name: "worker", stop: () => pool.stop() });
  }

  logger.info({ role, running: running.map((r) => r.name) }, "Relay started");

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal, role }, "Shutting down");

    /**
     * Must exceed DELIVERY_TIMEOUT_MS, or a deploy landing during a slow
     * delivery kills the request just before it would have timed out anyway,
     * leaving the row PROCESSING until its lease expires.
     */
    const watchdog = setTimeout(() => {
      logger.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, env.DELIVERY_TIMEOUT_MS + 10_000);
    watchdog.unref();

    try {
      /**
       * Stop the API first so no new events arrive, then let the scheduler and
       * workers finish what they already hold. Sequential rather than
       * parallel: closing connections out from under an in-flight delivery
       * would strand it in PROCESSING for the full lease timeout.
       */
      for (const component of running) {
        await component.stop();
        logger.info({ component: component.name }, "Stopped");
      }

      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      clearTimeout(watchdog);
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (error) {
      clearTimeout(watchdog);
      logger.error({ err: error }, "Error during shutdown");
      process.exit(1);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start Relay");
  process.exit(1);
});

export type { Role };
