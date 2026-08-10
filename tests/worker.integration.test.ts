import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Redis } from "ioredis";
import { prisma } from "../src/config/database.js";
import { RedisWindowQueue } from "../src/queue/RedisWindowQueue.js";
import { WorkerPool } from "../src/workers/worker.js";
import { verifySignature } from "../src/workers/signature.js";
import { TestReceiver } from "./helpers/receiver.js";

/**
 * The delivery engine, end to end: a real Redis, a real Postgres and a real
 * HTTP server on the other end.
 */

const WINDOW = 100;
const PREFIX = "relayworker";

let redis: Redis;
let queue: RedisWindowQueue;
let pool: WorkerPool;
let receiver: TestReceiver;
let webhookSecret: string;

beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  queue = new RedisWindowQueue(redis, WINDOW, PREFIX);
  receiver = new TestReceiver();
  await receiver.start();

  pool = new WorkerPool(queue, {
    concurrency: 2,
    deliveryTimeoutMs: 1_000,
    maxAttempts: 3,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
  });
});

afterAll(async () => {
  await queue.clear();
  await receiver.stop();
  redis.disconnect();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await queue.clear();
  receiver.reset();
  await prisma.user.deleteMany();
});

/** Seed a QUEUED delivery sitting in the window, as the scheduler would leave it. */
async function seedQueuedDelivery(
  url = receiver.url,
  overrides: { attempt?: number } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `w${Date.now()}@example.com`, passwordHash: "x" },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Delivery" },
  });
  webhookSecret = "whsec_test_secret_for_worker_tests";
  const webhook = await prisma.webhook.create({
    data: { projectId: project.id, url, secret: webhookSecret },
  });
  const event = await prisma.event.create({
    data: {
      projectId: project.id,
      eventType: "payment.succeeded",
      payload: { amount: 4200, currency: "GBP" },
    },
  });
  const delivery = await prisma.delivery.create({
    data: {
      eventId: event.id,
      webhookId: webhook.id,
      status: "QUEUED",
      attempt: overrides.attempt ?? 0,
    },
  });

  await queue.enqueue([delivery.id]);
  // The worker claims from the ready list, so move it to in-flight the way a
  // real claim would.
  await queue.claim(1);

  return delivery.id;
}

describe("successful delivery", () => {
  it("sends the request and marks the delivery DELIVERED", async () => {
    const id = await seedQueuedDelivery();

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("delivered");
    expect(receiver.requests).toHaveLength(1);

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    expect(delivery.status).toBe("DELIVERED");
    expect(delivery.attempt).toBe(1);
    expect(delivery.responseStatus).toBe(200);
    expect(delivery.deliveredAt).not.toBeNull();
    expect(delivery.lockedAt).toBeNull();
  });

  it("releases the Redis slot", async () => {
    const id = await seedQueuedDelivery();
    expect(await queue.occupancy()).toBe(1);

    await pool.processOne(id);

    // A slot never released is a slot gone forever — enough of them and the
    // window fills with ghosts and delivery stops.
    expect(await queue.occupancy()).toBe(0);
  });

  it("records an attempt row for the delivery history", async () => {
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.responseStatus).toBe(200);
    expect(attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("treats any 2xx as success", async () => {
    receiver.behaviour = { kind: "status", status: 204 };
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    expect((await prisma.delivery.findUniqueOrThrow({ where: { id } })).status).toBe(
      "DELIVERED",
    );
  });
});

describe("the request the customer receives", () => {
  it("carries a signature the customer can verify", async () => {
    /**
     * The end-to-end proof of the signing scheme: the receiver independently
     * recomputes the HMAC over the exact bytes it received and gets a match.
     */
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    const received = receiver.requests[0]!;
    const header = received.headers["x-relay-signature"] as string;

    expect(verifySignature(webhookSecret, received.body, header)).toBe(true);
  });

  it("rejects verification if the body is altered", async () => {
    const id = await seedQueuedDelivery();
    await pool.processOne(id);

    const received = receiver.requests[0]!;
    const header = received.headers["x-relay-signature"] as string;

    expect(verifySignature(webhookSecret, `${received.body}x`, header)).toBe(false);
  });

  it("includes identifying headers", async () => {
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    const headers = receiver.requests[0]!.headers;
    expect(headers["x-relay-delivery-id"]).toBe(id);
    expect(headers["x-relay-event-id"]).toBeTruthy();
    expect(headers["x-relay-attempt"]).toBe("1");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("wraps the payload in an envelope", async () => {
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    const body = JSON.parse(receiver.requests[0]!.body);
    expect(body.type).toBe("payment.succeeded");
    expect(body.data).toEqual({ amount: 4200, currency: "GBP" });
    expect(body.id).toBeTruthy();
    expect(body.created_at).toBeTruthy();
  });
});

describe("retryable failures", () => {
  it("moves a 500 to WAITING with a future retry", async () => {
    receiver.behaviour = { kind: "status", status: 500 };
    const id = await seedQueuedDelivery();

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("retrying");

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    expect(delivery.status).toBe("WAITING");
    expect(delivery.attempt).toBe(1);
    expect(delivery.nextRetryAt).not.toBeNull();
    expect(delivery.lastError).toContain("500");
  });

  it("removes the failed delivery from Redis entirely", async () => {
    /**
     * The architectural claim, tested directly. A failed delivery does not
     * linger in the window waiting to be retried — it leaves Redis and waits
     * in Postgres. That is what keeps the window bounded during an outage.
     */
    receiver.behaviour = { kind: "status", status: 500 };
    const id = await seedQueuedDelivery();

    await pool.processOne(id);

    expect(await queue.occupancy()).toBe(0);
    const stats = await queue.stats();
    expect(stats.ready).toBe(0);
    expect(stats.inFlight).toBe(0);
  });

  it("retries a connection reset", async () => {
    receiver.behaviour = { kind: "reset" };
    const id = await seedQueuedDelivery();

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("retrying");
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("WAITING");
  });

  it("times out a hanging endpoint rather than blocking forever", async () => {
    /**
     * Without the timeout, one unresponsive endpoint would hold a worker
     * indefinitely. Enough of them and every worker in the pool is stuck, and
     * deliveries stop for every other customer — a denial of service any
     * customer could cause by accident.
     */
    receiver.behaviour = { kind: "hang" };
    const id = await seedQueuedDelivery();

    const startedAt = Date.now();
    const result = await pool.processOne(id);
    const elapsed = Date.now() - startedAt;

    expect(result.outcome).toBe("retrying");
    expect(elapsed).toBeLessThan(3_000);
    expect(await queue.occupancy()).toBe(0);
  });

  it("retries a 429, because the endpoint asked us to slow down", async () => {
    receiver.behaviour = { kind: "status", status: 429 };
    const id = await seedQueuedDelivery();

    expect((await pool.processOne(id)).outcome).toBe("retrying");
  });
});

describe("permanent failures", () => {
  it("does not retry a 404", async () => {
    // The identical request will be rejected identically. Retrying it eight
    // times wastes both sides' resources and delays the customer finding out.
    receiver.behaviour = { kind: "status", status: 404 };
    const id = await seedQueuedDelivery();

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("failed");

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.nextRetryAt).toBeNull();
  });

  it("does not follow a redirect", async () => {
    /**
     * Following redirects would defeat the SSRF guard completely: register a
     * clean public URL, have it 302 to the metadata endpoint. So a 3xx is a
     * failure, and a permanent one — the endpoint is not where it was
     * registered, and only the customer can fix that.
     */
    receiver.behaviour = { kind: "redirect", location: "http://169.254.169.254/" };
    const id = await seedQueuedDelivery();

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("failed");
    expect(receiver.requests).toHaveLength(1); // the redirect was not chased
  });

  it("gives up once attempts are exhausted", async () => {
    receiver.behaviour = { kind: "status", status: 500 };
    // maxAttempts is 3, so this next failure is the third and final one.
    const id = await seedQueuedDelivery(receiver.url, { attempt: 2 });

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("failed");

    const delivery = await prisma.delivery.findUniqueOrThrow({ where: { id } });
    expect(delivery.status).toBe("FAILED");
    expect(delivery.attempt).toBe(3);
    expect(delivery.nextRetryAt).toBeNull();
  });
});

describe("claiming", () => {
  it("skips a delivery that is not QUEUED", async () => {
    /**
     * Covers the orphan case the scheduler's claim transaction can produce: a
     * rollback after Redis already accepted the ID. The worker must discard it
     * and free the slot rather than deliver something Postgres never marked as
     * scheduled.
     */
    const id = await seedQueuedDelivery();
    await prisma.delivery.update({ where: { id }, data: { status: "PENDING" } });

    const result = await pool.processOne(id);

    expect(result.outcome).toBe("skipped");
    expect(receiver.requests).toHaveLength(0);
    expect(await queue.occupancy()).toBe(0);
  });

  it("lets only one of two concurrent workers deliver", async () => {
    /**
     * The conditional UPDATE is what prevents this, without any lock: Postgres
     * lets only one of two concurrent updates see the row as QUEUED. If both
     * proceeded, the customer would receive the same webhook twice.
     */
    const id = await seedQueuedDelivery();

    const [a, b] = await Promise.all([pool.processOne(id), pool.processOne(id)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["delivered", "skipped"]);
    expect(receiver.requests).toHaveLength(1);
  });

  it("releases the slot even when processing throws", async () => {
    // A delivery whose webhook row has vanished makes the load throw. The
    // finally block must still release, or the slot is lost permanently.
    const id = await seedQueuedDelivery();
    await prisma.webhook.deleteMany();

    await pool.processOne(id).catch(() => undefined);

    expect(await queue.occupancy()).toBe(0);
  });
});
