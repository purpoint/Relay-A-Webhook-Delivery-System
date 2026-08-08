import { prisma } from "../config/database.js";
import type { ApiKey, Project } from "../generated/prisma/client.js";

/** An API key together with the project it authenticates. */
export type ApiKeyWithProject = ApiKey & { project: Project };

export interface CreateApiKeyInput {
  projectId: string;
  name: string;
  hashedKey: string;
  prefix: string;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<ApiKey> {
  return prisma.apiKey.create({ data: input });
}

/**
 * Resolve an incoming API key to its project.
 *
 * This runs on every published event, so it is the hottest query in the
 * system. It stays a single indexed lookup because `hashedKey` is a
 * deterministic SHA-256 with a unique constraint on it — see the note in
 * utils/crypto.ts on why API keys are not Argon2-hashed.
 *
 * Revoked keys are filtered out here rather than by the caller, so there is no
 * path that authenticates a revoked key by forgetting to check.
 */
export async function findActiveApiKeyByHash(
  hashedKey: string,
): Promise<ApiKeyWithProject | null> {
  return prisma.apiKey.findFirst({
    where: { hashedKey, revokedAt: null },
    include: { project: true },
  });
}

export async function listApiKeysForProject(projectId: string): Promise<ApiKey[]> {
  return prisma.apiKey.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Record that a key was just used.
 *
 * Deliberately fire-and-forget at the call site: this is a convenience for the
 * dashboard ("last used 3 minutes ago"), and an event must never fail to be
 * accepted because a bookkeeping write had a bad moment.
 */
export async function touchApiKeyLastUsed(id: string): Promise<void> {
  await prisma.apiKey.update({
    where: { id },
    data: { lastUsedAt: new Date() },
  });
}

/**
 * Revoke rather than delete. The audit trail of which key published which
 * event stays intact, and revocation is immediate because
 * findActiveApiKeyByHash filters on revokedAt.
 */
export async function revokeApiKey(id: string, projectId: string): Promise<boolean> {
  const result = await prisma.apiKey.updateMany({
    where: { id, projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}
