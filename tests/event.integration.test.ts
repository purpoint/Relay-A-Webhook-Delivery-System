import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * Event ingest — the write path.
 *
 * Three properties matter here and each has an attack or failure mode behind
 * it: the project is decided by the credential and not the body; the event and
 * its deliveries are written atomically; and a retried publish does not
 * duplicate the event.
 */

let app: AppInstance;
let token: string;
let projectId: string;
let apiKey: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function setUpProject(email: string) {
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "correct-horse-battery" },
  });
  const jwt = registered.json().data.token;

  const project = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: `${email} project` },
  });
  const pid = project.json().data.id;

  const key = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/api-keys`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: "production" },
  });

  return { jwt, projectId: pid, apiKey: key.json().data.plaintext as string };
}

beforeEach(async () => {
  await prisma.user.deleteMany();
  ({ jwt: token, projectId, apiKey } = await setUpProject("ada@example.com"));
});

function addWebhook(path: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { url: `http://127.0.0.1:4000${path}` },
  });
}

function publish(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/events",
    headers: { "x-api-key": apiKey, ...headers },
    payload: body as Record<string, unknown>,
  });
}

describe("authentication", () => {
  it("rejects a request with no API key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: { eventType: "payment.succeeded", payload: {} },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown API key", async () => {
    const res = await publish(
      { eventType: "payment.succeeded", payload: {} },
      { "x-api-key": "rlk_live_totallymadeupkeyvalue" },
    );

    expect(res.statusCode).toBe(401);
  });

  it("rejects a JWT — this route takes API keys only", async () => {
    // The two credential types are not interchangeable. A dashboard token
    // must not be usable for ingest, nor an API key for management.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: { eventType: "payment.succeeded", payload: {} },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked API key", async () => {
    const keys = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/api-keys`,
      headers: { authorization: `Bearer ${token}` },
    });
    const keyId = keys.json().data[0].id;

    await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await publish({ eventType: "payment.succeeded", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe("publishing", () => {
  it("returns 202 Accepted, not 201", async () => {
    const res = await publish({ eventType: "payment.succeeded", payload: { amount: 100 } });

    // 201 would claim the work is done. All that has happened is durable
    // storage; delivery occurs later in a different process.
    expect(res.statusCode).toBe(202);
    expect(res.json().data.deduplicated).toBe(false);
  });

  it("stores the event with its payload intact", async () => {
    await publish({
      eventType: "payment.succeeded",
      payload: { amount: 100, currency: "GBP", nested: { id: 7 } },
    });

    const event = await prisma.event.findFirstOrThrow({ where: { projectId } });
    expect(event.eventType).toBe("payment.succeeded");
    expect(event.payload).toEqual({ amount: 100, currency: "GBP", nested: { id: 7 } });
  });

  it("stores the event even when the project has no webhooks", async () => {
    // The event is a fact that happened. Having nowhere to send it does not
    // make it untrue, and a webhook added later can replay it.
    const res = await publish({ eventType: "payment.succeeded", payload: {} });

    expect(res.statusCode).toBe(202);
    expect(res.json().data.deliveryCount).toBe(0);
    expect(await prisma.event.count({ where: { projectId } })).toBe(1);
  });
});

describe("fan-out", () => {
  it("creates one delivery per active webhook", async () => {
    await addWebhook("/a");
    await addWebhook("/b");
    await addWebhook("/c");

    const res = await publish({ eventType: "payment.succeeded", payload: {} });

    expect(res.json().data.deliveryCount).toBe(3);
    expect(await prisma.delivery.count()).toBe(3);
  });

  it("skips inactive webhooks", async () => {
    await addWebhook("/a");
    const inactive = await addWebhook("/b");

    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/webhooks/${inactive.json().data.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isActive: false },
    });

    const res = await publish({ eventType: "payment.succeeded", payload: {} });

    expect(res.json().data.deliveryCount).toBe(1);
  });

  it("starts every delivery in PENDING with no retry scheduled", async () => {
    await addWebhook("/a");
    await publish({ eventType: "payment.succeeded", payload: {} });

    const delivery = await prisma.delivery.findFirstOrThrow();
    expect(delivery.status).toBe("PENDING");
    expect(delivery.attempt).toBe(0);
    expect(delivery.nextRetryAt).toBeNull();
    expect(delivery.lockedAt).toBeNull();
  });

  it("writes the event and its deliveries atomically", async () => {
    /**
     * The invariant the transaction exists to protect. An event with no
     * delivery rows would look accepted, never be picked up by the scheduler,
     * and never be sent — silently, after the customer received a 202.
     */
    await addWebhook("/a");
    await addWebhook("/b");
    await publish({ eventType: "payment.succeeded", payload: {} });

    const events = await prisma.event.findMany({ include: { deliveries: true } });
    expect(events).toHaveLength(1);
    expect(events[0]?.deliveries).toHaveLength(2);
  });

  it("does not fan out to another project's webhooks", async () => {
    await addWebhook("/mine");
    const bob = await setUpProject("bob@example.com");

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${bob.projectId}/webhooks`,
      headers: { authorization: `Bearer ${bob.jwt}` },
      payload: { url: "http://127.0.0.1:4000/bob" },
    });

    const res = await publish({ eventType: "payment.succeeded", payload: {} });

    expect(res.json().data.deliveryCount).toBe(1);
  });
});

describe("project is taken from the credential", () => {
  it("ignores a projectId supplied in the body", async () => {
    /**
     * The most important test in this file. If the body could name a project,
     * any valid API key would be able to publish into every other customer's
     * project.
     */
    const bob = await setUpProject("bob@example.com");

    await publish({
      eventType: "payment.succeeded",
      payload: {},
      projectId: bob.projectId,
    });

    // The event belongs to Ada's project, whose key was used — not Bob's.
    expect(await prisma.event.count({ where: { projectId } })).toBe(1);
    expect(await prisma.event.count({ where: { projectId: bob.projectId } })).toBe(0);
  });
});

describe("idempotency", () => {
  it("returns the same event for a repeated Idempotency-Key", async () => {
    await addWebhook("/a");

    const first = await publish(
      { eventType: "payment.succeeded", payload: { amount: 1 } },
      { "idempotency-key": "order-42" },
    );
    const second = await publish(
      { eventType: "payment.succeeded", payload: { amount: 1 } },
      { "idempotency-key": "order-42" },
    );

    expect(first.json().data.id).toBe(second.json().data.id);
    expect(first.json().data.deduplicated).toBe(false);
    expect(second.json().data.deduplicated).toBe(true);

    // Crucially, no second set of deliveries — the customer is not charged twice.
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.delivery.count()).toBe(1);
  });

  it("treats the key as unique per project, not globally", async () => {
    // Two customers independently choosing "order-1" must not collide.
    const bob = await setUpProject("bob@example.com");

    await publish(
      { eventType: "payment.succeeded", payload: {} },
      { "idempotency-key": "order-1" },
    );

    const bobRes = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      headers: { "x-api-key": bob.apiKey, "idempotency-key": "order-1" },
      payload: { eventType: "payment.succeeded", payload: {} },
    });

    expect(bobRes.statusCode).toBe(202);
    expect(bobRes.json().data.deduplicated).toBe(false);
    expect(await prisma.event.count()).toBe(2);
  });

  it("creates separate events without a key", async () => {
    await publish({ eventType: "payment.succeeded", payload: {} });
    await publish({ eventType: "payment.succeeded", payload: {} });

    expect(await prisma.event.count()).toBe(2);
  });

  it("resolves concurrent duplicates to a single event", async () => {
    /**
     * Two requests with the same key can both pass the existence check before
     * either inserts. The unique constraint is what actually enforces
     * uniqueness; the service catches the violation and returns the winner.
     */
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        publish(
          { eventType: "payment.succeeded", payload: {} },
          { "idempotency-key": "race-1" },
        ),
      ),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(202);
    }

    const ids = new Set(results.map((r) => r.json().data.id));
    expect(ids.size).toBe(1);
    expect(await prisma.event.count()).toBe(1);
  });
});

describe("validation", () => {
  it("rejects a missing eventType", async () => {
    const res = await publish({ payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an eventType with unsafe characters", async () => {
    const res = await publish({ eventType: "payment succeeded!", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-object payload", async () => {
    const res = await publish({ eventType: "payment.succeeded", payload: "a string" });
    expect(res.statusCode).toBe(400);
  });

  it("accepts an empty object payload", async () => {
    const res = await publish({ eventType: "ping", payload: {} });
    expect(res.statusCode).toBe(202);
  });
});
