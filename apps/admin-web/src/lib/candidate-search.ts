/**
 * The Candidates data-bank list's query vocabulary (A7, #2577) — pure, so every rule is unit
 * tested without a DOM and shared by the server page, the filter bar and the search box.
 *
 * ── WHAT THIS FILE IS ─────────────────────────────────────────────────────────────
 * The URL ↔ `POST /admin/candidates/search` seam. The page reads filters, sort and paging
 * from the address; the free-text term `q` NEVER lives here — `POST`, body only (ADR-0062
 * §3.6: the term must never reach a log line, and access logs record URLs). The search box
 * POSTs it to the same-origin search route instead.
 *
 * ── WHAT IT NEVER IMPORTS ─────────────────────────────────────────────────────────
 * No `server-only`, no zod, no fetch: the filter bar and the search box are client
 * components. The schemas and the POST itself live in `candidate-search-server.ts`.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-candidates.dto.ts` ───────────────────
 * Compared, never assumed — the server owns the contract. A sort or page size the server
 * does not serve is refused at parse time here (falling back to the default), so the page
 * never asks for a 400.
 */

import { formatCount } from "./format";
import { formatYears, humanize } from "./candidate-view";

/**
 * Sortable columns — every `admin_candidate_index` column the list may order by. Mirrored
 * from `CANDIDATE_SEARCH_SORTS` in the API DTO; a value added there must appear here the
 * day it ships, or the page cannot ask for it.
 */
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

/** Page sizes the list serves — max 100, the Candidates identity bound (see the API DTO). */
export const ADMIN_CANDIDATES_PAGE_SIZES = [25, 50, 100] as const;
export type AdminCandidatesPageSize = (typeof ADMIN_CANDIDATES_PAGE_SIZES)[number];

/** The default list order: most recently active first. */
export const DEFAULT_CANDIDATE_SORT: CandidateSearchSort = "last_active_at";
export const DEFAULT_CANDIDATE_DIR = "desc" as const;
export const DEFAULT_CANDIDATE_PAGE_SIZE: AdminCandidatesPageSize = 50;

/** The universal search box's debounce — the pause that ends a burst of keystrokes (#2577). */
export const UNIVERSAL_SEARCH_DEBOUNCE_MS = 300;

/** The term travels in a POST body, but it is still bounded: 1–200 chars (the API DTO). */
export const SEARCH_TERM_MAX_CHARS = 200;

/** Closed multi-value filters: comma-separated in the address (`?status=active,suspended`). */
export const CANDIDATE_LIST_FILTERS = [
  "status",
  "trade_id",
  "role_id",
  "state",
  "city",
  "language",
  "profile_status",
  "form_level",
] as const;
export type CandidateListFilter = (typeof CANDIDATE_LIST_FILTERS)[number];

/** Single-value filters: ranges, dates and flags. */
export const CANDIDATE_RANGE_FILTERS = [
  "min_experience_years",
  "max_experience_years",
  "role_experience_months_min",
  "role_experience_months_max",
  "has_resume",
  "last_active_from",
  "last_active_to",
  "registered_from",
  "registered_to",
  "deletion_scheduled",
  "flagged",
  "is_test_account",
] as const;
export type CandidateRangeFilter = (typeof CANDIDATE_RANGE_FILTERS)[number];

/** Every filter the page reads from the URL — what the FilterPanel counts and re-syncs on. */
export type CandidateFilters = Partial<
  Record<CandidateListFilter, string[]> & Record<CandidateRangeFilter, string>
>;

export interface CandidateSearchParams {
  filters: CandidateFilters;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: AdminCandidatesPageSize;
}

/** One row of the search response — the faceless projection plus an optional disclosed name. */
export interface CandidateSearchRow {
  worker_id: string;
  status: string | null;
  flagged: boolean;
  is_test_account: boolean;
  deletion_scheduled_at: string | null;
  current_city: string | null;
  current_state: string | null;
  trade_label: string | null;
  role_label: string | null;
  domain_label: string | null;
  total_experience_years: string | null;
  role_experience_months: number | null;
  availability_status: string | null;
  shift_preference: string | null;
  form_level: string | null;
  languages: string[];
  education_level: string | null;
  resume_count: number;
  latest_resume_status: string | null;
  profile_status: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only when disclosed under the identity rules; null when disclosed but unnamed. */
  name?: string | null;
}

export interface CandidateSearchResponse {
  candidates: CandidateSearchRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: {
    by_status: Array<{ value: string; count: number }>;
    by_trade: Array<{ value: string; count: number }>;
    by_city: Array<{ value: string; count: number }>;
    by_profile_status: Array<{ value: string; count: number }>;
  };
  q_type: "name" | "phone" | null;
}

// ---------------------------------------------------------------------------
// parsing the address
// ---------------------------------------------------------------------------

function first(value: string | string[] | undefined): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  const trimmed = one?.trim();
  return trimmed ? trimmed : undefined;
}

function isSearchSort(value: string | undefined): value is CandidateSearchSort {
  return (
    typeof value === "string" &&
    (CANDIDATE_SEARCH_SORTS as readonly string[]).includes(value)
  );
}

function parsePageSize(value: string | undefined): AdminCandidatesPageSize {
  const n = Number(value);
  if (n === 25 || n === 50 || n === 100) return n;
  return DEFAULT_CANDIDATE_PAGE_SIZE;
}

function parseList(value: string | string[] | undefined): string[] | undefined {
  const raw = first(value);
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * The page's query, from the address. Paging and sort are SANITIZED, not trusted: an unknown
 * sort, direction, page or page size falls back to its default, so the server never 400s on
 * them — a 400 from the search is then always about the filters, and the refusal screen can
 * say so. Unknown filter keys are ignored (never sent: the API body is `.strict()`).
 */
export function parseCandidateSearchParams(
  sp: Record<string, string | string[] | undefined>,
): CandidateSearchParams {
  const sortRaw = first(sp.sort);
  const sort = isSearchSort(sortRaw) ? sortRaw : DEFAULT_CANDIDATE_SORT;
  const dirRaw = first(sp.dir);
  const dir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : DEFAULT_CANDIDATE_DIR;
  const pageRaw = Number(first(sp.page));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const filters: CandidateFilters = {};
  for (const key of CANDIDATE_LIST_FILTERS) {
    const values = parseList(sp[key]);
    if (values) filters[key] = values;
  }
  for (const key of CANDIDATE_RANGE_FILTERS) {
    const value = first(sp[key]);
    if (value) filters[key] = value;
  }
  return { filters, sort, dir, page, pageSize: parsePageSize(first(sp.page_size)) };
}

/** True when any filter is set — what owns the ONE "Clear filters" and the panel's count. */
export function hasCandidateFilters(filters: CandidateFilters): boolean {
  return (
    Object.values(filters).some((v) =>
      Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0,
    ) ?? false
  );
}

/** The FilterPanel's set: every filter the page reads, and nothing that is not a filter. */
export function candidateFilterSet(filters: CandidateFilters): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(",");
    } else if (value) {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// writing the address and the POST body
// ---------------------------------------------------------------------------

/** The list's address for `params` — page 1 carries no `page`, defaults carry no key. */
export function candidateSearchHref(
  basePath: string,
  params: CandidateSearchParams,
  extra?: Record<string, string | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(candidateFilterSet(params.filters))) {
    q.set(key, String(value));
  }
  if (params.sort !== DEFAULT_CANDIDATE_SORT) q.set("sort", params.sort);
  if (params.dir !== DEFAULT_CANDIDATE_DIR) q.set("dir", params.dir);
  if (params.page > 1) q.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_CANDIDATE_PAGE_SIZE) {
    q.set("page_size", String(params.pageSize));
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) q.set(key, value);
    else q.delete(key);
  }
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/**
 * The `POST /admin/candidates/search` body for `params` plus an optional term. Empty filter
 * arrays and blank values are dropped — never sent — and an empty filters object is omitted,
 * so a bare list is a bare-filters body and `q` rides only in the body, never a URL.
 */
export function candidateSearchBody(params: CandidateSearchParams, q?: string): {
  filters?: Record<string, unknown>;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  page: number;
  page_size: AdminCandidatesPageSize;
  q?: string;
} {
  const filters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.filters)) {
    if (Array.isArray(value)) {
      if (value.length > 0) filters[key] = value;
    } else if (typeof value === "string" && value.length > 0) {
      if (key === "has_resume" || key === "deletion_scheduled" || key === "flagged" || key === "is_test_account") {
        if (value === "true") filters[key] = true;
        else if (value === "false") filters[key] = false;
      } else if (
        key === "min_experience_years" ||
        key === "max_experience_years" ||
        key === "role_experience_months_min" ||
        key === "role_experience_months_max"
      ) {
        const n = Number(value);
        if (Number.isFinite(n)) filters[key] = n;
      } else {
        filters[key] = value;
      }
    }
  }
  const term = normalizeSearchTerm(q);
  return {
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    sort: params.sort,
    dir: params.dir,
    page: params.page,
    page_size: params.pageSize,
    ...(term ? { q: term } : {}),
  };
}

// ---------------------------------------------------------------------------
// the universal search term — body only, never a URL
// ---------------------------------------------------------------------------

/** Trimmed and bounded to the API's 200 chars; blank (or missing) means "no term". */
export function normalizeSearchTerm(input: string | undefined | null): string {
  const trimmed = (input ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed.slice(0, SEARCH_TERM_MAX_CHARS) : "";
}

/** A sortable column's header link: toggling it flips the direction, keeping every filter. */
export function candidateSortLink(
  basePath: string,
  params: CandidateSearchParams,
  sort: CandidateSearchSort,
): { href: string; direction?: "ascending" | "descending"; label: string } {
  const active = params.sort === sort;
  const dir = active ? (params.dir === "asc" ? "desc" as const : "asc" as const) : ("desc" as const);
  const next: CandidateSearchParams = { ...params, sort, dir, page: 1 };
  return {
    href: candidateSearchHref(basePath, next),
    ...(active ? { direction: params.dir === "asc" ? ("ascending" as const) : ("descending" as const) } : {}),
    label: active
      ? params.dir === "asc"
        ? "sorted ascending, activate to sort descending"
        : "sorted descending, activate to sort ascending"
      : "activate to sort by this column",
  };
}

// ---------------------------------------------------------------------------
// headings, cells and the chooser groups
// ---------------------------------------------------------------------------

/** The results head: "Candidates · 24,310" — the API's exact total, never the page size. */
export function candidateListHeading(total: number): string {
  return `Candidates · ${formatCount(total)}`;
}

/** The column chooser's headings (#2577): Identity / Work / Activity / Account. */
export const CANDIDATE_COLUMN_GROUPS = ["Identity", "Work", "Activity", "Account"] as const;

/** Trade, else role, else domain — the employer's first scan of what this worker does. */
export function candidateTradeLabel(row: CandidateSearchRow): string | null {
  return row.trade_label ?? row.role_label ?? row.domain_label ?? null;
}

/** Total experience in years: "4 years", "0.5 years" — null when the worker never stated it. */
export function candidateExperienceLabel(row: CandidateSearchRow): string | null {
  if (row.total_experience_years === null) return null;
  const n = Number(row.total_experience_years);
  return Number.isFinite(n) ? formatYears(n) : row.total_experience_years;
}

/** "3 · Resume ready" / "2 · Generating" / "None" — the count first, then the newest state. */
export function candidateResumeLabel(row: CandidateSearchRow): string {
  if (row.resume_count <= 0) return "None";
  const state = row.latest_resume_status ? humanize(row.latest_resume_status) : null;
  return state ? `${row.resume_count} · ${state}` : String(row.resume_count);
}

/** Availability in words — the worker's own answer, de-snaked, never blanked. */
export function candidateAvailabilityLabel(row: CandidateSearchRow): string | null {
  return row.availability_status ? humanize(row.availability_status) : null;
}

// ---------------------------------------------------------------------------
// saved views — the operator's named filter sets (URL + this browser)
// ---------------------------------------------------------------------------

/** localStorage holds the named views; the address stays shareable on its own. */
export const CANDIDATE_SAVED_VIEWS_KEY = "candidates.savedViews.v1";

export interface CandidateSavedView {
  name: string;
  /** The list address's query string (filters + sort + page size) — never a search term. */
  query: string;
}

const SAVED_VIEW_NAME_MAX = 60;

/** Read defensively: localStorage is the viewer's to edit, so anything malformed is ignored. */
export function parseSavedViews(raw: string | null | undefined): CandidateSavedView[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CandidateSavedView[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { name, query } = item as { name?: unknown; query?: unknown };
    if (typeof name !== "string" || typeof query !== "string") continue;
    const cleanName = name.trim().slice(0, SAVED_VIEW_NAME_MAX);
    if (!cleanName || query.length > 2000) continue;
    // A stored query must be a bare query string — never a term carrier.
    if (/[?&]q=/.test(`?${query}`)) continue;
    out.push({ name: cleanName, query });
  }
  return out.slice(0, 20);
}

/** The current list address's storable query: filters, sort and page size — no page, no term. */
export function savedViewQuery(params: CandidateSearchParams): string {
  const href = candidateSearchHref("/candidates", { ...params, page: 1 });
  const at = href.indexOf("?");
  return at < 0 ? "" : href.slice(at + 1);
}
