import {
  CANDIDATE_PAGE_SIZES,
  CANDIDATE_SORT_KEYS,
  DEFAULT_CANDIDATE_PAGE_SIZE,
  type CandidateSearchFilters,
  type CandidatePageSize,
  type CandidateSearchSort,
} from "./candidate-search-model";

/**
 * A viewer's own saved views of the Candidates list (A7, #2577) — local only, parsed
 * defensively.
 *
 * `localStorage` is the viewer's to edit, so everything here treats it as untrusted input: a
 * malformed entry is dropped, not trusted, and a storage failure leaves the list working exactly
 * as it would without it. A saved view may keep the search term because it never leaves this
 * browser; a view LINK cannot (the term is body-only, ADR-0062 §3.6).
 */
export const SAVED_VIEWS_KEY = "bb-admin:candidates:views";
export const SAVED_VIEWS_MAX = 12;
export const SAVED_VIEW_NAME_MAX = 60;

export interface SavedCandidateView {
  id: string;
  name: string;
  saved_at: string;
  /** The universal term, kept locally only. */
  q?: string;
  filters: CandidateSearchFilters;
  sort: CandidateSearchSort;
  dir: "asc" | "desc";
  page_size: CandidatePageSize;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return out.length > 0 ? out : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const ARRAY_KEYS = [
  "status",
  "trade_id",
  "role_id",
  "state",
  "city",
  "language",
  "profile_status",
] as const;

const NUMBER_KEYS = [
  "min_experience_years",
  "max_experience_years",
  "role_experience_months_min",
  "role_experience_months_max",
] as const;

const BOOLEAN_KEYS = ["has_resume", "deletion_scheduled", "flagged", "is_test_account"] as const;

const DATE_KEYS = [
  "last_active_from",
  "last_active_to",
  "registered_from",
  "registered_to",
] as const;

/** A stored filter object, narrowed to the keys and value shapes the API accepts. */
export function parseSavedFilters(value: unknown): CandidateSearchFilters {
  if (!isRecord(value)) return {};
  const out: CandidateSearchFilters = {};
  for (const key of ARRAY_KEYS) {
    const list = stringList(value[key]);
    if (list !== undefined) out[key] = list;
  }
  for (const key of NUMBER_KEYS) {
    const n = finiteNumber(value[key]);
    if (n !== undefined) out[key] = n;
  }
  for (const key of BOOLEAN_KEYS) {
    const b = bool(value[key]);
    if (b !== undefined) out[key] = b;
  }
  for (const key of DATE_KEYS) {
    const raw = value[key];
    if (typeof raw === "string" && !Number.isNaN(new Date(raw).getTime())) out[key] = raw;
  }
  const formLevel = stringList(value.form_level);
  if (formLevel !== undefined) {
    const levels = formLevel.filter(
      (v): v is "easy" | "medium" | "hard" => v === "easy" || v === "medium" || v === "hard",
    );
    if (levels.length > 0) out.form_level = levels;
  }
  return out;
}

/** The stored list, in the viewer's save order. Anything malformed is dropped. */
export function parseSavedViews(raw: string | null): SavedCandidateView[] {
  if (raw === null || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SavedCandidateView[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.trim() === "") continue;
    if (typeof item.name !== "string" || item.name.trim() === "") continue;
    if (typeof item.saved_at !== "string") continue;
    const sort = (CANDIDATE_SORT_KEYS as readonly string[]).includes(item.sort as string)
      ? (item.sort as CandidateSearchSort)
      : "last_active_at";
    const dir = item.dir === "asc" || item.dir === "desc" ? item.dir : "desc";
    const pageSize = (CANDIDATE_PAGE_SIZES as readonly number[]).includes(item.page_size as number)
      ? (item.page_size as CandidatePageSize)
      : DEFAULT_CANDIDATE_PAGE_SIZE;
    out.push({
      id: item.id,
      name: item.name.trim().slice(0, SAVED_VIEW_NAME_MAX),
      saved_at: item.saved_at,
      ...(typeof item.q === "string" && item.q.trim() !== "" ? { q: item.q.trim() } : {}),
      filters: parseSavedFilters(item.filters),
      sort,
      dir,
      page_size: pageSize,
    });
    if (out.length >= SAVED_VIEWS_MAX) break;
  }
  return out;
}

/** The list with a view removed. */
export function removeSavedView(
  views: readonly SavedCandidateView[],
  id: string,
): SavedCandidateView[] {
  return views.filter((v) => v.id !== id);
}

/**
 * Save the current view under `name`. Saving the same name REPLACES that view (the id stays, so
 * the list does not jump); a new name is appended, and the OLDEST is dropped at the cap.
 */
export function saveCandidateView(
  views: readonly SavedCandidateView[],
  view: Omit<SavedCandidateView, "id" | "saved_at" | "name"> & {
    name: string;
    id: string;
    saved_at: string;
  },
): SavedCandidateView[] {
  const name = view.name.trim().slice(0, SAVED_VIEW_NAME_MAX);
  if (name === "") return [...views];
  const existing = views.find((v) => v.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const saved: SavedCandidateView = { ...view, name };
  if (existing) return views.map((v) => (v.id === existing.id ? saved : v));
  return [saved, ...views].slice(0, SAVED_VIEWS_MAX);
}

/** A url-safe id for a saved view, from the clock and a random tail (no server round trip). */
export function newSavedViewId(now = Date.now(), random = Math.random()): string {
  return `v-${now.toString(36)}-${Math.floor(random * 1e9).toString(36)}`;
}
