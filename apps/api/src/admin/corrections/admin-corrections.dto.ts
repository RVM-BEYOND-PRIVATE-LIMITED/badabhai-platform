import { z } from "zod";
import { canonicalCity } from "@badabhai/profiling-lexicon";
import { LOCKED_FIELD_KEYS, WORKER_ADMIN_OVERRIDE_FACT_KEYS } from "@badabhai/db";
import { AdminPayerReasonTextSchema } from "../admin-payer-logins.dto";

/**
 * #2561 — the ADMIN CORRECTION contract (ADR-0062 §3.1/§3.4/§3.9).
 *
 * PR 1 exposes the LOCATION group (`current_city`, `preferred_locations`); the remaining §4
 * groups are opened by PR 2 by widening {@link CORRECTABLE_FACT_KEYS}. Every body is
 * `.strict()`, carries a closed reason code and a written reason (15–500 characters, no hard
 * identifiers — it lives on `audit_logs`), and the actor is always the session admin.
 *
 * The four LOCKED fields (`workers.full_name`, `phone_e164`, `whatsapp_enc`,
 * `resume_show_photo`) are accepted by the schema ONLY so the service can answer a deliberate
 * 400 instead of a generic enum error; they can never reach a write.
 */

/** PR 1's field group. PR 2 appends the remaining keys here. */
export const CORRECTABLE_FACT_KEYS = ["current_city", "preferred_locations"] as const;
export type CorrectableFactKey = (typeof CORRECTABLE_FACT_KEYS)[number];

const ALL_KEYS = [...CORRECTABLE_FACT_KEYS, ...LOCKED_FIELD_KEYS] as const;

export const ADMIN_CORRECTION_REASON_CODES = [
  "worker_request",
  "profile_correction",
  "verification_error",
  "other",
] as const;
export const AdminCorrectionReasonCode = z.enum(ADMIN_CORRECTION_REASON_CODES);
export type AdminCorrectionReasonCode = z.infer<typeof AdminCorrectionReasonCode>;

const reasonShape = {
  reason_code: AdminCorrectionReasonCode,
  reason_text: AdminPayerReasonTextSchema,
} as const;

/** One canonical city (the worker preference form's own rule: unknown is a 400, never dropped). */
const canonicalCitySchema = z.string().trim().min(1).max(80).transform((value, ctx) => {
  const city = canonicalCity(value)?.value ?? null;
  if (city === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unrecognised city: ${value}` });
    return z.NEVER;
  }
  return city;
});

const preferredLocationsSchema = z
  .array(canonicalCitySchema)
  .min(1)
  .max(5)
  // De-duplicate CASE-INSENSITIVELY, keeping the first spelling the admin sent: the canonical
  // resolver preserves the input's casing, so "Pune" and "pune" would otherwise both survive.
  .transform((values) => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/**
 * POST /admin/candidates/:id/corrections. `value` is validated BY FACT KEY in the service
 * (the schema only proves the key is one this endpoint may address), so a locked field gets a
 * named 400 rather than a value-shape error.
 */
export const AdminCorrectionCreateSchema = z
  .object({
    fact_key: z.enum(ALL_KEYS),
    value: z.unknown(),
    ...reasonShape,
  })
  .strict();
export type AdminCorrectionCreateDto = z.infer<typeof AdminCorrectionCreateSchema>;

/** POST /admin/candidates/:id/corrections/:factKey/revert */
export const AdminCorrectionRevertSchema = z.object(reasonShape).strict();
export type AdminCorrectionRevertDto = z.infer<typeof AdminCorrectionRevertSchema>;

export const AdminCorrectionParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminCorrectionParamsDto = z.infer<typeof AdminCorrectionParamsSchema>;

export const AdminCorrectionFactParamsSchema = z
  .object({ id: z.string().uuid(), factKey: z.enum(ALL_KEYS) })
  .strict();
export type AdminCorrectionFactParamsDto = z.infer<typeof AdminCorrectionFactParamsSchema>;

/** The value schema for one correctable key (the service validates against it). */
export function correctionValueSchema(factKey: CorrectableFactKey): z.ZodType<unknown> {
  return factKey === "current_city" ? canonicalCitySchema : preferredLocationsSchema;
}

export function isLockedField(key: string): boolean {
  return (LOCKED_FIELD_KEYS as readonly string[]).includes(key);
}

export function isCorrectableFact(key: string): key is CorrectableFactKey {
  return (CORRECTABLE_FACT_KEYS as readonly string[]).includes(key);
}

/** The §4 full key list, re-exported for the history/detail contract. */
export const ALL_WORKER_FACT_KEYS = WORKER_ADMIN_OVERRIDE_FACT_KEYS;

// ----- responses (ids, keys, timestamps; never a corrected value) ---------------------------

export interface AdminCorrectionResult {
  worker_id: string;
  fact_key: string;
  override_id: string;
  /** False on an idempotent no-op (the value already equals the live correction). */
  changed: boolean;
}

export interface AdminCorrectionHistoryItem {
  override_id: string;
  fact_key: string;
  admin_id: string;
  reason_code: string;
  reason_text: string;
  created_at: Date;
  superseded_at: Date | null;
  superseded_by_id: string | null;
  /** True for the one row currently effective. */
  live: boolean;
}
