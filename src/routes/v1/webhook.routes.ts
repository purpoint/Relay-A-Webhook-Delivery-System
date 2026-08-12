import type { AppInstance } from "../../types/app.js";
import { requireUser } from "../../middleware/authenticate.js";
import { projectIdParamSchema } from "../../validators/project.schema.js";
import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookIdParamSchema,
} from "../../validators/webhook.schema.js";
import {
  getWebhook,
  listWebhooks,
  modifyWebhook,
  registerWebhook,
  removeWebhook,
} from "../../services/webhook.service.js";
import { success } from "../../utils/response.js";

/**
 * Webhook management — all behind a JWT.
 *
 * Note what an API key deliberately cannot do here. A leaked key can publish
 * events, but it cannot read, add or repoint a webhook URL. If it could, an
 * attacker holding one could redirect a customer's entire event stream to a
 * server they control, and the customer would see nothing amiss.
 */
export async function webhookRoutes(app: AppInstance): Promise<void> {
  app.addHook("preHandler", requireUser);

  const secured = [{ bearerAuth: [] }];

  app.post(
    "/projects/:projectId/webhooks",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Register an endpoint",
        description:
          "URLs are checked against the SSRF guard: loopback, private ranges, " +
          "link-local and cloud metadata addresses are rejected, because this URL " +
          "is one our own workers will later fetch from inside our network. " +
          "Each webhook is issued a signing secret used to sign every delivery.",
        security: secured,
        params: projectIdParamSchema,
        body: createWebhookSchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);
      const { url, description } = createWebhookSchema.parse(request.body);

      const webhook = await registerWebhook(
        projectId,
        request.user.sub,
        url,
        description,
      );

      return reply.code(201).send(success(webhook));
    },
  );

  app.get(
    "/projects/:projectId/webhooks",
    {
      schema: {
        tags: ["webhooks"],
        summary: "List endpoints",
        security: secured,
        params: projectIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);

      const webhooks = await listWebhooks(projectId, request.user.sub);

      return reply.send(success(webhooks));
    },
  );

  app.get(
    "/projects/:projectId/webhooks/:webhookId",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Fetch one endpoint",
        security: secured,
        params: webhookIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, webhookId } = webhookIdParamSchema.parse(request.params);

      const webhook = await getWebhook(projectId, request.user.sub, webhookId);

      return reply.send(success(webhook));
    },
  );

  app.patch(
    "/projects/:projectId/webhooks/:webhookId",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Update an endpoint",
        description:
          "The URL is re-validated here as well as on creation. Checking only at " +
          "creation would allow a harmless public URL to be registered and then " +
          "edited to an internal address.",
        security: secured,
        params: webhookIdParamSchema,
        body: updateWebhookSchema,
      },
    },
    async (request, reply) => {
      const { projectId, webhookId } = webhookIdParamSchema.parse(request.params);
      const changes = updateWebhookSchema.parse(request.body);

      const webhook = await modifyWebhook(
        projectId,
        request.user.sub,
        webhookId,
        changes,
      );

      return reply.send(success(webhook));
    },
  );

  app.delete(
    "/projects/:projectId/webhooks/:webhookId",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Delete an endpoint",
        security: secured,
        params: webhookIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, webhookId } = webhookIdParamSchema.parse(request.params);

      await removeWebhook(projectId, request.user.sub, webhookId);

      return reply.send(success({ id: webhookId, deleted: true }));
    },
  );
}
