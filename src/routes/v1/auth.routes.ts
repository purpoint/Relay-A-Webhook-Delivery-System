import type { AppInstance } from "../../types/app.js";
import { loginSchema, registerSchema } from "../../validators/auth.schema.js";
import { login, register } from "../../services/auth.service.js";
import { success } from "../../utils/response.js";
import { env } from "../../config/env.js";

/**
 * Registration and login.
 *
 * Handlers stay thin on purpose: validate, call a service, shape a response.
 * All the rules live in the service, which is what lets the same logic be
 * exercised by tests without an HTTP server.
 */
export async function authRoutes(app: AppInstance): Promise<void> {
  /**
   * Auth endpoints get a far tighter rate limit than the global default.
   *
   * They are the natural target for credential stuffing — replaying millions
   * of leaked email/password pairs. Argon2 makes each attempt expensive for us
   * as well as the attacker, so an unthrottled login endpoint is also a way to
   * exhaust our own CPU.
   */
  const authRateLimit = {
    config: {
      rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
    },
  };

  app.post("/register", authRateLimit, async (request, reply) => {
    const { email, password } = registerSchema.parse(request.body);

    const { user } = await register(email, password);
    const token = await signToken(app, user.id, user.email);

    return reply.code(201).send(success({ user, token }));
  });

  app.post("/login", authRateLimit, async (request, reply) => {
    const { email, password } = loginSchema.parse(request.body);

    const { user } = await login(email, password);
    const token = await signToken(app, user.id, user.email);

    return reply.code(200).send(success({ user, token }));
  });
}

/**
 * Issue a signed access token.
 *
 * `sub` (subject) is the standard JWT claim for "who this token is about".
 * Nothing secret goes in the payload — a JWT is signed, not encrypted, so
 * anyone holding it can read its contents.
 */
async function signToken(
  app: AppInstance,
  userId: string,
  email: string,
): Promise<string> {
  return app.jwt.sign({ sub: userId, email }, { expiresIn: env.JWT_EXPIRES_IN });
}
