import { describe, it, expect } from "vitest";
import { checkWebhookUrl } from "./url-safety.js";

/**
 * These tests are the guard against Server-Side Request Forgery.
 *
 * A webhook URL is an address our own workers will later fetch, from inside
 * our network. Every case below is a URL an attacker could register to make
 * our infrastructure reach somewhere it should not.
 */

const strict = { allowPrivate: false, requireHttps: true };
const permissive = { allowPrivate: true, requireHttps: false };

describe("checkWebhookUrl — accepts legitimate endpoints", () => {
  it.each([
    "https://example.com/webhooks",
    "https://api.customer.co.uk/hooks/relay?v=2",
    "https://sub.domain.example.com:8443/path",
    "https://93.184.216.34/hook", // a public IP is fine
  ])("accepts %s", (url) => {
    expect(checkWebhookUrl(url, strict)).toBeNull();
  });
});

describe("checkWebhookUrl — blocks cloud metadata endpoints", () => {
  it("blocks the AWS metadata IP", () => {
    /**
     * The attack this stops. On an unprotected EC2 instance this path returns
     * temporary IAM credentials for the host. Our worker would fetch them and
     * record the response as delivery history, where the customer reads it.
     */
    const result = checkWebhookUrl(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      strict,
    );
    expect(result).not.toBeNull();
  });

  it("blocks the GCP metadata hostname", () => {
    expect(
      checkWebhookUrl("https://metadata.google.internal/computeMetadata/v1/", strict),
    ).not.toBeNull();
  });
});

describe("checkWebhookUrl — blocks internal addresses", () => {
  it.each([
    ["loopback by name", "https://localhost/hook"],
    ["loopback by IP", "https://127.0.0.1/hook"],
    ["loopback, alternate form", "https://127.1.2.3/hook"],
    ["private 10.x", "https://10.0.0.5:6379/hook"],
    ["private 172.16-31.x", "https://172.20.10.1/hook"],
    ["private 192.168.x", "https://192.168.1.1/hook"],
    ["link-local", "https://169.254.1.1/hook"],
    ["this-network", "https://0.0.0.0/hook"],
    ["carrier NAT", "https://100.64.0.1/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["IPv6 unique local", "https://[fd00::1]/hook"],
    ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/hook"],
    ["internal TLD", "https://db.internal/hook"],
    ["local TLD", "https://printer.local/hook"],
    ["bare hostname", "https://intranet/hook"],
  ])("blocks %s", (_label, url) => {
    expect(checkWebhookUrl(url, strict)).not.toBeNull();
  });
});

describe("checkWebhookUrl — blocks non-HTTP schemes", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"])(
    "blocks %s",
    (url) => {
      expect(checkWebhookUrl(url, strict)).toBe("Must use http or https");
    },
  );
});

describe("checkWebhookUrl — other rejections", () => {
  it("rejects a malformed URL", () => {
    expect(checkWebhookUrl("not a url", strict)).toBe("Must be a valid absolute URL");
  });

  it("rejects a relative URL", () => {
    expect(checkWebhookUrl("/hooks/relay", strict)).toBe("Must be a valid absolute URL");
  });

  it("rejects embedded credentials", () => {
    // These would otherwise end up in our logs and delivery history.
    expect(checkWebhookUrl("https://user:pass@example.com/hook", strict)).toBe(
      "Must not contain credentials",
    );
  });

  it("rejects plain HTTP when HTTPS is required", () => {
    expect(checkWebhookUrl("http://example.com/hook", strict)).toBe("Must use https");
  });
});

describe("checkWebhookUrl — development policy", () => {
  it("allows loopback when private addresses are permitted", () => {
    // Needed for the local test receiver used by the M5 load test.
    expect(checkWebhookUrl("http://127.0.0.1:4000/hook", permissive)).toBeNull();
  });

  it("still blocks non-HTTP schemes even when permissive", () => {
    // Relaxing the address policy must not relax the scheme policy.
    expect(checkWebhookUrl("file:///etc/passwd", permissive)).not.toBeNull();
  });

  it("still blocks embedded credentials even when permissive", () => {
    expect(checkWebhookUrl("http://u:p@127.0.0.1/hook", permissive)).not.toBeNull();
  });
});
