import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "./signature.js";

const SECRET = "whsec_test_secret_value_for_signing";
const BODY = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { amount: 100 } });

describe("signPayload", () => {
  it("produces a versioned header", () => {
    const signed = signPayload(SECRET, BODY, 1_700_000_000);

    expect(signed.header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    // Unlike a password hash, this must be reproducible — the receiver has to
    // arrive at the identical value independently.
    const a = signPayload(SECRET, BODY, 1_700_000_000);
    const b = signPayload(SECRET, BODY, 1_700_000_000);

    expect(a.signature).toBe(b.signature);
  });

  it("changes when the body changes", () => {
    const a = signPayload(SECRET, BODY, 1_700_000_000);
    const b = signPayload(SECRET, `${BODY} `, 1_700_000_000);

    expect(a.signature).not.toBe(b.signature);
  });

  it("changes when the timestamp changes", () => {
    // The timestamp being *inside* the signature is what stops replay.
    const a = signPayload(SECRET, BODY, 1_700_000_000);
    const b = signPayload(SECRET, BODY, 1_700_000_001);

    expect(a.signature).not.toBe(b.signature);
  });

  it("changes when the secret changes", () => {
    const a = signPayload(SECRET, BODY, 1_700_000_000);
    const b = signPayload("whsec_a_different_secret_value_xx", BODY, 1_700_000_000);

    expect(a.signature).not.toBe(b.signature);
  });

  it("separates timestamp from body so they cannot be confused", () => {
    /**
     * Without a delimiter, timestamp 12 with body "34x" and timestamp 1 with
     * body "234x" would hash identical input. The dot prevents that.
     */
    const a = signPayload(SECRET, "34x", 12);
    const b = signPayload(SECRET, "234x", 1);

    expect(a.signature).not.toBe(b.signature);
  });
});

describe("verifySignature", () => {
  const NOW = 1_700_000_000;

  it("accepts a signature we just produced", () => {
    const signed = signPayload(SECRET, BODY, NOW);

    expect(verifySignature(SECRET, BODY, signed.header, 300, NOW)).toBe(true);
  });

  it("rejects a tampered body", () => {
    // The whole point: the receiver detects that the payload was altered.
    const signed = signPayload(SECRET, BODY, NOW);
    const tampered = JSON.stringify({ id: "evt_1", data: { amount: 999999 } });

    expect(verifySignature(SECRET, tampered, signed.header, 300, NOW)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const signed = signPayload(SECRET, BODY, NOW);

    expect(verifySignature("whsec_wrong_secret_value_here_x", BODY, signed.header, 300, NOW)).toBe(
      false,
    );
  });

  it("rejects a replayed request outside the tolerance window", () => {
    // Captured ten minutes ago, replayed now.
    const signed = signPayload(SECRET, BODY, NOW - 600);

    expect(verifySignature(SECRET, BODY, signed.header, 300, NOW)).toBe(false);
  });

  it("accepts a request inside the tolerance window", () => {
    // Clock skew between us and the receiver is normal and must not reject.
    const signed = signPayload(SECRET, BODY, NOW - 60);

    expect(verifySignature(SECRET, BODY, signed.header, 300, NOW)).toBe(true);
  });

  it("rejects a timestamp too far in the future", () => {
    /**
     * Bounding only the past would let a captured request stamped years ahead
     * remain valid indefinitely.
     */
    const signed = signPayload(SECRET, BODY, NOW + 600);

    expect(verifySignature(SECRET, BODY, signed.header, 300, NOW)).toBe(false);
  });

  it("rejects an attacker rewriting the timestamp to look fresh", () => {
    /**
     * The replay attempt this design defeats. The attacker has a valid old
     * request and edits the timestamp to a current one — but the timestamp is
     * part of the signed string, so the signature no longer matches.
     */
    const old = signPayload(SECRET, BODY, NOW - 6000);
    const forged = `t=${NOW},v1=${old.signature}`;

    expect(verifySignature(SECRET, BODY, forged, 300, NOW)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["missing v1", "t=1700000000"],
    ["missing timestamp", "v1=abc123"],
    ["non-numeric timestamp", "t=banana,v1=abc123"],
    ["nonsense", "not-a-header"],
  ])("rejects a malformed header (%s)", (_label, header) => {
    expect(verifySignature(SECRET, BODY, header, 300, NOW)).toBe(false);
  });
});
