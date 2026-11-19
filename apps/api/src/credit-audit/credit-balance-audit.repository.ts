import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One wallet key that breaks the invariant, as the audit read it. */
export interface CreditAuditFinding {
  /** The wallet key (`payer_credits.payer_id`, the tenant key). Opaque. */
  readonly walletKey: string;
  /** `payer_credits.balance`, or null when the key has no balance row (an orphan). */
  readonly balance: number | null;
  /** Σ `credit_ledger.delta` for the key (0 when it has no line). */
  readonly ledgerSum: number;
  /** Σ `credit_lots.credits_remaining` for the key (0 when it has no lot). */
  readonly lotsSum: number;
}

/** What one audit read. */
export interface CreditAuditSnapshot {
  /** Every wallet key read: balance rows, plus keys found only on the ledger or on lots. */
  readonly walletsChecked: number;
  /** The keys that break the invariant, ordered by key. */
  readonly findings: readonly CreditAuditFinding[];
}

/** The wallet keys and their three sums (shared by the count and the findings). */
const AUDIT_CTE = sql`
  WITH ledger AS (
    SELECT payer_id, sum(delta)::bigint AS s FROM credit_ledger GROUP BY payer_id
  ), lots AS (
    SELECT payer_id, sum(credits_remaining)::bigint AS s FROM credit_lots GROUP BY payer_id
  ), keys AS (
    SELECT payer_id FROM payer_credits
    UNION SELECT payer_id FROM ledger
    UNION SELECT payer_id FROM lots
  ), audit AS (
    SELECT k.payer_id,
           pc.payer_id IS NOT NULL AS has_wallet,
           pc.balance,
           coalesce(l.s, 0)::bigint AS ledger_sum,
           coalesce(o.s, 0)::bigint AS lots_sum,
           o.payer_id IS NOT NULL AS has_lots
    FROM keys k
    LEFT JOIN payer_credits pc ON pc.payer_id = k.payer_id
    LEFT JOIN ledger l ON l.payer_id = k.payer_id
    LEFT JOIN lots o ON o.payer_id = k.payer_id
  )
`;

/**
 * #2774 — THE NIGHTLY CREDIT BALANCE AUDIT'S ONE READ.
 *
 * The invariant (`packages/db/src/credit-wallet.ts`): per wallet, `payer_credits.balance` =
 * Σ `credit_ledger.delta` = Σ `credit_lots.credits_remaining`, and every writer moves the three
 * together under the wallet row lock. This read checks it for EVERY wallet key at once.
 *
 * ONE SNAPSHOT: both queries run in one `repeatable read`, `read only` transaction, so the sums
 * are taken at one instant and a spend committing mid-audit can never look like drift. Read-only
 * by construction: nothing here can write a wallet (repair is a separate, deliberate step).
 *
 * ORPHANS: a key with a non-zero ledger sum or any lot but no balance row. Account deletion keeps
 * all three (billing rails survive, `payer-account-deletion.service.ts`), so an orphan is an
 * anomaly, not a deleted company.
 */
@Injectable()
export class CreditBalanceAuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async read(): Promise<CreditAuditSnapshot> {
    return this.db.transaction(
      async (tx) => {
        const [count] = (await tx.execute(
          sql`${AUDIT_CTE} SELECT count(*)::bigint AS n FROM audit`,
        )) as unknown as Array<{ n: number | string }>;
        const rows = (await tx.execute(sql`${AUDIT_CTE}
          SELECT payer_id::text AS wallet_key, balance, ledger_sum, lots_sum
          FROM audit
          WHERE (NOT has_wallet AND (ledger_sum <> 0 OR has_lots))
             OR (has_wallet AND (balance <> ledger_sum OR balance <> lots_sum))
          ORDER BY payer_id`)) as unknown as Array<{
          wallet_key: string;
          balance: number | string | null;
          ledger_sum: number | string;
          lots_sum: number | string;
        }>;
        return {
          walletsChecked: Number(count?.n ?? 0),
          findings: rows.map((r) => ({
            walletKey: r.wallet_key,
            balance: r.balance === null ? null : Number(r.balance),
            ledgerSum: Number(r.ledger_sum),
            lotsSum: Number(r.lots_sum),
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
