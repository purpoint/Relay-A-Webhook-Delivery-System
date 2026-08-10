import type { AppInstance } from "../../types/app.js";
import { authRoutes } from "./auth.routes.js";
import { projectRoutes } from "./project.routes.js";
import { webhookRoutes } from "./webhook.routes.js";
import { eventRoutes } from "./event.routes.js";
import { eventQueryRoutes } from "./event-query.routes.js";

/**
 * Everything under /api/v1.
 *
 * Routes are grouped into separate Fastify plugins rather than registered flat,
 * because a plugin is an isolated scope: the `preHandler` hook that requires a
 * JWT inside projectRoutes applies to that group alone and cannot leak into
 * the auth routes, where demanding a token would make login impossible.
 *
 * That isolation is what allows eventRoutes to require an API key while its
 * siblings require a JWT, with no risk of one group's authentication being
 * applied to the other.
 */
export async function v1Routes(app: AppInstance): Promise<void> {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(projectRoutes);
  await app.register(webhookRoutes);
  await app.register(eventRoutes);
  await app.register(eventQueryRoutes);
}
