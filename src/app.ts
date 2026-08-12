import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import cookie from "@fastify/cookie";
import { validatorCompiler } from "fastify-type-provider-zod";
import { randomUUID } from "node:crypto";

import { env, isProduction, isTest } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1/index.js";
import { registerSwagger } from "./config/swagger.js";
import type { AppInstance } from "./types/app.js";

export interface BuildAppOptions {
  /**
   * Whether to enforce rate limiting.
   *
   * Defaults to on everywhere except tests. A test suite drives dozens of
   * requests from one address in a few seconds, which trips the limiter and
   * makes results depend on the order tests happen to run in. Turning it off
   * by default keeps suites deterministic; the tests that specifically cover
   * rate limiting pass `true` to switch it back on.
   */
  rateLimit?: boolean;

  /** Serve interactive docs at /docs. Off in tests, where nothing reads them. */
  swagger?: boolean;
}

/**
 * Builds the Fastify instance without starting it.
 *
 * Kept separate from server.ts so tests can build an app, drive it through
 * `app.inject()`, and never bind a port.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<AppInstance> {
  const rateLimitEnabled = options.rateLimit ?? !isTest;
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

  /**
   * Validate requests with the Zod schemas attached to each route.
   *
   * Only the validator is installed, not the serializer. The serializer would
   * strip response fields absent from a declared response schema, which is a
   * useful discipline but would mean writing a schema for every response
   * shape before any of them could be returned safely. Request validation is
   * what makes the docs usable and the inputs trustworthy; responses are
   * already built by typed helpers.
   */
  app.setValidatorCompiler(validatorCompiler);

  await app.register(helmet, {
    // Relay is a JSON API; the CSP defaults exist to constrain HTML documents
    // and only get in Swagger UI's way.
    contentSecurityPolicy: false,
  });

  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      // The default for management endpoints. Auth tightens it and ingest
      // raises it, both via per-route config.
      max: env.RATE_LIMIT_MAX,
      timeWindow: "1 minute",
      // Per-project once an API key is presented, per-IP otherwise. Rate
      // limiting purely by IP would let one customer behind a NAT exhaust the
      // budget for everyone sharing it.
      keyGenerator: (request) => {
        const apiKey = request.headers["x-api-key"];
        return typeof apiKey === "string" ? `key:${apiKey}` : `ip:${request.ip}`;
      },
    });
  }

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  // Refresh tokens travel in an httpOnly cookie, so the cookie parser must be
  // registered before any route that reads one.
  await app.register(cookie);

  // Registered before the routes so it can collect their schemas. Skipped in
  // tests, where nothing reads it and it only slows startup.
  if (options.swagger ?? !isTest) {
    await registerSwagger(app);
  }

  registerErrorHandler(app);

  // Health probes sit outside the version prefix — orchestrators shouldn't
  // have to track the API version to know whether the process is alive.
  await app.register(healthRoutes);

  await app.register(v1Routes, { prefix: "/api/v1" });

  app.log.info(
    { executionWindowSize: env.EXECUTION_WINDOW_SIZE },
    "Application built",
  );

  return app;
}
