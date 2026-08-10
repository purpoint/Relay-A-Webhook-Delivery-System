import type { Redis } from "ioredis";
import type { RedisWindowQueue } from "../queue/RedisWindowQueue.js";
import {
  claimForProcessing,
  recordFailure,
  recordSuccess,
} from "../repositories/delivery-execution.repository.js";
import { deliver } from "./deliver.js";
import { nextRetryAt, shouldRetry } from "./backoff.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("worker");

export interface WorkerOptions {
  concurrency: number;
  deliveryTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /** How long a blocking claim waits before looping to check for shutdown. */
  claimTimeoutSeconds?: number;

  /**
   * Supplies each loop with its own Redis connection for blocking claims.
   *
   * Required for real concurrency: BLMOVE occupies a connection for the whole
   * of its timeout, so loops sharing one client would serialise and the pool
   * would deliver one at a time regardless of its configured size.
   *
   * Omit in tests that only call processOne(), which never claims.
   */
  createBlockingClient?: (label: string) => Redis;
}

export interface ProcessResult {
  deliveryId: string;
  outcome: "delivered" | "retrying" | "failed" | "skipped";
}

/**
 * The delivery engine.
 *
 * Each worker does one thing repeatedly: take a delivery ID from the window,
 * send the HTTP request, record what happened, release the slot. It holds no
 * state between jobs, which is what makes running twenty of them the same as
 * running one.
 *
 * Workers never decide *what* to work on — that is the scheduler's job — and
 * never write to the window except to release a finished job.
 */
export class WorkerPool {
  private stopping = false;
  private readonly loops: Promise<void>[] = [];
  private readonly connections: Redis[] = [];
  private readonly claimTimeoutSeconds: number;

  constructor(
    private readonly queue: RedisWindowQueue,
    private readonly options: WorkerOptions,
  ) {
    this.claimTimeoutSeconds = options.claimTimeoutSeconds ?? 2;
  }

  /**
   * Process one delivery end to end.
   *
   * Separate from the loop so tests can drive a single delivery
   * deterministically rather than racing a background pool.
   */
  async processOne(deliveryId: string): Promise<ProcessResult> {
    try {
      const delivery = await claimForProcessing(deliveryId);

      if (!delivery) {
        /**
         * The row was not QUEUED. Either another worker took it, or it is one
         * of the orphans the scheduler's claim transaction can leave in Redis
         * when it rolls back after a successful enqueue. Either way this
         * worker has no business sending it — drop it and free the slot.
         */
        log.debug({ deliveryId }, "Delivery not claimable, skipping");
        return { deliveryId, outcome: "skipped" };
      }

      const attempt = delivery.attempt + 1;

      const result = await deliver(delivery, {
        timeoutMs: this.options.deliveryTimeoutMs,
      });

      if (result.success) {
        await recordSuccess({
          deliveryId,
          attempt,
          responseStatus: result.responseStatus ?? 200,
          durationMs: result.durationMs,
        });

        log.info(
          {
            deliveryId,
            attempt,
            status: result.responseStatus,
            durationMs: result.durationMs,
          },
          "Delivery succeeded",
        );

        return { deliveryId, outcome: "delivered" };
      }

      /**
       * A retry is scheduled only if the failure could plausibly resolve and
       * attempts remain. A 404 or 401 will answer identically next time, so
       * retrying it eight times wastes both sides' resources and delays the
       * customer learning their endpoint is misconfigured.
       */
      const retrying =
        result.retryable && shouldRetry(attempt, this.options.maxAttempts);

      const retryAt = retrying
        ? nextRetryAt(attempt, {
            baseMs: this.options.retryBaseMs,
            maxMs: this.options.retryMaxMs,
          })
        : null;

      await recordFailure({
        deliveryId,
        attempt,
        responseStatus: result.responseStatus,
        errorMessage: result.errorMessage ?? "Unknown error",
        durationMs: result.durationMs,
        nextRetryAt: retryAt,
      });

      log.warn(
        {
          deliveryId,
          attempt,
          status: result.responseStatus,
          retryable: result.retryable,
          nextRetryAt: retryAt?.toISOString(),
          error: result.errorMessage,
        },
        retrying ? "Delivery failed, retry scheduled" : "Delivery failed permanently",
      );

      return { deliveryId, outcome: retrying ? "retrying" : "failed" };
    } finally {
      /**
       * Release the Redis slot on **every** path, including thrown errors.
       *
       * This is the single most important line in the worker. A delivery that
       * finishes without releasing leaves its ID in the in-flight list and the
       * dedupe set forever: the slot is permanently consumed and the scheduler
       * will never offer that delivery again. Enough of those and the window
       * fills with ghosts and all delivery stops.
       *
       * Note this is *not* how a crashed worker is handled — a process that
       * dies never reaches a finally block. That case is the scheduler's lease
       * reaper. This covers the ordinary one: an exception on a live worker.
       */
      await this.queue.complete(deliveryId).catch((error: unknown) => {
        log.error({ err: error, deliveryId }, "Failed to release delivery from window");
      });
    }
  }

  /** Start `concurrency` loops, each independently claiming and processing. */
  start(): void {
    this.stopping = false;

    for (let i = 0; i < this.options.concurrency; i++) {
      const connection = this.options.createBlockingClient?.(`worker-${i}`);
      if (connection) this.connections.push(connection);

      this.loops.push(this.loop(i, connection));
    }

    log.info({ concurrency: this.options.concurrency }, "Worker pool started");
  }

  private async loop(index: number, connection?: Redis): Promise<void> {
    while (!this.stopping) {
      try {
        /**
         * Blocks until a job appears or the timeout expires. The timeout is
         * short so shutdown is noticed promptly; without it a worker could sit
         * blocked for minutes on an idle queue while the process tried to exit.
         */
        const deliveryId = await this.queue.claim(this.claimTimeoutSeconds, connection);

        if (!deliveryId) continue;

        await this.processOne(deliveryId);
      } catch (error) {
        /**
         * One bad delivery must never end the loop. If this worker exits, the
         * pool quietly shrinks; if it happens to every worker, delivery stops
         * with nothing obviously broken.
         */
        log.error({ err: error, worker: index }, "Worker loop error; continuing");
      }
    }
  }

  /**
   * Stop claiming new work and wait for in-flight deliveries to finish.
   *
   * Waiting matters. Killing a worker mid-request leaves the row PROCESSING,
   * and it stays that way until the lease expires — so an impatient shutdown
   * turns every deploy into a batch of deliveries delayed by the full lease
   * timeout.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.loops);

    // Close the per-loop connections. Left open, the process would not exit
    // even after every loop had finished.
    for (const connection of this.connections.splice(0)) {
      connection.disconnect();
    }

    log.info("Worker pool stopped");
  }
}
