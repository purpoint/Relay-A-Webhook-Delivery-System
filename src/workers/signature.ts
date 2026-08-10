import { createHmac } from "node:crypto";
import { secureCompare } from "../utils/crypto.js";

/**
 * Request signing.
 *
 * A webhook arrives at the customer's endpoint as an ordinary HTTP POST from
 * an unknown IP. Without a signature they have no way to distinguish it from
 * anyone else on the internet posting JSON at that URL — and the URL is not a
 * secret, it only has to leak once.
 *
 * So every request carries an HMAC of its own body, computed with the secret
 * shared with that webhook. The receiver recomputes it and compares. A match
 * proves two things at once: the request came from someone holding the secret,
 * and the body has not been altered in transit.
 */

export const SIGNATURE_HEADER = "x-relay-signature";
export const TIMESTAMP_HEADER = "x-relay-timestamp";
export const EVENT_ID_HEADER = "x-relay-event-id";
export const DELIVERY_ID_HEADER = "x-relay-delivery-id";
export const ATTEMPT_HEADER = "x-relay-attempt";

/**
 * How old a signed request may be before a receiver should reject it.
 *
 * Advisory — we publish it so receivers implement the check consistently. It
 * is the receiver's tolerance, not ours.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureParts {
  timestamp: number;
  signature: string;
  header: string;
}

/**
 * Sign a payload.
 *
 * The timestamp is signed *along with* the body rather than sent beside it.
 * That is the detail that makes the signature resist replay: an attacker who
 * captures a valid request cannot change the timestamp to make it look fresh,
 * because the timestamp is part of what was signed. Send it as a separate
 * unsigned header and it can be rewritten freely, which reduces the whole
 * scheme to "this was valid at some point in history".
 *
 * The signed string is `{timestamp}.{body}`. The dot matters: without a
 * separator, timestamp 12 with body "34..." and timestamp 1 with body
 * "234..." would produce identical input.
 */
export function signPayload(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): SignatureParts {
  const signedString = `${timestampSeconds}.${body}`;

  const signature = createHmac("sha256", secret).update(signedString).digest("hex");

  return {
    timestamp: timestampSeconds,
    signature,
    // Versioned, so a future scheme can be added without breaking receivers
    // that only understand v1 — exactly how Stripe handles the same problem.
    header: `t=${timestampSeconds},v1=${signature}`,
  };
}

/**
 * Verify a signature. This is what a *receiver* implements.
 *
 * Included here because it is the reference implementation we hand customers,
 * and because it lets the tests prove a real signature verifies rather than
 * merely asserting some hex was produced.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const parts = new Map(
    header.split(",").map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    }),
  );

  const timestampRaw = parts.get("t");
  const provided = parts.get("v1");

  if (!timestampRaw || !provided) return false;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) return false;

  /**
   * Reject anything outside the tolerance window, in either direction.
   *
   * Too old is the replay case. Too far in the future matters too: without
   * that bound, a captured request stamped years ahead would stay valid
   * indefinitely.
   */
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  // Constant-time: a normal === returns early on the first differing byte,
  // which leaks how much of a guess was correct.
  return secureCompare(expected, provided);
}
