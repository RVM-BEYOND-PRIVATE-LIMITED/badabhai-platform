import { z } from "zod";
import { FIELD_SOURCES } from "../profiles/worker-field-precedence";
import { SetMyEmploymentSchema } from "../profiles/worker-employment.dto";
import { SetMyLanguagesSchema } from "../profiles/worker-languages.dto";
import {
  CERTIFICATES_MAX,
  CertificateEntrySchema,
  EDUCATIONS_MAX,
  EducationEntrySchema,
  TRAININGS_MAX,
  TrainingEntrySchema,
  optionsOf,
} from "../profiles/worker-qualifications.dto";
import { DOCUMENTS_READY, WORK_TYPES } from "../profiles/worker-preferences.vocabulary";

/**
 * `GET /admin/candidates/:id` — ONE candidate's full record (ADR-0062 §2 / §3.8 / §3.9, #2560).
 *
 * WHAT IT IS FOR. Before support changes anything they must see the profile the way employers and
 * the résumé read it, and where every value came from. So each field is
 * `{ value, source, correction }`:
 *
 *   value       what the reader shows, computed by the SAME code the employer-facing reads run —
 *               `toProfileSummary`, the payer search's own statement + `toCandidateRow`,
 *               `readPreferenceFacts`, `qualificationFactsFrom` and the precedence resolvers.
 *   source      {@link FIELD_SOURCES} — which writer supplied it (`unknown` when the stored row
 *               cannot say; never a guess).
 *   correction  ALWAYS null in this issue. Typed as the shape #2561's correction layer fills
 *               (`worker_admin_override`), so that issue adds rows without a contract change.
 *               `reason_text` is deliberately NOT part of it: ADR-0062 shows reason text only on a
 *               single-worker history view, to `edit_candidates` holders.
 *
 * WHAT IT NEVER CARRIES (the `.strict()` schemas below are the backstop, and the service parses
 * every response through them before it leaves):
 *   - the PHONE or the WHATSAPP number, in any form — not on this surface at all;
 *   - a résumé DOWNLOAD link or PDF bytes — a résumé prints the worker's phone, and admin résumé
 *     download is a separate privacy decision;
 *   - push tokens, device hashes, IP hashes, the photo's storage key.
 *
 * THE ONE DELIBERATE DECRYPT SITE — `correction_values` (#2728). The GENERAL fields above still
 * never carry employer names or certificate licence numbers. The nullable `correction_values`
 * block is different on purpose: it exists to PREFILL the #2561 correction editors, where an
 * admin must see the effective current value before replacing it. It is therefore present ONLY
 * when the session admin holds `edit_candidates` (`analyst` gets `null`) and it reuses
 * `AdminCorrectionFactsService.readPrevious`, which decrypts the employer name and the licence
 * number. That makes this a reviewed, capability-gated decrypt site for correction prefill —
 * not a widening of the general record, which stays employer-name-free and licence-free.
 *
 * NAMES follow the identity rules: `AdminIdentityService` on the `workers` surface (capability
 * `read_identity`, the existing budget, `admin.identity_viewed` before the decrypt). Without it —
 * an analyst, or an exhausted budget — `name.value` is null and `name_disclosed` is false; the
 * rest of the record is unchanged.
 *
 * WIRE CONVENTION: snake_case, like every admin response. Timestamps are ISO-8601 strings.
 */

/** Every `:id` on this surface is a uuid. */
export const AdminCandidateParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminCandidateParamsDto = z.infer<typeof AdminCandidateParamsSchema>;

/** How many résumé versions one response lists (newest first); `truncated` says when more exist. */
export const ADMIN_CANDIDATE_RESUME_VERSIONS_MAX = 50;
/** How many recent applications one response lists (newest first). */
export const ADMIN_CANDIDATE_RECENT_APPLICATIONS = 10;

const iso = z.string().datetime({ offset: true });

export const FieldSourceSchema = z.enum(FIELD_SOURCES);

/** The admin correction on a field — filled by #2561 (`worker_admin_override`); null until then. */
export const FieldCorrectionSchema = z
  .object({
    override_id: z.string().uuid(),
    admin_id: z.string().uuid(),
    reason_code: z.string().min(1).max(64),
    created_at: iso,
  })
  .strict()
  .nullable();
export type FieldCorrection = z.infer<typeof FieldCorrectionSchema>;

/** One field: its value, where it came from, and the admin correction on it (if any). */
function field<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value, source: FieldSourceSchema, correction: FieldCorrectionSchema }).strict();
}

const labelledId = z.object({ id: z.string(), label: z.string() }).strict();
const nullableText = z.string().nullable();
const textList = z.array(z.string());

const tradeLevelBadge = z
  .object({
    skillId: z.string(),
    skillLabel: z.string().nullable(),
    tradeLevel: z.string(),
    tradeLevelLabel: z.string(),
    levelConfirmed: z.boolean(),
  })
  .strict();

const identitySchema = z
  .object({
    /** Null when not disclosed (see `name_disclosed`) or when no name is on record. */
    name: field(nullableText),
    /** True only when this admin was shown names on this response (read_identity + budget). */
    name_disclosed: z.boolean(),
    has_photo: field(z.boolean()),
    /** The worker's own résumé setting — photo visibility is a worker-only setting (§3.4). */
    resume_show_photo: field(z.boolean()),
    preferred_language: field(nullableText),
  })
  .strict();

const locationSchema = z
  .object({
    /** "Where the worker IS" — `resolveCityForSummary`, the profile summary's rule. */
    current_city: field(nullableText),
    current_state: field(nullableText),
    /** "Where he wants to work" — the attribute the résumé prints. */
    preferred_locations: field(textList),
  })
  .strict();

const tradeSchema = z
  .object({
    canonical_trade_id: field(nullableText),
    canonical_role_id: field(nullableText),
    /** The summary's display name (taxonomy first, then the interview's own label). */
    display_name: field(nullableText),
    job_domain: field(labelledId.nullable()),
    /** Declared secondary occupations (`worker_occupation`), labelled. */
    secondary_roles: field(z.array(labelledId)),
  })
  .strict();

/**
 * The payer all-candidates search card for this worker — the search's own statement narrowed to
 * him, through `toCandidateRow`. Every value field is null/empty when `in_search_pool` is false:
 * an employer does not see him at all.
 */
const employerCardSchema = z
  .object({
    in_search_pool: z.boolean(),
    /** R74 — a synthetic-workforce seed row, badged "Sample candidate" on the card. */
    is_sample: z.boolean(),
    role: field(labelledId.nullable()),
    other_roles: field(z.array(labelledId)),
    role_months: field(z.number().int().nonnegative().nullable()),
    industry: field(labelledId.nullable()),
    industry_months: field(z.number().int().nonnegative().nullable()),
    city: field(nullableText),
    trade_levels: field(z.array(tradeLevelBadge)),
  })
  .strict();

const matchSkillSchema = z
  .object({
    skill_id: z.string(),
    label: z.string(),
    industry: labelledId,
    months_bucketed: z.number().int().nonnegative(),
    wants: z.boolean(),
    source: FieldSourceSchema,
  })
  .strict();

const skillsSchema = z
  .object({
    /** The profile's skills as the summary and the résumé label them. */
    skills: field(textList),
    machines: field(textList),
    /** The match derivation's rows (`worker_skill`), wanted or not — what the matcher reads. */
    match_skills: z.array(matchSkillSchema),
  })
  .strict();

const experienceSchema = z
  .object({
    total_years: field(z.number().nonnegative().nullable()),
    /** Calendar months per industry, as the match derivation computed them. */
    industry_tenure: field(
      z.array(
        z
          .object({ industry: labelledId, calendar_months: z.number().int().nonnegative() })
          .strict(),
      ),
    ),
  })
  .strict();

const employmentRoleSchema = z
  .object({
    role_label: z.string(),
    start_ym: nullableText,
    end_ym: nullableText,
    /** The worker's own words. */
    work_done: nullableText,
    /** The model's rewrite, if any — the résumé prints it unless the worker declined it. */
    work_done_polished: nullableText,
    work_done_polish_declined: z.boolean(),
  })
  .strict();

const employmentSchema = z
  .object({
    employer_city: nullableText,
    employer_state: nullableText,
    start_ym: nullableText,
    /** Null means CURRENT. */
    end_ym: nullableText,
    duration_stated: z.boolean(),
    roles: z.array(employmentRoleSchema),
  })
  .strict();

const educationSchema = z
  .object({
    /** The education rows' headline line, as the résumé prints it. */
    headline: field(nullableText),
    /** The remaining education lines. */
    education: field(textList),
    certifications: field(textList),
    training: field(textList),
    /** The interview's closed education labels (the summary's two fields). */
    education_level: field(nullableText),
    education_field: field(nullableText),
    /** The form's credential components ("NCVT · 2018 · Govt. ITI"), as the résumé joins them. */
    education_detail: field(nullableText),
    education_credential: field(nullableText),
  })
  .strict();

const salarySchema = z
  .object({
    /** The band, never derived: `high` is null unless the worker stated an upper figure. */
    band: field(
      z
        .object({ low: z.number().nonnegative(), high: z.number().nonnegative().nullable() })
        .strict()
        .nullable(),
    ),
    period: field(z.enum(["month", "day", "year"])),
    /** The form's "₹50 hazaar se upar" chip (#2400) — prints "₹50,000+", not a stated figure. */
    open_top_chip: z.boolean(),
  })
  .strict();

const preferencesSchema = z
  .object({
    availability: field(
      z
        .object({
          status: nullableText,
          status_label: nullableText,
          available_from: nullableText,
          notice_period_days: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
    shift: field(nullableText),
    /** `workers.resume_night_shift_ready` — null means never answered. */
    night_shift_ready: field(z.boolean().nullable()),
    relocation: field(z.boolean().nullable()),
    accommodation: field(z.boolean().nullable()),
    job_type: field(nullableText),
    work_types: field(textList),
    commute_max_km: field(z.number().nonnegative().nullable()),
    willing_to_travel: field(z.boolean().nullable()),
    documents: field(textList),
  })
  .strict();

const resumeVersionSchema = z
  .object({
    resume_id: z.string().uuid(),
    version: z.number().int().positive(),
    generation_trigger: nullableText,
    generation_source: nullableText,
    render_status: z.string(),
    template_id: z.string(),
    /** A PDF has been rendered for this version. Never the key, never a link. */
    has_pdf: z.boolean(),
    generated_at: iso,
    rendered_at: iso.nullable(),
  })
  .strict();

const resumeSchema = z
  .object({
    versions: z.array(resumeVersionSchema),
    version_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const accountSchema = z
  .object({
    status: z.string(),
    verification_state: nullableText,
    verified_at: iso.nullable(),
    is_test_account: z.boolean(),
    is_sample: z.boolean(),
    deletion_scheduled_at: iso.nullable(),
    created_at: iso,
    updated_at: iso,
    profile: z
      .object({
        status: z.string(),
        /** The road that produced the current profile, as a field source. */
        source: FieldSourceSchema,
        confirmed_at: iso.nullable(),
        /** `worker_profiling_tier.tier` (`easy` | `medium` | `hard`). */
        form_level: nullableText,
      })
      .strict(),
    consent: z
      .object({
        /** `none` — never consented; `active` — latest row unrevoked; `revoked` — latest revoked. */
        state: z.enum(["none", "active", "revoked"]),
        consent_version: nullableText,
        accepted_at: iso.nullable(),
        purposes: textList,
        /** The latest row is unrevoked and lists `employer_sharing`. */
        employer_sharing: z.boolean(),
      })
      .strict(),
    devices: z
      .object({
        /** Unrevoked devices. */
        count: z.number().int().nonnegative(),
        latest_app_version: nullableText,
        last_seen_at: iso.nullable(),
      })
      .strict(),
    flag: z
      .object({
        flagged: z.boolean(),
        reason_code: nullableText,
        flagged_at: iso.nullable(),
      })
      .strict(),
  })
  .strict();

const recentApplicationSchema = z
  .object({
    id: z.string().uuid(),
    job_id: z.string().nullable(),
    job_posting_id: z.string().nullable(),
    source_surface: z.string(),
    match_tier: z.number().int().nullable(),
    created_at: iso,
  })
  .strict();

const activitySchema = z
  .object({
    /** `applications` rows with `action = 'applied'`. */
    application_count: z.number().int().nonnegative(),
    /** `applications` rows with `action = 'skipped'` (a job he passed on). */
    skipped_count: z.number().int().nonnegative(),
    recent_applications: z.array(recentApplicationSchema),
    unlock_count: z.number().int().nonnegative(),
  })
  .strict();

/**
 * #2728 — the EFFECTIVE current value of the eight structured facts, in the correction API's OWN
 * value shapes (`corrections/admin-corrections.dto.ts`). Present only for an admin holding
 * `edit_candidates`; `null` for everyone else. Every entry schema here is the same one a
 * correction write validates against, so the edit form can round-trip a value the API accepts.
 *
 * THIS BLOCK MAY CARRY THE DECRYPTED EMPLOYER NAME (work history) AND CERTIFICATE LICENCE NUMBER
 * (certifications) — see the file header. It is the reviewed, capability-gated correction-prefill
 * decrypt site, never a field of the general record.
 */
export const AdminCandidateCorrectionValuesSchema = z
  .object({
    /** `skill_*` ids, bounded exactly as a skills correction is. */
    skills: z.array(z.string().trim().min(1).max(80)).max(50),
    work_history: SetMyEmploymentSchema.pick({ employments: true }),
    education: z.array(EducationEntrySchema).max(EDUCATIONS_MAX),
    certifications: z.array(CertificateEntrySchema).max(CERTIFICATES_MAX),
    training: z.array(TrainingEntrySchema).max(TRAININGS_MAX),
    languages: SetMyLanguagesSchema.shape.languages,
    work_types: z.array(z.enum(optionsOf(WORK_TYPES))).max(4),
    documents_ready: z.array(z.enum(optionsOf(DOCUMENTS_READY))).max(8),
  })
  .strict()
  .nullable();
export type AdminCandidateCorrectionValues = z.infer<typeof AdminCandidateCorrectionValuesSchema>;
export type EffectiveCandidateCorrectionValues = NonNullable<AdminCandidateCorrectionValues>;

export const AdminCandidateDetailSchema = z
  .object({
    worker_id: z.string().uuid(),
    identity: identitySchema,
    location: locationSchema,
    trade: tradeSchema,
    employer_card: employerCardSchema,
    skills: skillsSchema,
    experience: experienceSchema,
    work_history: field(z.array(employmentSchema)),
    education: educationSchema,
    languages: field(textList),
    salary: salarySchema,
    preferences: preferencesSchema,
    resume: resumeSchema,
    account: accountSchema,
    activity: activitySchema,
    // #2728 — only for `edit_candidates` holders; null for an analyst (and for an older reader).
    correction_values: AdminCandidateCorrectionValuesSchema,
  })
  .strict();

export type AdminCandidateDetail = z.infer<typeof AdminCandidateDetailSchema>;
export type AdminCandidateField<T> = {
  value: T;
  source: z.infer<typeof FieldSourceSchema>;
  correction: FieldCorrection;
};
