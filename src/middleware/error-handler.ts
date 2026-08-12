import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { AppInstance } from "../types/app.js";
import { ZodError } from "zod";
import { AppError } from "../utils/errors.js";
import { failure } from "../utils/response.js";
import { isProduction } from "../config/env.js";

/**
 * The one place an exception becomes an HTTP response.
 *
 * Centralising this is what lets services throw domain errors without knowing
 * anything about HTTP, and guarantees that every failure leaves through the
 * same response envelope as every success.
 */
export interface ErrorHandlerOptions {
  /**
   * Serve the single-page app for unmatched GETs instead of a JSON 404.
   *
   * The monitor's routes exist in the browser, not on the server, so a deep
   * link or a page refresh would otherwise 404. API and docs paths are always
   * excluded — a mistyped endpoint must return a JSON error, not a page of
   * HTML, which is considerably harder to debug against.
   */
  spaFallback?: boolean;
}

export function registerErrorHandler(
  app: AppInstance,
  options: ErrorHandlerOptions = {},
): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    // Errors we raised deliberately: the message is safe to show the caller.
    if (error instanceof AppError) {
      request.log.info(
        { code: error.code, statusCode: error.statusCode, path: request.url },
        error.message,
      );
      return reply
        .code(error.statusCode)
        .send(failure(error.code, error.message, error.details));
    }

    // Schema validation that escaped a route's own handling.
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return reply
        .code(400)
        .send(failure("VALIDATION_ERROR", "Request validation failed", details));
    }

    const fastifyError = error as FastifyError;

    // Fastify's own validation layer, for routes using JSON schema.
    if (fastifyError.validation) {
      return reply.code(400).send(
        failure("VALIDATION_ERROR", "Request validation failed", fastifyError.validation),
      );
    }

    // Rate limiter and other plugins that set a 4xx status carry a safe message.
    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      return reply
        .code(statusCode)
        .send(failure(fastifyError.code ?? "BAD_REQUEST", error.message));
    }

    // Anything left is a bug. Log the whole thing, tell the caller nothing —
    // stack traces and driver messages leak schema and dependency details.
    request.log.error({ err: error, path: request.url }, "Unhandled error");

    return reply.code(500).send(
      failure(
        "INTERNAL_ERROR",
        isProduction ? "An unexpected error occurred" : error.message,
      ),
    );
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const isApiPath =
      request.url.startsWith("/api") ||
      request.url.startsWith("/docs") ||
      request.url.startsWith("/health") ||
      request.url.startsWith("/readyz");

    if (options.spaFallback && request.method === "GET" && !isApiPath) {
      return reply.sendFile("index.html");
    }

    return reply
      .code(404)
      .send(failure("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });
}
