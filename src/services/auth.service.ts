import { hashPassword, verifyPassword } from "../utils/crypto.js";
import { createUser, emailExists, findUserByEmail } from "../repositories/user.repository.js";
import { ConflictError, UnauthorizedError } from "../utils/errors.js";
import { componentLogger } from "../utils/logger.js";

const log = componentLogger("auth");

/**
 * The user as it is safe to send back over the wire — no password hash.
 *
 * Building this explicitly, rather than deleting fields from the database row,
 * means a column added to the schema later is not accidentally exposed. The
 * safe shape is opt-in.
 */
export interface PublicUser {
  id: string;
  email: string;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
}

/**
 * A precomputed Argon2 hash of a value nobody knows.
 *
 * Used to equalise the cost of logging in with an unknown email against a
 * known one — see the comment in `login` for why that matters.
 */
const DUMMY_HASH_PROMISE = hashPassword("relay-timing-equaliser-not-a-real-password");

export async function register(email: string, password: string): Promise<AuthResult> {
  if (await emailExists(email)) {
    /**
     * This does tell an attacker the address is registered, which is a real
     * disclosure. It is accepted because the alternative — silently pretending
     * to succeed — leaves a legitimate user with no way to understand why they
     * cannot log in afterwards. Registration is also rate limited, which is
     * the control that actually makes bulk enumeration impractical.
     */
    throw new ConflictError("An account with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({ email, passwordHash });

  log.info({ userId: user.id }, "User registered");

  return { user: toPublicUser(user) };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await findUserByEmail(email);

  if (!user) {
    /**
     * Verify against a dummy hash before failing.
     *
     * Without this, an unknown email returns immediately while a known one
     * spends ~50ms computing Argon2. That difference is easily measurable over
     * the network, and turns the login endpoint into an oracle for which
     * addresses have accounts. Doing the same work in both branches removes
     * the signal.
     */
    await verifyPassword(await DUMMY_HASH_PROMISE, password);
    log.warn({ email }, "Login attempt for unknown email");
    throw new UnauthorizedError("Invalid email or password");
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    log.warn({ userId: user.id }, "Login attempt with incorrect password");
    // Identical message to the unknown-email case, for the same reason.
    throw new UnauthorizedError("Invalid email or password");
  }

  log.info({ userId: user.id }, "User logged in");

  return { user: toPublicUser(user) };
}

export function toPublicUser(user: {
  id: string;
  email: string;
  createdAt: Date;
}): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}
