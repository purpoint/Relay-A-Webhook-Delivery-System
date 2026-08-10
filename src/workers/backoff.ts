/**
 * Retry timing.
 *
 * Two things are being balanced. Retry too eagerly and you add load to an
 * endpoint that is already struggling, turning a brief wobble into a longer
 * outage. Retry too lazily and legitimate events arrive uselessly late.
 *
 * Exponential backoff handles the first. Jitter handles a second problem that
 * only appears at scale, and which is the more interesting of the two.
 */

export interface BackoffOptions {
  /** Delay before the first retry, before jitter. */
  baseMs: number;
  /** Ceiling on the delay, so waits don't grow to days. */
  maxMs: number;
}

/**
 * Exponential delay for a given attempt number, with **full jitter**.
 *
 * The exponential part is standard: 5s, 10s, 20s, 40s... doubling each time,
 * capped. An endpoint down for maintenance gets progressively more room.
 *
 * The jitter is the part worth understanding.
 *
 * Picture 5,000 deliveries to one endpoint that has just gone down. They all
 * fail within the same second. With pure exponential backoff every one of them
 * computes the same delay and retries at the same instant — 5,000 requests in
 * one spike. They all fail again, and now they are synchronised for the next
 * round too, and the one after. The retry pattern has become a repeating
 * thundering herd aimed at a server that is already unwell.
 *
 * Worse, this is self-reinforcing: the spike is what keeps the endpoint down,
 * so the failures keep the group in lockstep.
 *
 * Full jitter picks uniformly at random from [0, delay] instead of using the
 * delay directly. Those 5,000 retries spread evenly across the whole window,
 * and the endpoint sees a manageable trickle. It also breaks the
 * synchronisation permanently — after one jittered round the group has
 * scattered and never re-converges.
 *
 * "Full" rather than a smaller fraction because it is the variant that
 * measurably minimises both completion time and server load in AWS's
 * published analysis. It does mean a retry can happen almost immediately,
 * which is fine: the point is spreading the group, not delaying each member.
 */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  // attempt is the number of failures so far, so the first retry is attempt 1
  // and should wait roughly baseMs rather than double it.
  const exponent = Math.max(0, attempt - 1);

  // Cap the exponent before shifting. 2 ** 1024 is Infinity, and a delivery
  // that somehow reached a high attempt count would produce NaN downstream.
  const uncapped = options.baseMs * 2 ** Math.min(exponent, 30);
  const ceiling = Math.min(uncapped, options.maxMs);

  return Math.floor(random() * ceiling);
}

/** The moment a delivery becomes eligible again. */
export function nextRetryAt(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): Date {
  return new Date(Date.now() + computeBackoffMs(attempt, options, random));
}

/**
 * Whether a failed delivery should be retried at all.
 *
 * `attempt` is the count *after* incrementing for the failure just recorded.
 */
export function shouldRetry(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}

/**
 * Whether an HTTP response counts as success.
 *
 * Any 2xx. Notably 3xx does not: a redirect means the endpoint is not where
 * the customer said it was, and silently following one would let a webhook be
 * re-pointed at an address that never passed the SSRF checks.
 */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether a failure is worth retrying.
 *
 * 5xx is the retryable case: the endpoint is unwell and may recover. So are
 * 408 request timeout, 425 too early, and 429 rate limited — the last being
 * the endpoint explicitly asking us to slow down rather than to stop.
 *
 * Every other 4xx is not. A 404 or 401 means the request itself was rejected,
 * and the identical request will be rejected identically next time; retrying
 * eight times wastes both sides' resources and delays the customer discovering
 * their endpoint is misconfigured.
 *
 * 3xx is also not retryable. We do not follow redirects — doing so would
 * deliver to a URL that never passed the SSRF checks — so a redirect means the
 * endpoint is not where it was registered. That is a configuration error only
 * the customer can fix, and repeating the request cannot.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return false;
}
