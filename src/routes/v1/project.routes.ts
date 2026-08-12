import type { AppInstance } from "../../types/app.js";
import { requireUser } from "../../middleware/authenticate.js";
import {
  apiKeyIdParamSchema,
  createApiKeySchema,
  createProjectSchema,
  projectIdParamSchema,
} from "../../validators/project.schema.js";
import {
  createProjectForUser,
  getOwnedProject,
  issueApiKey,
  listKeys,
  listProjects,
  revokeKey,
} from "../../services/project.service.js";
import { success } from "../../utils/response.js";

/**
 * Project and API-key management.
 *
 * Every route here is behind a JWT — these are dashboard operations performed
 * by a person. An API key deliberately cannot reach any of them.
 */
export async function projectRoutes(app: AppInstance): Promise<void> {
  // Applies to every route registered in this plugin scope, so a new endpoint
  // added below is authenticated by default rather than by remembering to.
  app.addHook("preHandler", requireUser);

  /** Every route in this group needs a bearer token; stated once. */
  const secured = [{ bearerAuth: [] }];

  app.post(
    "/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "Create a project",
        security: secured,
        body: createProjectSchema,
      },
    },
    async (request, reply) => {
      const { name } = createProjectSchema.parse(request.body);

      const project = await createProjectForUser(request.user.sub, name);

      return reply.code(201).send(success(project));
    },
  );

  app.get(
    "/projects",
    {
      schema: {
        tags: ["projects"],
        summary: "List your projects",
        security: secured,
      },
    },
    async (request, reply) => {
      const projects = await listProjects(request.user.sub);
      return reply.send(success(projects));
    },
  );

  app.get(
    "/projects/:projectId",
    {
      schema: {
        tags: ["projects"],
        summary: "Fetch one project",
        description:
          "Returns 404 rather than 403 for a project belonging to someone else — " +
          "403 would confirm that the id is real.",
        security: secured,
        params: projectIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);

      const project = await getOwnedProject(projectId, request.user.sub);

      return reply.send(success(project));
    },
  );

  // ── API keys ──────────────────────────────────────────────────────────────

  app.post(
    "/projects/:projectId/api-keys",
    {
      schema: {
        tags: ["projects"],
        summary: "Mint an API key",
        description:
          "The plaintext key appears in this response and never again — only a " +
          "SHA-256 hash is stored, so it genuinely cannot be shown later. Lose it " +
          "and issue a new one.",
        security: secured,
        params: projectIdParamSchema,
        body: createApiKeySchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);
      const { name } = createApiKeySchema.parse(request.body);

      const { key, plaintext } = await issueApiKey(projectId, request.user.sub, name);

      return reply.code(201).send(
        success({
          ...key,
          plaintext,
          warning: "Store this key now. It cannot be retrieved again.",
        }),
      );
    },
  );

  app.get(
    "/projects/:projectId/api-keys",
    {
      schema: {
        tags: ["projects"],
        summary: "List API keys",
        description: "Shows only the visible prefix of each key, never the key itself.",
        security: secured,
        params: projectIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId } = projectIdParamSchema.parse(request.params);

      const keys = await listKeys(projectId, request.user.sub);

      return reply.send(success(keys));
    },
  );

  app.delete(
    "/projects/:projectId/api-keys/:keyId",
    {
      schema: {
        tags: ["projects"],
        summary: "Revoke an API key",
        description:
          "Revokes rather than deletes, so the record of which key published which " +
          "event survives. Revocation takes effect immediately.",
        security: secured,
        params: apiKeyIdParamSchema,
      },
    },
    async (request, reply) => {
      const { projectId, keyId } = apiKeyIdParamSchema.parse(request.params);

      await revokeKey(projectId, request.user.sub, keyId);

      return reply.send(success({ id: keyId, revoked: true }));
    },
  );
}
