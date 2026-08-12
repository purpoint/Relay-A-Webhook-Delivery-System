import { randomBytes, createHash } from "node:crypto";
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../repositories/refresh-token.repository.js";
import { findUserById } from "../repositories/user.repository.js";
import { UnauthorizedError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const log = componentLogger("sessions");

/**
 * Refresh tokens.
 *
 * Access tokens are JWTs — self-contained, verified by signature alone, and so
 * impossible to revoke before they expire. That is an acceptable property only
 * because they live fifteen minutes and never leave browser memory.
 *
 * A credential lasting a week cannot work that way. Refresh tokens are
 * therefore opaque random strings backed by a database row, which means they
 * can be revoked the moment something looks wrong.
 */

export const REFRESH_COOKIE_NAME = "relay_refresh";

export interface IssuedRefreshToken {
  /** Sent to the browser in an httpOnly cookie. Never stored in clear. */
  plaintext: string;
  expiresAt: Date;
}

/** Deterministic, so the token can be found by one indexed lookup. */
function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function expiryDate(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function issueRefreshToken(userId: string): Promise<IssuedRefreshToken> {
  const plaintext = randomBytes(32).toString("base64url");
  const expiresAt = expiryDate();

  await createRefreshToken({ userId, hashedToken: hashToken(plaintext), expiresAt });

  return { plaintext, expiresAt };
}

export interface RefreshResult {
  userId: string;
  email: string;
  refresh: IssuedRefreshToken;
}

/**
 * Exchange a refresh token for a new access token and a new refresh token.
 *
 * The old token is revoked in the same step. This is **rotation**, and it is
 * what turns a stolen cookie from a permanent compromise into a detectable
 * one.
 *
 * Without rotation, a copied refresh token works for its full lifetime and
 * nothing in the system ever notices. With it, the thief and the real user end
 * up racing: whoever refreshes second presents a token that has already been
 * used, and that second use is a signal no legitimate client can produce.
 */
export async function refreshSession(plaintext: string): Promise<RefreshResult> {
  const record = await findRefreshTokenByHash(hashToken(plaintext));

  if (!record) {
    throw new UnauthorizedError("Invalid session");
  }

  if (record.revokedAt) {
    /**
     * Reuse detection.
     *
     * This token was already exchanged. A well-behaved client discards a token
     * the moment it swaps it, so presenting one twice means two parties hold
     * the same cookie — it was copied.
     *
     * We cannot tell which of them is the real user, so every session for the
     * account is revoked and both are signed out. The owner logs in again,
     * mildly inconvenienced; the thief is left with nothing.
     */
    const revoked = await revokeAllForUser(record.userId);

    log.warn(
      { userId: record.userId, sessionsRevoked: revoked },
      "Refresh token reused after rotation — all sessions revoked",
    );

    throw new UnauthorizedError("Session expired, please sign in again");
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw new UnauthorizedError("Session expired, please sign in again");
  }

  const user = await findUserById(record.userId);
  if (!user) throw new UnauthorizedError("Invalid session");

  const plaintextNext = randomBytes(32).toString("base64url");
  const expiresAt = expiryDate();

  await rotateRefreshToken(record.id, {
    userId: user.id,
    hashedToken: hashToken(plaintextNext),
    expiresAt,
  });

  return {
    userId: user.id,
    email: user.email,
    refresh: { plaintext: plaintextNext, expiresAt },
  };
}

/**
 * Sign out.
 *
 * Revokes only the presented token, so signing out on a laptop does not sign
 * you out on a phone. An unknown token is not an error — the caller wanted to
 * end a session and there is no session, which is the requested outcome.
 */
export async function endSession(plaintext: string): Promise<void> {
  const record = await findRefreshTokenByHash(hashToken(plaintext));
  if (!record || record.revokedAt) return;

  await revokeRefreshToken(record.id);
  log.info({ userId: record.userId }, "Session ended");
}

/** Cookie attributes, in one place so they cannot drift between routes. */
export function refreshCookieOptions(expiresAt: Date) {
  return {
    /** JavaScript cannot read it, so an XSS bug cannot steal it. */
    httpOnly: true,
    /** HTTPS only in production; relaxed locally, where there is no TLS. */
    secure: env.NODE_ENV === "production",
    /**
     * Not sent on cross-site requests, which is what makes CSRF a non-issue
     * here. Workable precisely because the frontend is served from the same
     * origin as the API — a separate frontend host would need "lax" or "none"
     * and explicit CSRF tokens.
     */
    sameSite: "strict" as const,
    /** Scoped to the refresh endpoints; not sent with every API call. */
    path: "/api/v1/auth",
    expires: expiresAt,
  };
}
