import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import type {
  AdminCandidatesPageSize,
  CandidateSearchResponse,
  CandidateSearchRow,
  CandidateSearchSort,
} from "./candidate-search";

/**
 * The `POST /admin/candidates/search` read seam (B5 #2559, A7 #2577 — ADR-0062 §3.6).
 *
 * POST, not GET: the free-text `q` travels in the BODY ONLY, never in a URL, route, error or
 * validation message (the term must never reach a log line). The list page calls it WITHOUT a
 * term (a bare-filters body); the universal search box POSTs its term to the same-origin
 * `candidates/search` route, which calls it WITH one.
 *
 * ── EVERY SHAPE IS PARSED, NOT TRUSTED ────────────────────────────────────────────────
 * Mirrored from `apps/api/src/admin/admin-candidates.dto.ts` — compared, never assumed — and
 * open where the server is open: an unknown sort or facet value must display, never blank the
 * page. The `name` key keeps its three states (absent ⇒ not disclosed, null ⇒ disclosed but
 * unnamed, string ⇒ the name), which is what keeps "not disclosed" distinguishable from "no
 * name recorded" all the way to the markup (`lib/identity.ts`).
 *
 * ── NEVER CACHED ──────────────────────────────────────────────────────────────────────
 * `adminFetch` stays on `cache: "no-store"`: the body may carry decrypted names, and Next's
 * Data Cache would serve them to the next admin with no audited read behind it.
 */

// ---------------------------------------------------------------------------
// wire shapes (mirrored from the API DTO)
// ---------------------------------------------------------------------------

const candidateSearchRowSchema = z.object({
  worker_id: z.string(),
  status: z.string().nullable(),
  flagged: z.boolean(),
  is_test_account: z.boolean(),
  deletion_scheduled_at: z.string().nullable(),
  current_city: z.string().nullable(),
  current_state: z.string().nullable(),
  trade_label: z.string().nullable(),
  role_label: z.string().nullable(),
  domain_label: z.string().nullable(),
  total_experience_years: z.string().nullable(),
  role_experience_months: z.number().nullable(),
  availability_status: z.string().nullable(),
  shift_preference: z.string().nullable(),
  form_level: z.string().nullable(),
  /** Never projected: `phone_hash`, `name_token_hashes`, `search_doc` are filter-only. */
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
  name: z.string().nullable().optional(),
});

const facetSchema = z.object({ value: z.string(), count: z.number() });

/** Exported so tests can parse a captured payload through the REAL schema. */
export const candidateSearchResponseSchema = z.object({
  candidates: z.array(candidateSearchRowSchema),
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

export type { CandidateSearchResponse, CandidateSearchRow };

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

export interface CandidateSearchBody {
  q?: string;
  filters?: Record<string, unknown>;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  page: number;
  page_size: AdminCandidatesPageSize;
}

/**
 * `POST /admin/candidates/search` (`read_candidates`), folded into the parsed response.
 * The body is built by `candidateSearchBody` — never a URL, never logged.
 */
export function searchCandidates(body: CandidateSearchBody): Promise<CandidateSearchResponse> {
  return adminFetch("/admin/candidates/search", {
    method: "POST",
    body,
    schema: candidateSearchResponseSchema,
  });
}
