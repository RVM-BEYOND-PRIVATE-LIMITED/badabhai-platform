import type { UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";

/**
 * #2753 item 10 — THE RULES of the company follow-up, as pure functions. No database, no clock,
 * no config: {@link import("./unlock-outcomes.service").UnlockOutcomesService} reads the clock and
 * the setting, and the due list's SQL (`UnlockOutcomesRepository.listDue`) is this rule written
 * as WHERE clauses over the same cutoff.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant an event must be at or before to be `afterDays` old at `now`. Whole days of 24
 * hours (not India calendar days): "granted at least 7 days ago" is `granted_at <= now - 7 × 24h`.
 */
export function followupCutoff(now: Date, afterDays: number): Date {
  return new Date(now.getTime() - afterDays * DAY_MS);
}

/** What the due rule reads about one opened contact. */
export interface DueFacts {
  /** `unlocks.granted_at`; null for a row that never opened (a request or a denial). */
  readonly grantedAt: Date | null;
  /** The stored answer, or null when the company has not answered. */
  readonly outcome: UnlockOutcome | null;
  /** When the stored answer was given; null with no answer. */
  readonly answeredAt: Date | null;
}

/**
 * IS THIS OPENED CONTACT DUE FOR THE FOLLOW-UP? Due when it was granted at least `afterDays` ago
 * AND either nobody has answered, or the answer is `still_talking` and is itself at least
 * `afterDays` old. Any other answer (`hired`, `not_hired`, the desk's `not_reached`) closes it.
 * The boundary counts: exactly `afterDays` is due.
 *
 * WHY "DUE" IS COMPUTED, NOT MARKED. #2753 item 10 says "a sweep marks each opened contact as due
 * after a set number of days". Marking would store a fact that is fully determined by two dates
 * and one answer — and stored, it can drift: a sweep that ran late or twice, a setting changed
 * between sweeps, an answer that raced the sweep. Computing it at read time gives the same list
 * the sweep would have produced, every time, with nothing to repair. The ownership and the worker
 * (his erasure, a pending deletion or a suspension) are the SQL's: a fact about the unlock and its
 * worker, not about this answer.
 *
 * A sweep would still be needed to NOTIFY a company that something is due; no company notification
 * channel exists today (the in-app feed under `notifications/` is the worker's, and email carries
 * only the closed transactional purposes), so there is nothing for one to send.
 */
export function isFollowupDue(facts: DueFacts, now: Date, afterDays: number): boolean {
  const cutoff = followupCutoff(now, afterDays).getTime();
  if (facts.grantedAt === null || facts.grantedAt.getTime() > cutoff) return false;
  if (facts.outcome === null) return true;
  if (facts.outcome !== "still_talking") return false;
  return facts.answeredAt !== null && facts.answeredAt.getTime() <= cutoff;
}

/** The stored answer the write decision reads. */
export interface HeldAnswer {
  readonly outcome: UnlockOutcome;
  readonly answeredBy: UnlockOutcomeAnswerer;
}

/**
 * WHAT ONE ANSWER DOES TO THE STORED ROW. One row per unlock; a later answer replaces the earlier
 * one, and the spine keeps the history:
 *  - `insert`: no answer yet — store it and emit `unlock.outcome_recorded`;
 *  - `change`: a different outcome or a different answerer — replace it and emit;
 *  - `refresh`: `still_talking` again from the same answerer — move `answered_at` only, so the
 *    contact waits the full follow-up period again before it is due; NO event (nothing changed);
 *  - `none`: any other repeat (a retry, a double tap) — nothing written, no event. A repeated
 *    `hired` must not move `answered_at`, which would move the hire into a later counted week.
 */
export type OutcomeWrite = "insert" | "change" | "refresh" | "none";

export function decideOutcomeWrite(
  held: HeldAnswer | null,
  outcome: UnlockOutcome,
  answeredBy: UnlockOutcomeAnswerer,
): OutcomeWrite {
  if (held === null) return "insert";
  if (held.outcome !== outcome || held.answeredBy !== answeredBy) return "change";
  return outcome === "still_talking" ? "refresh" : "none";
}
