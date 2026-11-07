import "server-only";
import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import {
  adminFetch,
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "./admin-http";

/**
 * ONE candidate's full record — the portal's read seam onto `GET /admin/candidates/:id` (#2560,
 * ADR-0062; contract: docs/api/admin-candidate-detail-api-reference.md). The Candidates drawer
 * (A7, #2577) renders it.
 *
 * ── EVERY FIELD IS `{ value, source, correction }` ──────────────────────────────────────
 * `value` is what employers and the resume read; `source` is which writer supplied it (a
 * closed enum on the server — read here as a STRING, so a source added there degrades to its
 * de-snaked name instead of failing the whole record); `correction` is the live admin correction
 * on it (#2561), or null.
 *
 * ── WHAT IT NEVER CARRIES ───────────────────────────────────────────────────────────────
 * No phone or WhatsApp number in any form, no employer names, no licence numbers, no resume
 * download link — the server does not send them. A phone is reached only through the separate,
 * reason-gated `POST /admin/workers/:id/reveal-contact`.
 *
 * ── THE NAME ────────────────────────────────────────────────────────────────────────────
 * `identity.name.value` is null and `name_disclosed` false for a role without `read_identity`
 * (analyst) or an admin whose name budget is spent — the rest of the record is unchanged. That is
 * never an error: `lib/candidate-view.ts` turns it into the console's named / capped / faceless
 * posture.
 *
 * ── NEVER CACHED ────────────────────────────────────────────────────────────────────────
 * The read omits `revalidate`, which keeps `adminFetch` on `cache: "no-store"`: the body may carry
 * a decrypted name, and Next's Data Cache would serve it to the next admin with no audited read
 * behind it (the rule `entities.identity.test.ts` holds for the entity reads).
 */

/** The admin correction on a field — #2561's `worker_admin_override`; null when none is live. */
const correctionSchema = z
  .object({
    override_id: z.string(),
    admin_id: z.string(),
    reason_code: z.string(),
    created_at: z.string(),
  })
  .nullable()
  .optional()
  .transform((c) => c ?? null);

/** One field: its value, where it came from, and the admin correction on it (if any). */
function field<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value, source: z.string(), correction: correctionSchema });
}

const text = z.string().nullable();
const textList = z.array(z.string());
const labelled = z.object({ id: z.string(), label: z.string() });

const tradeLevelSchema = z.object({
  skillId: z.string(),
  skillLabel: z.string().nullable(),
  tradeLevel: z.string(),
  tradeLevelLabel: z.string(),
  levelConfirmed: z.boolean(),
});

const employmentRoleSchema = z.object({
  role_label: z.string(),
  start_ym: text,
  end_ym: text,
  work_done: text,
  work_done_polished: text,
  work_done_polish_declined: z.boolean(),
});

const employmentSchema = z.object({
  employer_city: text,
  employer_state: text,
  start_ym: text,
  /** Null means CURRENT. */
  end_ym: text,
  duration_stated: z.boolean(),
  roles: z.array(employmentRoleSchema),
});

export const candidateDetailSchema = z.object({
  worker_id: z.string(),
  identity: z.object({
    name: field(text),
    name_disclosed: z.boolean(),
    has_photo: field(z.boolean()),
    resume_show_photo: field(z.boolean()),
    preferred_language: field(text),
  }),
  location: z.object({
    current_city: field(text),
    current_state: field(text),
    preferred_locations: field(textList),
  }),
  trade: z.object({
    canonical_trade_id: field(text),
    canonical_role_id: field(text),
    display_name: field(text),
    job_domain: field(labelled.nullable()),
    secondary_roles: field(z.array(labelled)),
  }),
  employer_card: z.object({
    in_search_pool: z.boolean(),
    is_sample: z.boolean(),
    role: field(labelled.nullable()),
    other_roles: field(z.array(labelled)),
    role_months: field(z.number().nullable()),
    industry: field(labelled.nullable()),
    industry_months: field(z.number().nullable()),
    city: field(text),
    trade_levels: field(z.array(tradeLevelSchema)),
  }),
  skills: z.object({
    skills: field(textList),
    machines: field(textList),
    match_skills: z.array(
      z.object({
        skill_id: z.string(),
        label: z.string(),
        industry: labelled,
        months_bucketed: z.number(),
        wants: z.boolean(),
        source: z.string(),
      }),
    ),
  }),
  experience: z.object({
    total_years: field(z.number().nullable()),
    industry_tenure: field(z.array(z.object({ industry: labelled, calendar_months: z.number() }))),
  }),
  work_history: field(z.array(employmentSchema)),
  education: z.object({
    headline: field(text),
    education: field(textList),
    certifications: field(textList),
    training: field(textList),
    education_level: field(text),
    education_field: field(text),
    education_detail: field(text),
    education_credential: field(text),
  }),
  languages: field(textList),
  salary: z.object({
    band: field(z.object({ low: z.number(), high: z.number().nullable() }).nullable()),
    period: field(z.string()),
    open_top_chip: z.boolean(),
  }),
  preferences: z.object({
    availability: field(
      z.object({
        status: text,
        status_label: text,
        available_from: text,
        notice_period_days: z.number().nullable(),
      }),
    ),
    shift: field(text),
    night_shift_ready: field(z.boolean().nullable()),
    relocation: field(z.boolean().nullable()),
    accommodation: field(z.boolean().nullable()),
    job_type: field(text),
    work_types: field(textList),
    commute_max_km: field(z.number().nullable()),
    willing_to_travel: field(z.boolean().nullable()),
    documents: field(textList),
  }),
  resume: z.object({
    versions: z.array(
      z.object({
        resume_id: z.string(),
        version: z.number(),
        generation_trigger: text,
        generation_source: text,
        render_status: z.string(),
        template_id: z.string(),
        has_pdf: z.boolean(),
        generated_at: z.string(),
        rendered_at: text,
      }),
    ),
    version_count: z.number(),
    truncated: z.boolean(),
  }),
  account: z.object({
    status: z.string(),
    verification_state: text,
    verified_at: text,
    is_test_account: z.boolean(),
    is_sample: z.boolean(),
    deletion_scheduled_at: text,
    created_at: z.string(),
    updated_at: z.string(),
    profile: z.object({
      status: z.string(),
      source: z.string(),
      confirmed_at: text,
      form_level: text,
    }),
    consent: z.object({
      state: z.string(),
      consent_version: text,
      accepted_at: text,
      purposes: textList,
      employer_sharing: z.boolean(),
    }),
    devices: z.object({
      count: z.number(),
      latest_app_version: text,
      last_seen_at: text,
    }),
    flag: z.object({
      flagged: z.boolean(),
      reason_code: text,
      flagged_at: text,
    }),
  }),
  activity: z.object({
    application_count: z.number(),
    skipped_count: z.number(),
    recent_applications: z.array(
      z.object({
        id: z.string(),
        job_id: text,
        job_posting_id: text,
        source_surface: z.string(),
        match_tier: z.number().nullable(),
        created_at: z.string(),
      }),
    ),
    unlock_count: z.number(),
  }),
});

export type CandidateDetail = z.infer<typeof candidateDetailSchema>;
/** One `{ value, source, correction }` field, as parsed. */
export type CandidateField<T> = { value: T; source: string; correction: CandidateCorrection };
export type CandidateCorrection = z.infer<typeof correctionSchema>;

/**
 * The record read, as the drawer renders it — never a throw. Each failure is its own screen:
 *   not_found   — no such worker (404), or an id that is not one (refused here, or a 400);
 *   forbidden   — the role may not read candidate records (403);
 *   signed_out  — the session is gone (401, or no cookie at all);
 *   error       — anything else (5xx, unreachable, an unexpected shape): our fault, so Retry.
 */
export type CandidateRecordResult =
  | { status: "ok"; detail: CandidateDetail }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "signed_out" }
  | { status: "error" };

export type CandidateRecordStatus = CandidateRecordResult["status"];

/**
 * `GET /admin/candidates/:id` (`read_candidates`), folded into {@link CandidateRecordResult}.
 *
 * ONLY A WORKER ID IS ASKED FOR. `id` comes from the address (`?c=`, the record route's path), and
 * anything that is not a uuid — the API's own check on `:id` — is no such candidate, with nothing
 * sent. That is not only a saved round trip: `encodeURIComponent` leaves "." and ".." as they are,
 * and fetch's URL parser resolves them away, so `?c=..` asked for `GET /admin/` and `?c=.` for
 * `GET /admin/candidates/` — the candidate LIST once #2559 serves it, a read that spends the name
 * budget and writes audit rows for a view nobody asked for. (`adminFetch` refuses such a path too,
 * for every caller; this keeps it from being built.)
 *
 * `signal` is the caller's cancellation — the record route passes its incoming request's, so a
 * drawer that moved on cancels the API call if it has not reached the API yet. One that has is
 * audited and charged a name all the same: the API records the view before it reads anything.
 */
export async function readCandidateRecord(
  id: string,
  signal?: AbortSignal,
): Promise<CandidateRecordResult> {
  if (!uuidSchema.safeParse(id).success) return { status: "not_found" };
  try {
    const detail = await adminFetch(`/admin/candidates/${encodeURIComponent(id)}`, {
      schema: candidateDetailSchema,
      signal,
    });
    return { status: "ok", detail };
  } catch (err) {
    if (isAdminUnauthorized(err)) return { status: "signed_out" };
    if (isAdminForbidden(err)) return { status: "forbidden" };
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) {
      return { status: "not_found" };
    }
    return { status: "error" };
  }
}
