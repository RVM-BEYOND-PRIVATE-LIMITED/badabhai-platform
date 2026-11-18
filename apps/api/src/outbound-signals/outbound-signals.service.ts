import { Injectable } from "@nestjs/common";
import type { Database, OutboundSignalKind } from "@badabhai/db";
import type { ApplicantOutcomeStage, ApplicantPostingKind } from "@badabhai/types";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { OutboundSignalsRepository } from "./outbound-signals.repository";

/**
 * How long a mark waits before it is sent: a company that taps "hired" by mistake and moves the
 * student back within this window never reaches RVM (the sender re-reads the stage before sending).
 */
export const OUTBOUND_SEND_DELAY_MS = 10 * 60_000;

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar day of `at` (`YYYY-MM-DD`): the `date` RVM's selection event carries. */
export function istDayOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The one signal per mark, ever (`outbound_signals_dedupe_key_uq`). */
export function selectionDedupeKey(
  postingKind: ApplicantPostingKind,
  postingId: string,
  workerId: string,
  stage: ApplicantOutcomeStage,
): string {
  return `rvm_selection_events:${postingKind}:${postingId}:${workerId}:${stage}`;
}

const KIND_OF: Readonly<Record<ApplicantOutcomeStage, OutboundSignalKind>> = {
  selected: "applicant_selected",
  hired: "applicant_hired",
};

/**
 * #2747 item 8 (ADR-0064 §3.6) — queue the mark RVM is told about. A company marks an RVM student
 * `selected` or `hired`, and RVM opens his proof prompt and the placement team's verification task
 * (Scheduler_Backend#162 item 8). The mark alone never releases the reward: RVM verifies.
 *
 * TWO HALVES, BOTH CALLED BY `PayerApplicantStagesService.setStage`:
 *  - {@link signalsStateFor}, BEFORE the stage transaction: is `OUTBOUND_SIGNALS_ROLLOUT`
 *    (`outbound_signals`) on for this company? `unavailable` when the pilot list cannot be read:
 *    the stage service then refuses the mark rather than save it with its signal silently lost.
 *  - {@link recordMark}, INSIDE it, after the stage row is written: queue one row for an
 *    actively linked RVM student, so the saved mark and its signal commit (or roll back)
 *    together. A BadaBhai worker, or a student whose link has ended, gets no row.
 *
 * The row holds ids only; the body (student ref, company, job title) is built when it is sent
 * (`OutboundSignalsSender`), no sooner than {@link OUTBOUND_SEND_DELAY_MS} after the mark. An undone mark sends nothing (#2771 proposes a withdrawal signal).
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
   * who is not an actively linked RVM student; `duplicate` when this mark was signalled before.
   */
  async recordMark(
    mark: {
      readonly postingKind: ApplicantPostingKind;
      readonly postingId: string;
      readonly workerId: string;
      readonly stage: ApplicantOutcomeStage;
      readonly at: Date;
    },
    tx: Database,
  ): Promise<"queued" | "duplicate" | "not_rvm"> {
    if (!(await this.repo.isActiveRvmStudent(mark.workerId, tx))) return "not_rvm";
    const queued = await this.repo.insertSelection(
      {
        dedupeKey: selectionDedupeKey(mark.postingKind, mark.postingId, mark.workerId, mark.stage),
        kind: KIND_OF[mark.stage],
        payload: {
          posting_kind: mark.postingKind,
          posting_id: mark.postingId,
          worker_id: mark.workerId,
          stage: mark.stage,
          marked_on: istDayOf(mark.at),
        },
        at: mark.at,
        sendAfter: new Date(mark.at.getTime() + OUTBOUND_SEND_DELAY_MS),
      },
      tx,
    );
    return queued ? "queued" : "duplicate";
  }
}
