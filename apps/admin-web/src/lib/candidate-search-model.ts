/**
 * The Candidates data bank's vocabulary and query arithmetic (A7, #2577; API B5, #2559) — pure,
 * so the client list, the same-origin search route and the tests all share one description of
 * what the API serves. No `server-only`, no React: the drawer and the list import this in the
 * browser.
 *
 * ── THE TERM NEVER TOUCHES A URL ───────────────────────────────────────────────────────
 * `POST /admin/candidates/search` takes the free-text term in its BODY only (ADR-0062 §3.6).
 * Every helper here that writes a URL simply has no parameter for `q`: a view link carries the
 * filters, the order, the page and the page size, never what someone typed into the search box.
 * Local saved views may keep a term because localStorage never reaches an access log.
 */

/** The columns the API may order by (`CANDIDATE_SEARCH_SORTS` in admin-candidates.dto.ts). */
export const CANDIDATE_SORT_KEYS = [
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

export type CandidateSearchSort = (typeof CANDIDATE_SORT_KEYS)[number];

/** How many rows one page may hold — the API's closed set. */
export const CANDIDATE_PAGE_SIZES = [25, 50, 100] as const;
export type CandidatePageSize = (typeof CANDIDATE_PAGE_SIZES)[number];
export const DEFAULT_CANDIDATE_PAGE_SIZE: CandidatePageSize = 50;
export const DEFAULT_CANDIDATE_SORT: CandidateSearchSort = "last_active_at";

/** The 18 filters `POST /admin/candidates/search` accepts. */
export interface CandidateSearchFilters {
  status?: string[];
  trade_id?: string[];
  role_id?: string[];
  min_experience_years?: number;
  max_experience_years?: number;
  role_experience_months_min?: number;
  role_experience_months_max?: number;
  state?: string[];
  city?: string[];
  language?: string[];
  profile_status?: string[];
  has_resume?: boolean;
  last_active_from?: string;
  last_active_to?: string;
  registered_from?: string;
  registered_to?: string;
  deletion_scheduled?: boolean;
  flagged?: boolean;
  is_test_account?: boolean;
  form_level?: Array<"easy" | "medium" | "hard">;
}

/** One order and one page of the data bank. */
export interface CandidateSearchQuery {
  q?: string;
  filters: CandidateSearchFilters;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  page: number;
  page_size: CandidatePageSize;
}

/** One faceless row (`AdminCandidateRow`), every field the API returns. */
export interface CandidateRow {
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
  /** Present only when the identity layer disclosed names; absent otherwise (analysts, cap). */
  name?: string | null;
}

export interface CandidateFacet {
  value: string;
  count: number;
}

export interface CandidateSearchResponse {
  candidates: CandidateRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: {
    by_status: CandidateFacet[];
    by_trade: CandidateFacet[];
    by_city: CandidateFacet[];
    by_profile_status: CandidateFacet[];
  };
  /** Which identity lookup ran: `name`, `phone`, or null (labels only / no term). Never the term. */
  q_type: "name" | "phone" | null;
}

// ---------------------------------------------------------------------------
// URL <-> query
// ---------------------------------------------------------------------------

const ARRAY_FILTERS = [
  "status",
  "trade_id",
  "role_id",
  "state",
  "city",
  "language",
  "profile_status",
  "form_level",
] as const;

const NUMBER_FILTERS = [
  "min_experience_years",
  "max_experience_years",
  "role_experience_months_min",
  "role_experience_months_max",
] as const;

const BOOLEAN_FILTERS = ["has_resume", "deletion_scheduled", "flagged", "is_test_account"] as const;

const DATE_FILTERS = [
  "last_active_from",
  "last_active_to",
  "registered_from",
  "registered_to",
] as const;

/** The filter keys this build writes to a view URL. */
export const CANDIDATE_FILTER_KEYS = [
  ...ARRAY_FILTERS,
  ...NUMBER_FILTERS,
  ...BOOLEAN_FILTERS,
  ...DATE_FILTERS,
] as const;

/** A date input's `YYYY-MM-DD` becomes the API's ISO instant at UTC midnight; an ISO string passes. */
function parseDate(value: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** A view URL's date part, for a date input: the ISO instant's first ten characters. */
function dateInputValue(value: string): string {
  return value.slice(0, 10);
}

/**
 * The query in a URL, narrowed defensively. Anything the API would refuse is DROPPED (a shared
 * view can be hand-edited; the list must still load), except that an unknown `sort`/`dir` falls
 * back to the default order. The search term is never read here — it is not in the URL.
 */
export function parseCandidateQuery(input: URLSearchParams | string): CandidateSearchQuery {
  const raw =
    typeof input === "string"
      ? input.includes("?")
        ? input.slice(input.indexOf("?") + 1)
        : input
      : null;
  const params = raw === null ? (input as URLSearchParams) : new URLSearchParams(raw);
  const filters: CandidateSearchFilters = {};

  for (const key of ARRAY_FILTERS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const values = raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    if (values.length > 0) {
      if (key === "form_level") {
        filters.form_level = values.filter(
          (v): v is "easy" | "medium" | "hard" => v === "easy" || v === "medium" || v === "hard",
        );
      } else filters[key] = values;
    }
  }

  for (const key of NUMBER_FILTERS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) filters[key] = value;
  }

  for (const key of BOOLEAN_FILTERS) {
    const raw = params.get(key);
    if (raw === "true") filters[key] = true;
    else if (raw === "false") filters[key] = false;
  }

  for (const key of DATE_FILTERS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const value = parseDate(raw);
    if (value !== undefined) filters[key] = value;
  }

  const sortRaw = params.get("sort");
  const sort = (CANDIDATE_SORT_KEYS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as CandidateSearchSort)
    : DEFAULT_CANDIDATE_SORT;
  const dirRaw = params.get("dir");
  const dir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : "desc";
  const pageRaw = Number(params.get("page"));
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const sizeRaw = Number(params.get("page_size"));
  const page_size = (CANDIDATE_PAGE_SIZES as readonly number[]).includes(sizeRaw)
    ? (sizeRaw as CandidatePageSize)
    : DEFAULT_CANDIDATE_PAGE_SIZE;

  return { filters, sort, dir, page, page_size };
}

/** The URL parameters of a view — filters, order, page, page size. Never the term. */
export function candidateViewParams(
  query: Omit<CandidateSearchQuery, "q">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ARRAY_FILTERS) {
    const value = query.filters[key];
    if (value !== undefined && value.length > 0) out[key] = value.join(",");
  }
  for (const key of NUMBER_FILTERS) {
    const value = query.filters[key];
    if (value !== undefined) out[key] = String(value);
  }
  for (const key of BOOLEAN_FILTERS) {
    const value = query.filters[key];
    if (value !== undefined) out[key] = value ? "true" : "false";
  }
  for (const key of DATE_FILTERS) {
    const value = query.filters[key];
    if (value !== undefined) out[key] = dateInputValue(value);
  }
  if (query.sort !== DEFAULT_CANDIDATE_SORT) out.sort = query.sort;
  if (query.dir !== "desc") out.dir = query.dir;
  if (query.page > 1) out.page = String(query.page);
  if (query.page_size !== DEFAULT_CANDIDATE_PAGE_SIZE) out.page_size = String(query.page_size);
  return out;
}

/** `/candidates?<view>` — the address a row link carries, with the drawer param added by caller. */
export function candidateViewHref(
  query: Omit<CandidateSearchQuery, "q">,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams(candidateViewParams(query));
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  const s = params.toString();
  return s ? `/candidates?${s}` : "/candidates";
}

/** Is any filter narrowing the list? (The term and the order are not filters; the page is not either.) */
export function hasCandidateFilters(filters: CandidateSearchFilters): boolean {
  return CANDIDATE_FILTER_KEYS.some((key) => filters[key] !== undefined);
}

/** The filters as a plain form of strings, for the panel's inputs. Empty = not set. */
export function candidateFiltersToForm(filters: CandidateSearchFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ARRAY_FILTERS) {
    const value = filters[key];
    if (value !== undefined && value.length > 0) out[key] = value.join(", ");
  }
  for (const key of NUMBER_FILTERS) {
    const value = filters[key];
    if (value !== undefined) out[key] = String(value);
  }
  for (const key of BOOLEAN_FILTERS) {
    const value = filters[key];
    if (value !== undefined) out[key] = value ? "true" : "false";
  }
  for (const key of DATE_FILTERS) {
    const value = filters[key];
    if (value !== undefined) out[key] = dateInputValue(value);
  }
  return out;
}

/** The panel's form of strings back to filters. Values it cannot read are dropped, not refused. */
export function candidateFormToFilters(
  form: Readonly<Record<string, string>>,
): CandidateSearchFilters {
  const params = new URLSearchParams();
  for (const key of [...CANDIDATE_FILTER_KEYS]) {
    const value = form[key]?.trim();
    if (value !== undefined && value !== "") params.set(key, value);
  }
  return parseCandidateQuery(params).filters;
}

// ---------------------------------------------------------------------------
// filters as chips
// ---------------------------------------------------------------------------

/** One active filter, as a removable chip. `key` + `value` identify what the × takes away. */
export interface CandidateFilterChip {
  key: keyof CandidateSearchFilters;
  /** The array member this chip removes; absent for a scalar/range/boolean filter. */
  value?: string;
  label: string;
}

const FILTER_LABELS: Readonly<Record<string, string>> = {
  status: "Status",
  trade_id: "Trade",
  role_id: "Role",
  state: "State",
  city: "City",
  language: "Language",
  profile_status: "Profile",
  form_level: "Form level",
};

const RANGE_LABELS: Readonly<Record<string, string>> = {
  min_experience_years: "Experience at least",
  max_experience_years: "Experience at most",
  role_experience_months_min: "Role experience at least",
  role_experience_months_max: "Role experience at most",
};

const DATE_LABELS: Readonly<Record<string, string>> = {
  last_active_from: "Active from",
  last_active_to: "Active before",
  registered_from: "Registered from",
  registered_to: "Registered before",
};

function humanizeCode(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every active filter as a chip, arrays one chip per member, in a stable order. */
export function candidateFilterChips(filters: CandidateSearchFilters): CandidateFilterChip[] {
  const out: CandidateFilterChip[] = [];
  for (const key of ARRAY_FILTERS) {
    const values = filters[key];
    if (!values) continue;
    for (const value of values) {
      out.push({ key, value, label: `${FILTER_LABELS[key]}: ${humanizeCode(value)}` });
    }
  }
  for (const key of NUMBER_FILTERS) {
    const value = filters[key];
    if (value === undefined) continue;
    const unit = key.includes("months") ? " months" : " yrs";
    out.push({ key, label: `${RANGE_LABELS[key]} ${value}${unit}` });
  }
  if (filters.has_resume !== undefined) {
    out.push({ key: "has_resume", label: filters.has_resume ? "Has a resume" : "No resume" });
  }
  for (const key of DATE_FILTERS) {
    const value = filters[key];
    if (value !== undefined)
      out.push({ key, label: `${DATE_LABELS[key]} ${dateInputValue(value)}` });
  }
  if (filters.deletion_scheduled !== undefined) {
    out.push({
      key: "deletion_scheduled",
      label: filters.deletion_scheduled ? "Deletion scheduled" : "Deletion not scheduled",
    });
  }
  if (filters.flagged !== undefined) {
    out.push({ key: "flagged", label: filters.flagged ? "Flagged" : "Not flagged" });
  }
  if (filters.is_test_account !== undefined) {
    out.push({
      key: "is_test_account",
      label: filters.is_test_account ? "Test accounts" : "Real accounts",
    });
  }
  return out;
}

/** The filters with one chip taken away. Never mutates the input. */
export function withoutFilterChip(
  filters: CandidateSearchFilters,
  chip: CandidateFilterChip,
): CandidateSearchFilters {
  const next: CandidateSearchFilters = { ...filters };
  if (chip.value !== undefined) {
    const current = next[chip.key];
    if (Array.isArray(current)) {
      const left = current.filter((v) => v !== chip.value);
      if (left.length > 0) (next as Record<string, unknown>)[chip.key] = left;
      else delete (next as Record<string, unknown>)[chip.key];
    }
  } else {
    delete (next as Record<string, unknown>)[chip.key];
  }
  return next;
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

/** A sortable header's words, and the order a first click gives it. */
export const CANDIDATE_SORT_COLUMNS: Readonly<
  Record<CandidateSearchSort, { label: string; firstDir: "asc" | "desc" }>
> = {
  last_active_at: { label: "last active", firstDir: "desc" },
  created_at: { label: "registered", firstDir: "desc" },
  updated_at: { label: "last updated", firstDir: "desc" },
  total_experience_years: { label: "most experienced", firstDir: "desc" },
  role_experience_months: { label: "most role experience", firstDir: "desc" },
  ai_cost_inr: { label: "highest AI cost", firstDir: "desc" },
  resume_count: { label: "most resumes", firstDir: "desc" },
  current_city: { label: "city A–Z", firstDir: "asc" },
  current_state: { label: "state A–Z", firstDir: "asc" },
  status: { label: "status A–Z", firstDir: "asc" },
  trade_label: { label: "trade A–Z", firstDir: "asc" },
  role_label: { label: "role A–Z", firstDir: "asc" },
  domain_label: { label: "domain A–Z", firstDir: "asc" },
  profile_status: { label: "profile status A–Z", firstDir: "asc" },
  salary_min_inr: { label: "lowest salary first", firstDir: "asc" },
  salary_max_inr: { label: "highest salary first", firstDir: "desc" },
  availability_status: { label: "availability A–Z", firstDir: "asc" },
  shift_preference: { label: "shift A–Z", firstDir: "asc" },
  form_level: { label: "form level A–Z", firstDir: "asc" },
  education_level: { label: "education A–Z", firstDir: "asc" },
};

/** What a header click does to the order: reverse the current column, or start this one. */
export function nextCandidateSort(
  current: { sort: CandidateSearchSort; dir: "asc" | "desc" },
  column: CandidateSearchSort,
): { sort: CandidateSearchSort; dir: "asc" | "desc" } {
  if (current.sort === column) {
    return { sort: column, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { sort: column, dir: CANDIDATE_SORT_COLUMNS[column].firstDir };
}
