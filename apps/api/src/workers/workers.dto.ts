import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { ProfileSource, ProfileStatus } from "@badabhai/types";

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
 * One half of the coarse home location captured beside the name (#1428).
 *
 * OPTIONAL, AND THE TWO HALVES ARE INDEPENDENT. The first onboarding screen resolves city+state
 * from the device or takes them by hand, and a manual entry can produce one without the other. An
 * omitted key leaves the stored value alone; this is a name endpoint that also accepts a location,
 * not a location endpoint.
 *
 * FREE TEXT, DELIBERATELY — and this is the one place this codebase does NOT resolve a city
 * against the gazetteer. `preferred_cities` 400s on anything outside the 36-value closed set
 * (#1406), which is right for a finishing-form field a worker reaches after committing. This is
 * screen ONE. The gazetteer is a closed set of manufacturing hubs by construction, so a worker in
 * Patna would be refused at the first thing the product ever asks him — and refused about the name
 * of the place he lives, which he is not wrong about. The service canonicalises the spelling when
 * the gazetteer happens to recognise it and stores what he typed when it does not.
 *
 * BOUNDED AND CONTROL-CHAR GUARDED like `full_name`, because it is the same class of input from
 * the same screen. 80 chars is far above any real Indian city or state name.
 *
 * NOT `.strict()` ON THE PARENT, and that is unchanged: this schema has always silently stripped
 * unknown keys, and making it strict now would turn a shipped client's extra field into a 400.
 */
function coarseLocationPart(field: "city" | "state") {
  return z
    .string()
    .trim()
    .min(1, `${field} must not be empty`)
    .max(80, `${field} is too long`)
    .refine((s) => !hasControlChars(s), `${field} must not contain control characters`)
    .refine((s) => !/^\d+$/.test(s), `${field} must not be digits only`)
    .optional();
}

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
  city: coarseLocationPart("city"),
  state: coarseLocationPart("state"),
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
 * ADR-0042 D9 / Layer A (a) — set, replace or clear the worker's optional WhatsApp number
 * (PUT /workers/me/whatsapp).
 *
 * `null` CLEARS. Unlike the preferences page there is no three-state subtlety: this PUT owns
 * the one value, and `null` and "unset" mean the same thing for a nullable column.
 *
 * THE NUMBER MUST BE E.164 (`+919876543210`) — the shared `e164PhoneSchema`, so the app
 * normalises and the server never guesses a country code. A guessed prefix stores a wrong
 * number on a résumé, which is worse than refusing the write. The value is PII: encrypted at
 * rest by the service, never echoed in the response, never logged, never evented.
 */
export const SetMyWhatsappSchema = z
  .object({
    whatsapp: e164PhoneSchema.nullable(),
  })
  .strict();
export type SetMyWhatsappDto = z.infer<typeof SetMyWhatsappSchema>;

/**
 * Response of `GET /workers/me/whatsapp` — the worker's OWN number, decrypted.
 *
 * `whatsapp` is null when nothing is on file OR when the stored token cannot be decrypted
 * (a retired key, a tampered row); `has_whatsapp` tells the two apart, so a client never
 * offers to "replace" a number that merely failed to read. The value never enters an event,
 * a log line or an AI boundary — this is a worker-self read.
 */
export interface MyWhatsappResponse {
  whatsapp: string | null;
  has_whatsapp: boolean;
}

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

/** The `profile` block of {@link WorkerProfileBundle}. */
export interface WorkerProfileBundleProfile {
  id: string;
  profile_status: ProfileStatus;
}

/** The `resume` block of {@link WorkerProfileBundle}. */
export interface WorkerProfileBundleResume {
  id: string;
  resume_text: string;
  version: number;
  /** 'pending' | 'rendered' | 'failed' — whether the PDF is downloadable yet. */
  render_status: string;
}

/**
 * Response of `GET /workers/me/profile` — the worker-self bundle the app uses to
 * restore `profileId` and reuse an already-generated resume. Either block is `null`
 * when the worker has no profile / no resume yet (never a 404).
 *
 * AN EXPLICIT ALLOWLIST, NOT THE ROW. The sibling ops route `GET /workers/:id/profile`
 * returns the raw Drizzle rows, which is tolerable behind `InternalServiceGuard` but
 * NOT on a worker-authed surface: `worker_profiles` carries the 768-dim `embedding`
 * (~10-15KB of JSON per call to a low-bandwidth mobile client), `raw_profile`, and
 * `rich_profile_draft` (the 28-field AI draft, including the model-authored
 * `clarification_questions` free text); `generated_resumes` carries `resume_json`,
 * `source_profile_snapshot` and `pdf_storage_key` (a private-bucket object key).
 * None of it is worker-visible content, and §9 is "never expose unnecessary data".
 *
 * Projecting field-by-field also means a column added to either table LATER cannot
 * silently join a public response — widening this is a decision, not an accident.
 * The PDF is fetched through the signed-URL route (ADR-0032), never via a raw key.
 */
export interface WorkerProfileBundle {
  profile: WorkerProfileBundleProfile | null;
  resume: WorkerProfileBundleResume | null;
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
   * Max possible strength (always 9 — the 9 field groups treated as binary, each
   * at most +1). Additive, backward-compatible: older clients ignore it.
   */
  strength_max: number;
  /**
   * Names of the 9 field-group slots that are empty/missing, for per-field hints
   * and the N/max meter. Each entry is a short canonical key:
   * "role" | "trade" | "skills" | "machines" | "experience" | "salary" | "location" | "availability" | "photo"
   */
  missing_fields: string[];
  /**
   * Whether the worker has uploaded a profile photo (boolean projection of the
   * photo POINTER — never the key/URL). TD77(b) — photo now counts toward
   * profile strength.
   */
  has_photo: boolean;
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
  /**
   * Highest academic level (e.g. "12th", "ITI", "B.Tech") and stream (e.g.
   * "Electronics", "Mechanical") — read defensively out of the `raw_profile`
   * JSONB (they are not projected columns). PII-FREE qualification labels, same
   * class as `skills`. `null` when unknown/no profile/malformed. Additive
   * (backward-compatible): older clients ignore them.
   */
  education_level: string | null;
  education_field: string | null;
  /**
   * Task 1 — which road produced this profile: `form` (trade-form road) or
   * `chat` (LLM-chat road). Written deterministically at extraction, read by
   * navigation and profile/resume screens so the two roads stop sharing one
   * flow. `null` when unknown (no profile row yet, or a pre-0107 row) —
   * clients must treat `null` as unknown, never as a road. Additive
   * (backward-compatible): older clients ignore it.
   */
  source: ProfileSource | null;
}

/**
 * ADR-0043 launch gate — `POST /workers/resume-erasure-backfill` (ops, InternalServiceGuard).
 *
 * `dry_run` HAS NO DEFAULT, on purpose. The caller states whether this call renders, so an empty
 * body (a probe, a typo) is a 400 rather than a read or a write. Paged by résumé id: pass the
 * previous response's `next_after` until it comes back null.
 */
export const ResumeErasureBackfillSchema = z
  .object({
    dry_run: z.boolean(),
    limit: z.number().int().min(1).max(500).default(100),
    after: z.string().uuid().nullable().default(null),
  })
  .strict();
export type ResumeErasureBackfillDto = z.infer<typeof ResumeErasureBackfillSchema>;

export interface ResumeErasureBackfillResponse {
  dry_run: boolean;
  /** Every résumé still stale when this call started, this page included. */
  stale: number;
  /** Résumés in this page. */
  batch: number;
  /** Fail-closed re-renders queued (or already waiting) by this call. Always 0 on a dry run. */
  enqueued: number;
  /** Résumés in this page whose re-render could not be queued; a later run picks them up. */
  failed: number;
  /** Pass as `after` for the next page; null when this page was the last. */
  next_after: string | null;
}
