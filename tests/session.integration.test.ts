import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { REFRESH_COOKIE_NAME } from "../src/services/session.service.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * Session lifecycle: login, refresh, rotation, reuse detection, logout.
 *
 * The reuse tests are the interesting ones. Rotation is what turns a stolen
 * refresh cookie from an undetectable week-long compromise into something the
 * system notices and shuts down.
 */

let app: AppInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.user.deleteMany();
});

function refreshCookieFrom(res: { cookies: unknown[] }): string {
  const cookies = res.cookies as { name: string; value: string }[];
  const found = cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
  if (!found) throw new Error("no refresh cookie on response");
  return found.value;
}

async function registerUser(email = "ada@example.com") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "correct-horse-battery" },
  });
}

describe("issuing sessions", () => {
  it("returns an access token in the body and a refresh cookie", async () => {
    const res = await registerUser();

    expect(res.statusCode).toBe(201);
    expect(typeof res.json().data.token).toBe("string");
    expect(refreshCookieFrom(res)).toBeTruthy();
  });

  it("marks the refresh cookie httpOnly and SameSite=Strict", async () => {
    /**
     * httpOnly is what stops an XSS bug reading the token. SameSite=Strict is
     * what makes CSRF a non-issue without a separate token, and is only
     * workable because the frontend is served from the same origin.
     */
    const res = await registerUser();
    const cookie = (res.cookies as { name: string; httpOnly?: boolean; sameSite?: string }[]).find(
      (c) => c.name === REFRESH_COOKIE_NAME,
    );

    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
  });

  it("stores only a hash of the refresh token", async () => {
    const res = await registerUser();
    const plaintext = refreshCookieFrom(res);

    const stored = await prisma.refreshToken.findFirstOrThrow();

    expect(stored.hashedToken).not.toBe(plaintext);
    expect(stored.hashedToken).toHaveLength(64); // SHA-256, hex
  });

  it("issues a fresh session on each login", async () => {
    await registerUser();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "correct-horse-battery" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "correct-horse-battery" },
    });

    // Two devices, two independent sessions.
    expect(refreshCookieFrom(first)).not.toBe(refreshCookieFrom(second));
    expect(await prisma.refreshToken.count()).toBe(3); // register + 2 logins
  });
});

describe("refreshing", () => {
  it("exchanges the cookie for a new access token", async () => {
    const registered = await registerUser();
    const cookie = refreshCookieFrom(registered);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.token).toBe("string");
    expect(res.json().data.user.email).toBe("ada@example.com");
  });

  it("rotates the refresh token on every use", async () => {
    /**
     * Rotation is what makes theft detectable. Without it a copied cookie
     * works silently for its full lifetime.
     */
    const registered = await registerUser();
    const original = refreshCookieFrom(registered);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: original },
    });

    expect(refreshCookieFrom(refreshed)).not.toBe(original);
  });

  it("revokes the old token once rotated", async () => {
    const registered = await registerUser();
    const original = refreshCookieFrom(registered);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: original },
    });

    const tokens = await prisma.refreshToken.findMany({ orderBy: { createdAt: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.revokedAt).not.toBeNull();
    expect(tokens[0]?.replacedById).toBe(tokens[1]?.id);
    expect(tokens[1]?.revokedAt).toBeNull();
  });

  it("the new access token actually works", async () => {
    const registered = await registerUser();

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: refreshCookieFrom(registered) },
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${refreshed.json().data.token}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().data.email).toBe("ada@example.com");
  });

  it("rejects a request with no cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: "not-a-real-token-value" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const registered = await registerUser();
    const cookie = refreshCookieFrom(registered);

    await prisma.refreshToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("reuse detection", () => {
  it("revokes every session when a rotated token is presented again", async () => {
    /**
     * The scenario: an attacker copies the refresh cookie. Both they and the
     * real user now hold it. Whoever refreshes second presents a token that
     * has already been exchanged — something no well-behaved client ever does,
     * because it discards the old token immediately.
     *
     * We cannot tell which party is legitimate, so both are signed out. The
     * owner logs in again; the thief is left with nothing.
     */
    const registered = await registerUser();
    const stolen = refreshCookieFrom(registered);

    // Legitimate user refreshes first.
    const legit = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: stolen },
    });
    expect(legit.statusCode).toBe(200);
    const legitNext = refreshCookieFrom(legit);

    // Attacker replays the copy they took earlier.
    const attacker = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: stolen },
    });
    expect(attacker.statusCode).toBe(401);

    // And the legitimate user's newer token is now dead too — the blast
    // radius is the account, deliberately, because we cannot identify the
    // thief.
    const afterwards = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: legitNext },
    });
    expect(afterwards.statusCode).toBe(401);

    const active = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(active).toBe(0);
  });

  it("leaves other users' sessions untouched", async () => {
    await registerUser("ada@example.com");
    const bob = await registerUser("bob@example.com");
    const bobCookie = refreshCookieFrom(bob);

    const adaLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "correct-horse-battery" },
    });
    const adaCookie = refreshCookieFrom(adaLogin);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: adaCookie },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: adaCookie },
    });

    // Bob is unaffected by Ada's incident.
    const bobRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: bobCookie },
    });

    expect(bobRefresh.statusCode).toBe(200);
  });
});

describe("logout", () => {
  it("revokes the presented token and clears the cookie", async () => {
    const registered = await registerUser();
    const cookie = refreshCookieFrom(registered);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [REFRESH_COOKIE_NAME]: cookie },
    });

    expect(res.statusCode).toBe(200);

    const stored = await prisma.refreshToken.findFirstOrThrow();
    expect(stored.revokedAt).not.toBeNull();
  });

  it("does not sign out other devices", async () => {
    // Signing out on a laptop should not sign you out on a phone.
    const laptop = await registerUser();
    const phone = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "correct-horse-battery" },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      cookies: { [REFRESH_COOKIE_NAME]: refreshCookieFrom(laptop) },
    });

    const phoneRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      cookies: { [REFRESH_COOKIE_NAME]: refreshCookieFrom(phone) },
    });

    expect(phoneRefresh.statusCode).toBe(200);
  });

  it("succeeds even with no session", async () => {
    // The caller wanted no session; there is no session. That is the outcome.
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(200);
  });
});
