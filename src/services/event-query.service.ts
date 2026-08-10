import {
  deliveryStatsForProject,
  findDeliveryForProject,
  findEventForProject,
  listDeliveriesForEvent,
  listEvents,
  replayDelivery,
  type DeliveryWithHistory,
  type EventWithCounts,
} from "../repositories/event-query.repository.js";
import { getOwnedProject } from "./project.service.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("events");

export interface EventSummary {
  id: string;
  eventType: string;
  createdAt: Date;
  /** Counts per delivery status, so a list row can show progress at a glance. */
  deliveries: Record<string, number>;
}

export interface EventPage {
  events: EventSummary[];
  /** Pass back as `cursor` to fetch the next page; null when there are none. */
  nextCursor: string | null;
}

export async function listProjectEvents(
  projectId: string,
  userId: string,
  options: { limit: number; cursor?: string | undefined; eventType?: string | undefined },
): Promise<EventPage> {
  await getOwnedProject(projectId, userId);

  /**
   * Fetch one more than asked for. If it comes back, there is another page —
   * which avoids a separate COUNT query whose answer would be stale by the
   * time it was returned anyway.
   */
  const rows = await listEvents({
    projectId,
    limit: options.limit + 1,
    cursor: options.cursor,
    eventType: options.eventType,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    events: page.map(toEventSummary),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getEvent(
  projectId: string,
  userId: string,
  eventId: string,
): Promise<EventSummary & { payload: unknown }> {
  await getOwnedProject(projectId, userId);

  const event = await findEventForProject(eventId, projectId);
  if (!event) throw new NotFoundError("Event");

  return { ...toEventSummary(event), payload: event.payload };
}

export interface DeliveryView {
  id: string;
  status: string;
  attempt: number;
  webhook: { id: string; url: string };
  nextRetryAt: Date | null;
  lastError: string | null;
  responseStatus: number | null;
  deliveredAt: Date | null;
  createdAt: Date;
  attempts: {
    attempt: number;
    responseStatus: number | null;
    errorMessage: string | null;
    durationMs: number;
    attemptedAt: Date;
  }[];
}

export async function getEventDeliveries(
  projectId: string,
  userId: string,
  eventId: string,
): Promise<DeliveryView[]> {
  await getOwnedProject(projectId, userId);

  const deliveries = await listDeliveriesForEvent(eventId, projectId);
  if (deliveries === null) throw new NotFoundError("Event");

  return deliveries.map(toDeliveryView);
}

export async function getDelivery(
  projectId: string,
  userId: string,
  deliveryId: string,
): Promise<DeliveryView> {
  await getOwnedProject(projectId, userId);

  const delivery = await findDeliveryForProject(deliveryId, projectId);
  if (!delivery) throw new NotFoundError("Delivery");

  return toDeliveryView(delivery);
}

/**
 * Requeue a terminal delivery.
 *
 * Note what this does *not* do: it does not send anything. It resets the row
 * to PENDING and lets the scheduler pick it up on its next tick, exactly as if
 * it were new. Replaying through the normal path rather than a special one
 * means it is subject to the same window cap, the same retry policy and the
 * same recovery — a bypass would be a second delivery mechanism to keep
 * correct.
 */
export async function replay(
  projectId: string,
  userId: string,
  deliveryId: string,
): Promise<void> {
  await getOwnedProject(projectId, userId);

  const delivery = await findDeliveryForProject(deliveryId, projectId);
  if (!delivery) throw new NotFoundError("Delivery");

  if (delivery.status !== "FAILED" && delivery.status !== "DELIVERED") {
    /**
     * Refusing rather than quietly succeeding. A delivery that is QUEUED or
     * PROCESSING is already in flight; resetting it would either send twice or
     * strand whatever currently holds it.
     */
    throw new ConflictError(
      `Only FAILED or DELIVERED deliveries can be replayed; this one is ${delivery.status}`,
    );
  }

  const replayed = await replayDelivery(deliveryId, projectId);
  if (!replayed) throw new ConflictError("Delivery could not be replayed");

  log.info({ projectId, deliveryId }, "Delivery queued for replay");
}

export async function getProjectStats(
  projectId: string,
  userId: string,
): Promise<Record<string, number>> {
  await getOwnedProject(projectId, userId);
  return deliveryStatsForProject(projectId);
}

function toEventSummary(event: EventWithCounts): EventSummary {
  const deliveries: Record<string, number> = {};
  for (const delivery of event.deliveries) {
    deliveries[delivery.status] = (deliveries[delivery.status] ?? 0) + 1;
  }

  return {
    id: event.id,
    eventType: event.eventType,
    createdAt: event.createdAt,
    deliveries,
  };
}

function toDeliveryView(delivery: DeliveryWithHistory): DeliveryView {
  return {
    id: delivery.id,
    status: delivery.status,
    attempt: delivery.attempt,
    webhook: delivery.webhook,
    nextRetryAt: delivery.nextRetryAt,
    lastError: delivery.lastError,
    responseStatus: delivery.responseStatus,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
    attempts: delivery.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      responseStatus: attempt.responseStatus,
      errorMessage: attempt.errorMessage,
      durationMs: attempt.durationMs,
      attemptedAt: attempt.attemptedAt,
    })),
  };
}
