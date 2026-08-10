import type { RedisWindowQueue } from "../queue/RedisWindowQueue.js";
import {
  claimEligibleDeliveries,
  countByStatus,
  findOrphanedQueued,
  reclaimExpiredLeases,
  resetToPending,
} from "../repositories/delivery.repository.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("scheduler");

export interface SchedulerOptions {
  /** Maximum jobs resident in Redis. The number the architecture bounds. */
  windowSize: number;
  /** Pause between ticks when there is nothing to do. */
  pollIntervalMs: number;
  /** Age at which a PROCESSING delivery is presumed abandoned. */
  leaseTimeoutMs: number;
  /** How many deliveries to claim in one database round-trip. */
  batchSize?: number;
}

export interface TickResult {
  reclaimed: number;
  /** QUEUED rows found absent from the window and returned to PENDING. */
  orphansRecovered: number;
  enqueued: number;
  occupancy: number;
  capacityAvailable: number;
}

/**
 * How long a QUEUED row must be absent from the window before the sweep treats
 * it as orphaned.
 *
 * Generous on purpose. The claim commits before it publishes, so a row is
 * briefly QUEUED and not yet in Redis during entirely normal operation; a
 * short grace period would reclaim rows that were about to be pushed.
 */
const ORPHAN_GRACE_MS = 30_000;

/**
 * The execution window manager.
 *
 * Its entire job is to keep Redis as full as it is allowed to be and never
 * fuller. It reads deliveries that are ready to run out of Postgres, offers
 * them to the window, and stops the moment the window is full — leaving the
 * remaining backlog, however large, sitting on disk where it costs nothing.
 *
 * The scheduler never delivers a webhook. It makes no outbound HTTP request of
 * any kind. Mixing the two would mean a slow customer endpoint could stall
 * the refilling of the window for every other customer.
 */
export class Scheduler {
  private readonly batchSize: number;
  private running = false;
  private stopping = false;
  /** Resolves once the loop has fully exited, so shutdown can wait on it. */
  private loopFinished: Promise<void> = Promise.resolve();

  constructor(
    private readonly queue: RedisWindowQueue,
    private readonly options: SchedulerOptions,
  ) {
    /**
     * Claim in batches rather than trying to fill the whole window in one
     * statement. A single query for 5,000 rows holds locks on all of them for
     * its duration, which blocks nothing (SKIP LOCKED) but does produce one
     * long transaction and one large result set. Smaller batches keep each
     * transaction short.
     */
    this.batchSize = options.batchSize ?? 500;
  }

  /**
   * One pass: recover abandoned work, then refill the window.
   *
   * Exposed separately from `start()` so tests can drive the scheduler
   * deterministically, one tick at a time, instead of racing a timer.
   */
  async tick(): Promise<TickResult> {
    const reclaimed = await this.reclaimAbandoned();
    const orphansRecovered = await this.recoverOrphans();

    const capacityAvailable = await this.queue.availableCapacity();

    if (capacityAvailable === 0) {
      // The window is full, which is the healthy steady state under load.
      // Postgres may hold millions more; they wait there.
      return {
        reclaimed,
        orphansRecovered,
        enqueued: 0,
        occupancy: await this.queue.occupancy(),
        capacityAvailable: 0,
      };
    }

    let enqueued = 0;
    let remaining = capacityAvailable;

    while (remaining > 0 && !this.stopping) {
      const batch = Math.min(remaining, this.batchSize);

      const accepted = await claimEligibleDeliveries(batch, (ids) =>
        this.queue.enqueue(ids),
      );

      if (accepted.length === 0) {
        // Either nothing is eligible, or the window filled underneath us
        // because another scheduler got there first. Either way, done.
        break;
      }

      enqueued += accepted.length;
      remaining -= accepted.length;
    }

    if (enqueued > 0) {
      log.info(
        { enqueued, occupancy: await this.queue.occupancy() },
        "Refilled execution window",
      );
    }

    return {
      reclaimed,
      orphansRecovered,
      enqueued,
      occupancy: await this.queue.occupancy(),
      capacityAvailable: await this.queue.availableCapacity(),
    };
  }

  /**
   * Return QUEUED rows that the window does not actually hold.
   *
   * A row reaches this state if the process dies between committing the claim
   * and publishing to Redis. It is then invisible to everything: the scheduler
   * looks only at PENDING and WAITING, and workers see only what Redis hands
   * them. Without this sweep such a delivery is lost silently and permanently
   * — no error, no log, just a webhook that never arrives.
   *
   * Membership is checked against Redis rather than assumed from age, because
   * during a large backlog a row can legitimately sit QUEUED in the window for
   * a long time waiting for a worker.
   */
  private async recoverOrphans(): Promise<number> {
    const candidates = await findOrphanedQueued(ORPHAN_GRACE_MS);
    if (candidates.length === 0) return 0;

    const orphans = await this.queue.notInWindow(candidates);
    if (orphans.length === 0) return 0;

    const recovered = await resetToPending(orphans);

    log.warn(
      { count: recovered },
      "Recovered QUEUED deliveries missing from the execution window",
    );

    return recovered;
  }

  /**
   * Recover deliveries whose worker died holding them.
   *
   * Postgres decides what is stale — it owns the lease timestamps — and Redis
   * is then told to free the corresponding slots. Doing it in that order
   * matters: if Redis were cleared first and the process died before the
   * database update, the row would stay PROCESSING with no slot and no owner,
   * and nothing would ever look at it again.
   */
  private async reclaimAbandoned(): Promise<number> {
    const reclaimedIds = await reclaimExpiredLeases(this.options.leaseTimeoutMs);

    if (reclaimedIds.length === 0) return 0;

    await this.queue.release(reclaimedIds);

    log.warn(
      { count: reclaimedIds.length, leaseTimeoutMs: this.options.leaseTimeoutMs },
      "Reclaimed deliveries from expired worker leases",
    );

    return reclaimedIds.length;
  }

  /** Run until `stop()` is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    log.info(
      {
        windowSize: this.options.windowSize,
        pollIntervalMs: this.options.pollIntervalMs,
      },
      "Scheduler started",
    );

    this.loopFinished = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (error) {
        /**
         * A failed tick must never end the loop. Postgres restarting or Redis
         * blipping should cost one cycle, not the scheduler process — if this
         * exits, the window stops refilling and every delivery in the system
         * silently stalls.
         */
        log.error({ err: error }, "Scheduler tick failed; continuing");
      }

      await this.sleep(this.options.pollIntervalMs);
    }

    log.info("Scheduler loop exited");
  }

  /**
   * Interruptible sleep.
   *
   * A plain timer would make shutdown wait out the full poll interval before
   * noticing it should stop. This resolves early when `stop()` fires.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private stopResolvers: Array<() => void> = [];

  /** Signal the loop to finish and wait for the current tick to complete. */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.stopping = true;

    // Wake an in-progress sleep so shutdown isn't held up by the poll interval.
    for (const wake of this.stopResolvers.splice(0)) wake();

    await this.loopFinished;
    this.running = false;
  }

  /** Snapshot for logging and, later, the M6 monitor. */
  async snapshot(): Promise<{
    window: { ready: number; inFlight: number; capacity: number };
    deliveries: Record<string, number>;
  }> {
    const [window, deliveries] = await Promise.all([
      this.queue.stats(),
      countByStatus(),
    ]);

    return { window, deliveries };
  }
}
