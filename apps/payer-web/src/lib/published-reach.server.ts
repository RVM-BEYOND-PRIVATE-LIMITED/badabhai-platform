import "server-only";
import type { MatchSelectionInput } from "./contracts";
import { previewReach } from "./payer-api";

/**
 * The reach of a posting that JUST published with `selection` — `reach_total` from
 * `POST /payer/match/reach-preview` (see `published-reach.ts` for why not the publish response).
 *
 * FAIL-SOFT TO NOTHING: the posting is already live, so a failed read must not turn a successful
 * publish into an error. It returns null and the confirmation simply shows no count — never a
 * fabricated or zeroed one (a "0" would read as the E13 zero-reach warning).
 */
export async function reachAfterPublish(selection: MatchSelectionInput): Promise<number | null> {
  try {
    return (await previewReach(selection)).reach_total;
  } catch {
    return null;
  }
}
