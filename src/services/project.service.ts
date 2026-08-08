import {
  createProject,
  findProjectForUser,
  listProjectsForUser,
} from "../repositories/project.repository.js";
import {
  createApiKey,
  listApiKeysForProject,
  revokeApiKey,
} from "../repositories/api-key.repository.js";
import { generateApiKey } from "../utils/crypto.js";
import { NotFoundError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";
import type { ApiKey, Project } from "../generated/prisma/client.js";

const log = componentLogger("projects");

export async function createProjectForUser(
  userId: string,
  name: string,
): Promise<Project> {
  const project = await createProject(userId, name);
  log.info({ userId, projectId: project.id }, "Project created");
  return project;
}

export async function listProjects(userId: string): Promise<Project[]> {
  return listProjectsForUser(userId);
}

/**
 * Fetch a project, or throw if the caller has no business seeing it.
 *
 * Every route that operates inside a project funnels through here, so the
 * ownership check happens exactly once and cannot be skipped by a new endpoint
 * that forgets it.
 *
 * A project belonging to someone else raises NotFoundError, not
 * ForbiddenError. "Forbidden" would confirm the project exists.
 */
export async function getOwnedProject(
  projectId: string,
  userId: string,
): Promise<Project> {
  const project = await findProjectForUser(projectId, userId);
  if (!project) throw new NotFoundError("Project");
  return project;
}

/** An API key row as it is safe to list — no secret material. */
export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey {
  key: PublicApiKey;
  /**
   * The full key in clear. Present only in the response to creation — it is
   * never stored and can never be shown again.
   */
  plaintext: string;
}

export async function issueApiKey(
  projectId: string,
  userId: string,
  name: string,
): Promise<CreatedApiKey> {
  await getOwnedProject(projectId, userId);

  const generated = generateApiKey();

  const record = await createApiKey({
    projectId,
    name,
    hashedKey: generated.hashed,
    prefix: generated.prefix,
  });

  log.info({ projectId, apiKeyId: record.id }, "API key issued");

  return { key: toPublicApiKey(record), plaintext: generated.plaintext };
}

export async function listKeys(
  projectId: string,
  userId: string,
): Promise<PublicApiKey[]> {
  await getOwnedProject(projectId, userId);
  const keys = await listApiKeysForProject(projectId);
  return keys.map(toPublicApiKey);
}

export async function revokeKey(
  projectId: string,
  userId: string,
  keyId: string,
): Promise<void> {
  await getOwnedProject(projectId, userId);

  const revoked = await revokeApiKey(keyId, projectId);
  if (!revoked) throw new NotFoundError("API key");

  log.info({ projectId, apiKeyId: keyId }, "API key revoked");
}

function toPublicApiKey(key: ApiKey): PublicApiKey {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}
