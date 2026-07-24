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

/**
 * Update the worker's resume display prefs (PATCH /workers/me/resume-prefs — the
 * "Aap control karte hain" edit screen). Both flags optional; at least one must be
 * present so an empty PATCH is a 400 rather than a silent no-op event. NON-PII.
 */
export const UpdateResumePrefsSchema = z
  .object({
    show_photo: z.boolean().optional(),
    night_shift_ready: z.boolean().optional(),
  })
  .strict()
  .refine(
    (o) => o.show_photo !== undefined || o.night_shift_ready !== undefined,
    "at least one of show_photo / night_shift_ready is required",
  );
export type UpdateResumePrefsDto = z.infer<typeof UpdateResumePrefsSchema>;

/**
 * ADR-0032 — confirm a profile-photo upload (POST /workers/me/photo). The client
 * registers the `storage_path` it was MINTED (upload-url response); the service
 * re-verifies it against the minted-key shape for THIS worker (anti-forgery, the
 * voice-seam pattern) and validates the uploaded object (mime/size) before
 * persisting the pointer. Never a URL; never client-chosen.
 */
export const ConfirmPhotoSchema = z
  .object({
    storage_path: z
      .string()
      .trim()
      .min(1, "storage_path is required")
      .max(512, "storage_path is too long")
      .refine((s) => !hasControlChars(s), "storage_path must not contain control characters"),
  })
  .strict();
export type ConfirmPhotoDto = z.infer<typeof ConfirmPhotoSchema>;

/**
 * Response of `GET /workers/me/resume-fields` — the worker-editable "safe fields"
 * loaded into the edit screen. Unlike the faceless profile-summary, this DOES
 * return the worker's OWN name (`full_name`) so they can correct its spelling —
 * a self-read of one's own name is not a cross-actor PII leak, and it never
 * reaches an LLM/event/log/ai_jobs. `full_name` is `null` until a name is set.
 * `has_photo` (ADR-0032) is a boolean projection of the photo POINTER — never
 * the key or a URL. Not a Zod schema: an output projection, not boundary input.
 */
export interface WorkerResumeFields {
  full_name: string | null;
  show_photo: boolean;
  night_shift_ready: boolean;
  has_photo: boolean;
}

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
  /**
   * Max possible strength (always 8 — the 8 field groups treated as binary, each
   * at most +1). Additive, backward-compatible: older clients ignore it.
   */
  strength_max: number;
  /**
   * Names of the 8 field-group slots that are empty/missing, for per-field hints
   * and the N/max meter. Each entry is a short canonical key:
   * "role" | "trade" | "skills" | "machines" | "experience" | "salary" | "location" | "availability"
   */
  missing_fields: string[];
  /**
   * Worker-confirmed canonical skill labels from the latest profile (e.g.
   * "CNC operating", "GD&T"). PII-FREE by construction — canonical taxonomy
   * labels, never a name/phone/employer. `[]` when none/no profile. Additive
   * (backward-compatible): older clients ignore it.
   */
  skills: string[];
  /** Canonical machine labels (e.g. "VMC", "Lathe"). PII-FREE; `[]` when none. */
  machines: string[];
  /**
   * `experience.total_years` — a NUMBER only. The free-text `experience.summary`
   * is deliberately NOT projected: it can carry §2 PII (employer names). `null`
   * when unknown/no profile.
   */
  experience_years: number | null;
}
