import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";

import { env, isProduction } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { healthRoutes } from "./routes/health.js";
import type { AppInstance } from "./types/app.js";

/**
 * Builds the Fastify instance without starting it.
 *
 * Kept separate from server.ts so tests can build an app, drive it through
 * `app.inject()`, and never bind a port.
 */
export async function buildApp(): Promise<AppInstance> {
  const app = Fastify({
    loggerInstance: logger,

    // Reuse an inbound request ID when a proxy supplies one, so a single
    // request stays traceable across service boundaries.
    genReqId: (req) => (req.headers["x-request-id"] as string) ?? randomUUID(),

    // Only honour X-Forwarded-* behind a trusted proxy. Trusting it
    // unconditionally would let any caller spoof their source IP and
    // sidestep per-IP rate limiting.
    trustProxy: isProduction,

    // Events carry arbitrary customer JSON, but not unbounded — 1MB is a
    // generous webhook payload and an effective cap on memory per request.
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    // Relay is a JSON API; the CSP defaults exist to constrain HTML documents
    // and only get in Swagger UI's way.
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    // Per-project once an API key is presented, per-IP otherwise. Rate
    // limiting purely by IP would let one customer behind a NAT exhaust the
    // budget for everyone sharing it.
    keyGenerator: (request) => {
      const apiKey = request.headers["x-api-key"];
      return typeof apiKey === "string" ? `key:${apiKey}` : `ip:${request.ip}`;
    },
  });

  registerErrorHandler(app);

  // Health probes sit outside the version prefix — orchestrators shouldn't
  // have to track the API version to know whether the process is alive.
  await app.register(healthRoutes);

  app.log.info(
    { executionWindowSize: env.EXECUTION_WINDOW_SIZE },
    "Application built",
  );

  return app;
}
