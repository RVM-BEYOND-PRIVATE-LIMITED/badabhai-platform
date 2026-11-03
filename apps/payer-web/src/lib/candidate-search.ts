import type { CandidateFilters, CandidateSearchBody } from "./contracts";
import {
  CANDIDATES_PATH,
  CURSOR_PARAM,
  CURSOR_SHAPE,
  POSTING_FILTER_PARAM,
  STAGE_FILTER_PARAM,
} from "./candidate-inbox";

/**
 * PURE reads for the Candidates tab's ALL CANDIDATES view (`/candidates`, ADR-0040 E2; owner
 * rulings 2026-11-03) — no I/O, no React. The page reads the URL, the filter options
 * (`GET /payer/candidates/filters`) and one search page (`POST /payer/candidates/search`); these
 * decide what the URL asks for, which of it the options let through, the body that is sent, the
 * links that keep or drop a filter, and the copy the counts read as.
 *
 * AFFORDANCE ONLY: nothing here authorizes or ranks anything. The API decides who is in the pool,
 * who matches, the order and every count; this module only refuses to SEND a value the filters
 * read did not offer (a hand-edited or stale link), so a junk filter never becomes a 400 and a
 * Retry that cannot succeed.
 */

/** The route — the Candidates tab opens here; the applicant inbox is one click away (Applied). */
export const CANDIDATE_SEARCH_PATH = "/candidates";

/** The search form's query keys — a plain GET form, one per control (plus the inbox's `cursor`). */
export const SEARCH_PARAM = {
  role: "role",
  experience: "exp",
  industry: "industry",
  industryExperience: "indexp",
  city: "city",
  strict: "strict",
} as const;

/** The ONE value the "Only show matches" checkbox submits. */
export const STRICT_ON = "1";

/** The five option-backed filters. */
export type SearchFilterKey = "role" | "experience" | "industry" | "industryExperience" | "city";
export const SEARCH_FILTER_KEYS: readonly SearchFilterKey[] = [
  "role",
  "experience",
  "industry",
  "industryExperience",
  "city",
];

type SearchParams = Record<string, string | string[] | undefined>;

/** What the ADDRESS asks for, before any of it is checked against what the options offer. */
export interface CandidateSearchAddress {
  /** Each filter as the address spells it, trimmed; null = not asked (absent, or "Any …"'s ""). */
  asked: Record<SearchFilterKey, string | null>;
  /** Params in a form no control submits — repeated, or a `strict` other than "1". Dropped. */
  malformed: number;
  strict: boolean;
  /** A cursor of the shape the server mints, else null (only the server can tell if it did). */
  cursor: string | null;
}

/** What the page SENDS: every filter is a value the options offered, in their own spelling. */
export interface CandidateSearchQuery {
  /** A role id (`mskill_*`) — the ONE role this portal sends (a single Role select). */
  role: string | null;
  /** An experience-bucket id: years on the role the card leads with. */
  experience: string | null;
  industry: string | null;
  /** An experience-bucket id: years in the industry. */
  industryExperience: string | null;
  /** A city, as the options spell it. */
  city: string | null;
  /** "Only show matches" — opt-in, explicit, never remembered (ADR-0040 Decision 2). */
  strict: boolean;
  cursor: string | null;
}

export const NO_SEARCH_FILTERS: CandidateSearchQuery = {
  role: null,
  experience: null,
  industry: null,
  industryExperience: null,
  city: null,
  strict: false,
  cursor: null,
};

/**
 * Read `/candidates?role=&exp=&industry=&indexp=&city=&strict=1&cursor=`. An empty value is no
 * filter (each select's "Any …" submits one). A repeated param, or a `strict` other than "1", is a
 * form no control submits: it is dropped and counted in `malformed` (the page says so once). A
 * cursor of any other shape is dropped silently, as the inbox does — the first page is read.
 */
export function parseCandidateSearchAddress(params: SearchParams): CandidateSearchAddress {
  let malformed = 0;
  const one = (key: string): string | null => {
    const raw = params[key];
    if (raw === undefined) return null;
    if (Array.isArray(raw)) {
      malformed += 1;
      return null;
    }
    const value = raw.trim();
    return value === "" ? null : value;
  };
  const asked: Record<SearchFilterKey, string | null> = {
    role: one(SEARCH_PARAM.role),
    experience: one(SEARCH_PARAM.experience),
    industry: one(SEARCH_PARAM.industry),
    industryExperience: one(SEARCH_PARAM.industryExperience),
    city: one(SEARCH_PARAM.city),
  };
  const rawStrict = params[SEARCH_PARAM.strict];
  let strict = false;
  if (rawStrict === STRICT_ON) strict = true;
  else if (rawStrict !== undefined && rawStrict !== "") malformed += 1;
  const rawCursor = params[CURSOR_PARAM];
  const cursor = typeof rawCursor === "string" && CURSOR_SHAPE.test(rawCursor) ? rawCursor : null;
  return { asked, malformed, strict, cursor };
}

/**
 * Does the address name an option-backed filter? Only then does the search wait for the options:
 * with none there is nothing to check, so the list is read BESIDE them (no waterfall on the
 * page's default view).
 */
export function asksForOptions(address: CandidateSearchAddress): boolean {
  return SEARCH_FILTER_KEYS.some((key) => address.asked[key] !== null);
}

/** Is there anything in the address to clear (a filter, strict, or something that was dropped)? */
export function addressHasFilters(address: CandidateSearchAddress): boolean {
  return asksForOptions(address) || address.strict || address.malformed > 0;
}

export interface ResolvedSearch {
  query: CandidateSearchQuery;
  /**
   * How many params were IGNORED because no control offers them (not among the options read, or
   * malformed) — the page says so once. Filters dropped because the options could not be read are
   * not counted here: the filter form already says the options did not load.
   */
  ignored: number;
}

/**
 * The query the page sends: every asked filter that the options OFFER — matched case-insensitively
 * and sent in the options' own spelling (`?city=pune` selects "Pune" rather than a value no option
 * holds) — and nothing else. A value not offered is dropped (counted in `ignored`); with no options
 * (`null`: the read failed) every asked filter is dropped, since none can be checked — the list is
 * then the unfiltered one, which is what the controls ("Any …" only) say.
 *
 * Anything dropped drops the cursor too: a cursor is a POSITION in the order of the filters that
 * minted it, so with a filter gone the first page is read. Strict needs no options (one value).
 */
export function resolveCandidateSearch(
  address: CandidateSearchAddress,
  options: CandidateFilters | null,
): ResolvedSearch {
  const offered: Record<SearchFilterKey, readonly string[]> | null = options && {
    role: options.roles.map((r) => r.id),
    experience: options.experienceBuckets.map((b) => b.id),
    industry: options.industries.map((i) => i.id),
    industryExperience: options.experienceBuckets.map((b) => b.id),
    city: options.cities,
  };
  let ignored = address.malformed;
  let dropped = address.malformed > 0;
  const pick = (key: SearchFilterKey): string | null => {
    const asked = address.asked[key];
    if (asked === null) return null;
    const hit = offered ? offeredValue(offered[key], asked) : null;
    if (hit === null) {
      dropped = true;
      if (offered) ignored += 1;
    }
    return hit;
  };
  const query: CandidateSearchQuery = {
    role: pick("role"),
    experience: pick("experience"),
    industry: pick("industry"),
    industryExperience: pick("industryExperience"),
    city: pick("city"),
    strict: address.strict,
    cursor: null,
  };
  return { query: { ...query, cursor: dropped ? null : address.cursor }, ignored };
}

/** The offered value `asked` names (case-insensitively), in the options' own spelling. */
function offeredValue(list: readonly string[], asked: string): string | null {
  const want = asked.toLowerCase();
  return list.find((value) => value.toLowerCase() === want) ?? null;
}

/**
 * The search body (snake_case, the route's convention) — ONLY the keys that are set; every unset
 * one is the API's own default (no filter, not strict, 20 a page), so the unfiltered first page is
 * `{}`. One role at most (`skill_ids`, a single Role select). `limit` only when the caller names
 * one. Never a payer id (XB-A).
 */
export function candidateSearchBody(query: CandidateSearchQuery, limit?: number): CandidateSearchBody {
  return {
    ...(query.role ? { skill_ids: [query.role] } : {}),
    ...(query.experience ? { experience: query.experience } : {}),
    ...(query.industry ? { industry_id: query.industry } : {}),
    ...(query.industryExperience ? { industry_experience: query.industryExperience } : {}),
    ...(query.city ? { city: query.city } : {}),
    ...(query.strict ? { strict: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

/**
 * `/candidates` with only the keys that are set, in the form's own spelling (`strict=1`) — never an
 * empty `role=` or `cursor=`. The pager's links, the states' ways out and "Show all candidates".
 */
export function candidateSearchHref(query: Partial<CandidateSearchQuery>): string {
  const q = new URLSearchParams();
  if (query.role) q.set(SEARCH_PARAM.role, query.role);
  if (query.experience) q.set(SEARCH_PARAM.experience, query.experience);
  if (query.industry) q.set(SEARCH_PARAM.industry, query.industry);
  if (query.industryExperience) q.set(SEARCH_PARAM.industryExperience, query.industryExperience);
  if (query.city) q.set(SEARCH_PARAM.city, query.city);
  if (query.strict) q.set(SEARCH_PARAM.strict, STRICT_ON);
  if (query.cursor) q.set(CURSOR_PARAM, query.cursor);
  const qs = q.toString();
  return qs ? `${CANDIDATE_SEARCH_PATH}?${qs}` : CANDIDATE_SEARCH_PATH;
}

/**
 * The filters a query applies, as one key — what the filter form and the card list are keyed by
 * (a kept `<select>` ignores a new `defaultValue`, and a new search starts with no session state).
 * The cursor is not part of it: paging is not a new selection.
 */
export function searchFiltersKey(query: CandidateSearchQuery): string {
  return [
    query.role,
    query.experience,
    query.industry,
    query.industryExperience,
    query.city,
    query.strict ? STRICT_ON : "",
  ]
    .map((v) => v ?? "")
    .join("|");
}

/**
 * An OLD inbox link — `/candidates?postingId=…` or `?stage=…`, from before the tab opened on All
 * candidates — goes on to the inbox's own route with its whole query, so bookmarks keep landing
 * where they did. Null for any other address. The target is always this app's own path (never a
 * value from the address), so this is no open redirect.
 */
export function inboxRedirectHref(params: SearchParams): string | null {
  if (params[POSTING_FILTER_PARAM] === undefined && params[STAGE_FILTER_PARAM] === undefined) {
    return null;
  }
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) q.append(key, v);
  }
  return `${CANDIDATES_PATH}?${q.toString()}`;
}

/** The label of the role the query filters by (a related row reads "Related to <it>"). */
export function pickedRoleLabel(
  query: Pick<CandidateSearchQuery, "role">,
  options: CandidateFilters | null,
): string | null {
  if (query.role === null || options === null) return null;
  return options.roles.find((r) => r.id === query.role)?.label ?? null;
}

/** THE COUNT BADGE (ADR-0040 §1/§4) — dependency-free in its own module, for the client list. */
export { countSummary, type CountSummary, type SearchCounts } from "./candidate-counts";
