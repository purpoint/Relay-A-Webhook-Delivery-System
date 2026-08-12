import { prisma } from "../config/database.js";
import type { RefreshToken } from "../generated/prisma/client.js";

/**
 * Storage for refresh tokens.
 *
 * Only hashes are held. Refresh tokens are 32 bytes of CSPRNG output, so like
 * API keys they carry enough entropy that a fast deterministic hash is both
 * sufficient and necessary — sufficient because there is nothing to brute
 * force, necessary because lookup must be a single indexed query.
 */

export interface CreateRefreshTokenInput {
  userId: string;
  hashedToken: string;
  expiresAt: Date;
}

export async function createRefreshToken(
  input: CreateRefreshTokenInput,
): Promise<RefreshToken> {
  return prisma.refreshToken.create({ data: input });
}

export async function findRefreshTokenByHash(
  hashedToken: string,
): Promise<RefreshToken | null> {
  /**
   * Deliberately returns revoked and expired rows too.
   *
   * Filtering them out here would lose the distinction between "no such
   * token" and "a token that was already used" — and the second is the signal
   * that a stolen cookie is being replayed. The service decides what to do
   * with each case.
   */
  return prisma.refreshToken.findUnique({ where: { hashedToken } });
}

/**
 * Rotate: revoke the presented token and record what replaced it.
 *
 * One transaction, so a crash cannot leave the old token valid alongside the
 * new one.
 */
export async function rotateRefreshToken(
  oldTokenId: string,
  next: CreateRefreshTokenInput,
): Promise<RefreshToken> {
  const [, created] = await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: oldTokenId },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({ data: next }),
  ]);

  await prisma.refreshToken.update({
    where: { id: oldTokenId },
    data: { replacedById: created.id },
  });

  return created;
}

export async function revokeRefreshToken(id: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every token a user holds.
 *
 * Used when a rotated token is presented a second time, which means the
 * cookie has been copied. At that point we cannot tell the thief from the
 * legitimate owner, so both are signed out and the real user logs in again.
 */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Housekeeping: expired rows serve no purpose and the table only grows. */
export async function deleteExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
