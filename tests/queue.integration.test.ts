import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Redis } from "ioredis";
import { RedisWindowQueue } from "../src/queue/RedisWindowQueue.js";

/**
 * The execution window, against a real Redis.
 *
 * This is the file that proves Relay's central claim. Everything else in the
 * system is ordinary backend work; the assertion that Redis never exceeds a
 * fixed size regardless of backlog is the reason the project exists, and it is
 * tested here directly rather than inferred.
 */

const CAPACITY = 100;
const PREFIX = "relaytest";

let redis: Redis;
let queue: RedisWindowQueue;

function ids(count: number, prefix = "d"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

beforeAll(async () => {
  redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
  queue = new RedisWindowQueue(redis, CAPACITY, PREFIX);
});

afterAll(async () => {
  await queue.clear();
  await redis.quit();
});

beforeEach(async () => {
  await queue.clear();
});

describe("capacity — the invariant the project exists for", () => {
  it("accepts a batch that fits", async () => {
    const accepted = await queue.enqueue(ids(50));

    expect(accepted).toHaveLength(50);
    expect(await queue.occupancy()).toBe(50);
  });

  it("stops exactly at capacity when offered more", async () => {
    const accepted = await queue.enqueue(ids(500));

    expect(accepted).toHaveLength(CAPACITY);
    expect(await queue.occupancy()).toBe(CAPACITY);
  });

  it("never exceeds capacity across many separate batches", async () => {
    // The realistic shape: a scheduler looping, offering more each tick.
    for (let batch = 0; batch < 20; batch++) {
      await queue.enqueue(ids(50, `batch${batch}`));
      expect(await queue.occupancy()).toBeLessThanOrEqual(CAPACITY);
    }

    expect(await queue.occupancy()).toBe(CAPACITY);
  });

  it("holds the cap under concurrent enqueues", async () => {
    /**
     * The race the Lua script exists to prevent. Ten callers each read
     * occupancy and decide there is room; without atomicity they all act on
     * the same stale reading and collectively overshoot.
     */
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => queue.enqueue(ids(30, `c${i}`))),
    );

    expect(await queue.occupancy()).toBe(CAPACITY);
  });

  it("counts in-flight jobs against capacity", async () => {
    // A claimed job has left the ready list but is still resident in Redis
    // and still consuming memory. Excluding it would let the window grow
    // without bound while workers were busy.
    await queue.enqueue(ids(CAPACITY));
    await queue.claim(1);
    await queue.claim(1);

    const stats = await queue.stats();
    expect(stats.ready).toBe(CAPACITY - 2);
    expect(stats.inFlight).toBe(2);
    expect(await queue.occupancy()).toBe(CAPACITY);

    // Still full, so nothing new gets in.
    expect(await queue.enqueue(["extra"])).toHaveLength(0);
  });

  it("frees a slot only when a job completes", async () => {
    await queue.enqueue(ids(CAPACITY));
    expect(await queue.enqueue(["extra"])).toHaveLength(0);

    const claimed = await queue.claim(1);
    expect(await queue.enqueue(["extra"])).toHaveLength(0); // claimed != done

    await queue.complete(claimed!);
    expect(await queue.enqueue(["extra"])).toEqual(["extra"]);
  });
});

describe("deduplication", () => {
  it("ignores an ID already in the window", async () => {
    await queue.enqueue(["a", "b"]);
    const accepted = await queue.enqueue(["b", "c"]);

    expect(accepted).toEqual(["c"]);
    expect(await queue.occupancy()).toBe(3);
  });

  it("ignores duplicates within one batch", async () => {
    const accepted = await queue.enqueue(["a", "a", "a"]);

    expect(accepted).toEqual(["a"]);
    expect(await queue.occupancy()).toBe(1);
  });

  it("will not re-accept a job that is in flight", async () => {
    // Otherwise two workers could deliver the same webhook simultaneously.
    await queue.enqueue(["a"]);
    await queue.claim(1);

    expect(await queue.enqueue(["a"])).toHaveLength(0);
  });

  it("accepts an ID again once completed", async () => {
    // Required for retries: a failed delivery must be able to come back.
    await queue.enqueue(["a"]);
    const claimed = await queue.claim(1);
    await queue.complete(claimed!);

    expect(await queue.enqueue(["a"])).toEqual(["a"]);
  });
});

describe("claiming", () => {
  it("returns jobs in FIFO order", async () => {
    await queue.enqueue(["first", "second", "third"]);

    expect(await queue.claim(1)).toBe("first");
    expect(await queue.claim(1)).toBe("second");
    expect(await queue.claim(1)).toBe("third");
  });

  it("moves the job to in-flight atomically", async () => {
    await queue.enqueue(["a"]);
    await queue.claim(1);

    const stats = await queue.stats();
    expect(stats.ready).toBe(0);
    expect(stats.inFlight).toBe(1);
  });

  it("returns null when nothing is available", async () => {
    expect(await queue.claim(1)).toBeNull();
  });

  it("gives a job to exactly one of several competing workers", async () => {
    await queue.enqueue(["only-one"]);

    const results = await Promise.all([queue.claim(1), queue.claim(1), queue.claim(1)]);

    expect(results.filter((r) => r === "only-one")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });
});

describe("completing", () => {
  it("removes the job from Redis entirely", async () => {
    await queue.enqueue(["a"]);
    const claimed = await queue.claim(1);
    await queue.complete(claimed!);

    expect(await queue.occupancy()).toBe(0);
  });

  it("is safe to call twice", async () => {
    // Workers call complete() in a finally block; a retry or an overlapping
    // shutdown path must not corrupt the window.
    await queue.enqueue(["a"]);
    await queue.claim(1);

    await queue.complete("a");
    await queue.complete("a");

    expect(await queue.occupancy()).toBe(0);
  });

  it("is safe to call for a job that was never queued", async () => {
    await expect(queue.complete("never-existed")).resolves.not.toThrow();
  });
});

describe("releasing abandoned jobs", () => {
  it("clears in-flight jobs whose worker died", async () => {
    await queue.enqueue(["a", "b"]);
    await queue.claim(1);
    await queue.claim(1);

    const released = await queue.release(["a", "b"]);

    expect(released).toBe(2);
    expect(await queue.occupancy()).toBe(0);
  });

  it("lets a released job be queued again", async () => {
    /**
     * The recovery path for a crashed worker. Postgres decides the lease
     * expired; this frees the Redis slot so the scheduler can offer the
     * delivery to a healthy worker.
     */
    await queue.enqueue(["a"]);
    await queue.claim(1);
    await queue.release(["a"]);

    expect(await queue.enqueue(["a"])).toEqual(["a"]);
  });
});

describe("occupancy reporting", () => {
  it("starts empty", async () => {
    expect(await queue.occupancy()).toBe(0);
    expect(await queue.availableCapacity()).toBe(CAPACITY);
  });

  it("reports remaining capacity", async () => {
    await queue.enqueue(ids(30));
    expect(await queue.availableCapacity()).toBe(CAPACITY - 30);
  });

  it("never reports negative capacity", async () => {
    await queue.enqueue(ids(500));
    expect(await queue.availableCapacity()).toBe(0);
  });
});
