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

/**
 * Worker SELF-service name capture (PATCH /workers/me/name). Tighter than the ops
 * {@link SetWorkerNameSchema}: 1–80 chars and rejects an all-digits string (a name
 * is not a number — catches a fat-fingered phone/id). Control chars rejected; the
 * value is PII, encrypted at rest by the service, and never echoed back.
 */
export const SetMyNameSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(1, "full_name is required")
    .max(80, "full_name is too long")
    .refine((s) => !hasControlChars(s), "full_name must not contain control characters")
    .refine((s) => !/^\d+$/.test(s), "full_name must not be digits only"),
});
export type SetMyNameDto = z.infer<typeof SetMyNameSchema>;
