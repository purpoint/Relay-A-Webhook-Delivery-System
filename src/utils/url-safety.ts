import { isIP } from "node:net";

/**
 * Validation for customer-supplied webhook URLs.
 *
 * This is the highest-risk input in the entire system, and the reason is worth
 * stating plainly: a webhook URL is an address our own servers will later make
 * an HTTP request to, from inside our network. That is exactly the shape of a
 * Server-Side Request Forgery (SSRF) vulnerability.
 *
 * Without checks here, a customer could register:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *       The AWS instance metadata endpoint. On an unprotected EC2 instance
 *       this returns temporary IAM credentials for the host. Our worker would
 *       fetch them and, in M5, dutifully record the response body as delivery
 *       history — where the customer can read it back.
 *
 *   http://localhost:5432  or  http://10.0.0.5:6379
 *       Internal services that are unreachable from the internet but perfectly
 *       reachable from our own worker.
 *
 *   file:///etc/passwd
 *       Not HTTP at all.
 *
 * The attacker does not need to breach anything. They sign up, paste a URL,
 * and let our infrastructure make the request for them.
 */

/** Reasons a URL was rejected, phrased for the person who typed it. */
export type UrlRejection = string;

/**
 * IPv4 ranges that must never be a delivery target.
 *
 * Each entry is [first octet, predicate on the remaining octets].
 */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;

  const [a = 0, b = 0] = parts;

  return (
    a === 0 || // 0.0.0.0/8      — "this network"
    a === 10 || // 10.0.0.0/8     — private
    a === 127 || // 127.0.0.0/8    — loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — carrier NAT
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12  — private
    (a === 192 && b === 168) || // 192.168.0.0/16 — private
    (a === 192 && b === 0) || // 192.0.0.0/24   — IETF protocol assignments
    a >= 224 // multicast and reserved
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalised = address.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    normalised === "::1" || // loopback
    normalised === "::" || // unspecified
    normalised.startsWith("fc") || // fc00::/7 unique local
    normalised.startsWith("fd") ||
    normalised.startsWith("fe80") || // link-local
    // IPv4-mapped addresses (::ffff:127.0.0.1) would otherwise slip through.
    normalised.startsWith("::ffff:")
  );
}

/**
 * Hostnames that resolve somewhere internal regardless of DNS.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal", // GCP metadata service
  "instance-data", // AWS
]);

export interface UrlCheckOptions {
  /**
   * Permit loopback and private addresses.
   *
   * Needed in development and tests, where the delivery target is a local
   * receiver on 127.0.0.1. Must be false in production — it disables the
   * entire protection above.
   */
  allowPrivate: boolean;
  /** Require HTTPS. Relaxed in development so a local receiver works. */
  requireHttps: boolean;
}

/**
 * Check a webhook URL. Returns null if acceptable, or a human-readable reason.
 *
 * IMPORTANT — this is validation at *registration* time and is not, on its
 * own, complete SSRF protection. A hostname that resolves to a public address
 * today can be repointed at 127.0.0.1 tomorrow, which is called DNS
 * rebinding. Closing that requires re-checking the resolved address at
 * delivery time, in the worker. That belongs in M4, and this comment exists so
 * the gap is recorded rather than assumed handled.
 */
export function checkWebhookUrl(
  raw: string,
  options: UrlCheckOptions,
): UrlRejection | null {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "Must be a valid absolute URL";
  }

  // Scheme. Anything other than HTTP(S) — file:, gopher:, ftp: — is either
  // meaningless as a webhook or actively an attack vector.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Must use http or https";
  }

  if (options.requireHttps && url.protocol !== "https:") {
    return "Must use https";
  }

  // Credentials embedded in the URL (https://user:pass@host) would end up in
  // our logs and delivery history.
  if (url.username || url.password) {
    return "Must not contain credentials";
  }

  const hostname = url.hostname.toLowerCase();

  if (!hostname) {
    return "Must include a hostname";
  }

  if (options.allowPrivate) {
    return null;
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return "Must not point at a loopback or internal address";
  }

  // `.internal` and `.local` are reserved for internal networks.
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return "Must not point at a loopback or internal address";
  }

  const ipVersion = isIP(hostname.replace(/^\[|\]$/g, ""));

  if (ipVersion === 4 && isPrivateIPv4(hostname)) {
    return "Must not point at a private or reserved IP address";
  }

  if (ipVersion === 6 && isPrivateIPv6(hostname)) {
    return "Must not point at a private or reserved IP address";
  }

  /**
   * A bare hostname with no dot ("http://intranet/hook") resolves through
   * internal DNS search domains and is almost never a legitimate public
   * endpoint.
   */
  if (ipVersion === 0 && !hostname.includes(".")) {
    return "Must be a fully qualified domain name";
  }

  return null;
}
