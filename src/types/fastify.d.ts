import type { Project } from "../generated/prisma/client.js";

/**
 * Type augmentation for request properties Relay's middleware attaches.
 *
 * Without this, `request.apiKey` would be a type error — Fastify has no idea
 * our middleware puts it there. Declaring it here means the compiler enforces
 * that handlers only read what authentication actually provides.
 */

declare module "@fastify/jwt" {
  interface FastifyJWT {
    /** What we put into a token when signing it. */
    payload: { sub: string; email: string };
    /** What `request.user` holds after a successful jwtVerify(). */
    user: { sub: string; email: string };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by the API-key middleware on the ingest path.
     *
     * Optional because most routes authenticate with a JWT instead, so a
     * handler must narrow before using it — which is the point: the type
     * system won't let an endpoint assume a credential it never required.
     */
    apiKey?: {
      id: string;
      projectId: string;
      project: Project;
    };
  }
}

export {};
