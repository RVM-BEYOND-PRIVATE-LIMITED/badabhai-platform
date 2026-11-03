/**
 * THE COUNT BADGE of the all-candidates search (ADR-0040 §1/§4) — PURE and dependency-free, so the
 * client card list (candidates/candidate-search-list.tsx) can say it without pulling the search's
 * URL/zod reads into the browser bundle. lib/candidate-search.ts re-exports it for the page.
 */

/** The counts one search response carries (ADR-0040 Decision 3) — rendered from THAT response. */
export interface SearchCounts {
  total: number;
  matched: number;
  unrecorded: number;
  filtered: boolean;
  strict: boolean;
}

/** What the count line says, and — in strict mode — what the list leaves out. */
export interface CountSummary {
  line: string;
  strictNote: string | null;
}

/**
 * Three numbers, never folded into one:
 *  - unfiltered: "{total} candidates";
 *  - filtered: "{matched} of {total} match", and " · {unrecorded} not recorded" when any was kept
 *    only because a filtered detail is unrecorded;
 *  - strict adds what the list shows: only the matches — and the not-recorded ones, which strict
 *    mode never excludes (Decision 4).
 * Null for an empty pool (`total` 0): its state says "nothing to show yet", with no zero shouted.
 */
export function countSummary(c: SearchCounts): CountSummary | null {
  if (c.total === 0) return null;
  if (!c.filtered) {
    return { line: c.total === 1 ? "1 candidate" : `${c.total} candidates`, strictNote: null };
  }
  const unrecorded = c.unrecorded > 0 ? ` · ${c.unrecorded} not recorded` : "";
  const line = `${c.matched} of ${c.total} match${unrecorded}`;
  if (!c.strict) return { line, strictNote: null };
  return {
    line,
    strictNote:
      c.unrecorded > 0
        ? "Only matches are shown, plus anyone whose profile doesn’t record a detail you filtered on."
        : "Only matches are shown.",
  };
}
