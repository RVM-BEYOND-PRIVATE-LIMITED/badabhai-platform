import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  APPLICANT_STAGES,
  APPLICANT_STAGES_V1,
  DEFAULT_APPLICANT_STAGE,
  isApplicantOutcomeStage,
  isApplicantStage,
  isApplicantStageV1,
  type ApplicantPostingKind,
  type ApplicantStage,
} from "@badabhai/types";
import { SERVER_CONFIG } from "../config/config.module";
import { PG_CHECK_VIOLATION, sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { OutboundSignalsService, marksUndone } from "../outbound-signals/outbound-signals.service";
import { HiresService } from "../hires/hires.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { applicantStagesEnabled, type ApplicantStagesConfig } from "./payer-applicant-stages.flag";
import {
  PayerApplicantStagesRepository,
  type ApplicantStageKey,
} from "./payer-applicant-stages.repository";
import {
  APPLICANT_NOT_FOUND,
  outcomeStageRefusal,
  type ApplicantStageOptionsDto,
  type SetApplicantStageResponseDto,
} from "./payer-applicant-stage.dto";

/** One owned posting's stored board, per posting kind: worker id → stage. */
export type OwnedPostingStages = Readonly<
  Record<ApplicantPostingKind, ReadonlyMap<string, ApplicantStage>>
>;

/**
 * Who is writing a stage: the session login (the row's `actor_payer_id`, the events' actor) and the
 * tenant key the posting was resolved with (the hire record's company, #2753 item 9).
 */
interface StageWriter {
  readonly actorPayerId: string;
  readonly tenantKey: TenantKey;
}

/**
 * #2747 item 8 / #2771 — the company's `outbound_signals` switch, read at most once per move: up
 * front for a move INTO an outcome stage (so a refusal comes before any write), lazily inside the
 * transaction for a move that only takes a mark back (so an ordinary New → Shortlist move never
 * reads it).
 */
interface SignalSwitch {
  state(): Promise<"on" | "off" | "unavailable">;
}

const logger = new Logger("PayerApplicantStages");

/**
 * A stored value narrowed to the vocabulary this build knows. `payer_applicant_stages_stage_chk`
 * keeps the column inside `APPLICANT_STAGES`, so an unknown value means the database is AHEAD of
 * this build (a stage added by a later migration, then the code rolled back — e.g. a `hired` row
 * read by a build from before #2747). It reads as the default — the board this build can draw —
 * and is never handed to the event, which would refuse it. `null` (no row) is the default by
 * definition.
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
 * owns the posting. Ownership is the TENANT's (ADR-0053): the posting's own payer while org tenancy
 * is off; the whole org once it is on, so teammates share one board. Business rules only: the rows
 * are {@link PayerApplicantStagesRepository}'s.
 *
 * ACCESS IS POSTING OWNERSHIP, through THE chokepoint (ADR-0053 §4, class C "via parent"): every
 * read and write first resolves the posting with `findOwnedPostingKind` (`findOwnedJobRef` — the
 * check the unlock and disclosure writes use), and the table is then addressed only by the
 * `(posting_kind, posting_id)` that resolution returned; nothing here has a payer predicate of its
 * own. A stage can be set only on an owned posting, and only for a worker on that posting's
 * applicant feed. `actor_payer_id` only records the acting login that moved the row (and the
 * event's envelope actor is that login too); the posting check uses the resolved tenant key.
 *
 * NO ORACLE: an unknown posting, another payer's posting and a worker who is not an applicant all
 * get the SAME 404 body the feeds use ({@link APPLICANT_NOT_FOUND}).
 *
 * OFF MEANS ABSENT. With `PAYER_APPLICANT_STAGES_ENABLED` off the route is refused by its guard
 * (and again here), {@link stagesForOwnedPosting} answers `null`, and NO query touches migration
 * 0134's table — which is what makes 0134 apply-before-flag-on rather than apply-before-deploy.
 *
 * THE OUTCOME STAGES (#2747 item 7, brief 4B.8). `selected` and `hired` are WRITTEN only while
 * `OUTCOME_STAGES_ROLLOUT` (`outcome_stages`) is on for the company; off, they get the 400 the
 * route always gave an unknown stage ({@link outcomeStageRefusal}). The switch gates the write,
 * never the stored state: a stored outcome stage is read back as itself, and moving an applicant
 * out of one (back to Shortlist, say) is allowed whatever the switch says. Migration 0166 widens
 * the CHECK; the switch goes on only after it is applied and verified.
 *
 * THE SIGNAL TO RVM (#2747 item 8). A real move INTO `selected` or `hired` of an actively linked RVM
 * student, by a company with `OUTBOUND_SIGNALS_ROLLOUT` on, also queues one `outbound_signals` row
 * in the SAME transaction ({@link OutboundSignalsService.recordMark}), so the mark and its signal
 * commit together. A pilot list that cannot be read refuses the mark with a 503 (nothing written).
 * A no-op or a BadaBhai worker queues nothing; nothing touches `outbound_signals` (migration 0167)
 * while that switch is off.
 *
 * THE WITHDRAWAL (#2771). A real move that takes a mark back — out of `selected` / `hired`, or
 * `hired` → `selected` — queues, in the SAME transaction, one withdrawal per undone mark that RVM
 * was sent or may still be sent ({@link OutboundSignalsService.recordUndo}); a mark never signalled
 * queues nothing. Behind the same switch, read only when the move undoes a mark: a pilot list that
 * cannot be read then refuses the move with a 503 and the transaction rolls back.
 *
 * THE HIRE RECORD (#2753 item 9). With `HIRE_RECORDS_ENABLED` on, a REAL move INTO `hired` also
 * confirms the company's hire record ({@link HiresService.recordCompanyMark}) and a real move OUT
 * of `hired` takes back a mark nothing else confirmed ({@link HiresService.undoCompanyMark}), both
 * in the SAME transaction, keyed by the resolved tenant key. A no-op calls nothing; with the switch
 * off nothing is called and nothing touches `hires`.
 */
@Injectable()
export class PayerApplicantStagesService {
  constructor(
    private readonly repo: PayerApplicantStagesRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ApplicantStagesConfig,
    // ADR-0053 — the payer tenant resolver (PayersModule). `setStage` is a route entry point.
    private readonly tenancy: PayerTenantScopeService,
    // #2747 — the `outcome_stages` switch (FeatureRolloutModule).
    private readonly rollout: FeatureRolloutService,
    // #2747 item 8 — the RVM selection signal, queued in the stage transaction.
    private readonly outbound: OutboundSignalsService,
    // #2753 item 9 — the hire record, written in the stage transaction.
    private readonly hires: HiresService,
  ) {}

  /** `PAYER_APPLICANT_STAGES_ENABLED`, read through the one shared reader. */
  get enabled(): boolean {
    return applicantStagesEnabled(this.config);
  }

  /**
   * May this company WRITE `selected` / `hired`? Fails closed: a pilot-list read error answers no
   * (the rollout service's rule), which here costs nothing but a refused mark.
   */
  private outcomeStagesOn(tenantKey: TenantKey): Promise<boolean> {
    return this.rollout.isEnabledFor("outcome_stages", tenantKey);
  }

  /**
   * `GET /payer/reach/applicant-stages` (#2747, #2852) — the stages this company's board may move
   * an applicant into, and whether an outcome mark on an RVM student is sent to RVM. The SAME two
   * reads {@link setStage} makes, keyed by the same tenant key, so the answer is what a move made
   * now would meet. Reads no posting, no stage row and no `outbound_signals` row: it touches only
   * the pilot list (and nothing at all while both switches are `off`).
   *
   * FAILS CLOSED, NEVER 5xx: a pilot list that cannot be read answers "not open" (`isEnabledFor`
   * for the outcome stages; `unavailable` → `false` for the signal). A move made then is refused
   * by `setStage` itself (400, or 503 for the signal), so the screen simply re-reads.
   */
  async stageOptions(actorPayerId: string): Promise<ApplicantStageOptionsDto> {
    // Defence in depth, as in setStage: the route's guard already refused while the board is off.
    if (!this.enabled) throw new NotFoundException();

    const scope = await this.tenancy.resolve(actorPayerId);
    const outcomeStages = await this.outcomeStagesOn(scope.tenantKey);
    // No mark without the outcome stages, so the signal switch is not even read while they are off.
    const rvmSignal =
      outcomeStages && (await this.outbound.signalsStateFor(scope.tenantKey)) === "on";
    return {
      stages: [...(outcomeStages ? APPLICANT_STAGES : APPLICANT_STAGES_V1)],
      outcomeStages,
      rvmSignal,
    };
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
    // The SESSION payer: resolved to the tenant key for the ownership chokepoint; the login
    // itself is the row's `actor_payer_id` and the event's actor.
    actorPayerId: string,
    postingId: string,
    workerId: string,
    stage: ApplicantStage,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<SetApplicantStageResponseDto> {
    // Defence in depth: the route's guard already refused, and no query may run while off.
    if (!this.enabled) throw new NotFoundException();

    const scope = await this.tenancy.resolve(actorPayerId);
    // #2747: before the posting is looked up, so the refusal says nothing about any posting.
    if (isApplicantOutcomeStage(stage) && !(await this.outcomeStagesOn(scope.tenantKey))) {
      throw outcomeStageRefusal(stage);
    }
    const postingKind = await this.repo.findOwnedPostingKind(postingId, scope.tenantKey);
    if (postingKind === null) throw new NotFoundException(APPLICANT_NOT_FOUND);
    const key: ApplicantStageKey = { postingKind, postingId, workerId };

    // #2747 item 8: read before the transaction (a pilot-list read is its own query). A pilot list
    // that cannot be read refuses the mark (nothing written) rather than save it with its signal
    // silently lost; the company retries.
    let read: Promise<"on" | "off" | "unavailable"> | null = null;
    const signals: SignalSwitch = {
      state: () => (read ??= this.outbound.signalsStateFor(scope.tenantKey)),
    };
    if (isApplicantOutcomeStage(stage) && (await signals.state()) === "unavailable") {
      throw new ServiceUnavailableException();
    }
    const outcome = await this.writeStage(
      key,
      stage,
      { actorPayerId, tenantKey: scope.tenantKey },
      ctx,
      now,
      signals,
    );

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
   * The transaction of {@link setStage}. A CHECK violation (23514) on an outcome stage means the
   * switch was turned on before migration 0166 widened `payer_applicant_stages_stage_chk`: the
   * transaction rolls back (nothing written, no event), the request fails, and the log says which
   * migration is missing. Ids and the code only.
   */
  private async writeStage(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    who: StageWriter,
    ctx: RequestContext,
    now: Date,
    signals: SignalSwitch,
  ): Promise<{ previous: ApplicantStage; changed: boolean }> {
    try {
      return await this.transact(key, stage, who, ctx, now, signals);
    } catch (err) {
      if (sqlStateOf(err) === PG_CHECK_VIOLATION && isApplicantOutcomeStage(stage)) {
        logger.error(
          `payer_applicant_stages refused stage=${stage} (sqlstate 23514): is migration 0166 applied? posting=${key.postingId}`,
        );
      }
      throw err;
    }
  }

  private transact(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    who: StageWriter,
    ctx: RequestContext,
    now: Date,
    signals: SignalSwitch,
  ): Promise<{ previous: ApplicantStage; changed: boolean }> {
    const { actorPayerId } = who;
    return this.repo.withTransaction(async (tx) => {
      if (!(await this.repo.isFeedApplicant(key, tx))) {
        throw new NotFoundException(APPLICANT_NOT_FOUND);
      }

      let held = await this.repo.lockStage(key, tx);
      if (held === null) {
        // No row: the applicant reads `new`. Re-sending `new` is the no-op below.
        if (stage === DEFAULT_APPLICANT_STAGE) {
          return { previous: DEFAULT_APPLICANT_STAGE, changed: false } as const;
        }
        if (await this.repo.insertStage(key, stage, actorPayerId, now, tx)) {
          await this.emitChanged(key, stage, DEFAULT_APPLICANT_STAGE, actorPayerId, ctx, tx);
          await this.queueSignals(key, stage, DEFAULT_APPLICANT_STAGE, signals, now, tx);
          await this.recordHire(key, stage, DEFAULT_APPLICANT_STAGE, who, ctx, now, tx);
          return { previous: DEFAULT_APPLICANT_STAGE, changed: true } as const;
        }
        // A concurrent FIRST move won the insert (ours waited on it, so it is committed). Lock
        // and read what it stored, and continue from there as an ordinary update.
        held = await this.repo.lockStage(key, tx);
      }

      const previous = readStoredStage(held);
      if (previous === stage) return { previous, changed: false } as const;
      await this.repo.updateStage(key, stage, actorPayerId, now, tx);
      await this.emitChanged(key, stage, previous, actorPayerId, ctx, tx);
      await this.queueSignals(key, stage, previous, signals, now, tx);
      await this.recordHire(key, stage, previous, who, ctx, now, tx);
      return { previous, changed: true } as const;
    });
  }

  /**
   * The RVM signals of one REAL move (the caller already returned on a no-op), on the stage
   * transaction. #2747 item 8: a move into `selected` / `hired` records that mark. #2771: each mark
   * the move takes back ({@link marksUndone}) records its withdrawal. Nothing at all unless the
   * company's `outbound_signals` switch is on; a switch that cannot be read refuses the move (503,
   * the transaction rolls back) rather than save an undo RVM would never hear about.
   */
  private async queueSignals(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    previous: ApplicantStage,
    signals: SignalSwitch,
    at: Date,
    tx: Database,
  ): Promise<void> {
    const undone = marksUndone(previous, stage);
    if (!isApplicantOutcomeStage(stage) && undone.length === 0) return;
    const state = await signals.state();
    if (state === "unavailable") throw new ServiceUnavailableException();
    if (state !== "on") return;
    if (isApplicantOutcomeStage(stage)) await this.outbound.recordMark({ ...key, stage, at }, tx);
    for (const mark of undone) await this.outbound.recordUndo({ ...key, stage: mark, at }, tx);
  }

  /**
   * #2753 item 9 — the hire record of one REAL move (the caller already returned on a no-op). Into
   * `hired`: the company's mark confirms the record. Out of `hired`: the undo rule. Any other move,
   * or `HIRE_RECORDS_ENABLED` off: nothing is called. On the stage transaction, keyed by the tenant
   * key the posting was resolved with, so a teammate's mark and the founder's are one company.
   */
  private async recordHire(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    previous: ApplicantStage,
    who: StageWriter,
    ctx: RequestContext,
    at: Date,
    tx: Database,
  ): Promise<void> {
    if (stage !== "hired" && previous !== "hired") return;
    if (!this.hires.enabled) return;
    const hireKey = { tenantPayerId: who.tenantKey, ...key };
    const by = {
      // The VERIFIED session login who moved the row, as on the stage event; never the tenant.
      actor: { actor_type: "payer", actor_id: who.actorPayerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    } as const;
    if (stage === "hired") await this.hires.recordCompanyMark(hireKey, at, tx, by);
    else await this.hires.undoCompanyMark(hireKey, at, tx, by);
  }

  /**
   * The stored board of ONE posting the tenant owns, for the per-posting feed to annotate its rows
   * with — `null` while the flag is off (no query). `tenant` is the CALLER's one resolution of the
   * session payer (ADR-0053 §5.2 rule 1), never re-resolved here.
   *
   * OWNERSHIP FIRST, THROUGH THE CHOKEPOINT (ADR-0053 §4): the posting is resolved with
   * `findOwnedPostingKind` — jobs-first, exactly the resolution the feed itself makes — and only
   * then is the board read, by the resolved `(posting_kind, posting_id)`. Another tenant's posting
   * (or an unknown id) resolves to nothing, so its board is never read and the answer is empty.
   */
  async stagesForOwnedPosting(
    postingId: string,
    tenant: TenantKey,
  ): Promise<OwnedPostingStages | null> {
    if (!this.enabled) return null;
    const byKind: Record<ApplicantPostingKind, Map<string, ApplicantStage>> = {
      agency_job: new Map(),
      company_posting: new Map(),
    };
    const postingKind = await this.repo.findOwnedPostingKind(postingId, tenant);
    if (postingKind === null) return byKind;
    for (const row of await this.repo.listPostingStages(postingKind, postingId)) {
      byKind[postingKind].set(row.workerId, readStoredStage(row.stage));
    }
    return byKind;
  }

  /**
   * The spine record of one real move. A move between two of the first three stages is
   * `payer.applicant_stage_changed` v1, byte for byte as before #2747; a move to or from
   * `selected` / `hired` is `payer.applicant_stage_changed_v2`. So no move is reported twice.
   */
  private async emitChanged(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    previous: ApplicantStage,
    actorPayerId: string,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    const envelope = {
      // The VERIFIED session login who moved the row — never a body value (XB-A), never the
      // tenant (ADR-0053 §7: the person rides the envelope).
      actor: { actor_type: "payer", actor_id: actorPayerId },
      // The applicant is what moved; the posting rides the payload.
      subject: { subject_type: "worker", subject_id: key.workerId },
      // NO idempotency key, deliberately (the `resume.skin_changed` reasoning). Exactly-once comes
      // from the transaction and the no-op above; a transition key such as `from:to` would wrongly
      // dedupe a legitimate second New → Shortlist after the applicant was moved back.
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    } as const;
    const ids = {
      posting_kind: key.postingKind,
      posting_id: key.postingId,
      worker_id: key.workerId,
    };
    if (isApplicantStageV1(stage) && isApplicantStageV1(previous)) {
      await this.events.emit({
        ...envelope,
        event_name: "payer.applicant_stage_changed",
        payload: {
          ...ids,
          stage,
          previous_stage: previous,
        } satisfies PayloadInputOf<"payer.applicant_stage_changed">,
      });
      return;
    }
    await this.events.emit({
      ...envelope,
      event_name: "payer.applicant_stage_changed_v2",
      payload: {
        ...ids,
        stage,
        previous_stage: previous,
      } satisfies PayloadInputOf<"payer.applicant_stage_changed_v2">,
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
