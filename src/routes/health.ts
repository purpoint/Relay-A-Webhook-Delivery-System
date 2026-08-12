import type { AppInstance } from "../types/app.js";
import { checkDatabaseConnection } from "../config/database.js";
import { checkRedisConnection } from "../config/redis.js";
import { success, failure } from "../utils/response.js";

/**
 * Liveness and readiness, kept deliberately distinct.
 *
 * `/health` answers "is this process alive" — an orchestrator that gets a
 * failure here should restart the container.
 *
 * `/readyz` answers "can this process actually serve traffic", which means
 * genuinely reaching Postgres and Redis. A probe that returns 200 without
 * checking its dependencies is worse than no probe: it keeps a broken
 * instance in the load balancer rotation.
 */
export async function healthRoutes(app: AppInstance): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness — is this process alive",
        description:
          "Answers unconditionally. A failure here means the process should be " +
          "restarted.",
      },
    },
    async () => {
      return success({ status: "ok", uptime: Math.floor(process.uptime()) });
    },
  );

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness — can this process serve traffic",
        description:
          "Genuinely reaches Postgres and Redis, returning 503 if either is " +
          "unavailable. A probe that answers 200 without checking is worse than " +
          "none: it keeps a broken instance in the load balancer.",
      },
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([
        checkDatabaseConnection(),
        checkRedisConnection(),
      ]);

      const ready = database && redis;
      const checks = { database, redis };

      if (!ready) {
        return reply
          .code(503)
          .send(failure("NOT_READY", "One or more dependencies are unavailable", checks));
      }

      return success({ status: "ready", checks });
    },
  );
}
