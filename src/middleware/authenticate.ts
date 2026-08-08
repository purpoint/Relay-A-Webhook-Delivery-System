import type { FastifyReply, FastifyRequest } from "fastify";
import { hashApiKey, isApiKeyFormat } from "../utils/crypto.js";
import {
  findActiveApiKeyByHash,
  touchApiKeyLastUsed,
} from "../repositories/api-key.repository.js";
import { UnauthorizedError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("auth");

/**
 * Relay has two kinds of caller, and they authenticate differently.
 *
 *   A human, through the dashboard, holds a short-lived JWT and manages
 *   projects, webhooks and keys.
 *
 *   A machine, running in the customer's own backend, holds a long-lived API
 *   key and may do exactly one thing: publish events.
 *
 * Keeping them separate is a containment measure. An API key sitting in a
 * customer's server config for two years is far more likely to leak than a
 * token that expires within the hour — so a leaked key must not be able to
 * create projects, read delivery history, or mint further keys.
 */

/**
 * Require a valid JWT. Attaches the caller to `request.user`.
 *
 * Used as a Fastify `preHandler`, which runs after the request is parsed but
 * before the route handler — so a handler behind this can assume it has an
 * authenticated user.
 */
export async function requireUser(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    // Deliberately vague: distinguishing "expired" from "malformed" from
    // "wrong signature" tells an attacker how close they are.
    throw new UnauthorizedError("A valid access token is required");
  }
}

/**
 * Require a valid API key, supplied in the `X-API-Key` header.
 *
 * Attaches the key and its project to `request.apiKey`, so the ingest handler
 * never has to work out which project an event belongs to — it is settled by
 * the credential itself and cannot be spoofed by the request body.
 */
export async function requireApiKey(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers["x-api-key"];
  const provided = Array.isArray(header) ? header[0] : header;

  if (!provided || !isApiKeyFormat(provided)) {
    throw new UnauthorizedError("A valid API key is required");
  }

  // Deterministic hash, so this is one indexed lookup rather than a scan.
  const record = await findActiveApiKeyByHash(hashApiKey(provided));

  if (!record) {
    log.warn({ prefix: provided.slice(0, 15) }, "Rejected unknown API key");
    throw new UnauthorizedError("A valid API key is required");
  }

  request.apiKey = {
    id: record.id,
    projectId: record.projectId,
    project: record.project,
  };

  /**
   * Record last-used without awaiting.
   *
   * This is a convenience for the dashboard, and it runs on the hottest path
   * in the system. Blocking every published event on a bookkeeping write would
   * add a round-trip to the critical path — and worse, a transient failure
   * here would reject an event we could otherwise have accepted.
   */
  void touchApiKeyLastUsed(record.id).catch((error: unknown) => {
    log.warn({ err: error, apiKeyId: record.id }, "Failed to update API key lastUsedAt");
  });
}
