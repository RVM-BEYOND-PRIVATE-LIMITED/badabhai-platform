import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  CANDIDATE_PAGE_SIZES,
  CANDIDATE_SORT_KEYS,
  type CandidateSearchQuery,
  type CandidateSearchResponse,
} from "./candidate-search-model";

/**
 * The Candidates data bank's read seam (A7, #2577) onto `POST /admin/candidates/search` (B5,
 * #2559; contract: apps/api/src/admin/admin-candidates.dto.ts).
 *
 * ── WHY A POST ────────────────────────────────────────────────────────────────────────
 * The universal term travels in the BODY, never in a URL or a query string: the API deliberately
 * keeps it out of access logs (ADR-0062 §3.6). The portal's same-origin route
 * (`(portal)/candidates/search/route.ts`) carries the browser's body here, so the term never
 * appears on a page address either.
 *
 * ── NO CACHE ──────────────────────────────────────────────────────────────────────────
 * A row may carry a decrypted name when `read_identity` allowed it. `adminFetch` omits
 * `revalidate`, keeping it on `cache: "no-store"`, so one admin's named page can never be
 * served to the next from Next's Data Cache.
 */

const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 datetime" });

const filtersSchema = z
  .object({
    status: z.array(z.string().min(1)).max(10).optional(),
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
    form_level: z
      .array(z.enum(["easy", "medium", "hard"]))
      .max(3)
      .optional(),
  })
  .strict();

/** The body the same-origin search route accepts — the API's own request, narrowed. */
export const candidateSearchRequestSchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    filters: filtersSchema.optional(),
    sort: z.enum(CANDIDATE_SORT_KEYS).default("last_active_at"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce
      .number()
      .int()
      .refine(
        (v): v is (typeof CANDIDATE_PAGE_SIZES)[number] =>
          (CANDIDATE_PAGE_SIZES as readonly number[]).includes(v),
        { message: "page_size must be one of 25, 50 or 100" },
      )
      .default(50),
  })
  .strict();

const facetSchema = z.object({ value: z.string(), count: z.number() });

const rowSchema = z.object({
  worker_id: z.string(),
  status: z.string().nullable(),
  flagged: z.boolean(),
  is_test_account: z.boolean(),
  deletion_scheduled_at: z.string().nullable(),
  employer_sharing_consent: z.boolean(),
  current_city: z.string().nullable(),
  current_state: z.string().nullable(),
  canonical_trade_id: z.string().nullable(),
  canonical_role_id: z.string().nullable(),
  job_domain_id: z.string().nullable(),
  trade_label: z.string().nullable(),
  role_label: z.string().nullable(),
  domain_label: z.string().nullable(),
  total_experience_years: z.string().nullable(),
  role_experience_months: z.number().nullable(),
  salary_min_inr: z.string().nullable(),
  salary_max_inr: z.string().nullable(),
  salary_period: z.string().nullable(),
  availability_status: z.string().nullable(),
  shift_preference: z.string().nullable(),
  form_level: z.string().nullable(),
  skills: z.array(z.string()),
  languages: z.array(z.string()),
  education_level: z.string().nullable(),
  resume_count: z.number(),
  latest_resume_status: z.string().nullable(),
  latest_resume_version: z.number().nullable(),
  profile_status: z.string().nullable(),
  profile_source: z.string().nullable(),
  app_version: z.string().nullable(),
  last_active_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  ai_cost_inr: z.string(),
  referral_source: z.string().nullable(),
  // Absent for a role without name access, or when the hourly name budget is spent.
  name: z.string().nullable().optional(),
});

const responseSchema = z.object({
  candidates: z.array(rowSchema),
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  total_pages: z.number(),
  counts: z.object({
    by_status: z.array(facetSchema),
    by_trade: z.array(facetSchema),
    by_city: z.array(facetSchema),
    by_profile_status: z.array(facetSchema),
  }),
  q_type: z.enum(["name", "phone"]).nullable(),
});

/**
 * One page of the data bank. The route turns a thrown `AdminRequestError` into the list's error
 * state; this function adds nothing of its own, so the caller can tell a refused filter (400), a
 * spent search cap (429), a lost session (401) and an outage (5xx) apart.
 */
export async function searchCandidates(
  query: CandidateSearchQuery,
  signal?: AbortSignal,
): Promise<CandidateSearchResponse> {
  const body = {
    ...(query.q ? { q: query.q } : {}),
    filters: query.filters,
    sort: query.sort,
    dir: query.dir,
    page: query.page,
    page_size: query.page_size,
  };
  return adminFetch("/admin/candidates/search", {
    method: "POST",
    body,
    schema: responseSchema,
    signal,
  });
}
