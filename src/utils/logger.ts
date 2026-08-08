import { pino } from "pino";
import { env, isProduction, isTest } from "../config/env.js";

/**
 * Structured logging for the whole system.
 *
 * Production emits newline-delimited JSON for log aggregators. Development
 * gets pretty-printed output, since nobody wants to read raw JSON while
 * debugging a scheduler loop.
 */
export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,

  // Strip credentials before they reach a log sink. This list must grow
  // alongside anything that carries a secret — API keys, webhook signing
  // secrets, bearer tokens.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-api-key']",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.secret",
      "*.apiKey",
      "*.token",
    ],
    censor: "[redacted]",
  },

  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }),
});

/**
 * Handing this instance to Fastify makes the resulting FastifyInstance generic
 * over this exact logger type rather than the default FastifyBaseLogger, so
 * anything typed against the app needs to name it. See src/types/app.ts.
 */
export type AppLogger = typeof logger;

/**
 * A logger tagged with the component it belongs to, so scheduler, worker and
 * API lines stay distinguishable once they're interleaved in one stream.
 */
export function componentLogger(component: string): AppLogger {
  return logger.child({ component });
}
