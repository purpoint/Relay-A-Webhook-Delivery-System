/**
 * Relay's error taxonomy.
 *
 * Services throw these; a single Fastify error handler turns them into HTTP
 * responses. That split is deliberate — a service should be able to say "this
 * webhook doesn't exist" without knowing that HTTP calls it 404, which keeps
 * the same services usable from the scheduler and workers where there is no
 * request to respond to.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Request validation failed", details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

/**
 * The caller is authenticated but the resource belongs to someone else.
 *
 * Note that tenancy checks should generally prefer NotFoundError over this:
 * telling a stranger that a project exists but isn't theirs leaks the
 * existence of that project. Reserve 403 for cases where the caller already
 * demonstrably knows the resource exists.
 */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(404, "NOT_FOUND", `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource already exists", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(429, "RATE_LIMITED", message);
  }
}
