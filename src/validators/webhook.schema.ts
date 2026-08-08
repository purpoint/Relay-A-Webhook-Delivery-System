import { z } from "zod";

/**
 * Shape checks only. Whether a URL is *safe* to point our workers at is a
 * separate question, answered by utils/url-safety.ts in the service — it
 * depends on runtime configuration, which a static schema cannot see.
 */
export const createWebhookSchema = z.object({
  url: z.url("Must be a valid URL").max(2048, "URL is too long"),
  description: z
    .string()
    .trim()
    .max(500, "Description must be at most 500 characters")
    .optional(),
});

export const updateWebhookSchema = z
  .object({
    url: z.url("Must be a valid URL").max(2048).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  // An empty body would be a no-op update that still returns 200, which reads
  // like success while changing nothing.
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export const webhookIdParamSchema = z.object({
  projectId: z.uuid("Invalid project id"),
  webhookId: z.uuid("Invalid webhook id"),
});
