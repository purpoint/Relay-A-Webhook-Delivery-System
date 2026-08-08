import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * Rate limiting is switched off for the other suites so their results don't
 * depend on execution order. This one builds an app with it explicitly on, so
 * the protection stays covered rather than merely disabled.
 */

let app: AppInstance;

beforeAll(async () => {
  app = await buildApp({ rateLimit: true });
  await app.ready();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("rate limiting", () => {
  it("throttles repeated login attempts", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@example.com", password: "whatever-password" },
      });

    const statuses: number[] = [];
    // The auth limit is 10/minute; 15 attempts must run into it.
    for (let i = 0; i < 15; i++) {
      statuses.push((await attempt()).statusCode);
    }

    expect(statuses).toContain(429);

    // Credential stuffing is the attack this blocks: replaying millions of
    // leaked email/password pairs. It also protects our own CPU, since every
    // attempt costs an Argon2 hash.
    const throttled = statuses.filter((s) => s === 429).length;
    expect(throttled).toBeGreaterThanOrEqual(5);
  });

  it("returns the standard error envelope when throttled", async () => {
    let last;
    for (let i = 0; i < 15; i++) {
      last = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "nobody@example.com", password: "whatever-password" },
      });
    }

    expect(last?.statusCode).toBe(429);

    // Even the rate limiter's rejection goes through our error handler, so
    // clients get one shape to parse rather than a special case.
    const body = last?.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toBeNull();
    expect(body.timestamp).toBeTruthy();
  });
});
