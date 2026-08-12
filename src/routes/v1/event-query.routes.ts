import { z } from "zod";
import type { AppInstance } from "../../types/app.js";
import { requireUser } from "../../middleware/authenticate.js";
import { projectIdParamSchema } from "../../validators/project.schema.js";
import {
  getDelivery,
  getEvent,
  getEventDeliveries,
  getProjectStats,
  listProjectEvents,
  replay,
} from "../../services/event-query.service.js";
import { success } from "../../utils/response.js";

/**
 * Delivery history — the read side.
 *
 * All JWT-protected. Publishing is a machine's job; inspecting what happened
 * is a person's, and an API key deliberately cannot read this. A leaked key
 * should not expose the customer's event history.
 */

const listQuerySchema = z.object({
  // Capped: an unbounded limit lets one request ask for the whole table.
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
  eventType: z.string().trim().max(100).optional(),
});

const eventIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
  eventId: z.uuid("Invalid event id"),
});

const deliveryIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
  deliveryId: z.uuid("Invalid delivery id"),
});

export async function eventQueryRoutes(app: AppInstance): Promise<void> {
  app.addHook("preHandler", requireUser);

  const secured = [{ bearerAuth: [] }];

  app.get(
    "/projects/:projectId/events",
    {
      schema: {
        tags: ["events"],
        summary: "List published events",
        description:
          "Cursor-paginated. Pass the returned `nextCursor` back as `cursor` for " +
          "the next page — an offset would grow slower the deeper you page and " +
          "would repeat rows when new events arrive mid-paging.",
        security: secured,
        params: projectIdParamSchema,
        querystring: listQuerySchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);
      const query = listQuerySchema.parse(request.query);

      const page = await listProjectEvents(projectId, request.user.sub, query);

      return reply.send(success(page));
    },
  );

  app.get(
    "/projects/:projectId/events/:eventId",
    {
      schema: {
        tags: ["events"],
        summary: "Fetch one event, with its payload",
        security: secured,
        params: eventIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, eventId } = eventIdParamSchema.parse(request.params);

      const event = await getEvent(projectId, request.user.sub, eventId);

      return reply.send(success(event));
    },
  );

  app.get(
    "/projects/:projectId/events/:eventId/deliveries",
    {
      schema: {
        tags: ["events"],
        summary: "Delivery history for an event",
        description:
          "One delivery per webhook, each with its full attempt history — status " +
          "code, error and duration per attempt. This is the endpoint that answers " +
          "why a webhook did not arrive.",
        security: secured,
        params: eventIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, eventId } = eventIdParamSchema.parse(request.params);

      const deliveries = await getEventDeliveries(projectId, request.user.sub, eventId);

      return reply.send(success(deliveries));
    },
  );

  app.get(
    "/projects/:projectId/deliveries/:deliveryId",
    {
      schema: {
        tags: ["events"],
        summary: "Fetch one delivery",
        security: secured,
        params: deliveryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, deliveryId } = deliveryIdParamSchema.parse(request.params);

      const delivery = await getDelivery(projectId, request.user.sub, deliveryId);

      return reply.send(success(delivery));
    },
  );

  app.post(
    "/projects/:projectId/deliveries/:deliveryId/replay",
    {
      schema: {
        tags: ["events"],
        summary: "Queue a terminal delivery for another attempt",
        description:
          "Resets the row to PENDING and lets the scheduler pick it up; it sends " +
          "nothing directly, so a replay inherits the same window cap, backoff and " +
          "recovery as any other delivery. Only FAILED or DELIVERED can be " +
          "replayed — anything in flight returns 409.",
        security: secured,
        params: deliveryIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, deliveryId } = deliveryIdParamSchema.parse(request.params);

      await replay(projectId, request.user.sub, deliveryId);

      /**
       * 202, matching ingest. The delivery has been queued for another
       * attempt, not delivered — the scheduler picks it up on its next tick
       * and it takes the ordinary path from there.
       */
      return reply.code(202).send(success({ id: deliveryId, status: "PENDING" }));
    },
  );

  app.get(
    "/projects/:projectId/stats",
    {
      schema: {
        tags: ["events"],
        summary: "Delivery counts by status",
        security: secured,
        params: projectIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);

      const deliveries = await getProjectStats(projectId, request.user.sub);

      return reply.send(success({ deliveries }));
    },
  );
}
