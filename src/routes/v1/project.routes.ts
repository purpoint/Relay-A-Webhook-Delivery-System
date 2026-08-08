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

  app.post("/projects", async (request, reply) => {
    const { name } = createProjectSchema.parse(request.body);

    const project = await createProjectForUser(request.user.sub, name);

    return reply.code(201).send(success(project));
  });

  app.get("/projects", async (request, reply) => {
    const projects = await listProjects(request.user.sub);
    return reply.send(success(projects));
  });

  app.get("/projects/:projectId", async (request, reply) => {
    const { projectId } = projectIdParamSchema.parse(request.params);

    const project = await getOwnedProject(projectId, request.user.sub);

    return reply.send(success(project));
  });

  // ── API keys ──────────────────────────────────────────────────────────────

  app.post("/projects/:projectId/api-keys", async (request, reply) => {
    const { projectId } = projectIdParamSchema.parse(request.params);
    const { name } = createApiKeySchema.parse(request.body);

    const { key, plaintext } = await issueApiKey(projectId, request.user.sub, name);

    /**
     * The only moment the full key exists outside the caller's own records.
     * We store a hash, so if this response is lost the key is unrecoverable
     * and a new one must be issued — which is the intended property.
     */
    return reply.code(201).send(
      success({
        ...key,
        plaintext,
        warning: "Store this key now. It cannot be retrieved again.",
      }),
    );
  });

  app.get("/projects/:projectId/api-keys", async (request, reply) => {
    const { projectId } = projectIdParamSchema.parse(request.params);

    const keys = await listKeys(projectId, request.user.sub);

    return reply.send(success(keys));
  });

  app.delete("/projects/:projectId/api-keys/:keyId", async (request, reply) => {
    const { projectId, keyId } = apiKeyIdParamSchema.parse(request.params);

    await revokeKey(projectId, request.user.sub, keyId);

    return reply.send(success({ id: keyId, revoked: true }));
  });
}
