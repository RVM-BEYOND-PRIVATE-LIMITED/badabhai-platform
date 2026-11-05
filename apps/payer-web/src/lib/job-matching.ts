import type { PostingTradeFormWire } from "./contracts";
import { candidateSearchHref } from "./candidate-search";

/**
 * #2671 — "Find matching workers" on a company job opens Candidates search already filled in from
 * that job. This is the PURE link builder: the job's own trade decides the ONE role sent (the
 * trade's `match_skill_id`, not the related skills the payer unticked), and the job's free-text
 * city is sent ONLY when the filters read offers it (the search 400s any city it does not know).
 *
 * The page fetches the catalogue and the filter options; nothing here keeps a copy of either. A
 * draft, a closed job, a job with no trade, or one whose `role_kind` is not among the 16 returns
 * null — no link is drawn rather than one that cannot work.
 */

export const FIND_MATCHING_LABEL = "Find matching workers";

/** Whether a posting's status is one the button is offered on (open or paused). */
export function canFindMatching(status: string): boolean {
  return status === "open" || status === "paused";
}

/** The city as the filters spell it, or null when the options do not list it (case-insensitive). */
export function offeredCity(
  cities: readonly string[] | null,
  city: string | null | undefined,
): string | null {
  if (cities === null || city === null || city === undefined) return null;
  const wanted = city.trim().toLowerCase();
  if (wanted === "") return null;
  return cities.find((option) => option.trim().toLowerCase() === wanted) ?? null;
}

/** The Candidates-search link for a job, or null when the job cannot offer one. */
export function matchingWorkersHref(input: {
  status: string;
  roleKind: string | null;
  jobCity: string | null;
  trades: readonly PostingTradeFormWire[];
  cities: readonly string[] | null;
}): string | null {
  if (!canFindMatching(input.status) || input.roleKind === null) return null;
  const trade = input.trades.find((row) => row.role_kind === input.roleKind);
  if (trade === undefined || trade.match_skill_id === "") return null;
  return candidateSearchHref({
    role: trade.match_skill_id,
    city: offeredCity(input.cities, input.jobCity),
    strict: true,
  });
}
