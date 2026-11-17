import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type {
  ApplicantPostingKind,
  UnlockCompanyOutcome,
  UnlockOutcome,
  UnlockOutcomeAnswerer,
} from "@badabhai/types";
import { SERVER_CONFIG } from "../config/config.module";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { HiresService } from "../hires/hires.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { decideOutcomeWrite, followupCutoff } from "./unlock-outcome-rules";
import { unlockFollowupEnabled, type UnlockFollowupConfig } from "./unlock-outcomes.flag";
import {
  UnlockOutcomesRepository,
  type DueRow,
  type HeldOutcome,
  type OpenedUnlock,
} from "./unlock-outcomes.repository";
import {
  encodeDueCursor,
  type DueUnlockItemDto,
  type DueUnlocksPageDto,
  type DueUnlocksQueryDto,
  type RecordUnlockOutcomeResponseDto,
} from "./unlock-outcomes.dto";

/** Postgres `foreign_key_violation`: the worker was erased between the read and the insert. */
const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Who answered, for the event envelope: the company login, or the admin at the desk (#2750).
 * Never the tenant key (that is the row's own column).
 */
export interface OutcomeOrigin {
  readonly actor: {
    readonly actor_type: "payer" | "admin";
    readonly actor_id: string;
  };
  readonly correlationId: string;
  readonly requestId?: string;
}

/**
 * #2750 item 7 — who gave the desk's answer: a desk admin, or `system` (no id) when the
 * couldn't-reach deadline sweep closes a case nobody closed in time.
 */
export interface DeskOutcomeOrigin {
  readonly actor:
    | OutcomeOrigin["actor"]
    | { readonly actor_type: "system"; readonly actor_id: null };
  readonly correlationId: string;
  readonly requestId?: string;
}

/** What one answer did to the stored row. */
export interface UnlockOutcomeWrite {
  readonly unlockId: string;
  readonly workerId: string;
  readonly outcome: UnlockOutcome;
  /** The answer stored before this one; null for the first. */
  readonly previousOutcome: UnlockOutcome | null;
  /** When the stored answer was given, after this call. */
  readonly answeredAt: Date;
  /** A new answer was recorded and `unlock.outcome_recorded` emitted on the caller's tx. */
  readonly changed: boolean;
}

/**
 * #2753 item 10 — THE COMPANY FOLLOW-UP: what became of each contact a company opened.
 *
 *  - {@link listDue}: `GET /payer/unlock-outcomes/due`, the tenant's contacts due for an answer.
 *    "Due" is COMPUTED at read time (`isFollowupDue`, the SQL in `listDue`), not marked by a sweep:
 *    the same list, with no stored state that can drift.
 *  - {@link recordCompanyOutcome}: `POST /payer/unlocks/:unlockId/outcome`, the company's answer.
 *  - {@link recordDeskOutcome}: the desk's `not_reached` (#2750), on the desk's own transaction.
 *    No route calls it yet.
 *
 * ONE ROW PER UNLOCK (`unlock_outcomes`): a later answer replaces the earlier one, and
 * `unlock.outcome_recorded` (one per real change, in the same transaction) is the history.
 *
 * THE HIRE LINK (#2753 item 9). A `hired` answer, with `HIRE_RECORDS_ENABLED` on, confirms the
 * company's hire record ({@link HiresService.recordCompanyAnswer}) in the SAME transaction, keyed by
 * the tenant, the worker and the unlock's posting.
 *
 * OFF MEANS ABSENT. With `UNLOCK_FOLLOWUP_ENABLED` off the routes are refused by their guard (and
 * again here), and the desk method writes nothing — nothing names `unlock_outcomes`, which is
 * what makes its migration apply-before-the-switch rather than apply-before-deploy.
 */
@Injectable()
export class UnlockOutcomesService {
  constructor(
    private readonly repo: UnlockOutcomesRepository,
    private readonly events: EventsService,
    // #2753 item 9 — the hire record a `hired` answer confirms (HiresModule).
    private readonly hires: HiresService,
    // ADR-0053 — the payer tenant resolver (PayersModule). Both routes are entry points.
    private readonly tenancy: PayerTenantScopeService,
    @Inject(SERVER_CONFIG) private readonly config: UnlockFollowupConfig,
  ) {}

  /** `UNLOCK_FOLLOWUP_ENABLED`, read through the one shared reader. */
  get enabled(): boolean {
    return unlockFollowupEnabled(this.config);
  }

  /**
   * `GET /payer/unlock-outcomes/due` — one page of the session tenant's contacts due for the
   * follow-up, the longest-waiting first. Ids, the grant time and the current answer: no name, no
   * phone, no posting. In mode `on` a teammate sees the org's contacts (the unlock list's rule).
   * Read-only: no event.
   */
  async listDue(
    actorPayerId: string,
    query: DueUnlocksQueryDto,
    now: Date = new Date(),
  ): Promise<DueUnlocksPageDto> {
    // Defence in depth: the route's guard already refused, and no query may run while off.
    if (!this.enabled) throw new NotFoundException();
    const scope = await this.tenancy.resolve(actorPayerId);
    const cutoff = followupCutoff(now, this.config.UNLOCK_FOLLOWUP_AFTER_DAYS);
    const rows = await this.repo.listDue(
      scope.tenantKey,
      cutoff,
      query.cursor ?? null,
      query.limit + 1,
    );
    // Over-fetch by one, so the cursor is honest at an exact multiple of the page size.
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(toDueItem),
      nextCursor:
        hasMore && last
          ? encodeDueCursor({ grantedKey: last.grantedKey, unlockId: last.unlockId })
          : null,
    };
  }

  /**
   * `POST /payer/unlocks/:unlockId/outcome` — the company's answer about one contact it opened.
   *
   * OWNERSHIP FIRST, through the unlock routes' chokepoint: the session payer resolves to its
   * tenant key, and the unlock must be that tenant's (`unlocks.payer_id`), an opened contact
   * (granted, revealed or lapsed) whose worker still exists. Anything else — an unknown id,
   * another company's, a request or a denial, an erased worker — is the ONE neutral 404, the same
   * body the switch-off guard gives. Not due yet is NOT a refusal: a company may answer early.
   *
   * ONE TRANSACTION: the row (insert, replace, or for a repeated `still_talking` a moved
   * `answered_at`), `unlock.outcome_recorded` on a real change, and for `hired` the hire record.
   */
  async recordCompanyOutcome(
    actorPayerId: string,
    unlockId: string,
    outcome: UnlockCompanyOutcome,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<RecordUnlockOutcomeResponseDto> {
    if (!this.enabled) throw new NotFoundException();
    const scope = await this.tenancy.resolve(actorPayerId);
    const by: OutcomeOrigin = {
      // The VERIFIED session login who answered — never a body value (XB-A), never the tenant.
      actor: { actor_type: "payer", actor_id: actorPayerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    };

    let written: UnlockOutcomeWrite;
    try {
      written = await this.repo.withTransaction(async (tx) => {
        const unlock = await this.repo.findOwnedOpened(unlockId, scope.tenantKey, tx);
        if (unlock === null) throw new NotFoundException();
        const write = await this.write(unlock, outcome, "company", now, tx, by);
        if (outcome === "hired") await this.recordHire(unlock, scope.tenantKey, now, tx, by);
        return write;
      });
    } catch (err) {
      // The worker was erased between the read and the insert (his row is gone, so the FK
      // refuses): the same neutral 404 an erased worker's unlock gets. Nothing was written.
      if (sqlStateOf(err) === PG_FOREIGN_KEY_VIOLATION) throw new NotFoundException();
      throw err;
    }

    return {
      unlock_id: written.unlockId,
      worker_id: written.workerId,
      outcome,
      previous_outcome: written.previousOutcome,
      answered_at: written.answeredAt.toISOString(),
      changed: written.changed,
    };
  }

  /**
   * THE DESK'S ANSWER (#2750's couldn't-reach case): store `not_reached` for `unlockId`, on the
   * DESK'S transaction, answered by `desk`. Any opened contact, whichever company holds it (the
   * desk acts for the company); like every answer it replaces what was stored. Reusable as is:
   * #2750 adds the route, its guard and its audit.
   *
   * `null` — nothing written, nothing emitted — while `UNLOCK_FOLLOWUP_ENABLED` is off (no query
   * names the table, so the desk's transaction never fails on a missing migration) and when the
   * unlock is not an opened contact or its worker was erased.
   */
  async recordDeskOutcome(
    unlockId: string,
    outcome: "not_reached",
    tx: Database,
    by: DeskOutcomeOrigin,
    at: Date = new Date(),
  ): Promise<UnlockOutcomeWrite | null> {
    if (!this.enabled) return null;
    const unlock = await this.repo.findOpened(unlockId, tx);
    if (unlock === null) return null;
    // `not_reached` never reaches the hire link (only a company's `hired` does), so the only use of
    // `by` here is the event envelope, which takes a `system` actor as it is.
    return this.write(unlock, outcome, "desk", at, tx, by as OutcomeOrigin);
  }

  /**
   * Lock the unlock's answer, ask the rules what this answer does, write that and emit — or do
   * nothing. A first answer that loses the insert to a concurrent one (ours waited on it, so it is
   * committed) locks the winner's row and decides again from it.
   */
  private async write(
    unlock: OpenedUnlock,
    outcome: UnlockOutcome,
    answeredBy: UnlockOutcomeAnswerer,
    at: Date,
    tx: Database,
    by: OutcomeOrigin,
  ): Promise<UnlockOutcomeWrite> {
    const answer = { outcome, answeredBy, answeredAt: at };
    let held: HeldOutcome | null = await this.repo.lockOutcome(unlock.unlockId, tx);
    if (held === null) {
      if (await this.repo.insertOutcome(unlock, answer, tx)) {
        await this.emit(unlock, outcome, answeredBy, tx, by);
        return outcomeWrite(unlock, outcome, null, at, true);
      }
      held = await this.repo.lockOutcome(unlock.unlockId, tx);
      if (held === null) {
        throw new Error("unlock_outcomes: a concurrent insert won the key but no row is there");
      }
    }

    const decision = decideOutcomeWrite(held, outcome, answeredBy);
    if (decision === "none") {
      return outcomeWrite(unlock, outcome, held.outcome, held.answeredAt, false);
    }
    await this.repo.updateOutcome(unlock.unlockId, answer, tx);
    if (decision === "refresh") return outcomeWrite(unlock, outcome, held.outcome, at, false);
    await this.emit(unlock, outcome, answeredBy, tx, by);
    return outcomeWrite(unlock, outcome, held.outcome, at, true);
  }

  /**
   * #2753 item 9 — a `hired` answer confirms the company's hire record, on the answer's
   * transaction, keyed by the tenant, the worker and the unlock's posting. Called on EVERY `hired`
   * answer, a repeat included: the hire rules stamp `company_answered_at` once and make a repeat a
   * no-op, and calling again confirms a record the switch was off for the first time.
   *
   * WITHOUT A POSTING NOTHING IS CALLED: an unlock opened from search or by the ops route names no
   * `job_id` / `job_posting_id`, and a hire record is one company, worker AND posting. The answer is
   * still stored in `unlock_outcomes`, which is where the launch test counts it.
   */
  private async recordHire(
    unlock: OpenedUnlock,
    tenant: TenantKey,
    at: Date,
    tx: Database,
    by: OutcomeOrigin,
  ): Promise<void> {
    if (!this.hires.enabled) return;
    const posting = postingOf(unlock);
    if (posting === null) return;
    await this.hires.recordCompanyAnswer(
      { tenantPayerId: tenant, workerId: unlock.workerId, ...posting },
      at,
      tx,
      by,
    );
  }

  /** `unlock.outcome_recorded` on the caller's transaction. Ids and closed values only. */
  private async emit(
    unlock: OpenedUnlock,
    outcome: UnlockOutcome,
    answeredBy: UnlockOutcomeAnswerer,
    tx: Database,
    by: OutcomeOrigin,
  ): Promise<void> {
    await this.events.emit({
      event_name: "unlock.outcome_recorded",
      actor: by.actor,
      subject: { subject_type: "unlock", subject_id: unlock.unlockId },
      payload: {
        unlock_id: unlock.unlockId,
        worker_id: unlock.workerId,
        outcome,
        answered_by: answeredBy,
      } satisfies PayloadInputOf<"unlock.outcome_recorded">,
      // NO idempotency key, deliberately (the stage and hire events' reasoning): `still_talking` →
      // `hired` → `still_talking` are three real answers, and exactly-once comes from the row lock
      // and the no-op rule.
      correlationId: by.correlationId,
      requestId: by.requestId,
      tx,
    });
  }
}

function outcomeWrite(
  unlock: OpenedUnlock,
  outcome: UnlockOutcome,
  previousOutcome: UnlockOutcome | null,
  answeredAt: Date,
  changed: boolean,
): UnlockOutcomeWrite {
  return {
    unlockId: unlock.unlockId,
    workerId: unlock.workerId,
    outcome,
    previousOutcome,
    answeredAt,
    changed,
  };
}

/** The posting an unlock was opened from, as a hire record names it; null when it names none. */
export function postingOf(
  unlock: Pick<OpenedUnlock, "jobId" | "jobPostingId">,
): { postingKind: ApplicantPostingKind; postingId: string } | null {
  if (unlock.jobPostingId !== null) {
    return { postingKind: "company_posting", postingId: unlock.jobPostingId };
  }
  if (unlock.jobId !== null) return { postingKind: "agency_job", postingId: unlock.jobId };
  return null;
}

function toDueItem(row: DueRow): DueUnlockItemDto {
  return {
    unlock_id: row.unlockId,
    worker_id: row.workerId,
    granted_at: row.grantedAt.toISOString(),
    outcome: row.outcome,
  };
}
