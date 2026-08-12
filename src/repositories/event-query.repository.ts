import { prisma } from "../config/database.js";
import type { Delivery, DeliveryAttempt, Event } from "../generated/prisma/client.js";
import type { DeliveryStatus } from "../generated/prisma/enums.js";

/**
 * Read-side queries for the dashboard: what happened, and why.
 *
 * Separate from event.repository.ts, which owns the write path. The two have
 * different shapes — writes are one transaction on the hot path, reads are
 * paginated joins nobody is waiting on — and keeping them apart stops the
 * ingest path accumulating query helpers it never uses.
 */

export interface EventListFilters {
  projectId: string;
  eventType?: string | undefined;
  limit: number;
  /**
   * Keyset cursor: the id of the last row from the previous page.
   *
   * Deliberately not an OFFSET. Offset pagination makes the database count and
   * discard every skipped row, so page 500 of a million-row table reads half a
   * million rows to return twenty. It is also unstable — a row inserted while
   * you page shifts everything down and you see a duplicate.
   */
  cursor?: string | undefined;
}

export type EventWithCounts = Event & {
  deliveries: { status: DeliveryStatus }[];
};

export async function listEvents(filters: EventListFilters): Promise<EventWithCounts[]> {
  return prisma.event.findMany({
    where: {
      projectId: filters.projectId,
      ...(filters.eventType ? { eventType: filters.eventType } : {}),
    },
    include: { deliveries: { select: { status: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filters.limit,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });
}

export async function findEventForProject(
  eventId: string,
  projectId: string,
): Promise<EventWithCounts | null> {
  // Scoped by project, so another customer's event id simply returns nothing.
  return prisma.event.findFirst({
    where: { id: eventId, projectId },
    include: { deliveries: { select: { status: true } } },
  });
}

export type DeliveryWithHistory = Delivery & {
  webhook: { id: string; url: string };
  attempts: DeliveryAttempt[];
};

/**
 * Every delivery for one event, with the full attempt history.
 *
 * The attempts are the actually useful part when a customer asks "why didn't
 * this arrive?" — each row carries the status code, the error and how long it
 * took, so the answer is visible rather than inferred.
 */
export async function listDeliveriesForEvent(
  eventId: string,
  projectId: string,
): Promise<DeliveryWithHistory[] | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, projectId },
    select: { id: true },
  });

  // Null rather than an empty array: "no such event" and "an event with no
  // deliveries" are different answers and deserve different status codes.
  if (!event) return null;

  return prisma.delivery.findMany({
    where: { eventId },
    include: {
      webhook: { select: { id: true, url: true } },
      attempts: { orderBy: { attempt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function findDeliveryForProject(
  deliveryId: string,
  projectId: string,
): Promise<DeliveryWithHistory | null> {
  return prisma.delivery.findFirst({
    // The tenancy check reaches through the event, since Delivery has no
    // projectId of its own.
    where: { id: deliveryId, event: { projectId } },
    include: {
      webhook: { select: { id: true, url: true } },
      attempts: { orderBy: { attempt: "asc" } },
    },
  });
}

/**
 * Put a terminal delivery back in the queue.
 *
 * Only FAILED and DELIVERED are replayable. A delivery that is PENDING,
 * QUEUED, PROCESSING or WAITING is already on its way, and resetting it would
 * either duplicate the send or strand whatever is currently holding it.
 *
 * Attempts reset to zero so the replay gets a full set of retries rather than
 * inheriting an exhausted counter.
 */
export async function replayDelivery(
  deliveryId: string,
  projectId: string,
): Promise<boolean> {
  const result = await prisma.delivery.updateMany({
    where: {
      id: deliveryId,
      event: { projectId },
      status: { in: ["FAILED", "DELIVERED"] },
    },
    data: {
      status: "PENDING",
      attempt: 0,
      nextRetryAt: null,
      lockedAt: null,
      lastError: null,
      responseStatus: null,
      deliveredAt: null,
    },
  });

  return result.count > 0;
}

export async function countEventsForProject(projectId: string): Promise<number> {
  return prisma.event.count({ where: { projectId } });
}

/** Delivery status counts for one project, for the dashboard summary. */
export async function deliveryStatsForProject(
  projectId: string,
): Promise<Record<string, number>> {
  const rows = await prisma.delivery.groupBy({
    by: ["status"],
    where: { event: { projectId } },
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}
