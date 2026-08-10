import { prisma } from "../config/database.js";
import type { Delivery, Event, Webhook } from "../generated/prisma/client.js";

/**
 * Database access for executing a delivery, as distinct from scheduling one.
 */

export type DeliveryContext = Delivery & {
  event: Event;
  webhook: Webhook;
};

/**
 * Take ownership of a delivery.
 *
 * This is a conditional update, not a read followed by a write, and the
 * condition is the important part: it only matches rows still in QUEUED. If
 * another worker got there first the row is already PROCESSING, zero rows
 * match, and this returns null.
 *
 * That makes the claim atomic without any lock. Postgres guarantees only one
 * of two concurrent UPDATEs to the same row can see it as QUEUED, so exactly
 * one worker wins and the other walks away. A read-then-write would let both
 * see QUEUED and both proceed, and the customer would receive the same webhook
 * twice.
 *
 * `lockedAt` starts the lease. If this worker dies mid-request, the
 * scheduler's reaper uses that timestamp to decide the delivery has been
 * abandoned.
 */
export async function claimForProcessing(
  deliveryId: string,
): Promise<DeliveryContext | null> {
  const result = await prisma.delivery.updateMany({
    where: { id: deliveryId, status: "QUEUED" },
    data: { status: "PROCESSING", lockedAt: new Date() },
  });

  if (result.count === 0) return null;

  return prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, webhook: true },
  });
}

export interface SuccessRecord {
  deliveryId: string;
  attempt: number;
  responseStatus: number;
  durationMs: number;
}

export async function recordSuccess(record: SuccessRecord): Promise<void> {
  await prisma.$transaction([
    prisma.delivery.update({
      where: { id: record.deliveryId },
      data: {
        status: "DELIVERED",
        attempt: record.attempt,
        responseStatus: record.responseStatus,
        deliveredAt: new Date(),
        lockedAt: null,
        nextRetryAt: null,
        lastError: null,
      },
    }),
    prisma.deliveryAttempt.create({
      data: {
        deliveryId: record.deliveryId,
        attempt: record.attempt,
        responseStatus: record.responseStatus,
        durationMs: record.durationMs,
      },
    }),
  ]);
}

export interface FailureRecord {
  deliveryId: string;
  attempt: number;
  responseStatus?: number | undefined;
  errorMessage: string;
  durationMs: number;
  /** Null when attempts are exhausted or the failure is not retryable. */
  nextRetryAt: Date | null;
}

/**
 * Record a failed attempt.
 *
 * The status transition is the heart of the architecture. A delivery that will
 * be retried goes to WAITING with a future `nextRetryAt` — and WAITING rows
 * are **not in Redis**. That is precisely what keeps the window bounded: a
 * million failing deliveries are a million rows on disk, invisible to the
 * scheduler until their retry time arrives.
 *
 * Both writes are one transaction so the delivery's current state and its
 * attempt history can never disagree.
 */
export async function recordFailure(record: FailureRecord): Promise<void> {
  const exhausted = record.nextRetryAt === null;

  await prisma.$transaction([
    prisma.delivery.update({
      where: { id: record.deliveryId },
      data: {
        status: exhausted ? "FAILED" : "WAITING",
        attempt: record.attempt,
        responseStatus: record.responseStatus ?? null,
        lastError: record.errorMessage.slice(0, 1000),
        nextRetryAt: record.nextRetryAt,
        lockedAt: null,
      },
    }),
    prisma.deliveryAttempt.create({
      data: {
        deliveryId: record.deliveryId,
        attempt: record.attempt,
        responseStatus: record.responseStatus ?? null,
        errorMessage: record.errorMessage.slice(0, 1000),
        durationMs: record.durationMs,
      },
    }),
  ]);
}
