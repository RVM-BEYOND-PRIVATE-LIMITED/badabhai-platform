import type { HireRecordSource, HireStatus } from "@badabhai/types";
import { istDateString } from "../auth/session-tiers";

/**
 * #2753 item 9 — THE RULES of a hire record, as one pure function. No database, no clock, no
 * config: {@link HiresService} locks the row, asks here what it becomes, and writes that.
 *
 * WHAT EACH SOURCE DOES (the design note and owner question 2's default):
 *  - `company_mark`, `company_answer`, `desk_confirm` CONFIRM: each stamps its own column the first
 *    time and leaves the record `confirmed`. A company mark is a confirmation on its own.
 *  - `worker_answer` REPORTS: it stamps `worker_answered_at` the first time and leaves the record
 *    `reported`, unless it is already `confirmed` (then it stays confirmed). The worker's word
 *    alone never confirms a hire.
 *  - `company_unmark` is THE UNDO: the company moved him OUT of `hired`. A record confirmed by the
 *    company's mark and by nothing else (no company answer, no desk confirmation) goes to
 *    `rejected`. Any other record is left alone. A later re-mark confirms it again.
 *  - `desk_reject`: the desk's word is final until someone confirms again.
 *
 * HISTORY STAYS. A timestamp is set once — the first time its source said "hired" — and never
 * cleared, by an undo or a rejection alike, so "how it was confirmed" stays readable. `hired_on`
 * is the India day of the FIRST confirming source and is kept as well; readers count only
 * `confirmed` rows.
 *
 * ONE ANSWER PER CALL: the state the record must now hold, or `null` when nothing changes (a
 * repeat, an undo of something no mark confirmed, or a take-back of a record that does not exist).
 * A change is a new status or a newly stamped source; only a change is written and emitted.
 */

/** The parts of a `hires` row these rules read and write. */
export interface HireState {
  readonly status: HireStatus;
  readonly companyMarkedAt: Date | null;
  readonly companyAnsweredAt: Date | null;
  readonly workerAnsweredAt: Date | null;
  readonly deskConfirmedAt: Date | null;
  /** `YYYY-MM-DD`, India time; null until a source confirms. */
  readonly hiredOn: string | null;
}

/** The column each source that says "hired" stamps. The two take-backs stamp nothing. */
const STAMP: Readonly<
  Partial<
    Record<
      HireRecordSource,
      "companyMarkedAt" | "companyAnsweredAt" | "workerAnsweredAt" | "deskConfirmedAt"
    >
  >
> = {
  company_mark: "companyMarkedAt",
  company_answer: "companyAnsweredAt",
  worker_answer: "workerAnsweredAt",
  desk_confirm: "deskConfirmedAt",
};

const CONFIRMS: readonly HireRecordSource[] = ["company_mark", "company_answer", "desk_confirm"];

/** A record nobody has written yet: what a source that may create one starts from. */
const BLANK: HireState = {
  status: "reported",
  companyMarkedAt: null,
  companyAnsweredAt: null,
  workerAnsweredAt: null,
  deskConfirmedAt: null,
  hiredOn: null,
};

/** India Standard Time day (`YYYY-MM-DD`) of an instant. */
export function hireDayOf(at: Date): string {
  return istDateString(at.getTime());
}

/**
 * The state the record must hold after `source` said its word at `at`, or `null` when nothing
 * changes. `current` is the locked row, or `null` when the record does not exist yet.
 */
export function nextHireState(
  current: HireState | null,
  source: HireRecordSource,
  at: Date,
): HireState | null {
  if (source === "company_unmark") {
    if (current === null) return null;
    const onlyTheMark =
      current.status === "confirmed" &&
      current.companyMarkedAt !== null &&
      current.companyAnsweredAt === null &&
      current.deskConfirmedAt === null;
    return onlyTheMark ? { ...current, status: "rejected" } : null;
  }

  if (source === "desk_reject") {
    if (current === null || current.status === "rejected") return null;
    return { ...current, status: "rejected" };
  }

  const before = current ?? BLANK;
  const column = STAMP[source]!;
  const firstTime = before[column] === null;

  if (source === "worker_answer") {
    // A repeat of his own answer changes nothing, whatever the record says now.
    if (!firstTime) return null;
    return {
      ...before,
      workerAnsweredAt: at,
      status: before.status === "confirmed" ? "confirmed" : "reported",
    };
  }

  // A confirming source.
  if (!CONFIRMS.includes(source)) throw new Error(`unknown hire source: ${String(source)}`);
  const next: HireState = {
    ...before,
    [column]: firstTime ? at : before[column],
    status: "confirmed",
    hiredOn: before.hiredOn ?? hireDayOf(at),
  };
  const changed = current === null || firstTime || current.status !== "confirmed";
  return changed ? next : null;
}
