import { randomBytes } from "node:crypto";
import {
  createWebhook,
  deleteWebhook,
  findWebhookForProject,
  listWebhooksForProject,
  updateWebhook,
  type UpdateWebhookInput,
} from "../repositories/webhook.repository.js";
import { getOwnedProject } from "./project.service.js";
import { checkWebhookUrl } from "../utils/url-safety.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { Webhook } from "../generated/prisma/client.js";

const log = componentLogger("webhooks");

/**
 * A webhook as returned to the caller.
 *
 * The signing secret is included — unlike an API key, the customer genuinely
 * needs it, because they must use it to verify the signature on every request
 * we send them. It is theirs, not ours, and it only ever travels to the
 * project that owns it.
 */
export interface PublicWebhook {
  id: string;
  url: string;
  secret: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const urlPolicy = {
  allowPrivate: env.ALLOW_PRIVATE_WEBHOOK_URLS,
  requireHttps: env.REQUIRE_HTTPS_WEBHOOKS,
};

/**
 * Reject URLs our own workers must never be pointed at.
 *
 * Applied on create *and* update — an endpoint that validated only on creation
 * could be registered as a harmless public URL and then edited to
 * http://169.254.169.254. See utils/url-safety.ts.
 */
function assertUrlAllowed(url: string): void {
  const rejection = checkWebhookUrl(url, urlPolicy);
  if (rejection) {
    throw new ValidationError("Invalid webhook URL", [{ path: "url", message: rejection }]);
  }
}

/**
 * 32 bytes of randomness, used in M4 to sign every outbound request with
 * HMAC-SHA256 so the receiver can prove the call came from us and was not
 * altered in transit.
 */
function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export async function registerWebhook(
  projectId: string,
  userId: string,
  url: string,
  description?: string,
): Promise<PublicWebhook> {
  await getOwnedProject(projectId, userId);
  assertUrlAllowed(url);

  const webhook = await createWebhook({
    projectId,
    url,
    secret: generateSigningSecret(),
    description,
  });

  log.info({ projectId, webhookId: webhook.id }, "Webhook registered");

  return toPublicWebhook(webhook);
}

export async function listWebhooks(
  projectId: string,
  userId: string,
): Promise<PublicWebhook[]> {
  await getOwnedProject(projectId, userId);
  const webhooks = await listWebhooksForProject(projectId);
  return webhooks.map(toPublicWebhook);
}

export async function getWebhook(
  projectId: string,
  userId: string,
  webhookId: string,
): Promise<PublicWebhook> {
  await getOwnedProject(projectId, userId);

  const webhook = await findWebhookForProject(webhookId, projectId);
  if (!webhook) throw new NotFoundError("Webhook");

  return toPublicWebhook(webhook);
}

export async function modifyWebhook(
  projectId: string,
  userId: string,
  webhookId: string,
  changes: UpdateWebhookInput,
): Promise<PublicWebhook> {
  await getOwnedProject(projectId, userId);

  if (changes.url !== undefined) assertUrlAllowed(changes.url);

  const webhook = await updateWebhook(webhookId, projectId, changes);
  if (!webhook) throw new NotFoundError("Webhook");

  log.info({ projectId, webhookId, changes: Object.keys(changes) }, "Webhook updated");

  return toPublicWebhook(webhook);
}

export async function removeWebhook(
  projectId: string,
  userId: string,
  webhookId: string,
): Promise<void> {
  await getOwnedProject(projectId, userId);

  const deleted = await deleteWebhook(webhookId, projectId);
  if (!deleted) throw new NotFoundError("Webhook");

  log.info({ projectId, webhookId }, "Webhook deleted");
}

function toPublicWebhook(webhook: Webhook): PublicWebhook {
  return {
    id: webhook.id,
    url: webhook.url,
    secret: webhook.secret,
    description: webhook.description,
    isActive: webhook.isActive,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}
