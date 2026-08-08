import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * Webhook registration and management.
 *
 * Two themes here. The first is ordinary CRUD behaviour. The second, and the
 * one that matters, is that webhook URLs are validated on every path that can
 * set them — because a URL that is only checked on creation can be registered
 * as something harmless and then edited into an attack.
 */

let app: AppInstance;
let token: string;
let projectId: string;

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

  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "ada@example.com", password: "correct-horse-battery" },
  });
  token = registered.json().data.token;

  const project = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Ada's project" },
  });
  projectId = project.json().data.id;
});

function auth() {
  return { authorization: `Bearer ${token}` };
}

function createWebhook(url: string, description?: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/webhooks`,
    headers: auth(),
    payload: description === undefined ? { url } : { url, description },
  });
}

describe("registering a webhook", () => {
  it("creates one and returns a signing secret", async () => {
    const res = await createWebhook("http://127.0.0.1:4000/hook", "local receiver");

    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.url).toBe("http://127.0.0.1:4000/hook");
    expect(body.isActive).toBe(true);

    // Unlike an API key, the secret is deliberately returned: the customer
    // needs it to verify the HMAC signature on every request we send them.
    expect(body.secret).toMatch(/^whsec_/);
  });

  it("gives each webhook a distinct secret", async () => {
    const a = await createWebhook("http://127.0.0.1:4000/a");
    const b = await createWebhook("http://127.0.0.1:4000/b");

    expect(a.json().data.secret).not.toBe(b.json().data.secret);
  });

  it("rejects a malformed URL", async () => {
    const res = await createWebhook("not-a-url");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-HTTP scheme even when private addresses are allowed", async () => {
    // Tests run with allowPrivate on, for the local receiver. Relaxing the
    // address policy must not relax the scheme policy.
    const res = await createWebhook("file:///etc/passwd");

    expect(res.statusCode).toBe(400);
  });

  it("rejects credentials embedded in the URL", async () => {
    const res = await createWebhook("http://user:pass@127.0.0.1:4000/hook");

    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/webhooks`,
      payload: { url: "http://127.0.0.1:4000/hook" },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("listing and fetching", () => {
  it("lists webhooks for the project", async () => {
    await createWebhook("http://127.0.0.1:4000/a");
    await createWebhook("http://127.0.0.1:4000/b");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: auth(),
    });

    expect(res.json().data).toHaveLength(2);
  });

  it("returns 404 for a webhook that does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks/2b8f4c1e-0000-4000-8000-000000000000`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("updating", () => {
  it("changes the URL", async () => {
    const created = await createWebhook("http://127.0.0.1:4000/old");
    const id = created.json().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
      payload: { url: "http://127.0.0.1:4000/new" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe("http://127.0.0.1:4000/new");
  });

  it("can deactivate a webhook", async () => {
    const created = await createWebhook("http://127.0.0.1:4000/hook");
    const id = created.json().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
      payload: { isActive: false },
    });

    expect(res.json().data.isActive).toBe(false);
  });

  it("validates the URL on update, not only on create", async () => {
    /**
     * The attack this closes: register a harmless public URL to pass the
     * initial check, then edit it to something internal. Validation has to
     * live on every path that can set the field.
     */
    const created = await createWebhook("http://127.0.0.1:4000/hook");
    const id = created.json().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
      payload: { url: "file:///etc/passwd" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty update", async () => {
    const created = await createWebhook("http://127.0.0.1:4000/hook");
    const id = created.json().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("deleting", () => {
  it("removes the webhook", async () => {
    const created = await createWebhook("http://127.0.0.1:4000/hook");
    const id = created.json().data.id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: auth(),
    });
    expect(after.statusCode).toBe(404);
  });
});

describe("tenancy isolation", () => {
  let bobToken: string;

  beforeEach(async () => {
    const bob = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "bob@example.com", password: "correct-horse-battery" },
    });
    bobToken = bob.json().data.token;
  });

  it("hides another user's webhooks", async () => {
    await createWebhook("http://127.0.0.1:4000/hook");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/webhooks`,
      headers: { authorization: `Bearer ${bobToken}` },
    });

    // 404 on the project, not an empty list — Bob should not learn the
    // project exists at all.
    expect(res.statusCode).toBe(404);
  });

  it("refuses to repoint another user's webhook", async () => {
    /**
     * The worst case in this file. If this failed, an attacker could redirect
     * a customer's entire event stream to a server they control, and the
     * customer would see nothing wrong.
     */
    const created = await createWebhook("http://127.0.0.1:4000/hook");
    const id = created.json().data.id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${id}`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { url: "http://127.0.0.1:9999/attacker" },
    });

    expect(res.statusCode).toBe(404);

    const stored = await prisma.webhook.findUniqueOrThrow({ where: { id } });
    expect(stored.url).toBe("http://127.0.0.1:4000/hook");
  });
});
