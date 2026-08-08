import { prisma } from "../config/database.js";
import type { Event } from "../generated/prisma/client.js";
import type { InputJsonValue } from "../generated/prisma/internal/prismaNamespace.js";

/**
 * Prisma reports a violated unique constraint as error code P2002.
 *
 * Checked structurally rather than by importing Prisma's error class, which
 * keeps this working across client regenerations and avoids reaching into the
 * generated client's internals.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export interface CreateEventInput {
  projectId: string;
  eventType: string;
  payload: InputJsonValue;
  idempotencyKey?: string | undefined;
  /** Webhook ids to fan out to. May be empty. */
  webhookIds: string[];
}

export interface CreatedEvent {
  event: Event;
  deliveryCount: number;
}

/**
 * Persist an event and its deliveries **atomically**.
 *
 * The transaction is the whole point of this function. An event and its
 * deliveries must both exist or neither must: if the process died between the
 * two writes, we would be left with an event that looks accepted but has no
 * delivery rows, so the scheduler would never pick it up and it would never be
 * sent. Silently. The customer received a 202 and nothing ever arrives.
 *
 * Wrapping both writes means a crash rolls the whole thing back, and the
 * client's retry — which is what a lost 202 provokes — creates it cleanly.
 */
export async function createEventWithDeliveries(
  input: CreateEventInput,
): Promise<CreatedEvent> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.create({
      data: {
        projectId: input.projectId,
        eventType: input.eventType,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    if (input.webhookIds.length === 0) {
      // A project with no active webhooks still gets the event stored. The
      // event is a fact that happened; having nowhere to send it does not make
      // it untrue, and a webhook registered later can replay it.
      return { event, deliveryCount: 0 };
    }

    // createMany issues a single multi-row INSERT rather than one statement
    // per webhook, which matters on the hot path.
    const result = await tx.delivery.createMany({
      data: input.webhookIds.map((webhookId) => ({
        eventId: event.id,
        webhookId,
      })),
    });

    return { event, deliveryCount: result.count };
  });
}

/**
 * Look up a previous event by its idempotency key.
 *
 * Scoped to the project: two customers independently choosing the key
 * "order-1" must not collide.
 */
export async function findEventByIdempotencyKey(
  projectId: string,
  idempotencyKey: string,
): Promise<Event | null> {
  return prisma.event.findFirst({ where: { projectId, idempotencyKey } });
}

export async function countDeliveriesForEvent(eventId: string): Promise<number> {
  return prisma.delivery.count({ where: { eventId } });
}
