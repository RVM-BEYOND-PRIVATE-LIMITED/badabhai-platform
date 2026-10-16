import type { InterviewExtractOutput } from "@badabhai/ai-contracts";

import type { ChatEditsStamp } from "../profiling/understanding/chat-edits.stamp";

/**
 * THE PROFILE BUILD HONOURS WHAT THE WORKER CONFIRMED IN CHAT (ADR-0057 R9, #2313) — pure.
 *
 * WHY THE TWO INPUTS AND NOT THE OUTPUT. The build's merge (`toExtractionOutput`) already has one
 * precedence rule per field, owned there. A confirmed change is honoured by correcting the two
 * transcript-read INPUTS before that merge runs, so every field built from them — the profile's,
 * the rich draft's and the résumé container's alike — agrees without a second precedence table:
 *
 *   1. THE PARSE OVERLAY. A pack field the worker REMOVED and never answered again is absent from
 *      the answer map, and the overlay — typed from the transcript, which still says the old value
 *      — would fill it straight back in. It is dropped from the overlay, so the field stays empty.
 *   2. PHASE C, wherever it would outrank the answer map. The model wins for the city and
 *      availability (`preferModel`), so a pack field the worker CHANGED or removed has the model's
 *      value cleared, and the answer map's confirmed value (or nothing) stands.
 *   3. PHASE C's LISTS. For a list the worker changed, the chat's settled list REPLACES Phase C's
 *      (owner ruling 2026-10-16): a deleted job never comes back, an edited one reads as confirmed.
 *
 * NO STAMP, NOTHING TOUCHED: both inputs are returned as they came, so a session with no confirmed
 * change builds a byte-identical profile.
 */

/** Phase C's keys that outrank the answer map, by the pack target field they share a fact with. */
const PHASE_C_KEY_BY_TARGET = {
  current_city: "current_city",
  availability: "availability",
  preferred_locations: "preferred_locations",
  salary_expected: "expected_salary",
} as const satisfies Readonly<Record<string, keyof InterviewExtractOutput>>;

export interface HonouredInputs<A> {
  readonly accepted: A;
  readonly interview: InterviewExtractOutput | null;
  /** Ids-only count of what was corrected, for the build's log line. */
  readonly corrected: number;
}

export function withChatEdits<A extends Readonly<Record<string, unknown>>>(
  stamp: ChatEditsStamp | null,
  accepted: A,
  interview: InterviewExtractOutput | null,
): HonouredInputs<A> {
  if (stamp === null) return { accepted, interview, corrected: 0 };
  let corrected = 0;

  const deleted = new Set(stamp.deleted_fields);
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(accepted)) {
    if (deleted.has(field)) corrected += 1;
    else kept[field] = value;
  }

  if (interview === null) return { accepted: kept as A, interview, corrected };
  let honoured: InterviewExtractOutput = interview;
  const changed = new Set(
    stamp.ledger
      .map((entry) => entry.target_field)
      .filter((field): field is string => field !== null),
  );
  for (const [target, key] of Object.entries(PHASE_C_KEY_BY_TARGET)) {
    if (!changed.has(target)) continue;
    honoured = { ...honoured, [key]: key === "preferred_locations" ? [] : null };
    corrected += 1;
  }
  if (stamp.skills !== null) {
    honoured = { ...honoured, skills: [...stamp.skills] };
    corrected += 1;
  }
  if (stamp.experiences !== null) {
    honoured = { ...honoured, experiences: stamp.experiences.map((job) => ({ ...job })) };
    corrected += 1;
  }
  return { accepted: kept as A, interview: honoured, corrected };
}
