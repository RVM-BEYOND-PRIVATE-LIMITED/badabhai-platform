import { z } from "zod";
import type { ProfileStatus } from "@badabhai/types";

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

/** The `trade` block of {@link WorkerProfileSummary}. Every part is nullable —
 * extraction may not have canonicalized yet; the client shows a "complete your
 * profile" hint on nulls. */
export interface WorkerProfileSummaryTrade {
  canonical_trade_id: string | null;
  canonical_role_id: string | null;
  display_name: string | null;
}

/**
 * Response of `GET /workers/me/profile-summary` (TD54 — the worker-app home
 * "my profile" card). Derived entirely from the worker's LATEST
 * `worker_profiles` row; carries NO PII (no name — an OPEN escalation, see
 * docs/worker-profile-summary-spec.md — and no phone/hash, ever). Not a Zod
 * schema: this is an output projection, not boundary input.
 */
export interface WorkerProfileSummary {
  /** `"none"` when the worker has no profile row yet. */
  profile_status: ProfileStatus | "none";
  /** ISO-8601, `null` until the profile is confirmed. */
  confirmed_at: string | null;
  trade: WorkerProfileSummaryTrade;
  /** First of `location_preference.preferred_cities`, `null` when absent/empty. */
  city: string | null;
  /** Recomputed on read (countFields-equivalent); `0` when no profile. Never stored. */
  strength: number;
}
