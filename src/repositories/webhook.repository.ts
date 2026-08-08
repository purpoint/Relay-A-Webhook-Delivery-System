import { prisma } from "../config/database.js";
import type { Webhook } from "../generated/prisma/client.js";

export interface CreateWebhookInput {
  projectId: string;
  url: string;
  secret: string;
  description?: string | undefined;
}

export async function createWebhook(input: CreateWebhookInput): Promise<Webhook> {
  return prisma.webhook.create({
    data: {
      projectId: input.projectId,
      url: input.url,
      secret: input.secret,
      description: input.description ?? null,
    },
  });
}

export async function listWebhooksForProject(projectId: string): Promise<Webhook[]> {
  return prisma.webhook.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The fan-out query.
 *
 * Run on every published event to decide how many Delivery rows to create.
 * Only `id` is selected — the event path has no use for URLs or secrets, and
 * not loading them keeps the row small and avoids secrets travelling further
 * than they must.
 */
export async function listActiveWebhookIds(projectId: string): Promise<string[]> {
  const rows = await prisma.webhook.findMany({
    where: { projectId, isActive: true },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function findWebhookForProject(
  webhookId: string,
  projectId: string,
): Promise<Webhook | null> {
  return prisma.webhook.findFirst({ where: { id: webhookId, projectId } });
}

export interface UpdateWebhookInput {
  url?: string | undefined;
  description?: string | null | undefined;
  isActive?: boolean | undefined;
}

export async function updateWebhook(
  webhookId: string,
  projectId: string,
  input: UpdateWebhookInput,
): Promise<Webhook | null> {
  // updateMany rather than update, so the projectId scope is part of the
  // WHERE clause instead of a separate ownership check that could be skipped.
  const result = await prisma.webhook.updateMany({
    where: { id: webhookId, projectId },
    data: {
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  if (result.count === 0) return null;

  return findWebhookForProject(webhookId, projectId);
}

export async function deleteWebhook(
  webhookId: string,
  projectId: string,
): Promise<boolean> {
  const result = await prisma.webhook.deleteMany({ where: { id: webhookId, projectId } });
  return result.count > 0;
}
