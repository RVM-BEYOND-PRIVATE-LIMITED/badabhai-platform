import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { CreditCallResult } from "@badabhai/types";
import { ADMIN_ACTION_CODES } from "../admin-action-codes";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_IDENTITY_PAGE_MAX } from "../admin-entities.dto";
import { AdminEventsRepository } from "../admin-events.repository";
import { AdminIdentityService } from "../admin-identity.service";
import { sqlStateOf } from "../../common/db-error";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import type {
  AdminNumbersCreditCall,
  AdminNumbersLogCreditCallDto,
  AdminNumbersLogCreditCallResult,
  AdminNumbersLoggedCall,
  AdminNumbersOutOfCreditsPage,
  AdminNumbersOutOfCreditsQueryDto,
  AdminNumbersOutOfCreditsRow,
} from "./admin-numbers.dto";
import { NumbersCallsRepository, type LoggedCall } from "./numbers-calls.repository";
import {
  CREDITS_EXHAUSTED_EVENT,
  callIdForKey,
  decodeOutOfCreditsCursor,
  pageOutOfCredits,
  rankOutOfCredits,
} from "./out-of-credits";

/** Postgres `undefined_table`. */
const PG_UNDEFINED_TABLE = "42P01";
/** SQLSTATEs that mean the database is older than this build: fail CLOSED with a 503. */
const SCHEMA_BEHIND = new Set([PG_UNDEFINED_TABLE, "42703"]);
/** Postgres `foreign_key_violation`: the company was deleted between the check and the insert. */
const PG_FOREIGN_KEY_VIOLATION = "23503";

/** The 409 of an Idempotency-Key reused for a different call. */
export const CREDIT_CALL_KEY_REUSED = "idempotency_key_reused" as const;

let callLogMissingWarned = false;

/** For tests: forget that the missing-call-log warning was given. */
export function resetCallLogMissingWarningForTests(): void {
  callLogMissingWarned = false;
}

/**
 * #2755 item 8, metric group 10 — THE TELECALLER'S CALL LIST and its CALL LOG. Reached only through
 * `AdminNumbersEnabledGuard` and `read_business_numbers`, so with `ADMIN_NUMBERS_ENABLED` off none
 * of it runs.
 *
 * ── THE LIST (`GET /admin/numbers/out-of-credits`) ─────────────────────────────────────────────
 * The countable companies (not test, sample or archived) whose USABLE balance is zero now (the
 * unlock path's `readSpendableCredits` rule, as one set query: `numbers-calls.repository.ts`),
 * newest first by the moment they ran out — the later of their last `payer.credits_exhausted`
 * (read through `AdminEventsRepository`) and the expiry of their newest lot that expired holding
 * credits — keyset paged on (ran_out_at, payer_id). Each row carries the last real paid order, the
 * last contact opened and the latest call logged. READ-ONLY: it writes nothing; the only event is
 * the identity read's own audit row.
 *  - NAMES only through `AdminIdentityService` (surface `payers`, the company name it already
 *    serves on the Companies list): `read_identity`, the egress cap, `admin.identity_viewed`
 *    committed, then the decrypt. Without it the field is ABSENT. A page that will carry names is
 *    clamped to the identity bound (50) BEFORE the read, as the entity lists do.
 *  - NO PHONE, on any path: it stays on the User accounts surface (`GET /admin/accounts`,
 *    `manage_payer_credentials`); the page says so with `accounts_link_hint: true`.
 *  - The call log missing (42P01, its migration not applied) is not an outage of the list: every
 *    row answers `last_call: null` and one warning per process is logged.
 *
 * ── THE CALL LOG (`POST /admin/numbers/out-of-credits/:payerId/calls`) ─────────────────────────
 * One closed result code per call. The row's id is derived from the admin and the REQUIRED
 * Idempotency-Key, so a retry is a replay (`created: false`, nothing written or emitted again) and
 * the same key for a different call is a 409. An unknown, test or sample company is a 404. The row,
 * `admin.credit_call_logged` and `admin.action_performed` commit in one transaction. The call log
 * missing is a 503 (fail closed, nothing written).
 */
@Injectable()
export class AdminNumbersCallsService {
  private readonly logger = new Logger(AdminNumbersCallsService.name);

  constructor(
    private readonly repo: NumbersCallsRepository,
    private readonly adminEvents: AdminEventsRepository,
    private readonly identity: AdminIdentityService,
    private readonly events: EventsService,
  ) {}

  /**
   * The page size this request will use: a page that will carry names is clamped to the identity
   * bound, decided BEFORE the read (`AdminEntitiesService.effectiveLimit`'s rule: `Math.min`, so it
   * can only ever make a page smaller).
   */
  effectiveLimit(admin: AuthenticatedAdmin, requested: number): number {
    return this.identity.isPermitted(admin)
      ? Math.min(requested, ADMIN_IDENTITY_PAGE_MAX)
      : requested;
  }

  // -- GET /admin/numbers/out-of-credits -------------------------------------------------------

  async outOfCredits(
    admin: AuthenticatedAdmin,
    query: AdminNumbersOutOfCreditsQueryDto,
    ctx: RequestContext,
  ): Promise<AdminNumbersOutOfCreditsPage> {
    return this.guarded(async () => {
      const limit = this.effectiveLimit(admin, query.limit);
      const zero = await this.repo.zeroBalanceCompanies();
      const exhausted = await this.adminEvents.latestPayerSubjectEventAt(
        CREDITS_EXHAUSTED_EVENT,
        zero.map((z) => z.payerId),
      );
      const page = pageOutOfCredits(
        rankOutOfCredits(zero, exhausted),
        decodeOutOfCreditsCursor(query.cursor),
        limit,
      );
      const ids = page.rows.map((r) => r.payerId);
      const purchases = await this.repo.lastPurchases(ids);
      const opens = await this.repo.lastOpens(ids);
      const calls = await this.lastCallsOrNone(ids);

      const rows: AdminNumbersOutOfCreditsRow[] = page.rows.map((r) => {
        const purchase = purchases.get(r.payerId);
        const open = opens.get(r.payerId);
        const call = calls.get(r.payerId);
        return {
          payer_id: r.payerId,
          ran_out_at: r.ranOutAt.toISOString(),
          last_purchase:
            purchase === undefined
              ? null
              : { at: purchase.at.toISOString(), pack_code: purchase.packCode },
          last_open_at: open === undefined ? null : open.toISOString(),
          last_call: call === undefined ? null : callView(call),
        };
      });

      // Names are ADDITIVE: null (no read_identity, budget spent, over the bound) leaves every row
      // faceless, byte for byte. An empty page asks for none (nothing to disclose or audit).
      if (ids.length > 0) {
        const names = await this.identity.resolve(admin, "payers", ids, null, ctx);
        if (names !== null) {
          for (const row of rows) row.org_name = names.get(row.payer_id) ?? null;
        }
      }
      return { rows, next_cursor: page.nextCursor, accounts_link_hint: true };
    });
  }

  // -- POST /admin/numbers/out-of-credits/:payerId/calls ---------------------------------------

  async logCreditCall(
    admin: AuthenticatedAdmin,
    payerId: string,
    dto: AdminNumbersLogCreditCallDto,
    idempotencyKey: string,
    ctx: RequestContext,
  ): Promise<AdminNumbersLogCreditCallResult> {
    return this.guarded(async () => {
      const callId = callIdForKey(admin.id, idempotencyKey);
      const replay = await this.replay(callId, payerId, dto.result);
      if (replay !== null) return replay;

      if (!(await this.repo.countableCompanyExists(payerId))) throw new NotFoundException();

      let created: LoggedCall | undefined;
      try {
        created = await this.repo.withTransaction(async (tx) => {
          const row = await this.repo.insertCall(tx, {
            id: callId,
            payerId,
            adminId: admin.id,
            result: dto.result,
          });
          // A concurrent request with the same key won the insert: answer as its replay below.
          if (row === undefined) return undefined;
          await this.emitLogged(tx, admin.id, row, ctx);
          return row;
        });
      } catch (err) {
        // The company was deleted between the check and the insert.
        if (sqlStateOf(err) === PG_FOREIGN_KEY_VIOLATION) throw new NotFoundException();
        throw err;
      }
      if (created === undefined) {
        const raced = await this.replay(callId, payerId, dto.result);
        if (raced !== null) return raced;
        throw new Error("numbers calls: the key's call row vanished after a conflicting insert");
      }
      return { call: loggedView(created), created: true };
    });
  }

  // -- internals -----------------------------------------------------------------------------

  /**
   * A retry of a call that already landed: the stored row (`created: false`), nothing re-written
   * or re-emitted. The same key for ANOTHER company or result is a 409, never a silent replay of
   * a different call.
   */
  private async replay(
    callId: string,
    payerId: string,
    result: CreditCallResult,
  ): Promise<AdminNumbersLogCreditCallResult | null> {
    const stored = await this.repo.findCall(callId);
    if (stored === undefined) return null;
    if (stored.payerId !== payerId || stored.result !== result) {
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        message: "This Idempotency-Key already logged a different call",
        reason: CREDIT_CALL_KEY_REUSED,
      });
    }
    return { call: loggedView(stored), created: false };
  }

  /**
   * The latest call per company, or none at all while the call log's migration is not applied
   * (42P01): the list still answers, every row `last_call: null`, and one warning per process
   * says why. Any other error propagates.
   */
  private async lastCallsOrNone(ids: readonly string[]): Promise<Map<string, LoggedCall>> {
    if (ids.length === 0) return new Map();
    try {
      return await this.repo.lastCalls(ids);
    } catch (err) {
      if (sqlStateOf(err) !== PG_UNDEFINED_TABLE) throw err;
      if (!callLogMissingWarned) {
        callLogMissingWarned = true;
        this.logger.warn(
          `credit_call_log is missing (sqlstate=${PG_UNDEFINED_TABLE}): the call list answers ` +
            "last_call: null and POST /admin/numbers/out-of-credits/:payerId/calls answers 503 " +
            "until the credit_call_log migration is applied.",
        );
      }
      return new Map();
    }
  }

  /** `admin.credit_call_logged` and `admin.action_performed`, on the call row's transaction. */
  private async emitLogged(
    tx: Database,
    adminId: string,
    call: LoggedCall,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"admin.credit_call_logged"> = {
      payer_id: call.payerId,
      call_id: call.id,
      admin_id: adminId,
      result: call.result,
    };
    await this.events.emit({
      event_name: "admin.credit_call_logged",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: call.payerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin.credit_call_logged:${call.id}`,
      tx,
    });
    const action: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: ADMIN_ACTION_CODES.credit_call_logged,
      target_type: "payer",
      target_id: call.payerId,
    };
    await this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: call.payerId },
      payload: action,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${ADMIN_ACTION_CODES.credit_call_logged}:${adminId}:${call.id}`,
      tx,
    });
  }

  /**
   * FAIL CLOSED on a database older than this build (a table or column missing): a 503, never a
   * half-written call or a list read against a missing source. Anything else is rethrown as is.
   */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      const state = sqlStateOf(err);
      if (state !== undefined && SCHEMA_BEHIND.has(state)) {
        throw new ServiceUnavailableException("the numbers screen's schema is not applied yet");
      }
      throw err;
    }
  }
}

function callView(call: LoggedCall): AdminNumbersCreditCall {
  return {
    called_at: call.calledAt.toISOString(),
    result: call.result,
    admin_id: call.calledByAdminId,
  };
}

function loggedView(call: LoggedCall): AdminNumbersLoggedCall {
  return { id: call.id, payer_id: call.payerId, ...callView(call) };
}
