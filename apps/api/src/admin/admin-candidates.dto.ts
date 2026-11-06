import { z } from "zod";

/**
 * Wire contract for `POST /admin/candidates/search` (B5, #2559 — ADR-0062
 * §3.6). POST, not GET: the free-text `q` travels in the BODY ONLY — never in
 * a URL, route, error or validation message (the term must never reach a log
 * line; a logging test pins that). Like the payer search.
 *
 * The term is UNIVERSAL: one box searching every field at once — partial match
 * on folded labels (`search_doc`), an exact full phone number, and whole-word
 * exact name tokens. Which branches run depends on the term shape AND the
 * caller's capability (see the service): analysts never touch the name/phone
 * branches and get rows without names.
 */

/** Sortable columns — every `admin_candidate_index` column the list may order by. */
export const CANDIDATE_SEARCH_SORTS = [
  "last_active_at",
  "created_at",
  "updated_at",
  "total_experience_years",
  "role_experience_months",
  "ai_cost_inr",
  "resume_count",
  "current_city",
  "current_state",
  "status",
  "trade_label",
  "role_label",
  "domain_label",
  "profile_status",
  "salary_min_inr",
  "salary_max_inr",
  "availability_status",
  "shift_preference",
  "form_level",
  "education_level",
] as const;
export type CandidateSearchSort = (typeof CANDIDATE_SEARCH_SORTS)[number];

/** ISO-8601 datetime string, validated at the boundary (never a Date object on the wire). */
const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 datetime" });

export const AdminCandidateSearchFiltersSchema = z
  .object({    status: z.array(z.string().min(1)).max(10).optional(),
    trade_id: z.array(z.string().min(1)).max(20).optional(),
    role_id: z.array(z.string().min(1)).max(20).optional(),
    min_experience_years: z.coerce.number().nonnegative().max(60).optional(),
    max_experience_years: z.coerce.number().nonnegative().max(60).optional(),
    role_experience_months_min: z.coerce.number().int().nonnegative().max(1200).optional(),
    role_experience_months_max: z.coerce.number().int().nonnegative().max(1200).optional(),
    state: z.array(z.string().min(1)).max(20).optional(),
    city: z.array(z.string().min(1)).max(20).optional(),
    language: z.array(z.string().min(1)).max(20).optional(),
    profile_status: z.array(z.string().min(1)).max(20).optional(),
    has_resume: z.boolean().optional(),
    last_active_from: isoDateTime.optional(),
    last_active_to: isoDateTime.optional(),
    registered_from: isoDateTime.optional(),
    registered_to: isoDateTime.optional(),
    deletion_scheduled: z.boolean().optional(),
    flagged: z.boolean().optional(),
    is_test_account: z.boolean().optional(),
    form_level: z.array(z.enum(["easy", "medium", "hard"])).max(3).optional(),
  })
  .strict();

/** Page sizes the list serves — max 100, the Candidates identity bound (see below). */
export const ADMIN_CANDIDATES_PAGE_SIZES = [25, 50, 100] as const;

export const AdminCandidateSearchSchema = z.object({
    /** Free-text term — body only, never logged (see the service). Optional: bare filters list. */
    q: z.string().trim().min(1).max(200).optional(),
    filters: AdminCandidateSearchFiltersSchema.optional(),
    sort: z.enum(CANDIDATE_SEARCH_SORTS).default("last_active_at"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce
      .number()
      .int()
      .refine((v): v is (typeof ADMIN_CANDIDATES_PAGE_SIZES)[number] => v === 25 || v === 50 || v === 100, {
        message: "page_size must be one of 25, 50 or 100",
      })
      .default(50),
  })
  .strict();
export type AdminCandidateSearchDto = z.infer<typeof AdminCandidateSearchSchema>;

/** One faceless candidate row — every `admin_candidate_index` column EXCEPT the lookup material. */
export interface AdminCandidateRow {
  worker_id: string;
  status: string | null;
  flagged: boolean;
  is_test_account: boolean;
  deletion_scheduled_at: string | null;
  employer_sharing_consent: boolean;
  current_city: string | null;
  current_state: string | null;
  canonical_trade_id: string | null;
  canonical_role_id: string | null;
  job_domain_id: string | null;
  trade_label: string | null;
  role_label: string | null;
  domain_label: string | null;
  total_experience_years: string | null;
  role_experience_months: number | null;
  salary_min_inr: string | null;
  salary_max_inr: string | null;
  salary_period: string | null;
  availability_status: string | null;
  shift_preference: string | null;
  form_level: string | null;
  skills: string[];
  languages: string[];
  education_level: string | null;
  resume_count: number;
  latest_resume_status: string | null;
  latest_resume_version: number | null;
  profile_status: string | null;
  profile_source: string | null;
  app_version: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  ai_cost_inr: string;
  referral_source: string | null;
  /**
   * The worker's name — present ONLY when disclosed under the identity rules
   * (role + budget + audit). ABSENT when undisclosed (no capability, capped, or
   * over bound); `null` when disclosed and no name is on record.
   */
  name?: string | null;
}

export interface AdminCandidateFacet {
  value: string;
  count: number;
}

export interface AdminCandidateSearchResponse {
  candidates: AdminCandidateRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: {
    by_status: AdminCandidateFacet[];
    by_trade: AdminCandidateFacet[];
    by_city: AdminCandidateFacet[];
    by_profile_status: AdminCandidateFacet[];
  };
  /**
   * Which identity lookup ran for `q` — `name`, `phone`, or `null` (pure label
   * search or no term). NEVER the term itself.
   */
  q_type: "name" | "phone" | null;
}
