import { describe, it, expect } from "vitest";
import {
  computeBackoffMs,
  isRetryableStatus,
  isSuccessStatus,
  shouldRetry,
} from "./backoff.js";

const OPTS = { baseMs: 5_000, maxMs: 3_600_000 };

/** Removes randomness so the exponential curve itself can be asserted. */
const alwaysMax = () => 0.999_999;
const alwaysMin = () => 0;

describe("computeBackoffMs — the exponential curve", () => {
  it("doubles the ceiling with each attempt", () => {
    expect(computeBackoffMs(1, OPTS, alwaysMax)).toBeCloseTo(5_000, -2);
    expect(computeBackoffMs(2, OPTS, alwaysMax)).toBeCloseTo(10_000, -2);
    expect(computeBackoffMs(3, OPTS, alwaysMax)).toBeCloseTo(20_000, -2);
    expect(computeBackoffMs(4, OPTS, alwaysMax)).toBeCloseTo(40_000, -2);
  });

  it("waits roughly the base delay on the first retry, not double", () => {
    expect(computeBackoffMs(1, OPTS, alwaysMax)).toBeLessThan(5_001);
  });

  it("never exceeds the ceiling", () => {
    for (const attempt of [10, 20, 50, 100]) {
      expect(computeBackoffMs(attempt, OPTS, alwaysMax)).toBeLessThanOrEqual(OPTS.maxMs);
    }
  });

  it("stays finite at absurd attempt counts", () => {
    // 2 ** 1024 is Infinity, which would produce NaN downstream and a row
    // with an invalid nextRetryAt that no query would ever match.
    const result = computeBackoffMs(5000, OPTS, alwaysMax);

    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeLessThanOrEqual(OPTS.maxMs);
  });
});

describe("computeBackoffMs — full jitter", () => {
  it("returns zero at the bottom of the range", () => {
    expect(computeBackoffMs(3, OPTS, alwaysMin)).toBe(0);
  });

  it("spreads a synchronised group across the window", () => {
    /**
     * The property jitter exists for.
     *
     * Five thousand deliveries to one endpoint fail in the same second. With
     * pure exponential backoff every one computes the same delay and retries
     * at the same instant — a thundering herd aimed at a server already
     * struggling, which then keeps them synchronised for the next round too.
     *
     * With full jitter they scatter across the whole window.
     */
    const delays = Array.from({ length: 5000 }, () => computeBackoffMs(3, OPTS));

    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(4000);

    // And they genuinely cover the range rather than clustering.
    const ceiling = 20_000;
    const buckets = [0, 0, 0, 0];
    for (const d of delays) {
      buckets[Math.min(3, Math.floor((d / ceiling) * 4))]! += 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(5000 / 4 / 2);
    }
  });

  it("always stays within [0, ceiling]", () => {
    for (let i = 0; i < 1000; i++) {
      const d = computeBackoffMs(4, OPTS);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(40_000);
    }
  });
});

describe("shouldRetry", () => {
  it("allows retries below the limit", () => {
    expect(shouldRetry(1, 8)).toBe(true);
    expect(shouldRetry(7, 8)).toBe(true);
  });

  it("stops at the limit", () => {
    expect(shouldRetry(8, 8)).toBe(false);
    expect(shouldRetry(9, 8)).toBe(false);
  });
});

describe("isSuccessStatus", () => {
  it.each([200, 201, 202, 204, 299])("treats %i as success", (status) => {
    expect(isSuccessStatus(status)).toBe(true);
  });

  it.each([100, 301, 302, 400, 404, 500, 503])("treats %i as failure", (status) => {
    expect(isSuccessStatus(status)).toBe(false);
  });
});

describe("isRetryableStatus", () => {
  it.each([500, 502, 503, 504])("retries %i — the endpoint may recover", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([
    [408, "request timeout"],
    [425, "too early"],
    [429, "rate limited — the endpoint asked us to slow down, not stop"],
  ])("retries %i (%s)", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 422])(
    "does not retry %i — the identical request will be rejected identically",
    (status) => {
      expect(isRetryableStatus(status)).toBe(false);
    },
  );

  it.each([301, 302, 307, 308])(
    "does not retry %i — we do not follow redirects, so this is a misconfiguration",
    (status) => {
      // Following a redirect would deliver to a URL that never passed the
      // SSRF checks, so a 3xx means the endpoint is not where it was
      // registered. Only the customer can fix that; repeating cannot.
      expect(isRetryableStatus(status)).toBe(false);
    },
  );
});
