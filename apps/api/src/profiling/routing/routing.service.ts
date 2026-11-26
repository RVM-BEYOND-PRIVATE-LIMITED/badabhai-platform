/**
 * First-question routing service (#3015) — pure lookup, no Nest, no DB.
 *
 * A routing entry fires when the worker's FIRST message, normalised the way phrases are,
 * is one of its phrases or is one of them plus particles ("hoon", "ka kaam", "karta hoon").
 * A message that names a trade outright ("cnc turner operator") goes to that trade as today:
 * routing never overrides a more exact phrase — the caller checks that first by running the
 * occupation ladder and preferring an `auto` pin over any routing hit.
 *
 * PRIVACY: routing copy only. No worker data.
 */
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { ROUTING_ENTRY_BY_ID, ROUTING_TABLE, type RoutingEntry } from "./routing-table";

/** Normalised phrase -> entry id, built once. Later rows win on duplicate (none exist). */
const NORMALISED_PHRASE_TO_ENTRY: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const entry of ROUTING_TABLE) {
    for (const phrase of entry.phrases) {
      m.set(normalizeOccupationText(phrase), entry.id);
    }
  }
  return m;
})();

export function findRoutingEntryId(normalisedText: string): string | null {
  return NORMALISED_PHRASE_TO_ENTRY.get(normalisedText) ?? null;
}

/** Raw text -> entry, normalising the same way the alias corpus does. */
export function findRoutingEntry(rawText: string): RoutingEntry | null {
  const id = findRoutingEntryId(normalizeOccupationText(rawText));
  if (id === null) return null;
  return ROUTING_ENTRY_BY_ID.get(id) ?? null;
}

export function getRoutingEntry(id: string): RoutingEntry | null {
  return ROUTING_ENTRY_BY_ID.get(id) ?? null;
}
