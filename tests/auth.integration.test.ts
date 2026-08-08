import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * End-to-end tests for registration, login and tenancy.
 *
 * These drive the real app against the real database via `app.inject()`, which
 * runs a request through the entire stack — hooks, validation, error handler —
 * without binding a port.
 *
 * The tenancy tests matter most. A bug there doesn't crash anything; it
 * quietly serves one customer's data to another, and the only thing standing
 * between us and that is a check somebody has to remember to write.
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
  // Users cascade to projects and API keys, so this clears everything.
  await prisma.user.deleteMany();
});

async function registerUser(email: string, password = "correct-horse-battery") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password },
  });
  return res;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("POST /api/v1/auth/register", () => {
  it("creates a user and returns a token", async () => {
    const res = await registerUser("ada@example.com");

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.email).toBe("ada@example.com");
    expect(typeof body.data.token).toBe("string");
  });

  it("never returns the password hash", async () => {
    const res = await registerUser("ada@example.com");

    // Checking the serialised body, not just the parsed object — a leak could
    // hide in a nested field this assertion would otherwise walk past.
    expect(res.body).not.toContain("passwordHash");
    expect(res.body).not.toContain("$argon2");
  });

  it("normalises email to lowercase", async () => {
    const res = await registerUser("ADA@Example.COM");

    expect(res.json().data.user.email).toBe("ada@example.com");
  });

  it("rejects a duplicate email", async () => {
    await registerUser("ada@example.com");
    const res = await registerUser("ada@example.com");

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("rejects a short password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "ada@example.com", password: "short" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "not-an-email", password: "correct-horse-battery" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/auth/login", () => {
  beforeEach(async () => {
    await registerUser("ada@example.com");
  });

  it("returns a token for correct credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "correct-horse-battery" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.token).toBe("string");
  });

  it("rejects a wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "wrong-password-here" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("gives an identical response for unknown email and wrong password", async () => {
    // If these differed, the endpoint would reveal which addresses have
    // accounts — an account enumeration oracle.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "correct-horse-battery" },
    });

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "ada@example.com", password: "wrong-password-here" },
    });

    expect(unknown.statusCode).toBe(wrongPassword.statusCode);
    expect(unknown.json().error.message).toBe(wrongPassword.json().error.message);
  });
});

describe("project routes require authentication", () => {
  it("rejects a request with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects" });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a garbage token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: bearer("not.a.jwt"),
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("tenancy isolation", () => {
  let adaToken: string;
  let bobToken: string;
  let adaProjectId: string;

  beforeEach(async () => {
    adaToken = (await registerUser("ada@example.com")).json().data.token;
    bobToken = (await registerUser("bob@example.com")).json().data.token;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: bearer(adaToken),
      payload: { name: "Ada's project" },
    });
    adaProjectId = created.json().data.id;
  });

  it("lists only your own projects", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: bearer(bobToken),
    });

    expect(res.json().data).toHaveLength(0);
  });

  it("returns 404, not 403, for someone else's project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${adaProjectId}`,
      headers: bearer(bobToken),
    });

    // 403 would confirm the project exists, which is itself a disclosure.
    expect(res.statusCode).toBe(404);
  });

  it("refuses to mint an API key inside someone else's project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${adaProjectId}/api-keys`,
      headers: bearer(bobToken),
      payload: { name: "stolen" },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("API keys", () => {
  let token: string;
  let projectId: string;

  beforeEach(async () => {
    token = (await registerUser("ada@example.com")).json().data.token;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: bearer(token),
      payload: { name: "Ada's project" },
    });
    projectId = created.json().data.id;
  });

  it("returns the plaintext key exactly once, at creation", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: bearer(token),
      payload: { name: "production" },
    });

    expect(created.statusCode).toBe(201);
    const plaintext = created.json().data.plaintext;
    expect(plaintext).toMatch(/^rlk_live_/);

    // Listing keys afterwards must never expose it again.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: bearer(token),
    });

    expect(listed.body).not.toContain(plaintext);
    expect(listed.json().data[0].prefix).toBe(plaintext.slice(0, 15));
  });

  it("stores a hash, never the key itself", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: bearer(token),
      payload: { name: "production" },
    });
    const plaintext = created.json().data.plaintext;

    const stored = await prisma.apiKey.findFirstOrThrow({ where: { projectId } });

    expect(stored.hashedKey).not.toBe(plaintext);
    expect(stored.hashedKey).toHaveLength(64); // SHA-256, hex
  });

  it("marks a revoked key as revoked", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: bearer(token),
      payload: { name: "production" },
    });
    const keyId = created.json().data.id;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/api-keys/${keyId}`,
      headers: bearer(token),
    });

    expect(revoked.statusCode).toBe(200);

    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(stored.revokedAt).not.toBeNull();
  });
});
