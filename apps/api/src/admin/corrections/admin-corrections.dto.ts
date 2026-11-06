import { z } from "zod";
import { canonicalCity } from "@badabhai/profiling-lexicon";
import { DOMAINS, ROLES } from "@badabhai/taxonomy";
import { LOCKED_FIELD_KEYS, WORKER_ADMIN_OVERRIDE_FACT_KEYS } from "@badabhai/db";
import { AdminPayerReasonTextSchema } from "../admin-payer-logins.dto";
import { SetMyEmploymentSchema } from "../../profiles/worker-employment.dto";
import {
  CERTIFICATES_MAX,
  CertificateEntrySchema,
  EDUCATIONS_MAX,
  EducationEntrySchema,
  TRAININGS_MAX,
  TrainingEntrySchema,
  optionsOf,
} from "../../profiles/worker-qualifications.dto";
import { SetMyLanguagesSchema } from "../../profiles/worker-languages.dto";
import {
  AVAILABILITY_STATUSES,
  DOCUMENTS_READY,
  JOB_TYPES,
  SALARY_PERIODS,
  SHIFTS,
  WORK_TYPES,
} from "../../profiles/worker-preferences.vocabulary";

/**
 * #2561 — the ADMIN CORRECTION contract (ADR-0062 §3.1/§3.4/§3.9).
 *
 * PR 1 exposed the LOCATION group; PR 2 opens every remaining §4 fact key. Every body is
 * `.strict()`, carries a closed reason code and a written reason (15–500 characters, no hard
 * identifiers — it lives on `audit_logs`), and the actor is always the session admin.
 *
 * THE VALUE SHAPES ARE THE WORKER'S OWN. Trade/role/secondary-role ids are the closed taxonomy
 * ids; skills are `skill_*` ids (existence checked in the service, because the skill corpus is
 * a database vocabulary, not the small in-code placeholder); work history, qualifications and
 * languages reuse the PUT schemas verbatim, so a correction cannot accept a row the worker's own
 * page would reject. A salary correction carries both ends of the band, because writing only the
 * attribute pair would leave the DraftProfile container visible (ADR-0062 §3.2).
 *
 * The four LOCKED fields (`workers.full_name`, `phone_e164`, `whatsapp_enc`,
 * `resume_show_photo`) are accepted by the schema ONLY so the service can answer a deliberate
 * 400 instead of a generic enum error; they can never reach a write.
 */

export const CORRECTABLE_FACT_KEYS = WORKER_ADMIN_OVERRIDE_FACT_KEYS;
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

/** The closed id spaces the profile columns already use (`dom_*` / `role_*`). */
const DOMAIN_IDS = DOMAINS.map((domain) => domain.id) as [string, ...string[]];
const ROLE_IDS = ROLES.map((role) => role.id) as [string, ...string[]];

/**
 * A `skill_*` id. The in-code `SKILLS` placeholder is deliberately NOT the validator: the real
 * vocabulary lives in the `skill` table, and the service rejects an id the database does not
 * know with a named 400 before any row is touched.
 */
const skillIdSchema = z.string().trim().min(1).max(80);

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

const availabilityValueSchema = z
  .object({
    status: z.enum(optionsOf(AVAILABILITY_STATUSES)).nullable().optional(),
    available_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "available_from must be YYYY-MM-DD")
      .nullable()
      .optional(),
    notice_period_days: z.number().int().min(0).max(180).nullable().optional(),
  })
  .strict()
  .nullable();

/**
 * Both ends of the expected-salary band. `max: null` is a point figure (the worker stated only
 * the lower end), not a missing value; `{min:null,max:null}` clears the band.
 */
const salaryExpectedValueSchema = z
  .object({
    min: z.number().int().min(1000).max(500000).nullable(),
    max: z.number().int().min(1000).max(500000).nullable(),
  })
  .strict()
  .refine((value) => value.min === null || value.max === null || value.max >= value.min, {
    message: "salary max must not be below min",
    path: ["max"],
  })
  .nullable();

/**
 * Work history reuses the worker's PUT shape, but an ADMIN correction can never attach one of
 * the worker's voice notes: the repository does not prove note ownership (the worker service
 * does), and an admin has no business pointing a stint at someone's audio.
 */
const workHistoryValueSchema = SetMyEmploymentSchema.pick({ employments: true }).superRefine(
  (value, ctx) => {
    const withVoiceNote = value.employments.some(
      (employment) =>
        employment.work_done_voice_note_id !== null ||
        (employment.roles ?? []).some((role) => role.work_done_voice_note_id !== null),
    );
    if (withVoiceNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "admin corrections cannot attach a worker voice note",
        path: ["employments"],
      });
    }
  },
);

/** One value schema per correctable key; `Record` makes a missing key a compile error. */
const VALUE_SCHEMAS: Record<CorrectableFactKey, z.ZodType<unknown>> = {
  current_city: canonicalCitySchema,
  preferred_locations: preferredLocationsSchema,
  trade: z.enum(DOMAIN_IDS).nullable(),
  role: z.enum(ROLE_IDS).nullable(),
  secondary_roles: z.array(z.enum(ROLE_IDS)).max(4).transform(dedupe),
  skills: z.array(skillIdSchema).max(50).transform(dedupe),
  experience: z.number().min(0).max(60).nullable(),
  work_history: workHistoryValueSchema,
  education: z.array(EducationEntrySchema).max(EDUCATIONS_MAX),
  certifications: z.array(CertificateEntrySchema).max(CERTIFICATES_MAX),
  training: z.array(TrainingEntrySchema).max(TRAININGS_MAX),
  languages: SetMyLanguagesSchema.shape.languages,
  salary_expected: salaryExpectedValueSchema,
  salary_period: z.enum(optionsOf(SALARY_PERIODS)).nullable(),
  availability: availabilityValueSchema,
  shift: z.enum(optionsOf(SHIFTS)).nullable(),
  relocation: z.boolean().nullable(),
  accommodation: z.boolean().nullable(),
  job_type: z.enum(optionsOf(JOB_TYPES)).nullable(),
  work_types: z.array(z.enum(optionsOf(WORK_TYPES))).max(4).transform(dedupe),
  commute_max_km: z.number().int().min(0).max(500).nullable(),
  willing_to_travel: z.boolean().nullable(),
  documents_ready: z.array(z.enum(optionsOf(DOCUMENTS_READY))).max(8).transform(dedupe),
};

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
  return VALUE_SCHEMAS[factKey];
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
