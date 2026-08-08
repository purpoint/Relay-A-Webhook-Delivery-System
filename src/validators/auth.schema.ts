import { z } from "zod";

/**
 * Validation for the auth endpoints.
 *
 * These schemas are the boundary between untrusted input and the rest of the
 * system: past this point, code can assume an email is shaped like an email
 * and a password meets policy, without re-checking.
 */

export const registerSchema = z.object({
  email: z.email("A valid email address is required").toLowerCase().trim(),

  /**
   * Length is the only rule enforced.
   *
   * Composition requirements — "one uppercase, one digit, one symbol" — are
   * counterproductive: they push people towards predictable substitutions like
   * "Password1!" while blocking genuinely strong passphrases. Both NIST and
   * OWASP now advise length minimums instead.
   *
   * The 72-byte ceiling is a real constraint of several password hashes and is
   * imposed here so the limit surfaces as a clear validation message rather
   * than a silent truncation deeper down.
   */
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(72, "Password must be at most 72 characters"),
});

export const loginSchema = z.object({
  email: z.email("A valid email address is required").toLowerCase().trim(),
  password: z.string().min(1, "Password is required"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
