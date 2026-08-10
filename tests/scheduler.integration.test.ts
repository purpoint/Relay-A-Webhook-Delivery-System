import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Redis } from "ioredis";
import { prisma } from "../src/config/database.js";
import { RedisWindowQueue } from "../src/queue/RedisWindowQueue.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

/**
 * The scheduler, against a real Postgres and a real Redis.
 *
 * The claim under test is the one the whole project rests on: however large
 * the backlog in Postgres, Redis holds no more than the configured window.
 */

const WINDOW = 50;
const PREFIX = "relaysched";
const LEASE_MS = 60_000;

let redis: Redis;
let queue: RedisWindowQueue;
let scheduler: Scheduler;
let projectId: string;
let webhookId: string;

beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  queue = new RedisWindowQueue(redis, WINDOW, PREFIX);
  scheduler = new Scheduler(queue, {
    windowSize: WINDOW,
    pollIntervalMs: 50,
    leaseTimeoutMs: LEASE_MS,
    batchSize: 20,
  });
});

afterAll(async () => {
  await queue.clear();
  await redis.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await queue.clear();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { email: "sched@example.com", passwordHash: "x" },
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Scheduling" },
  });
  const webhook = await prisma.webhook.create({
    data: { projectId: project.id, url: "http://127.0.0.1:4000/hook", secret: "whsec_x" },
  });

  projectId = project.id;
  webhookId = webhook.id;
});

/** Create `count` deliveries in the given state, bypassing the API. */
async function seedDeliveries(
  count: number,
  overrides: Partial<{
    status: "PENDING" | "WAITING" | "PROCESSING" | "QUEUED";
    nextRetryAt: Date | null;
    lockedAt: Date | null;
  }> = {},
): Promise<void> {
  const event = await prisma.event.create({
    data: { projectId, eventType: "load.test", payload: {} },
  });

  await prisma.delivery.createMany({
    data: Array.from({ length: count }, () => ({
      eventId: event.id,
      webhookId,
      status: overrides.status ?? "PENDING",
      nextRetryAt: overrides.nextRetryAt ?? null,
      lockedAt: overrides.lockedAt ?? null,
    })),
  });
}

describe("the bounded window", () => {
  it("fills the window and stops there", async () => {
    await seedDeliveries(200);

    const result = await scheduler.tick();

    expect(result.enqueued).toBe(WINDOW);
    expect(await queue.occupancy()).toBe(WINDOW);
  });

  it("leaves the rest of the backlog in Postgres", async () => {
    /**
     * The whole thesis, in one assertion. Two hundred deliveries exist; fifty
     * are resident in Redis; the other hundred and fifty wait on disk costing
     * nothing.
     */
    await seedDeliveries(200);

    await scheduler.tick();

    expect(await queue.occupancy()).toBe(WINDOW);
    expect(await prisma.delivery.count({ where: { status: "PENDING" } })).toBe(150);
    expect(await prisma.delivery.count()).toBe(200);
  });

  it("never exceeds the window across repeated ticks", async () => {
    await seedDeliveries(500);

    for (let i = 0; i < 10; i++) {
      await scheduler.tick();
      expect(await queue.occupancy()).toBeLessThanOrEqual(WINDOW);
    }

    expect(await queue.occupancy()).toBe(WINDOW);
  });

  it("does nothing when the window is already full", async () => {
    await seedDeliveries(200);
    await scheduler.tick();

    const second = await scheduler.tick();

    expect(second.enqueued).toBe(0);
    expect(await queue.occupancy()).toBe(WINDOW);
  });

  it("refills only as jobs are completed", async () => {
    await seedDeliveries(200);
    await scheduler.tick();

    // Drain ten, as workers would.
    for (let i = 0; i < 10; i++) {
      const claimed = await queue.claim(1);
      await queue.complete(claimed!);
    }
    expect(await queue.occupancy()).toBe(WINDOW - 10);

    const result = await scheduler.tick();

    expect(result.enqueued).toBe(10);
    expect(await queue.occupancy()).toBe(WINDOW);
  });

  it("marks enqueued deliveries QUEUED and leaves the rest PENDING", async () => {
    await seedDeliveries(200);

    await scheduler.tick();

    expect(await prisma.delivery.count({ where: { status: "QUEUED" } })).toBe(WINDOW);
    expect(await prisma.delivery.count({ where: { status: "PENDING" } })).toBe(150);
  });
});

describe("eligibility", () => {
  it("picks up WAITING deliveries whose retry is due", async () => {
    await seedDeliveries(5, {
      status: "WAITING",
      nextRetryAt: new Date(Date.now() - 1000),
    });

    const result = await scheduler.tick();

    expect(result.enqueued).toBe(5);
  });

  it("ignores WAITING deliveries whose retry is in the future", async () => {
    /**
     * This is what keeps Redis small during an outage. A million failed
     * deliveries sit WAITING with future retry times and are invisible to the
     * scheduler until their moment arrives.
     */
    await seedDeliveries(5, {
      status: "WAITING",
      nextRetryAt: new Date(Date.now() + 60_000),
    });

    const result = await scheduler.tick();

    expect(result.enqueued).toBe(0);
    expect(await queue.occupancy()).toBe(0);
  });

  it("compares retry times independently of the database timezone", async () => {
    /**
     * Regression test for a real bug.
     *
     * nextRetryAt is `timestamp without time zone` holding UTC, while
     * Postgres now() returns timestamptz. Comparing them casts one into the
     * session timezone, so the query's notion of "now" shifted by the server's
     * UTC offset. On a machine set to Asia/Kolkata every retry due within the
     * next five and a half hours fired immediately; in a negative-offset zone
     * the same bug would stall deliveries past their due time.
     *
     * A small offset is used here deliberately: it fails under any non-zero
     * timezone skew, not only a large one.
     */
    await seedDeliveries(4, {
      status: "WAITING",
      nextRetryAt: new Date(Date.now() + 5 * 60_000),
    });

    expect((await scheduler.tick()).enqueued).toBe(0);

    // ...and is picked up once genuinely due.
    await prisma.delivery.updateMany({
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });

    expect((await scheduler.tick()).enqueued).toBe(4);
  });

  it("ignores terminal deliveries", async () => {
    const event = await prisma.event.create({
      data: { projectId, eventType: "x", payload: {} },
    });
    await prisma.delivery.createMany({
      data: [
        { eventId: event.id, webhookId, status: "DELIVERED" },
        { eventId: event.id, webhookId, status: "FAILED" },
      ],
    });

    expect((await scheduler.tick()).enqueued).toBe(0);
  });

  it("ignores deliveries already in the window", async () => {
    await seedDeliveries(5);
    await scheduler.tick();

    const second = await scheduler.tick();

    expect(second.enqueued).toBe(0);
    expect(await queue.occupancy()).toBe(5);
  });

  it("takes the oldest eligible deliveries first", async () => {
    const event = await prisma.event.create({
      data: { projectId, eventType: "x", payload: {} },
    });

    const older = await prisma.delivery.create({
      data: {
        eventId: event.id,
        webhookId,
        status: "WAITING",
        nextRetryAt: new Date(Date.now() - 10_000),
      },
    });
    await prisma.delivery.create({
      data: {
        eventId: event.id,
        webhookId,
        status: "WAITING",
        nextRetryAt: new Date(Date.now() - 1_000),
      },
    });

    await scheduler.tick();

    expect(await queue.claim(1)).toBe(older.id);
  });
});

describe("reclaiming abandoned work", () => {
  it("returns expired leases to WAITING", async () => {
    /**
     * A worker died holding these. Without recovery the rows stay PROCESSING
     * forever and their Redis slots are never freed — the window slowly fills
     * with work nobody is doing.
     */
    await seedDeliveries(3, {
      status: "PROCESSING",
      lockedAt: new Date(Date.now() - LEASE_MS - 1000),
    });

    const result = await scheduler.tick();

    expect(result.reclaimed).toBe(3);
    expect(await prisma.delivery.count({ where: { status: "WAITING" } })).toBe(0);
    // Reclaimed and then immediately re-enqueued in the same tick, since their
    // retry time is now.
    expect(await prisma.delivery.count({ where: { status: "QUEUED" } })).toBe(3);
  });

  it("leaves healthy in-flight deliveries alone", async () => {
    await seedDeliveries(3, { status: "PROCESSING", lockedAt: new Date() });

    const result = await scheduler.tick();

    expect(result.reclaimed).toBe(0);
    expect(await prisma.delivery.count({ where: { status: "PROCESSING" } })).toBe(3);
  });

  it("counts the attempt against a reclaimed delivery", async () => {
    // A delivery that reliably kills its worker would otherwise cycle forever.
    // Counting the attempt means it eventually reaches FAILED.
    await seedDeliveries(1, {
      status: "PROCESSING",
      lockedAt: new Date(Date.now() - LEASE_MS - 1000),
    });

    await scheduler.tick();

    const delivery = await prisma.delivery.findFirstOrThrow();
    expect(delivery.attempt).toBe(1);
    expect(delivery.lastError).toContain("lease expired");
  });

  it("frees the Redis slot held by an abandoned delivery", async () => {
    await seedDeliveries(1);
    await scheduler.tick();

    const claimed = await queue.claim(1);
    expect(await queue.stats()).toMatchObject({ inFlight: 1 });

    await prisma.delivery.update({
      where: { id: claimed! },
      data: { status: "PROCESSING", lockedAt: new Date(Date.now() - LEASE_MS - 1000) },
    });

    await scheduler.tick();

    const stats = await queue.stats();
    expect(stats.inFlight).toBe(0);
  });
});

describe("multiple schedulers", () => {
  it("hand out disjoint sets of deliveries", async () => {
    /**
     * FOR UPDATE SKIP LOCKED is what makes horizontal scaling of the scheduler
     * safe. Without it, two schedulers would either block on each other or
     * hand the same delivery to two workers, and the customer would receive
     * the same webhook twice.
     */
    await seedDeliveries(40);

    const second = new Scheduler(queue, {
      windowSize: WINDOW,
      pollIntervalMs: 50,
      leaseTimeoutMs: LEASE_MS,
      batchSize: 20,
    });

    const [a, b] = await Promise.all([scheduler.tick(), second.tick()]);

    // Between them they enqueue every delivery exactly once.
    expect(a.enqueued + b.enqueued).toBe(40);
    expect(await queue.occupancy()).toBe(40);
    expect(await prisma.delivery.count({ where: { status: "QUEUED" } })).toBe(40);
  });

  it("do not exceed the window between them", async () => {
    await seedDeliveries(300);

    const others = Array.from(
      { length: 3 },
      () =>
        new Scheduler(queue, {
          windowSize: WINDOW,
          pollIntervalMs: 50,
          leaseTimeoutMs: LEASE_MS,
          batchSize: 20,
        }),
    );

    await Promise.all([scheduler.tick(), ...others.map((s) => s.tick())]);

    expect(await queue.occupancy()).toBe(WINDOW);
  });
});

describe("snapshot", () => {
  it("reports window and delivery counts", async () => {
    await seedDeliveries(200);
    await scheduler.tick();

    const snapshot = await scheduler.snapshot();

    expect(snapshot.window).toEqual({ ready: WINDOW, inFlight: 0, capacity: WINDOW });
    expect(snapshot.deliveries["QUEUED"]).toBe(WINDOW);
    expect(snapshot.deliveries["PENDING"]).toBe(150);
  });
});
