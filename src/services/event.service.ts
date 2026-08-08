import {
  countDeliveriesForEvent,
  createEventWithDeliveries,
  findEventByIdempotencyKey,
  isUniqueConstraintError,
} from "../repositories/event.repository.js";
import { listActiveWebhookIds } from "../repositories/webhook.repository.js";
import { componentLogger } from "../utils/logger.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";

const log = componentLogger("events");

export interface PublishedEvent {
  id: string;
  eventType: string;
  createdAt: Date;
  /** How many webhooks this event fanned out to. */
  deliveryCount: number;
  /** True when an existing event was returned instead of a new one. */
  deduplicated: boolean;
}

/**
 * Accept an event.
 *
 * The most important thing this function does is what it *doesn't* do: it
 * makes no outbound HTTP call. Accepting an event means it is durably in
 * Postgres, not that it has been delivered. Sending to a customer endpoint can
 * take thirty seconds when that endpoint is unhealthy, and no publisher should
 * ever wait on that. Delivery is the scheduler's and the workers' problem.
 *
 * The project comes from the authenticated API key, never from the request
 * body. If callers could name a project, any valid key would be able to
 * publish into anyone else's.
 */
export async function publishEvent(
  projectId: string,
  eventType: string,
  payload: InputJsonValue,
  idempotencyKey?: string,
): Promise<PublishedEvent> {
  // Fast path for a client retrying a request it already made successfully.
  if (idempotencyKey) {
    const existing = await findEventByIdempotencyKey(projectId, idempotencyKey);
    if (existing) {
      log.info(
        { projectId, eventId: existing.id, idempotencyKey },
        "Duplicate publish ignored",
      );
      return {
        id: existing.id,
        eventType: existing.eventType,
        createdAt: existing.createdAt,
        deliveryCount: await countDeliveriesForEvent(existing.id),
        deduplicated: true,
      };
    }
  }

  const webhookIds = await listActiveWebhookIds(projectId);

  try {
    const { event, deliveryCount } = await createEventWithDeliveries({
      projectId,
      eventType,
      payload,
      idempotencyKey,
      webhookIds,
    });

    log.info(
      { projectId, eventId: event.id, eventType, deliveryCount },
      "Event published",
    );

    if (deliveryCount === 0) {
      // Worth surfacing: almost always a misconfiguration on the customer's
      // side, and otherwise invisible to them until they wonder why nothing
      // arrives.
      log.warn(
        { projectId, eventId: event.id },
        "Event stored with no active webhooks to deliver to",
      );
    }

    return {
      id: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt,
      deliveryCount,
      deduplicated: false,
    };
  } catch (error) {
    /**
     * Two requests carrying the same idempotency key can both pass the check
     * above before either inserts — a race the check alone cannot close. The
     * database's unique constraint is what actually enforces uniqueness; this
     * catch turns the resulting violation into the same answer the fast path
     * would have given.
     *
     * Relying on the constraint rather than a lock is deliberate: the
     * constraint is correct even across multiple API server processes, where
     * an in-process lock would not be.
     */
    if (idempotencyKey && isUniqueConstraintError(error)) {
      const existing = await findEventByIdempotencyKey(projectId, idempotencyKey);

      if (existing) {
        log.info(
          { projectId, eventId: existing.id, idempotencyKey },
          "Concurrent duplicate publish resolved",
        );
        return {
          id: existing.id,
          eventType: existing.eventType,
          createdAt: existing.createdAt,
          deliveryCount: await countDeliveriesForEvent(existing.id),
          deduplicated: true,
        };
      }
    }

    throw error;
  }
}
