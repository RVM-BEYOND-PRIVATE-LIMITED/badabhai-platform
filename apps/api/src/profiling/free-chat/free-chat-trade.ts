/**
 * #2355 — "does this message NAME a trade, whatever else it says?"
 *
 * The free-chat start decision asks whether a `resume` message already describes the work.
 * `hasFirstPersonClaim` answers it for the person ("main welder hoon") but its blockers
 * deliberately veto aspiration and training ("chahta", "seekh") — the same veto the
 * identify and experience gates depend on, so it stays. A message can still name usable
 * work through the veto ("mai carpenter mai profile banana chahta hu"), and dropping it
 * costs the worker a repeat of the trade they already stated.
 *
 * This predicate answers the other half: an L0/L1 span match against the in-process
 * occupation snapshot. In-process, no DB, no LLM — the same layers `OccupationService`
 * runs first on every identify, so the start decision and identify can never disagree
 * about whether a trade is named.
 *
 * NULL SNAPSHOT IS "NO". Until the index builds, `namesATrade` is false for every
 * message and the start decision is exactly today's — the index's own contract
 * ("refuse to pretend", `OccupationIndexService.snapshot`) rather than a new fallback.
 */
import { matchSpan, type SpanIndex } from "@badabhai/profiling-lexicon";

/** A lazily-read span index: the snapshot swaps under the reader, so it is read per turn. */
export function namesATradeIn(spansOf: () => SpanIndex | null): (text: string) => boolean {
  return (text: string): boolean => {
    const spans = spansOf();
    return spans !== null && matchSpan(spans, text) !== null;
  };
}
