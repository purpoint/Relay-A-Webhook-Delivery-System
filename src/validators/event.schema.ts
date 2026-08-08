import { z } from "zod";

/**
 * The ingest contract — the hottest, most public schema in the system.
 */
export const publishEventSchema = z.object({
  /**
   * A dotted name identifying what happened: "payment.succeeded",
   * "user.created". Constrained to a conservative character set so it is safe
   * to use in log lines, metric labels and, later, subscription filters
   * without escaping.
   */
  eventType: z
    .string()
    .trim()
    .min(1, "eventType is required")
    .max(100, "eventType must be at most 100 characters")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "eventType may contain only letters, numbers, dots, underscores and hyphens",
    ),

  /**
   * The customer's own data, forwarded verbatim to their endpoint.
   *
   * Required to be an object rather than any JSON value. A bare string or
   * number is legal JSON but leaves no room to add fields later, and every
   * webhook consumer in existence expects to parse an object.
   *
   * Overall body size is capped at 1MB by Fastify's bodyLimit.
   */
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Optional `Idempotency-Key` header.
 *
 * Lets a client retry a publish after a timeout without risking a duplicate
 * event — which matters because a lost response is indistinguishable from a
 * lost request, and the safe assumption for the client is always to retry.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255, "Idempotency-Key must be at most 255 characters")
  .optional();
