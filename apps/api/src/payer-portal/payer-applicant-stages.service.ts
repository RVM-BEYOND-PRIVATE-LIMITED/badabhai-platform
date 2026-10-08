import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  DEFAULT_APPLICANT_STAGE,
  isApplicantStage,
  type ApplicantPostingKind,
  type ApplicantStage,
} from "@badabhai/types";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { applicantStagesEnabled, type ApplicantStagesConfig } from "./payer-applicant-stages.flag";
import {
  PayerApplicantStagesRepository,
  type ApplicantStageKey,
} from "./payer-applicant-stages.repository";
import {
  APPLICANT_NOT_FOUND,
  type SetApplicantStageResponseDto,
} from "./payer-applicant-stage.dto";

/** One owned posting's stored board, per posting kind: worker id → stage. */
export type OwnedPostingStages = Readonly<
  Record<ApplicantPostingKind, ReadonlyMap<string, ApplicantStage>>
>;

const logger = new Logger("PayerApplicantStages");

/**
 * A stored value narrowed to the vocabulary this build knows. `payer_applicant_stages_stage_chk`
 * keeps the column inside `APPLICANT_STAGES`, so an unknown value means the database is AHEAD of
 * this build (a stage added by a later migration, then the code rolled back). It reads as the
 * default — the board this build can draw — and is never handed to the event, which would refuse
 * it. `null` (no row) is the default by definition.
 */
export function readStoredStage(stored: string | null | undefined): ApplicantStage {
  if (stored === null || stored === undefined) return DEFAULT_APPLICANT_STAGE;
  if (isApplicantStage(stored)) return stored;
  logger.warn("payer_applicant_stages holds a stage this build does not know; reading it as new");
  return DEFAULT_APPLICANT_STAGE;
}

/**
 * THE PAYER APPLICANT PIPELINE BOARD (owner ruling 2026-10-07) — payer-web's New / Shortlist /
 * Passed stages, saved server-side so they survive a reload and are the same in every session that
 * owns the posting. Today that is the posting's own payer; teammates share the board only once
 * PAY-DB-01 (ADR-0053) moves posting ownership to the org. Business rules only: the rows are
 * {@link PayerApplicantStagesRepository}'s.
 *
 * ACCESS IS POSTING OWNERSHIP, through THE chokepoint (ADR-0053 §4, class C "via parent"): every
 * read and write first resolves the posting with `findOwnedPostingKind` (`findOwnedJobRef` — the
 * check the unlock and disclosure writes use), and the table is then addressed only by the
 * `(posting_kind, posting_id)` that resolution returned; nothing here has a payer predicate of its
 * own. A stage can be set only on an owned posting, and only for a worker on that posting's
 * applicant feed. `actor_payer_id` only records the acting login that moved the row. When
 * PAY-DB-01 retypes the chokepoint to the org's tenant key, the board becomes the org's with no
 * change here.
 *
 * NO ORACLE: an unknown posting, another payer's posting and a worker who is not an applicant all
 * get the SAME 404 body the feeds use ({@link APPLICANT_NOT_FOUND}).
 *
 * OFF MEANS ABSENT. With `PAYER_APPLICANT_STAGES_ENABLED` off the route is refused by its guard
 * (and again here), {@link stagesForOwnedPosting} answers `null`, and NO query touches migration
 * 0134's table — which is what makes 0134 apply-before-flag-on rather than apply-before-deploy.
 */
@Injectable()
export class PayerApplicantStagesService {
  constructor(
    private readonly repo: PayerApplicantStagesRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ApplicantStagesConfig,
  ) {}

  /** `PAYER_APPLICANT_STAGES_ENABLED`, read through the one shared reader. */
  get enabled(): boolean {
    return applicantStagesEnabled(this.config);
  }

  /**
   * `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` — put one applicant in `stage`.
   *
   * RESOLVES THE POSTING THE WAY THE FEED DOES: `postingId` is an owned agency `jobs` row or an
   * owned company `job_postings` row (jobs-first); anything else is the neutral 404, before the
   * transaction opens. Then, INSIDE it, the worker must be on that posting's feed — checked in
   * the same transaction as the write, so a stage is never stored for a non-applicant.
   *
   * IDEMPOTENT. The stage the applicant already holds (a retry, a double tap, `new` for someone
   * nobody moved) is a 200 with `changed: false`: nothing written, no event. A real change writes
   * the row and emits `payer.applicant_stage_changed` in ONE transaction (the event commits iff
   * the stage does). The row is locked for the duration, so two concurrent requests moving the
   * same applicant serialise and each event reports the stage it actually replaced; two concurrent
   * FIRST moves cannot both insert — the loser re-reads the winner's committed stage and proceeds
   * from it (last write wins, every event exact).
   */
  async setStage(
    // The SESSION payer: the ownership chokepoint's input and the row's/event's actor.
    payerId: string,
    postingId: string,
    workerId: string,
    stage: ApplicantStage,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<SetApplicantStageResponseDto> {
    // Defence in depth: the route's guard already refused, and no query may run while off.
    if (!this.enabled) throw new NotFoundException();

    const postingKind = await this.repo.findOwnedPostingKind(postingId, payerId);
    if (postingKind === null) throw new NotFoundException(APPLICANT_NOT_FOUND);
    const key: ApplicantStageKey = { postingKind, postingId, workerId };

    const outcome = await this.repo.withTransaction(async (tx) => {
      if (!(await this.repo.isFeedApplicant(key, tx))) {
        throw new NotFoundException(APPLICANT_NOT_FOUND);
      }

      let held = await this.repo.lockStage(key, tx);
      if (held === null) {
        // No row: the applicant reads `new`. Re-sending `new` is the no-op below.
        if (stage === DEFAULT_APPLICANT_STAGE) {
          return { previous: DEFAULT_APPLICANT_STAGE, changed: false } as const;
        }
        if (await this.repo.insertStage(key, stage, payerId, now, tx)) {
          await this.emitChanged(key, stage, DEFAULT_APPLICANT_STAGE, payerId, ctx, tx);
          return { previous: DEFAULT_APPLICANT_STAGE, changed: true } as const;
        }
        // A concurrent FIRST move won the insert (ours waited on it, so it is committed). Lock
        // and read what it stored, and continue from there as an ordinary update.
        held = await this.repo.lockStage(key, tx);
      }

      const previous = readStoredStage(held);
      if (previous === stage) return { previous, changed: false } as const;
      await this.repo.updateStage(key, stage, payerId, now, tx);
      await this.emitChanged(key, stage, previous, payerId, ctx, tx);
      return { previous, changed: true } as const;
    });

    return {
      postingId,
      postingKind,
      workerId,
      stage,
      previousStage: outcome.previous,
      changed: outcome.changed,
    };
  }

  /**
   * The stored board of ONE posting the payer owns, for the per-posting feed to annotate its rows
   * with — `null` while the flag is off (no query).
   *
   * OWNERSHIP FIRST, THROUGH THE CHOKEPOINT (ADR-0053 §4): the posting is resolved with
   * `findOwnedPostingKind` — jobs-first, exactly the resolution the feed itself makes — and only
   * then is the board read, by the resolved `(posting_kind, posting_id)`. Another payer's posting
   * (or an unknown id) resolves to nothing, so its board is never read and the answer is empty.
   */
  async stagesForOwnedPosting(
    postingId: string,
    payerId: string,
  ): Promise<OwnedPostingStages | null> {
    if (!this.enabled) return null;
    const byKind: Record<ApplicantPostingKind, Map<string, ApplicantStage>> = {
      agency_job: new Map(),
      company_posting: new Map(),
    };
    const postingKind = await this.repo.findOwnedPostingKind(postingId, payerId);
    if (postingKind === null) return byKind;
    for (const row of await this.repo.listPostingStages(postingKind, postingId)) {
      byKind[postingKind].set(row.workerId, readStoredStage(row.stage));
    }
    return byKind;
  }

  private async emitChanged(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    previous: ApplicantStage,
    payerId: string,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      event_name: "payer.applicant_stage_changed",
      // The VERIFIED session payer who moved the row — never a body value (XB-A).
      actor: { actor_type: "payer", actor_id: payerId },
      // The applicant is what moved; the posting rides the payload.
      subject: { subject_type: "worker", subject_id: key.workerId },
      payload: {
        posting_kind: key.postingKind,
        posting_id: key.postingId,
        worker_id: key.workerId,
        stage,
        previous_stage: previous,
      } satisfies PayloadInputOf<"payer.applicant_stage_changed">,
      // NO idempotency key, deliberately (the `resume.skin_changed` reasoning). Exactly-once comes
      // from the transaction and the no-op above; a transition key such as `from:to` would wrongly
      // dedupe a legitimate second New → Shortlist after the applicant was moved back.
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }
}

/** Annotate each feed row with its stage (`new` when the board holds none). */
export function withStages<R extends { workerId: string }>(
  rows: readonly R[],
  stages: ReadonlyMap<string, ApplicantStage>,
): (R & { stage: ApplicantStage })[] {
  return rows.map((row) => ({
    ...row,
    stage: stages.get(row.workerId) ?? DEFAULT_APPLICANT_STAGE,
  }));
}
