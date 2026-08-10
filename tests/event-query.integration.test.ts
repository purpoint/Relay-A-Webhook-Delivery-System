import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { AppInstance } from "../src/types/app.js";

/**
 * Delivery history — the read side a customer uses to answer "why didn't my
 * webhook arrive?"
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
    payload: { name: "prod" },
  });

  return { jwt, projectId: pid, apiKey: key.json().data.plaintext as string };
}

beforeEach(async () => {
  await prisma.user.deleteMany();
  ({ jwt: token, projectId, apiKey } = await setUpProject("ada@example.com"));
});

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function addWebhook(path = "/hook") {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/webhooks`,
    headers: auth(),
    payload: { url: `http://127.0.0.1:4000${path}` },
  });
  return res.json().data.id as string;
}

async function publish(eventType = "payment.succeeded") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/events",
    headers: { "x-api-key": apiKey },
    payload: { eventType, payload: { amount: 100 } },
  });
  return res.json().data.id as string;
}

describe("listing events", () => {
  it("returns events with a delivery status breakdown", async () => {
    await addWebhook("/a");
    await addWebhook("/b");
    await publish();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const { events } = res.json().data;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("payment.succeeded");
    // Two webhooks, so two PENDING deliveries.
    expect(events[0].deliveries).toEqual({ PENDING: 2 });
  });

  it("filters by event type", async () => {
    await addWebhook();
    await publish("payment.succeeded");
    await publish("order.created");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?eventType=order.created`,
      headers: auth(),
    });

    const { events } = res.json().data;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("order.created");
  });

  it("paginates with a cursor rather than an offset", async () => {
    /**
     * Keyset pagination: the cursor is the last row's id. Offset pagination
     * would make the database count and discard every skipped row, and would
     * also shift results when a new event arrives mid-paging.
     */
    await addWebhook();
    for (let i = 0; i < 5; i++) await publish();

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=2`,
      headers: auth(),
    });

    const page1 = first.json().data;
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=2&cursor=${page1.nextCursor}`,
      headers: auth(),
    });

    const page2 = second.json().data;
    expect(page2.events).toHaveLength(2);

    // No overlap between pages.
    const ids = new Set([...page1.events, ...page2.events].map((e: { id: string }) => e.id));
    expect(ids.size).toBe(4);
  });

  it("reports no further pages at the end", async () => {
    await addWebhook();
    await publish();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=25`,
      headers: auth(),
    });

    expect(res.json().data.nextCursor).toBeNull();
  });

  it("caps the page size", async () => {
    // An unbounded limit would let one request ask for the whole table.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events?limit=5000`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("delivery history", () => {
  it("shows one delivery per webhook, with attempt history", async () => {
    await addWebhook("/a");
    await addWebhook("/b");
    const eventId = await publish();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events/${eventId}/deliveries`,
      headers: auth(),
    });

    const deliveries = res.json().data;
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].status).toBe("PENDING");
    expect(deliveries[0].webhook.url).toContain("127.0.0.1:4000");
    expect(deliveries[0].attempts).toEqual([]);
  });

  it("surfaces why a delivery failed", async () => {
    /**
     * The question this whole read side exists to answer. The customer needs
     * the status code and the error, not just "it failed".
     */
    await addWebhook();
    const eventId = await publish();

    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: "WAITING",
        attempt: 2,
        lastError: "HTTP 500: internal server error",
        responseStatus: 500,
        nextRetryAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.deliveryAttempt.createMany({
      data: [
        { deliveryId: delivery.id, attempt: 1, responseStatus: 500, errorMessage: "boom", durationMs: 42 },
        { deliveryId: delivery.id, attempt: 2, responseStatus: 500, errorMessage: "boom", durationMs: 39 },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events/${eventId}/deliveries`,
      headers: auth(),
    });

    const view = res.json().data[0];
    expect(view.status).toBe("WAITING");
    expect(view.attempt).toBe(2);
    expect(view.lastError).toContain("500");
    expect(view.nextRetryAt).toBeTruthy();
    expect(view.attempts).toHaveLength(2);
    expect(view.attempts[0].durationMs).toBe(42);
  });

  it("returns 404 for an unknown event", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events/2b8f4c1e-0000-4000-8000-000000000000/deliveries`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("replay", () => {
  async function makeFailedDelivery(): Promise<string> {
    await addWebhook();
    await publish();
    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        attempt: 8,
        lastError: "HTTP 500",
        responseStatus: 500,
      },
    });
    return delivery.id;
  }

  it("returns a failed delivery to PENDING with a fresh attempt count", async () => {
    const deliveryId = await makeFailedDelivery();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/deliveries/${deliveryId}/replay`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(202);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe("PENDING");
    // Reset, so the replay gets a full set of retries rather than inheriting
    // an exhausted counter.
    expect(delivery.attempt).toBe(0);
    expect(delivery.lastError).toBeNull();
    expect(delivery.nextRetryAt).toBeNull();
  });

  it("refuses to replay a delivery that is already in flight", async () => {
    /**
     * Resetting a QUEUED or PROCESSING delivery would either send it twice or
     * strand whatever currently holds it. Refusing loudly beats a quiet
     * success that corrupts state.
     */
    await addWebhook();
    await publish();
    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "PROCESSING", lockedAt: new Date() },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/deliveries/${delivery.id}/replay`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(409);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe("PROCESSING");
  });

  it("allows replaying a delivered webhook", async () => {
    // Useful when a customer lost the original on their side.
    await addWebhook();
    await publish();
    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "DELIVERED", deliveredAt: new Date(), attempt: 1 },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/deliveries/${delivery.id}/replay`,
      headers: auth(),
    });

    expect(res.statusCode).toBe(202);
  });
});

describe("stats", () => {
  it("counts deliveries by status", async () => {
    await addWebhook("/a");
    await addWebhook("/b");
    await publish();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/stats`,
      headers: auth(),
    });

    expect(res.json().data.deliveries).toEqual({ PENDING: 2 });
  });
});

describe("tenancy and auth", () => {
  it("requires a JWT", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects an API key — history is not readable with an ingest credential", async () => {
    /**
     * The containment property. A leaked API key can publish events; it must
     * not be able to read the customer's entire event history.
     */
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { "x-api-key": apiKey },
    });

    expect(res.statusCode).toBe(401);
  });

  it("hides another user's events", async () => {
    await addWebhook();
    await publish();
    const bob = await setUpProject("bob@example.com");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/events`,
      headers: { authorization: `Bearer ${bob.jwt}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses to replay another user's delivery", async () => {
    await addWebhook();
    await publish();
    const delivery = await prisma.delivery.findFirstOrThrow();
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED" },
    });

    const bob = await setUpProject("bob@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/deliveries/${delivery.id}/replay`,
      headers: { authorization: `Bearer ${bob.jwt}` },
    });

    expect(res.statusCode).toBe(404);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe("FAILED");
  });
});
