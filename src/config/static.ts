import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppInstance } from "../types/app.js";

/**
 * Serves the built monitor page from the API process.
 *
 * Same origin as the API, which is what removes CORS from the picture
 * entirely — no preflight requests, no origin allowlist to maintain, and,
 * more importantly, it lets the refresh cookie use SameSite=Strict. A
 * separately hosted frontend would need SameSite=Lax or None and explicit
 * CSRF protection to go with it.
 *
 * It also means one service to deploy rather than two.
 */
export async function registerStatic(app: AppInstance): Promise<boolean> {
  // dist/config/static.js at runtime, src/config/static.ts under tsx — the
  // built frontend sits at the project root either way.
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "public");

  if (!existsSync(root)) {
    /**
     * Not an error. The API is perfectly usable without the frontend, and
     * requiring a build step before the server would start would be a poor
     * trade for anyone working on the backend alone.
     */
    app.log.info(
      { expected: root },
      "No built frontend found — run `npm run build:web` to serve the monitor",
    );
    return false;
  }

  /**
   * A wildcard GET route at the root.
   *
   * Safe to register before the API routes: Fastify's router matches specific
   * paths ahead of wildcards, so /api/v1/... still reaches its own handler.
   *
   * The single-page fallback deliberately lives in the error handler rather
   * than here. Fastify permits only one not-found handler per prefix, and the
   * error handler already owns it — two registrations for the same prefix is a
   * startup failure.
   */
  await app.register(fastifyStatic, { root, prefix: "/" });

  app.log.info({ root }, "Serving monitor page");
  return true;
}
