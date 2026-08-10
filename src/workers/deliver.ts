import { request as undiciRequest } from "undici";
import {
  ATTEMPT_HEADER,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signPayload,
} from "./signature.js";
import { isRetryableStatus, isSuccessStatus } from "./backoff.js";
import type { DeliveryContext } from "../repositories/delivery-execution.repository.js";

/**
 * The single outbound HTTP request.
 *
 * Kept free of database and Redis access so it can be tested against a real
 * local server without any of the surrounding machinery.
 */

export interface DeliveryOutcome {
  success: boolean;
  /** Absent when the request never produced a response at all. */
  responseStatus?: number | undefined;
  /** Whether trying the identical request again could plausibly work. */
  retryable: boolean;
  errorMessage?: string | undefined;
  durationMs: number;
}

export interface DeliverOptions {
  timeoutMs: number;
  /** Bytes of the response body to keep for delivery history. */
  maxResponseBytes?: number;
}

/**
 * The JSON a receiver sees.
 *
 * Deliberately wraps the customer's payload rather than sending it bare, so
 * the envelope can gain fields later without colliding with whatever keys the
 * customer happens to use.
 */
export function buildRequestBody(delivery: DeliveryContext): string {
  return JSON.stringify({
    id: delivery.event.id,
    type: delivery.event.eventType,
    created_at: delivery.event.createdAt.toISOString(),
    data: delivery.event.payload,
  });
}

export async function deliver(
  delivery: DeliveryContext,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const body = buildRequestBody(delivery);
  const attempt = delivery.attempt + 1;

  const signed = signPayload(delivery.webhook.secret, body);
  const startedAt = Date.now();

  try {
    const response = await undiciRequest(delivery.webhook.url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "Relay/1.0",
        [SIGNATURE_HEADER]: signed.header,
        [TIMESTAMP_HEADER]: String(signed.timestamp),
        [EVENT_ID_HEADER]: delivery.event.id,
        [DELIVERY_ID_HEADER]: delivery.id,
        [ATTEMPT_HEADER]: String(attempt),
      },

      /**
       * A hard ceiling on the whole request.
       *
       * Without it a receiver that accepts the connection and then never
       * responds would hold this worker forever. One such endpoint could
       * occupy every worker in the pool and stop deliveries for every other
       * customer — a denial of service that any customer could trigger by
       * accident.
       */
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,

      /**
       * Redirects are deliberately not followed.
       *
       * undici's `request` does not follow them unless a redirect interceptor
       * is added, so this is the default rather than a setting — but it is a
       * security property worth naming, because adding that interceptor later
       * would quietly defeat the SSRF guard. Following a redirect means
       * delivering to a URL that never passed validation: register a clean
       * public endpoint, have it 302 to 169.254.169.254, and the guard is
       * bypassed entirely.
       *
       * A 3xx therefore falls through as a failure, and is treated as
       * non-retryable — see isRetryableStatus.
       */
    });

    /**
     * The body must be consumed even though we mostly discard it. Undici
     * pools connections, and an unread body leaves the connection unusable
     * and eventually exhausts the pool.
     */
    const text = await response.body.text();
    const durationMs = Date.now() - startedAt;

    if (isSuccessStatus(response.statusCode)) {
      return { success: true, responseStatus: response.statusCode, retryable: false, durationMs };
    }

    const maxBytes = options.maxResponseBytes ?? 500;

    return {
      success: false,
      responseStatus: response.statusCode,
      retryable: isRetryableStatus(response.statusCode),
      errorMessage: `HTTP ${response.statusCode}: ${text.slice(0, maxBytes)}`,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    /**
     * No response at all — DNS failure, connection refused, TLS error,
     * timeout. All are treated as retryable: they describe the state of the
     * network or the endpoint right now, not a permanent verdict on the
     * request. An endpoint being down is the ordinary case this whole system
     * exists to handle.
     */
    return {
      success: false,
      retryable: true,
      errorMessage: describeTransportError(error),
      durationMs,
    };
  }
}

function describeTransportError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return "Unknown transport error";
}
