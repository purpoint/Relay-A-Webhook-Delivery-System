import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { disconnectDatabase } from "./config/database.js";
import { disconnectRedis } from "./config/redis.js";

/**
 * API server entrypoint.
 *
 * This process only ever writes to Postgres. It never delivers a webhook and
 * never talks to a customer endpoint — accepting an event means the event is
 * durably persisted, not that it has been sent.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  // Track shutdown so a second signal during a slow drain can't start the
  // teardown sequence twice.
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Shutting down");

    // Order matters: stop accepting requests before closing the connections
    // that in-flight requests are still using.
    try {
      await app.close();
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "Error during shutdown");
      process.exit(1);
    }
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    void shutdown("unhandledRejection");
  });

  await app.listen({ port: env.PORT, host: env.HOST });

  logger.info(
    { port: env.PORT, host: env.HOST, env: env.NODE_ENV },
    "Relay API server listening",
  );
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start server");
  process.exit(1);
});
