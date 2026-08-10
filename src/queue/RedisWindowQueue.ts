import type { Redis } from "ioredis";
import type { QueueAdapter } from "./QueueAdapter.js";
import { COMPLETE_LUA, ENQUEUE_LUA, REQUEUE_LUA } from "./scripts.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("queue");

/**
 * The execution window, built on three Redis keys.
 *
 *   relay:window     LIST   delivery IDs ready to execute
 *   relay:inflight   LIST   claimed by a worker, outcome not yet known
 *   relay:enqueued   SET    membership guard, so an ID cannot be queued twice
 *
 * Occupancy is `LLEN window + LLEN inflight`, and the scheduler never pushes
 * beyond the configured capacity. Because nothing outside this class writes
 * these keys, that arithmetic is exact — "how many jobs are in Redis?" is
 * answerable with two commands, which is precisely the property that makes the
 * 5,000 cap demonstrable rather than merely asserted.
 *
 * Deliberately built on plain list operations rather than a queue library.
 * A library's central feature is retrying failed jobs, and it holds that
 * retry state in Redis — the exact thing Relay forbids. Failed deliveries here
 * leave Redis entirely and wait in Postgres until their retry falls due.
 */
export class RedisWindowQueue implements QueueAdapter {
  private readonly readyKey: string;
  private readonly inFlightKey: string;
  private readonly dedupeKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly capacity: number,
    keyPrefix = "relay",
  ) {
    this.readyKey = `${keyPrefix}:window`;
    this.inFlightKey = `${keyPrefix}:inflight`;
    this.dedupeKey = `${keyPrefix}:enqueued`;
  }

  async enqueue(deliveryIds: string[]): Promise<string[]> {
    if (deliveryIds.length === 0) return [];

    const accepted = (await this.redis.eval(
      ENQUEUE_LUA,
      3,
      this.readyKey,
      this.inFlightKey,
      this.dedupeKey,
      String(this.capacity),
      ...deliveryIds,
    )) as string[];

    if (accepted.length < deliveryIds.length) {
      // Expected whenever the window fills; worth seeing at debug level
      // because it is also the signal that workers are the bottleneck.
      log.debug(
        { offered: deliveryIds.length, accepted: accepted.length },
        "Execution window rejected part of a batch",
      );
    }

    return accepted;
  }

  /**
   * BLMOVE atomically pops from the ready list and pushes to in-flight.
   *
   * The atomicity is the point. With separate pop and push, a worker that died
   * in between would leave the job in neither list — invisible to Redis and
   * to the scheduler, which believes it is still queued because the dedupe set
   * says so. The delivery would simply never happen.
   *
   * LEFT/RIGHT gives FIFO: the scheduler appends on the right, workers take
   * from the left, so the oldest eligible delivery goes first.
   *
   * `connection` should be a client dedicated to this caller. BLMOVE holds its
   * connection for the entire timeout, so ten workers sharing one client would
   * not wait in parallel — they would queue, and the pool's concurrency would
   * collapse to one. Defaults to the shared client, which is fine for tests
   * and single-consumer use.
   */
  async claim(timeoutSeconds: number, connection?: Redis): Promise<string | null> {
    const client = connection ?? this.redis;

    const id = await client.blmove(
      this.readyKey,
      this.inFlightKey,
      "LEFT",
      "RIGHT",
      timeoutSeconds,
    );

    return id ?? null;
  }

  async complete(deliveryId: string): Promise<void> {
    await this.redis.eval(
      COMPLETE_LUA,
      2,
      this.inFlightKey,
      this.dedupeKey,
      deliveryId,
    );
  }

  /**
   * Evict jobs whose owning worker Postgres has judged dead.
   *
   * Called only by the scheduler's reaper. Postgres decides what is stale —
   * it holds the lease timestamps and is the source of truth — and this
   * carries out that decision in Redis.
   */
  async release(deliveryIds: string[]): Promise<number> {
    if (deliveryIds.length === 0) return 0;

    const count = (await this.redis.eval(
      REQUEUE_LUA,
      2,
      this.inFlightKey,
      this.dedupeKey,
      ...deliveryIds,
    )) as number;

    return count;
  }

  /**
   * Of the given IDs, which the window does not hold.
   *
   * Used by the scheduler's orphan sweep. Membership is answered by the dedupe
   * set, which is exactly the set of IDs resident in the window — checking the
   * two lists instead would mean reading thousands of elements to answer a
   * membership question.
   *
   * SMISMEMBER tests the whole batch in one round trip, so a sweep over a
   * thousand candidates is one command rather than a thousand.
   */
  async notInWindow(deliveryIds: string[]): Promise<string[]> {
    if (deliveryIds.length === 0) return [];

    const present = await this.redis.smismember(this.dedupeKey, ...deliveryIds);

    return deliveryIds.filter((_id, index) => present[index] === 0);
  }

  async occupancy(): Promise<number> {
    const [ready, inFlight] = await Promise.all([
      this.redis.llen(this.readyKey),
      this.redis.llen(this.inFlightKey),
    ]);

    return ready + inFlight;
  }

  async stats(): Promise<{ ready: number; inFlight: number; capacity: number }> {
    const [ready, inFlight] = await Promise.all([
      this.redis.llen(this.readyKey),
      this.redis.llen(this.inFlightKey),
    ]);

    return { ready, inFlight, capacity: this.capacity };
  }

  /** Remaining space. Never negative, even if capacity were lowered at runtime. */
  async availableCapacity(): Promise<number> {
    return Math.max(0, this.capacity - (await this.occupancy()));
  }

  async clear(): Promise<void> {
    await this.redis.del(this.readyKey, this.inFlightKey, this.dedupeKey);
  }
}
