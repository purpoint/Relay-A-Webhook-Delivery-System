import type { AppInstance } from "../../types/app.js";
import { requireApiKey } from "../../middleware/authenticate.js";
import { idempotencyKeySchema, publishEventSchema } from "../../validators/event.schema.js";
import { publishEvent } from "../../services/event.service.js";
import { success } from "../../utils/response.js";
import { UnauthorizedError } from "../../utils/errors.js";
import type { InputJsonValue } from "../../generated/prisma/internal/prismaNamespace.js";

/**
 * Event ingest — the hot path.
 *
 * This is the only route authenticated by API key rather than JWT, because it
 * is the only one a machine calls. Everything else in the API is a person
 * managing configuration; this is a customer's backend saying "something
 * happened", potentially millions of times.
 */
export async function eventRoutes(app: AppInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post("/events", async (request, reply) => {
    // requireApiKey guarantees this, but the type is optional because most
    // routes authenticate differently. Narrowing here keeps that honest rather
    // than asserting it away.
    if (!request.apiKey) throw new UnauthorizedError("A valid API key is required");

    const { eventType, payload } = publishEventSchema.parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);

    /**
     * The project comes from the credential, never the body.
     *
     * This is the single most important line in the file. If a caller could
     * name the target project, any valid API key would be able to publish
     * into every other customer's project.
     */
    const result = await publishEvent(
      request.apiKey.projectId,
      eventType,
      payload as InputJsonValue,
      idempotencyKey,
    );

    /**
     * 202 Accepted, not 201 Created.
     *
     * The distinction is real and worth being precise about: 201 would claim
     * the work is done. All we have done is durably store the event. Delivery
     * happens later, in a different process, and may take minutes or days if
     * the customer's endpoint is unhealthy. 202 says exactly that — accepted
     * for processing, outcome not yet known.
     */
    return reply.code(202).send(success(result));
  });
}
