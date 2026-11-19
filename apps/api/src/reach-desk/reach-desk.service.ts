import { randomUUID } from "node:crypto";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ContactReachAttemptResult,
  ContactReachCaseRow,
  ContactReachResolvedBy,
  Database,
} from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { CreditRules } from "@badabhai/pricing";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { CreditRulesService } from "../credit-rules/credit-rules.service";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import {
  UnlockOutcomesService,
  type DeskOutcomeOrigin,
} from "../unlock-outcomes/unlock-outcomes.service";
import { istDayStart } from "../unlocks/unlocks.service";
import {
  ReachDeskRepository,
  type ReachCaseFilter,
  type ReachCaseWithAttempts,
} from "./reach-desk.repository";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const UNDEFINED_TABLE = "42P01";

/** A report made more than `couldntReachWindowDays` IST days after the open. */
export class ReportWindowClosedError extends ConflictException {
  constructor() {
    super({ code: "REPORT_WINDOW_CLOSED" });
  }
}

/** The desk tried to act on a case that is already closed. */
export class CaseResolvedError extends ConflictException {
  constructor() {
    super({ code: "CASE_RESOLVED" });
  }
}

/** How the desk closes a case. */
export type DeskOutcome = "reached_interested" | "reached_declined" | "not_reached";

/** A case as the company sees it. */
export interface PayerReachCaseView {
  readonly case_id: string;
  readonly unlock_id: string;
  readonly status: ContactReachCaseRow["status"];
  readonly reported_at: string;
  readonly deadline_at: string;
  readonly resolved_at: string | null;
  readonly credits_returned: number;
}

/** A case as the desk sees it: ids to act on (the worker to reveal), and the work done so far. */
export interface DeskReachCaseView extends PayerReachCaseView {
  readonly payer_id: string;
  readonly worker_id: string | null;
  readonly reported_by: string;
  readonly resolved_by: ContactReachResolvedBy | null;
  readonly resolved_by_admin_id: string | null;
  readonly attempts: number;
}

export interface DeskReachCaseDetail extends DeskReachCaseView {
  readonly attempt_log: readonly {
    readonly attempt_id: string;
    readonly admin_id: string;
    readonly result: ContactReachAttemptResult;
    readonly attempted_at: string;
  }[];
}

/** What one deadline sweep tick did. */
export interface ReachDeadlineSweepResult {
  readonly skipped: boolean;
  readonly due: number;
  readonly closed: number;
  readonly failed: number;
}

/**
 * #2750 item 7 (brief 4C.9, B7-13) — the working-number guarantee and the worker desk.
 *
 * THE COMPANY. Within `couldntReachWindowDays` (7) IST calendar days of opening a contact, a
 * company under the credit rules reports it could not reach the worker (`POST
 * /payer/unlocks/:id/couldnt-reach`). That opens ONE case per open, due `deskWindowHours` (48)
 * later. A second report answers the first case. Off for the company, or not its open: 404.
 *
 * THE DESK (`work_reach_desk`). It calls the worker (his number through the existing reason-gated
 * reveal, `POST /admin/workers/:id/reveal-contact`, with the case id as the reason), logs each
 * attempt, and closes the case:
 *   - reached and interested / reached and declined: no credit back;
 *   - not reached: the credits the open took come back (below), and the company's follow-up answer
 *     for that open becomes `not_reached` (#2753, a no-op while that switch is off).
 * A case still open at its deadline is closed as not reached by the sweep, attempted or not (owner
 * ruling 2026-11-17).
 *
 * THE RETURN. Each `unlock_debit` line of the open gives its credits back as a NEW `returned` lot
 * with a `returned` ledger line naming the open: the spent lot's own expiry while that is still
 * ahead (never, for a lot that never expires), else `returnedLotValidityDays` (30) from now. A free
 * (waived) open returns nothing. Exactly once per spent lot (`reach_returned:<unlock>:<lot>`), in
 * the same transaction as the case's close and its event.
 */
@Injectable()
export class ReachDeskService {
  private readonly logger = new Logger(ReachDeskService.name);

  constructor(
    private readonly repo: ReachDeskRepository,
    private readonly creditRules: CreditRulesService,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly outcomes: UnlockOutcomesService,
    private readonly events: EventsService,
  ) {}

  // ── The company ────────────────────────────────────────────────────────────────────────

  /**
   * @throws NotFoundException — off for this company, or the open is not its, or not a contact.
   * @throws ReportWindowClosedError — past `couldntReachWindowDays` IST days after the open.
   * @throws ServiceUnavailableException — the tables are missing.
   */
  async report(
    actorPayerId: string,
    unlockId: string,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<PayerReachCaseView> {
    const tenant = await this.liveTenant(actorPayerId);
    return this.guardTable(async () => {
      const unlock = await this.repo.findOwnUnlock(tenant, unlockId);
      if (
        !unlock ||
        unlock.grantedAt === null ||
        (unlock.status !== "granted" && unlock.status !== "revealed")
      ) {
        throw new NotFoundException();
      }
      const held = await this.repo.findCaseByUnlock(unlockId);
      if (held) return payerView(held);

      const rules = await this.creditRules.get();
      if (!withinReportWindow(unlock.grantedAt, now, rules)) throw new ReportWindowClosedError();

      const row = await this.repo.withTransaction(async (tx) => {
        const inserted = await this.repo.insertCase(tx, {
          unlockId,
          tenant,
          workerId: unlock.workerId,
          reportedBy: actorPayerId,
          deadlineAt: new Date(now.getTime() + rules.deskWindowHours * HOUR_MS),
        });
        if (!inserted) return (await this.repo.findCaseByUnlock(unlockId, tx))!;
        const payload: PayloadInputOf<"payer.contact_reach_reported"> = {
          case_id: inserted.id,
          unlock_id: unlockId,
          payer_id: tenant,
          deadline_at: inserted.deadlineAt.toISOString(),
        };
        await this.events.emit({
          event_name: "payer.contact_reach_reported",
          actor: { actor_type: "payer", actor_id: actorPayerId },
          subject: { subject_type: "payer", subject_id: tenant },
          payload,
          idempotencyKey: `payer.contact_reach_reported:${inserted.id}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tx,
        });
        return inserted;
      });
      return payerView(row);
    });
  }

  /** The company's case for one of its opens. 404 when off, not its open, or never reported. */
  async getForPayer(actorPayerId: string, unlockId: string): Promise<PayerReachCaseView> {
    const tenant = await this.liveTenant(actorPayerId);
    return this.guardTable(async () => {
      const unlock = await this.repo.findOwnUnlock(tenant, unlockId);
      if (!unlock) throw new NotFoundException();
      const held = await this.repo.findCaseByUnlock(unlockId);
      if (!held) throw new NotFoundException();
      return payerView(held);
    });
  }

  // ── The desk ───────────────────────────────────────────────────────────────────────────

  async list(filter: {
    status: ReachCaseFilter;
    cursor?: string;
    limit: number;
  }): Promise<{ cases: DeskReachCaseView[]; next_cursor: string | null }> {
    this.creditRules.assertLive();
    return this.guardTable(async () => {
      const rows = await this.repo.listCases({
        status: filter.status,
        after: decodeEntityCursor(filter.cursor),
        limit: filter.limit + 1,
      });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      const orderAt = (r: ReachCaseWithAttempts) =>
        (filter.status === "open" ? r.deadlineAt : r.reportedAt).toISOString();
      return {
        cases: page.map(deskView),
        next_cursor:
          rows.length > filter.limit && last
            ? encodeEntityCursor({ createdAt: orderAt(last), id: last.id })
            : null,
      };
    });
  }

  async get(caseId: string): Promise<DeskReachCaseDetail> {
    this.creditRules.assertLive();
    return this.guardTable(async () => {
      const row = await this.repo.getCase(caseId);
      if (!row) throw new NotFoundException();
      const attempts = await this.repo.listAttempts(caseId);
      return {
        ...deskView({ ...row, attempts: attempts.length }),
        attempt_log: attempts.map((a) => ({
          attempt_id: a.id,
          admin_id: a.adminId,
          result: a.result,
          attempted_at: a.attemptedAt.toISOString(),
        })),
      };
    });
  }

  /** One call the desk made. A closed case takes no more attempts (409). */
  async logAttempt(
    adminId: string,
    caseId: string,
    result: ContactReachAttemptResult,
  ): Promise<DeskReachCaseDetail> {
    this.creditRules.assertLive();
    await this.guardTable(() =>
      this.repo.withTransaction(async (tx) => {
        const row = await this.repo.lockCase(tx, caseId);
        if (!row) throw new NotFoundException();
        if (row.status !== "open") throw new CaseResolvedError();
        const attempt = await this.repo.insertAttempt(tx, { caseId, adminId, result });
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.reach_case_attempt_logged,
          caseId,
          metadata: { attempt_id: attempt.id, result },
        });
      }),
    );
    return this.get(caseId);
  }

  /** The desk closes a case. A closed case cannot be closed again (409). */
  async resolveByDesk(
    adminId: string,
    caseId: string,
    outcome: DeskOutcome,
    reasonText: string,
    ctx: RequestContext,
  ): Promise<DeskReachCaseDetail> {
    this.creditRules.assertLive();
    const rules = await this.creditRules.get();
    await this.guardTable(() =>
      this.repo.withTransaction(async (tx) => {
        const row = await this.repo.lockCase(tx, caseId);
        if (!row) throw new NotFoundException();
        if (row.status !== "open") throw new CaseResolvedError();
        const closed = await this.close(tx, row, outcome, "desk", adminId, rules, {
          actor: { actor_type: "admin", actor_id: adminId },
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        });
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.reach_case_resolved,
          caseId,
          metadata: {
            unlock_id: row.unlockId,
            payer_id: row.payerId,
            outcome,
            credits_returned: closed.creditsReturned,
            reason_text: reasonText,
          },
        });
      }),
    );
    return this.get(caseId);
  }

  // ── The deadline ───────────────────────────────────────────────────────────────────────

  /**
   * Close every open case past its deadline as not reached (credits back), one per transaction, at
   * most `limit` per tick. Nothing while the `credit_rules` switch is off everywhere; a missing
   * table is logged and waited out; one case's failure is logged and retried next tick.
   */
  async sweepDeadlines(limit: number, now: Date = new Date()): Promise<ReachDeadlineSweepResult> {
    if (!this.rollout.isLiveForServiceCaller("credit_rules")) {
      return { skipped: true, due: 0, closed: 0, failed: 0 };
    }
    let ids: string[];
    try {
      ids = await this.repo.dueCaseIds(limit, now);
    } catch (err) {
      if (sqlStateOf(err) !== UNDEFINED_TABLE) throw err;
      this.logger.warn(
        `reach-desk deadline sweep: contact_reach_cases missing (sqlstate=${UNDEFINED_TABLE}); waiting for the migration`,
      );
      return { skipped: true, due: 0, closed: 0, failed: 0 };
    }
    const rules = await this.creditRules.get();
    let closed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const done = await this.repo.withTransaction(async (tx) => {
          const row = await this.repo.lockCase(tx, id);
          if (!row || row.status !== "open" || row.deadlineAt.getTime() > now.getTime()) {
            return false;
          }
          await this.close(tx, row, "not_reached", "deadline", null, rules, {
            actor: { actor_type: "system", actor_id: null },
            // A UUID: the event envelope refuses anything else, and a refused event rolls the
            // whole close back (#2750 — every deadline close failed before this).
            correlationId: randomUUID(),
          });
          return true;
        });
        if (done) closed += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `reach-desk deadline sweep: case=${id} failed (sqlstate=${sqlStateOf(err) ?? "none"}); retried next tick`,
        );
      }
    }
    return { skipped: false, due: ids.length, closed, failed };
  }

  // ── Shared ─────────────────────────────────────────────────────────────────────────────

  /** Close an open, locked case: the return (not reached only), the follow-up answer, the event. */
  private async close(
    tx: Database,
    row: ContactReachCaseRow,
    outcome: DeskOutcome,
    resolvedBy: ContactReachResolvedBy,
    adminId: string | null,
    rules: CreditRules,
    origin: DeskOutcomeOrigin,
  ): Promise<ContactReachCaseRow> {
    const at = new Date();
    let creditsReturned = 0;
    if (outcome === "not_reached") {
      // The case's stored wallet key: written from the reporter's resolved tenant key.
      const walletKey = row.payerId;
      for (const spent of await this.repo.spentFromLots(tx, walletKey, row.unlockId)) {
        const expiresAt =
          spent.lotId !== null && spent.lotExpiresAt === null
            ? null
            : spent.lotExpiresAt !== null && spent.lotExpiresAt.getTime() > at.getTime()
              ? spent.lotExpiresAt
              : new Date(at.getTime() + rules.returnedLotValidityDays * DAY_MS);
        if (await this.repo.returnCredits(tx, walletKey, row.unlockId, spent, expiresAt)) {
          creditsReturned += spent.credits;
        }
      }
      await this.outcomes.recordDeskOutcome(row.unlockId, "not_reached", tx, origin, at);
    }
    const closed = await this.repo.resolve(tx, row.id, {
      status: outcome,
      creditsReturned,
      resolvedBy,
      adminId,
      at,
    });
    if (!closed) throw new CaseResolvedError();
    const payload: PayloadInputOf<"payer.contact_reach_resolved"> = {
      case_id: row.id,
      unlock_id: row.unlockId,
      payer_id: row.payerId,
      status: outcome,
      credits_returned: creditsReturned,
      resolved_by: resolvedBy,
    };
    await this.events.emit({
      event_name: "payer.contact_reach_resolved",
      actor: origin.actor,
      subject: { subject_type: "payer", subject_id: row.payerId },
      payload,
      idempotencyKey: `payer.contact_reach_resolved:${row.id}`,
      correlationId: origin.correlationId,
      ...(origin.requestId ? { requestId: origin.requestId } : {}),
      tx,
    });
    return closed;
  }

  /** The caller's tenant, when the credit rules are on for it; else the neutral 404. */
  private async liveTenant(actorPayerId: string): Promise<TenantKey> {
    const scope = await this.tenancy.resolve(actorPayerId);
    if ((await this.rollout.stateFor("credit_rules", scope.tenantKey)) !== "on") {
      throw new NotFoundException();
    }
    return scope.tenantKey;
  }

  private async guardTable<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error(
          `contact_reach_cases missing (sqlstate=${UNDEFINED_TABLE}); apply the reach-desk migration`,
        );
        throw new ServiceUnavailableException();
      }
      throw err;
    }
  }
}

/**
 * B7-13 — a report is accepted on IST day `couldntReachWindowDays` after the open (day 0 is the
 * day of the open) and refused on the day after.
 */
export function withinReportWindow(grantedAt: Date, now: Date, rules: CreditRules): boolean {
  const days = Math.round(
    (istDayStart(now).getTime() - istDayStart(grantedAt).getTime()) / DAY_MS,
  );
  return days <= rules.couldntReachWindowDays;
}

function payerView(row: ContactReachCaseRow): PayerReachCaseView {
  return {
    case_id: row.id,
    unlock_id: row.unlockId,
    status: row.status,
    reported_at: row.reportedAt.toISOString(),
    deadline_at: row.deadlineAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    credits_returned: row.creditsReturned,
  };
}

function deskView(row: ReachCaseWithAttempts): DeskReachCaseView {
  return {
    ...payerView(row),
    payer_id: row.payerId,
    worker_id: row.workerId,
    reported_by: row.reportedBy,
    resolved_by: row.resolvedBy,
    resolved_by_admin_id: row.resolvedByAdminId,
    attempts: row.attempts,
  };
}
