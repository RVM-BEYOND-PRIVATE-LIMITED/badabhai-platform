import { Injectable } from "@nestjs/common";
import type { Database, OutboundSignalKind } from "@badabhai/db";
import {
  APPLICANT_OUTCOME_STAGES,
  type ApplicantOutcomeStage,
  type ApplicantPostingKind,
} from "@badabhai/types";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { OutboundSignalsRepository, type ChainRow } from "./outbound-signals.repository";

/**
 * How long a mark waits before it is sent: a company that taps "hired" by mistake and moves the
 * student back within this window never reaches RVM (the sender re-reads the stage before sending).
 * A withdrawal (#2771) waits as long, so a mark taken back and given again within it sends nothing.
 */
export const OUTBOUND_SEND_DELAY_MS = 10 * 60_000;

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar day of `at` (`YYYY-MM-DD`): the `date` RVM's selection event carries. */
export function istDayOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The key of a mark's FIRST signal (`outbound_signals_dedupe_key_uq`). */
export function selectionDedupeKey(
  postingKind: ApplicantPostingKind,
  postingId: string,
  workerId: string,
  stage: ApplicantOutcomeStage,
): string {
  return `rvm_selection_events:${postingKind}:${postingId}:${workerId}:${stage}`;
}

/** A later row of a mark's chain (#2771): unique per predecessor, so one successor per row. */
export function chainDedupeKey(firstKey: string, afterId: string): string {
  return `${firstKey}:after:${afterId}`;
}

const KIND_OF: Readonly<Record<ApplicantOutcomeStage, OutboundSignalKind>> = {
  selected: "applicant_selected",
  hired: "applicant_hired",
};

/** #2771 — the kind of a withdrawal: a selected or hired mark RVM was sent, undone. */
export const WITHDRAWAL_KIND = "applicant_mark_withdrawn" satisfies OutboundSignalKind;

/**
 * The stages under which a mark is TRUE: `selected` still holds once he is hired; `hired` holds
 * only while he is hired. The sender re-checks a signal against it before sending; a move from
 * true to not-true undoes the mark (#2771).
 */
export const STILL_TRUE: Readonly<Record<ApplicantOutcomeStage, readonly string[]>> = {
  selected: ["selected", "hired"],
  hired: ["hired"],
};

/**
 * #2771 — the marks one real move undoes: each outcome stage true before the move and not after.
 * `hired` → `shortlist` undoes both; `hired` → `selected` undoes `hired` only; `selected` → `hired`
 * undoes nothing.
 */
export function marksUndone(previous: string, next: string): ApplicantOutcomeStage[] {
  return APPLICANT_OUTCOME_STAGES.filter(
    (mark) => STILL_TRUE[mark].includes(previous) && !STILL_TRUE[mark].includes(next),
  );
}

/** More rows than a chain can ever legitimately hold: a guard against a corrupted (cyclic) one. */
const MAX_CHAIN = 1_000;

/**
 * #2771 — the newest row of a mark's chain: walk from the first selection along each row's one
 * successor. Null for a mark never signalled.
 */
export function latestOf(chain: readonly ChainRow[]): ChainRow | null {
  const next = new Map<string, ChainRow>();
  for (const row of chain) if (row.afterId !== null) next.set(row.afterId, row);
  let at = chain.find((row) => row.afterId === null) ?? null;
  for (let i = 0; at !== null && i < MAX_CHAIN; i += 1) {
    const successor = next.get(at.id);
    if (successor === undefined) return at;
    at = successor;
  }
  return at;
}

/**
 * #2771 — what RVM holds for this mark up to `fromId` (a row's predecessor): the last DELIVERED row
 * at or before it in the chain (a selection: RVM has the mark; a withdrawal: RVM was told it was
 * undone), or null when nothing up to it was ever delivered. The sender reads it only once every
 * earlier row has settled (the claim waits for a pending predecessor), so the answer is final.
 */
export function lastDeliveredFrom(
  chain: readonly ChainRow[],
  fromId: string | null,
): ChainRow | null {
  const byId = new Map(chain.map((row) => [row.id, row]));
  let cursor = fromId;
  for (let i = 0; cursor !== null && i < MAX_CHAIN; i += 1) {
    const row = byId.get(cursor);
    if (row === undefined) return null;
    if (row.status === "delivered") return row;
    cursor = row.afterId;
  }
  return null;
}

/** Is this chain row a selection (not a withdrawal)? */
export function isSelectionRow(row: ChainRow): boolean {
  return row.kind !== WITHDRAWAL_KIND;
}

/** One mark on one applicant of one posting, at one moment. */
interface MarkAt {
  readonly postingKind: ApplicantPostingKind;
  readonly postingId: string;
  readonly workerId: string;
  readonly stage: ApplicantOutcomeStage;
  readonly at: Date;
}

/**
 * #2747 item 8 (ADR-0064 §3.6) — queue the mark RVM is told about. A company marks an RVM student
 * `selected` or `hired`, and RVM opens his proof prompt and the placement team's verification task
 * (Scheduler_Backend#162 item 8). The mark alone never releases the reward: RVM verifies.
 *
 * CALLED BY `PayerApplicantStagesService.setStage`:
 *  - {@link signalsStateFor}, BEFORE the stage transaction (or, for an undo, inside it): is
 *    `OUTBOUND_SIGNALS_ROLLOUT` (`outbound_signals`) on for this company? `unavailable` when the
 *    pilot list cannot be read: the stage service then refuses the move rather than save it with
 *    its signal silently lost.
 *  - {@link recordMark}, INSIDE it, after the stage row is written: queue one row for an
 *    actively linked RVM student, so the saved mark and its signal commit (or roll back)
 *    together. A BadaBhai worker, or a student whose link has ended, gets no row.
 *  - {@link recordUndo} (#2771), INSIDE it, for each mark the move takes back
 *    ({@link marksUndone}).
 *
 * The row holds ids only; the body (student ref, company, job title) is built when it is sent
 * (`OutboundSignalsSender`), no sooner than {@link OUTBOUND_SEND_DELAY_MS} after the mark.
 *
 * THE UNDO (#2771, Prakash 19 Nov 2026). A mark's rows form a CHAIN — selection, withdrawal,
 * selection again … — each later row keyed on the one before it, so the database allows one
 * successor per row: an undo queues exactly one withdrawal, and only while the chain ends in a
 * selection that went or may yet go. A re-mark after a withdrawal queues a fresh selection. The
 * sender sends a chain in order and cancels whichever row turns out not to be needed.
 */
@Injectable()
export class OutboundSignalsService {
  constructor(
    private readonly repo: OutboundSignalsRepository,
    private readonly rollout: FeatureRolloutService,
  ) {}

  signalsStateFor(tenantKey: TenantKey): Promise<"on" | "off" | "unavailable"> {
    return this.rollout.stateFor("outbound_signals", tenantKey);
  }

  /**
   * Queue the signal for one saved outcome mark, in the caller's transaction. `not_rvm` for anyone
   * who is not an actively linked RVM student; `duplicate` when RVM has, or will have, this mark.
   */
  async recordMark(mark: MarkAt, tx: Database): Promise<"queued" | "duplicate" | "not_rvm"> {
    if (!(await this.repo.isActiveRvmStudent(mark.workerId, tx))) return "not_rvm";
    // #2771: the mark is a duplicate while the chain ends in a selection that is not cancelled
    // (pending, delivered, or refused for good). After a withdrawal, or a selection the sender
    // cancelled, marking him again queues a fresh selection after that row.
    const latest = latestOf(await this.repo.chainFor(mark, tx));
    if (latest !== null && isSelectionRow(latest) && latest.status !== "cancelled") {
      return "duplicate";
    }
    const firstKey = selectionDedupeKey(
      mark.postingKind,
      mark.postingId,
      mark.workerId,
      mark.stage,
    );
    const queued = await this.repo.insertSignal(
      {
        dedupeKey: latest === null ? firstKey : chainDedupeKey(firstKey, latest.id),
        kind: KIND_OF[mark.stage],
        payload: {
          posting_kind: mark.postingKind,
          posting_id: mark.postingId,
          worker_id: mark.workerId,
          stage: mark.stage,
          marked_on: istDayOf(mark.at),
          ...(latest === null ? {} : { after_signal_id: latest.id }),
        },
        at: mark.at,
        sendAfter: new Date(mark.at.getTime() + OUTBOUND_SEND_DELAY_MS),
      },
      tx,
    );
    return queued ? "queued" : "duplicate";
  }

  /**
   * #2771 — queue the withdrawal of one undone mark, in the caller's (stage) transaction, due
   * {@link OUTBOUND_SEND_DELAY_MS} after the undo. Only when the chain ends in a selection that is
   * `pending` (it may yet go) or `delivered` (RVM has it); the sender later cancels a withdrawal
   * whose selection never reached RVM. `nothing_sent` for a mark never signalled, or one already
   * withdrawn, cancelled or refused: a mark never sent is never withdrawn, and an undo queues at
   * most one row.
   *
   * No link check: the withdrawal carries no student reference, and a mark RVM holds is withdrawn
   * even after his link has ended.
   */
  async recordUndo(mark: MarkAt, tx: Database): Promise<"queued" | "duplicate" | "nothing_sent"> {
    const latest = latestOf(await this.repo.chainFor(mark, tx));
    if (
      latest === null ||
      !isSelectionRow(latest) ||
      (latest.status !== "pending" && latest.status !== "delivered")
    ) {
      return "nothing_sent";
    }
    const queued = await this.repo.insertSignal(
      {
        dedupeKey: chainDedupeKey(
          selectionDedupeKey(mark.postingKind, mark.postingId, mark.workerId, mark.stage),
          latest.id,
        ),
        kind: WITHDRAWAL_KIND,
        payload: {
          posting_kind: mark.postingKind,
          posting_id: mark.postingId,
          worker_id: mark.workerId,
          stage: mark.stage,
          undone_on: istDayOf(mark.at),
          after_signal_id: latest.id,
        },
        at: mark.at,
        sendAfter: new Date(mark.at.getTime() + OUTBOUND_SEND_DELAY_MS),
      },
      tx,
    );
    return queued ? "queued" : "duplicate";
  }
}
