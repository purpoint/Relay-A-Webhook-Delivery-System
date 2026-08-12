import type { AppInstance } from "../../types/app.js";
import { loginSchema, registerSchema } from "../../validators/auth.schema.js";
import { login, register } from "../../services/auth.service.js";
import {
  REFRESH_COOKIE_NAME,
  endSession,
  issueRefreshToken,
  refreshCookieOptions,
  refreshSession,
} from "../../services/session.service.js";
import { success } from "../../utils/response.js";
import { UnauthorizedError } from "../../utils/errors.js";
import { env } from "../../config/env.js";
import { requireUser } from "../../middleware/authenticate.js";

/**
 * Registration, login, refresh and logout.
 *
 * Two tokens with different jobs:
 *
 *   The access token is a JWT in the response body. The browser keeps it in
 *   memory only — never localStorage, where any injected script could read it.
 *   It lasts fifteen minutes.
 *
 *   The refresh token goes back as an httpOnly cookie, unreadable by
 *   JavaScript, and is exchanged for a new access token when the old one
 *   expires. It lasts a week and is revocable.
 *
 * The split means an XSS bug can steal at most fifteen minutes of access,
 * rather than a credential that works for a week.
 */
export async function authRoutes(app: AppInstance): Promise<void> {
  const rateLimit = {
    rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
  };

  app.post(
    "/register",
    {
      config: rateLimit,
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        description:
          "Returns an access token in the body and sets an httpOnly refresh cookie. " +
          "Passwords must be at least 12 characters; there are no composition rules, " +
          "which is current NIST and OWASP guidance.",
        body: registerSchema,
      },
    },
    async (request, reply) => {
      const { email, password } = registerSchema.parse(request.body);

      const { user } = await register(email, password);
      const token = await signToken(app, user.id, user.email);
      const refresh = await issueRefreshToken(user.id);

      return reply
        .setCookie(
          REFRESH_COOKIE_NAME,
          refresh.plaintext,
          refreshCookieOptions(refresh.expiresAt),
        )
        .code(201)
        .send(success({ user, token }));
    },
  );

  app.post(
    "/login",
    {
      config: rateLimit,
      schema: {
        tags: ["auth"],
        summary: "Sign in",
        description:
          "Returns an access token and sets an httpOnly refresh cookie. " +
          "An unknown email and a wrong password produce identical responses, " +
          "in identical time, so the endpoint cannot be used to discover which " +
          "addresses have accounts.",
        body: loginSchema,
      },
    },
    async (request, reply) => {
      const { email, password } = loginSchema.parse(request.body);

      const { user } = await login(email, password);
      const token = await signToken(app, user.id, user.email);
      const refresh = await issueRefreshToken(user.id);

      return reply
        .setCookie(
          REFRESH_COOKIE_NAME,
          refresh.plaintext,
          refreshCookieOptions(refresh.expiresAt),
        )
        .code(200)
        .send(success({ user, token }));
    },
  );

  /**
   * Exchange the refresh cookie for a new access token.
   *
   * Rate limited like login: this endpoint also accepts a credential, and an
   * attacker holding a stolen cookie should not be able to mint access tokens
   * without limit.
   */
  app.post(
    "/refresh",
    {
      config: rateLimit,
      schema: {
        tags: ["auth"],
        summary: "Exchange the refresh cookie for a new access token",
        description:
          "Reads the httpOnly refresh cookie; takes no body. Each use rotates the " +
          "token and revokes its predecessor, so presenting an already-exchanged " +
          "token means the cookie was copied — and every session for that account " +
          "is then revoked.",
      },
    },
    async (request, reply) => {
      const presented = request.cookies[REFRESH_COOKIE_NAME];

      if (!presented) throw new UnauthorizedError("No session");

      const result = await refreshSession(presented);
      const token = await signToken(app, result.userId, result.email);

      // The old cookie is now revoked, so it must be replaced rather than left
      // in place — the browser would otherwise present a dead token next time
      // and trigger the reuse alarm on a legitimate client.
      return reply
        .setCookie(
          REFRESH_COOKIE_NAME,
          result.refresh.plaintext,
          refreshCookieOptions(result.refresh.expiresAt),
        )
        .send(success({ token, user: { id: result.userId, email: result.email } }));
    },
  );

  app.post(
    "/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Sign out",
        description:
          "Revokes only the presented refresh token, so signing out on one device " +
          "leaves other devices signed in.",
      },
    },
    async (request, reply) => {
      const presented = request.cookies[REFRESH_COOKIE_NAME];

      if (presented) await endSession(presented);

      // Clear the cookie whether or not the token was valid, so a browser
      // holding something stale is not left presenting it forever.
      return reply
        .clearCookie(REFRESH_COOKIE_NAME, { path: "/api/v1/auth" })
        .send(success({ signedOut: true }));
    },
  );

  /**
   * Who am I?
   *
   * The frontend calls this after a refresh to populate its header without
   * having to decode the JWT itself.
   */
  app.get(
    "/me",
    {
      preHandler: requireUser,
      schema: {
        tags: ["auth"],
        summary: "The signed-in user",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      return reply.send(success({ id: request.user.sub, email: request.user.email }));
    },
  );
}

/**
 * Issue a signed access token.
 *
 * `sub` is the standard JWT claim for who the token is about. Nothing secret
 * goes in the payload — a JWT is signed, not encrypted, so anyone holding it
 * can read its contents.
 */
async function signToken(
  app: AppInstance,
  userId: string,
  email: string,
): Promise<string> {
  return app.jwt.sign({ sub: userId, email }, { expiresIn: env.JWT_EXPIRES_IN });
}
