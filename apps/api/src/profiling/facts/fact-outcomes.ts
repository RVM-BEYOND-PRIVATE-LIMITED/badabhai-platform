import type { QuestionPackItem } from "@badabhai/ai-contracts";

import type { AnswerMap } from "../answer-map";
import { factForPackItem, type WorkerFactId } from "./worker-fact.registry";

/**
 * Per-fact outcome of ONE session's answer map — the sets the Phase 3 settled-vs-missing view
 * renders (fill-gap Phase 2).
 *
 * WHY THIS EXISTS AT ALL. The answer map knows three statuses (`answered`, `declined`,
 * `unanswered`) and a fourth state it deliberately does not store: NO record. Those four mean
 * different things to a worker deciding what to finish, and the difference between the last two
 * is the whole point:
 *
 *  - `unanswered` — the question was SERVED and the interview moved past it without an answer
 *    (including the ask budget's final turn, pinned in `orchestrator.service.test.ts`).
 *  - `missing` — nothing was ever asked. Either the session ended before reaching it or the
 *    budget was spent first.
 *
 * Collapsing those would tell a worker "you skipped this" about a question they never saw. PURE,
 * and read-only: this computes a classification and writes nothing, so it cannot change
 * completion, progress or any counting elsewhere.
 *
 * `declined` IS A COMPLETE ANSWER (`answer-map.ts`, "never re-asked, never blocking completion")
 * — it is reported as its own status precisely so the view can say "you told us you don't know"
 * rather than "missing". `isCore` is carried alongside so the view can mark the declined CORE
 * questions, which are the ones a worker is most likely to want to revisit.
 */
export type FactOutcomeStatus = "answered" | "declined" | "unanswered" | "missing";

export interface FactOutcome {
  readonly fact: WorkerFactId;
  /** The pack item the fact was resolved through — first spelling wins, in pack order. */
  readonly questionKey: string;
  readonly status: FactOutcomeStatus;
  readonly isCore: boolean;
}

/**
 * Best-status-wins ranking. Two pack items can settle the same fact (aliases — `trade` has
 * several), and a worker who answered through one spelling has settled the fact regardless of
 * what a sibling spelling's record says. Answered beats declined beats unanswered beats absent.
 */
const STATUS_PRIORITY: Readonly<Record<FactOutcomeStatus, number>> = {
  answered: 3,
  declined: 2,
  unanswered: 1,
  missing: 0,
};

/**
 * Classify every fact the given pack items settle, in first-appearance (display) order.
 *
 * Items that name no registered fact are skipped: they are pack-local attributes with no fact
 * identity, and inventing one here would put a field into the view that no other surface knows.
 * The caller passes the items of the session's RESOLVED packs (occupation + universal), so the
 * outcome set is exactly "what this road could have collected".
 */
export function sessionFactOutcomes(
  items: readonly Pick<QuestionPackItem, "question_key" | "target_field" | "is_core">[],
  answers: AnswerMap,
): FactOutcome[] {
  const byFact = new Map<WorkerFactId, FactOutcome>();

  for (const item of items) {
    const match = factForPackItem(item);
    if (!match) continue;

    const record = answers[item.question_key];
    const status = record?.status;
    const outcome: FactOutcome = {
      fact: match.fact,
      questionKey: item.question_key,
      status:
        status === "answered" || status === "declined" || status === "unanswered"
          ? status
          : "missing",
      isCore: item.is_core,
    };

    const held = byFact.get(match.fact);
    if (!held || STATUS_PRIORITY[outcome.status] > STATUS_PRIORITY[held.status]) {
      byFact.set(match.fact, outcome);
    }
  }

  return [...byFact.values()];
}

/** The facts a question was served for and the worker never answered — the finish-list feed. */
export function unansweredFacts(outcomes: readonly FactOutcome[]): WorkerFactId[] {
  return outcomes.filter((outcome) => outcome.status === "unanswered").map((o) => o.fact);
}

/** The CORE facts the worker explicitly declined — complete answers the view must not show as gaps. */
export function declinedCoreFacts(outcomes: readonly FactOutcome[]): WorkerFactId[] {
  return outcomes
    .filter((outcome) => outcome.status === "declined" && outcome.isCore)
    .map((o) => o.fact);
}
