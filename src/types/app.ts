import type { FastifyInstance, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppLogger } from "../utils/logger.js";

/**
 * The Fastify instance as Relay actually configures it.
 *
 * Passing our own pino instance via `loggerInstance` makes Fastify's generic
 * logger parameter that concrete type instead of the default
 * `FastifyBaseLogger`. The two are not interchangeable under
 * `exactOptionalPropertyTypes`, so every function that receives the app —
 * route plugins, the error handler — must be typed against this alias rather
 * than a bare `FastifyInstance`.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  AppLogger,
  FastifyTypeProviderDefault
>;
