/**
 * TEST SUPPORT — one fully loaded #2560 candidate record (A7, #2577), shaped exactly as
 * `GET /admin/candidates/:id` answers it (`AdminCandidateDetailSchema`, apps/api). Synthetic
 * values only: no real person, and — like the real response — no phone anywhere.
 */
import type { CandidateDetail } from "../src/lib/candidate-detail";

export const RECORD_WORKER_ID = "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01";
export const RECORD_POSTING_ID = "7a7a7a7a-0000-4000-8000-000000000007";

const f = <T>(value: T, source: string) => ({ value, source, correction: null });

export function candidateRecord(over: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    worker_id: RECORD_WORKER_ID,
    identity: {
      name: f<string | null>("Ramesh Kumar", "unknown"),
      name_disclosed: true,
      has_photo: f(true, "worker_edit"),
      resume_show_photo: f(true, "unknown"),
      preferred_language: f<string | null>("hi", "unknown"),
    },
    location: {
      current_city: f<string | null>("Pune", "worker_edit"),
      current_state: f<string | null>("Maharashtra", "worker_edit"),
      preferred_locations: f(["Pune", "Chakan"], "worker_edit"),
    },
    trade: {
      canonical_trade_id: f<string | null>("trade_welder", "interview"),
      canonical_role_id: f<string | null>("role_tig_welder", "interview"),
      display_name: f<string | null>("TIG Welder", "interview"),
      job_domain: f<{ id: string; label: string } | null>(
        { id: "jd_welder", label: "Welding" },
        "derived",
      ),
      secondary_roles: f([{ id: "occ_fitter", label: "Fitter" }], "unknown"),
    },
    employer_card: {
      in_search_pool: true,
      is_sample: false,
      role: f<{ id: string; label: string } | null>(
        { id: "mskill_tig_welder", label: "TIG Welder" },
        "derived",
      ),
      other_roles: f([{ id: "mskill_mig_welder", label: "MIG Welder" }], "derived"),
      role_months: f<number | null>(48, "derived"),
      industry: f<{ id: string; label: string } | null>(
        { id: "ind_auto", label: "Automotive" },
        "derived",
      ),
      industry_months: f<number | null>(30, "derived"),
      city: f<string | null>("Pune", "worker_edit"),
      trade_levels: f(
        [
          {
            skillId: "mskill_tig_welder",
            skillLabel: "TIG Welder",
            tradeLevel: "operator",
            tradeLevelLabel: "Operator",
            levelConfirmed: true,
          },
        ],
        "unknown",
      ),
    },
    skills: {
      skills: f(["TIG welding", "Arc welding"], "interview"),
      machines: f(["Welding inverter"], "interview"),
      match_skills: [
        {
          skill_id: "mskill_tig_welder",
          label: "TIG Welder",
          industry: { id: "ind_auto", label: "Automotive" },
          months_bucketed: 48,
          wants: true,
          source: "derived",
        },
        {
          skill_id: "mskill_grinder",
          label: "Grinder",
          industry: { id: "ind_fab", label: "Fabrication" },
          months_bucketed: 6,
          wants: false,
          source: "ops",
        },
      ],
    },
    experience: {
      total_years: f<number | null>(4, "interview"),
      industry_tenure: f(
        [{ industry: { id: "ind_auto", label: "Automotive" }, calendar_months: 30 }],
        "derived",
      ),
    },
    work_history: f(
      [
        {
          employer_city: "Pune",
          employer_state: "Maharashtra",
          start_ym: "2021-04",
          end_ym: null,
          duration_stated: true,
          roles: [
            {
              role_label: "TIG Welder",
              start_ym: "2021-04",
              end_ym: null,
              work_done: "Welded exhaust frames",
              work_done_polished: "Welds exhaust frames to drawing tolerances",
              work_done_polish_declined: true,
            },
          ],
        },
      ],
      "worker_edit",
    ),
    education: {
      headline: f<string | null>("ITI — Welder", "form"),
      education: f(["10th pass"], "form"),
      certifications: f(["NCVT Welder"], "form"),
      training: f(["Shop-floor safety"], "unknown"),
      education_level: f<string | null>("ITI", "interview"),
      education_field: f<string | null>("Welder", "interview"),
      education_detail: f<string | null>("NCVT · 2018 · Govt. ITI", "form"),
      education_credential: f<string | null>("NCVT", "form"),
    },
    languages: f(["Hindi", "Marathi"], "interview"),
    salary: {
      band: f<{ low: number; high: number | null } | null>({ low: 18000, high: 22000 }, "worker_edit"),
      period: f("month", "worker_edit"),
      open_top_chip: false,
    },
    preferences: {
      availability: f(
        {
          status: "within_week",
          status_label: "Within a week",
          available_from: null,
          notice_period_days: 15,
        },
        "form",
      ),
      shift: f<string | null>("Night", "interview"),
      night_shift_ready: f<boolean | null>(null, "unknown"),
      relocation: f<boolean | null>(true, "form"),
      accommodation: f<boolean | null>(false, "form"),
      job_type: f<string | null>("Permanent", "form"),
      work_types: f(["Contract"], "form"),
      commute_max_km: f<number | null>(15, "form"),
      willing_to_travel: f<boolean | null>(true, "form"),
      documents: f(["Aadhaar", "PAN"], "resume_import"),
    },
    resume: {
      versions: [
        {
          resume_id: "d0d0d0d0-0000-4000-8000-000000000002",
          version: 2,
          generation_trigger: "chat_edit",
          generation_source: "chat",
          render_status: "rendered",
          template_id: "bb_trade",
          has_pdf: true,
          generated_at: "2026-11-01T10:00:00.000Z",
          rendered_at: "2026-11-01T10:00:05.000Z",
        },
      ],
      version_count: 2,
      truncated: false,
    },
    account: {
      status: "active",
      verification_state: "phone_verified",
      verified_at: "2026-10-01T09:00:00.000Z",
      is_test_account: false,
      is_sample: false,
      deletion_scheduled_at: null,
      created_at: "2026-09-20T09:00:00.000Z",
      updated_at: "2026-11-01T10:00:00.000Z",
      profile: {
        status: "confirmed",
        source: "interview",
        confirmed_at: "2026-10-02T09:00:00.000Z",
        form_level: "medium",
      },
      consent: {
        state: "active",
        consent_version: "v3",
        accepted_at: "2026-09-20T09:01:00.000Z",
        purposes: ["profiling", "employer_sharing"],
        employer_sharing: true,
      },
      devices: { count: 1, latest_app_version: "2.4.1", last_seen_at: "2026-11-03T08:00:00.000Z" },
      flag: { flagged: false, reason_code: null, flagged_at: null },
    },
    activity: {
      application_count: 3,
      skipped_count: 5,
      recent_applications: [
        {
          id: "a0a0a0a0-0000-4000-8000-000000000003",
          job_id: null,
          job_posting_id: RECORD_POSTING_ID,
          source_surface: "job_feed",
          match_tier: 1,
          created_at: "2026-11-02T08:00:00.000Z",
        },
      ],
      unlock_count: 2,
    },
    editable: {
      skills: ["skill_tig_welder", "skill_arc_welding"],
      languages: [{ language: "hindi", can_speak: true, can_read: true, can_write: false }],
      work_types: ["contract"],
      documents_ready: ["aadhaar", "pan"],
      education: [
        {
          credential: "iti",
          field: "Welder",
          council: "ncvt",
          year: 2018,
          institute: "Govt. ITI, Faridabad",
        },
      ],
      certifications: [
        { name: "NCVT Welder", issuer: null, year: null, licence_number: null, licence_expiry: null },
      ],
      training: [{ name: "Shop-floor safety", provider: null, year: null }],
      work_history: [
        {
          employer_city: "Pune",
          employer_state: "Maharashtra",
          start_ym: "2021-04",
          end_ym: null,
          roles: [
            {
              role_label: "TIG Welder",
              start_ym: "2021-04",
              end_ym: null,
              work_done: "Welded exhaust frames",
            },
          ],
        },
      ],
    },
    ...over,
  };
}

/** The same record as an analyst gets it: the name withheld, everything else unchanged. */
export function facelessRecord(): CandidateDetail {
  const r = candidateRecord();
  return {
    ...r,
    identity: { ...r.identity, name: f<string | null>(null, "unknown"), name_disclosed: false },
  };
}
