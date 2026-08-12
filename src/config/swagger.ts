import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import type { AppInstance } from "../types/app.js";
import { env, isProduction } from "./env.js";

/**
 * Interactive API documentation.
 *
 * Until the M6 monitor exists this is the only interface to Relay that is not
 * curl, and it doubles as the reference a customer integrating against the API
 * would read.
 */
export async function registerSwagger(app: AppInstance): Promise<void> {
  await app.register(swagger, {
    /**
     * Converts the Zod schemas attached to each route into the JSON Schema
     * OpenAPI expects.
     *
     * Without this, routes carry no schema Fastify can read, so every endpoint
     * appeared under "default" with "No parameters" and no request body to
     * edit — documentation that described nothing and could not be used to try
     * anything.
     *
     * Deriving the docs from the same Zod schemas that perform validation
     * means the two cannot disagree. Hand-written JSON Schema alongside them
     * would be a second source of truth, and it would drift the first time
     * someone changed a field in one place only.
     */
    transform: jsonSchemaTransform,

    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Relay API",
        version: "0.1.0",
        description: [
          "A webhook delivery platform with durable event storage and a bounded",
          "Redis execution window.",
          "",
          "**Two credential types, and they are not interchangeable.**",
          "",
          "- `bearerAuth` — a JWT from `/auth/login`, for management endpoints.",
          "  Short-lived, held by a person.",
          "- `apiKey` — the `X-API-Key` header, for `POST /events` only. Long-lived,",
          "  held by a machine.",
          "",
          "The split limits the damage from a leaked API key: it can publish events",
          "and nothing else. It cannot read delivery history, repoint a webhook, or",
          "mint further keys.",
          "",
          "**Publishing returns 202, not 201.** Acceptance means the event is durably",
          "stored in Postgres, not that it has been delivered. Delivery happens in a",
          "separate process and may take minutes or days if the endpoint is unhealthy.",
        ].join("\n"),
      },
      servers: [{ url: `http://localhost:${String(env.PORT)}`, description: "Local" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "A token from POST /api/v1/auth/login.",
          },
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
            description:
              "A project API key, shown once at creation. Valid only for POST /events.",
          },
        },
      },
      tags: [
        { name: "auth", description: "Registration and login" },
        { name: "projects", description: "Projects and API keys" },
        { name: "webhooks", description: "Endpoint registration" },
        { name: "events", description: "Publishing and history" },
        { name: "health", description: "Liveness and readiness" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  app.log.info(
    { url: `http://localhost:${String(env.PORT)}/docs` },
    isProduction
      ? "API documentation available"
      : "API documentation available — open this in a browser",
  );
}
