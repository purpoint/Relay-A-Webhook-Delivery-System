import { z } from "zod";

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(100, "Project name must be at most 100 characters"),
});

export const createApiKeySchema = z.object({
  /**
   * A label for the key, so a project with several can tell them apart
   * ("production", "staging") — the key itself is never visible again after
   * creation, so this is the only way to identify one later.
   */
  name: z
    .string()
    .trim()
    .min(1, "Key name is required")
    .max(100, "Key name must be at most 100 characters"),
});

/**
 * Path parameters arrive as strings. Validating them as UUIDs here means a
 * malformed id is a clean 400 rather than a database error surfacing as a 500.
 */
export const projectIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
});

export const apiKeyIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
  keyId: z.uuid("Invalid API key id"),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
