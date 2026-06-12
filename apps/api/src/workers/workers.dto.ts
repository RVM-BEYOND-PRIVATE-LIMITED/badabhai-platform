import { z } from "zod";

/** True if the string contains any ASCII control character (C0 or DEL). */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * Set the worker's real name. Kept deliberately small: a single free-text name,
 * trimmed, bounded, and rejecting control characters. The value is PII and is
 * encrypted at rest by the service — it is never echoed back.
 */
export const SetWorkerNameSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(1, "full_name is required")
    .max(100, "full_name is too long")
    .refine((s) => !hasControlChars(s), "full_name must not contain control characters"),
});
export type SetWorkerNameDto = z.infer<typeof SetWorkerNameSchema>;
