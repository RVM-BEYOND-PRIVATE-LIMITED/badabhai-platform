import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import {
  creditCallLog,
  payers,
  paymentOrders,
  unlocks,
  type CreditCallLogRow,
  type Database,
} from "@badabhai/db";
import type { CreditCallResult } from "@badabhai/types";
import { DATABASE } from "../../database/database.module";
import { OPENED_UNLOCK_STATUSES } from "../../unlock-outcomes/unlock-outcomes.repository";
import { countablePayer } from "./exclusions";
import type { ZeroBalanceCompany } from "./out-of-credits";

/** Largest `IN (...)` id list per statement (the funnel's bound: far under the driver ceiling). */
const ID_BATCH_MAX = 2000;

/** A company's last real paid order. */
export interface LastPurchase {
  readonly at: Date;
  /** The pack bought; null for an order that sells no credit pack (#2749 part 3). */
  readonly packCode: string | null;
}

/** One logged call, as the list and the POST read it. */
export interface LoggedCall {
  readonly id: string;
  readonly payerId: string;
  readonly calledByAdminId: string;
  readonly calledAt: Date;
  readonly result: CreditCallResult;
}

/** Split `ids` into bounded batches. */
function batches(ids: readonly string[]): string[][] {
  const unique = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_BATCH_MAX) out.push(unique.slice(i, i + ID_BATCH_MAX));
  return out;
}

/** Epoch milliseconds from a raw row (`float8` arrives as a number; anything else is null). */
function msOf(value: unknown): Date | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? new Date(n) : null;
}

function toLoggedCall(r: CreditCallLogRow): LoggedCall {
  return {
    id: r.id,
    payerId: r.payerId,
    calledByAdminId: r.calledByAdminId,
    calledAt: new Date(r.calledAt),
    result: r.result,
  };
}

/**
 * #2755 part C — data access for the OUT-OF-CREDITS CALL LIST and its CALL LOG.
 *
 * ── THE READS ARE SELECT-ONLY ──────────────────────────────────────────────────────────────
 * They project ids, times, a pack code, a closed result code and one computed expiry: never a
 * name, a phone, an email or a payload. Company exclusions are part A's (`exclusions.ts`). The
 * spine read (`payer.credits_exhausted`) is not here: it goes through `AdminEventsRepository`,
 * the admin reader of `events`.
 *
 * ── USABLE BALANCE: OUR OWN READ-ONLY SET QUERY, THE APP'S RULE ──────────────────────────────
 * The app's one "spendable balance" read is `readSpendableCredits` (packages/db
 * `credit-wallet.ts`, the unlock path's F-1 precondition): `max(0, payer_credits.balance − the
 * credits its lots past expires_at still hold)`, 0 for a wallet with no row. It is exported and
 * pure, but it reads ONE wallet per call; the call list needs every zero wallet at once, ordered
 * and paged. So {@link zeroBalanceCompanies} spells THE SAME RULE as one set query over
 * `payer_credits` and `credit_lots`, without editing the wallet code, and the DB gate proves it
 * agrees with `readSpendableCredits` wallet by wallet.
 *
 * ── THE ONE WRITE IS ONE INSERT INTO `credit_call_log` ──────────────────────────────────────
 * Keyed on the id derived from the Idempotency-Key (`callIdForKey`): `ON CONFLICT (id) DO
 * NOTHING`, so a retried POST inserts nothing. Nothing updates or deletes a call.
 */
@Injectable()
export class NumbersCallsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** One transaction for the call row and its events. */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  // -- the list ------------------------------------------------------------------------------

  /**
   * Every COUNTABLE company (not a test or sample company, not archived) whose USABLE balance is
   * zero now — the wallet's balance minus what its lots past `expires_at` still hold is at most
   * zero (`readSpendableCredits`' rule, see the class header) — with the `expires_at` of its newest
   * lot that EXPIRED HOLDING CREDITS: past its date and either still holding (not yet swept) or
   * stamped `expired_at` (the sweep removed what it held). A lot spent to zero before its date is
   * not an expiry. The wallet key is the company id (`payer_credits.payer_id`, the tenant key).
   */
  async zeroBalanceCompanies(): Promise<ZeroBalanceCompany[]> {
    const rows = (await this.db.execute(sql`
      SELECT "pc"."payer_id" AS payer_id,
             (SELECT extract(epoch from max(l.expires_at)) * 1000 FROM credit_lots l
               WHERE l.payer_id = "pc"."payer_id"
                 AND l.expires_at IS NOT NULL AND l.expires_at <= now()
                 AND (l.credits_remaining > 0 OR l.expired_at IS NOT NULL)
             )::float8 AS last_expiry_ms
        FROM payer_credits "pc"
        JOIN payers "co" ON "co"."id" = "pc"."payer_id"
       WHERE "co"."status" <> 'archived'
         AND ${countablePayer(sql.raw(`"pc"."payer_id"`))}
         AND "pc"."balance" - coalesce((
               SELECT sum(l.credits_remaining) FROM credit_lots l
                WHERE l.payer_id = "pc"."payer_id" AND l.credits_remaining > 0
                  AND l.expires_at IS NOT NULL AND l.expires_at <= now()), 0) <= 0
    `)) as unknown as Array<{ payer_id: unknown; last_expiry_ms: unknown }>;
    return rows.map((r) => ({
      payerId: String(r.payer_id),
      lastLotExpiryAt: msOf(r.last_expiry_ms),
    }));
  }

  /**
   * Each listed company's LAST REAL PAID ORDER: `payment_orders` with status paid (the mock route
   * writes no order row), its settle time (`updated_at` at the move to paid, part B's rule) and
   * pack code; the newest by settle time, then id.
   */
  async lastPurchases(payerIds: readonly string[]): Promise<Map<string, LastPurchase>> {
    const out = new Map<string, LastPurchase>();
    for (const batch of batches(payerIds)) {
      const rows = await this.db
        .selectDistinctOn([paymentOrders.payerId], {
          payerId: paymentOrders.payerId,
          at: paymentOrders.updatedAt,
          packCode: paymentOrders.packCode,
        })
        .from(paymentOrders)
        .where(and(eq(paymentOrders.status, "paid"), inArray(paymentOrders.payerId, batch)))
        .orderBy(paymentOrders.payerId, desc(paymentOrders.updatedAt), desc(paymentOrders.id));
      for (const r of rows) out.set(r.payerId, { at: new Date(r.at), packCode: r.packCode });
    }
    return out;
  }

  /** Each listed company's LAST OPEN: the newest `granted_at` of an unlock it was granted. */
  async lastOpens(payerIds: readonly string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const batch of batches(payerIds)) {
      const rows = await this.db
        .select({ payerId: unlocks.payerId, at: max(unlocks.grantedAt) })
        .from(unlocks)
        .where(
          and(
            inArray(unlocks.status, [...OPENED_UNLOCK_STATUSES]),
            isNotNull(unlocks.grantedAt),
            inArray(unlocks.payerId, batch),
          ),
        )
        .groupBy(unlocks.payerId);
      for (const r of rows) if (r.at !== null) out.set(r.payerId, new Date(r.at));
    }
    return out;
  }

  /**
   * Each listed company's LATEST logged call (by `called_at`, then id). Throws 42P01 before the
   * call log's migration; the service answers the list without it.
   */
  async lastCalls(payerIds: readonly string[]): Promise<Map<string, LoggedCall>> {
    const out = new Map<string, LoggedCall>();
    for (const batch of batches(payerIds)) {
      const rows = await this.db
        .selectDistinctOn([creditCallLog.payerId])
        .from(creditCallLog)
        .where(inArray(creditCallLog.payerId, batch))
        .orderBy(creditCallLog.payerId, desc(creditCallLog.calledAt), desc(creditCallLog.id));
      for (const r of rows) out.set(r.payerId, toLoggedCall(r));
    }
    return out;
  }

  // -- the call log --------------------------------------------------------------------------

  /** Is `payerId` a company whose calls may be logged: it exists, and is no test or sample one? */
  async countableCompanyExists(payerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: payers.id })
      .from(payers)
      .where(and(eq(payers.id, payerId), countablePayer(sql.raw(`"payers"."id"`))))
      .limit(1);
    return rows.length > 0;
  }

  /** The call row `id`, or undefined. */
  async findCall(id: string): Promise<LoggedCall | undefined> {
    const rows = await this.db
      .select()
      .from(creditCallLog)
      .where(eq(creditCallLog.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : toLoggedCall(row);
  }

  /**
   * Insert one call on the caller's transaction; `undefined` when a row with this id already
   * exists (a retried POST, or the same request racing itself): nothing was written.
   */
  async insertCall(
    tx: Database,
    input: { id: string; payerId: string; adminId: string; result: CreditCallResult },
  ): Promise<LoggedCall | undefined> {
    const rows = await tx
      .insert(creditCallLog)
      .values({
        id: input.id,
        payerId: input.payerId,
        calledByAdminId: input.adminId,
        result: input.result,
      })
      .onConflictDoNothing({ target: creditCallLog.id })
      .returning();
    const row = rows[0];
    return row === undefined ? undefined : toLoggedCall(row);
  }
}
