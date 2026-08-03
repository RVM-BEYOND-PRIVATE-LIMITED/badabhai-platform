/**
 * D6 — Matching V1 free-tier credit grant.
 *
 * Grants every EXISTING payer the V1 free-tier unlock credits (`match_config`
 * `free_unlock_credits`, 50 at launch): one `credit_ledger` row + a `payer_credits`
 * balance top-up.
 *
 * EXACTLY-ONCE IS A DB GUARANTEE, NOT A LOOP INVARIANT. Each ledger row carries
 * `idempotency_key = 'free_tier_grant:<payerId>'`, and `credit_ledger_idempotency_key_uq`
 * (the partial unique from ADMIN-3a H2) rejects a second insert with the same key. So:
 *   * a re-run inserts NO second ledger row, and
 *   * the balance is bumped ONLY when the ledger insert actually inserted — the code
 *     reads RETURNING, it does not assume. A crash between the two is safe to re-run:
 *     the ledger insert no-ops and the balance top-up is skipped, so a partially applied
 *     run cannot double-credit. (The reverse gap — ledger written, process killed before
 *     the balance bump — is repaired by the `--repair-balances` pass below, which
 *     reconciles `payer_credits.balance` against the ledger sum.)
 *
 * The two writes run in ONE TRANSACTION per payer, so the normal path cannot diverge at
 * all; `--repair-balances` exists for a pre-existing divergence, not for this script's
 * own failure mode.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes.
 *
 * PRIVACY: opaque payer ids + integer credit amounts only. `payers` PII (encrypted email
 * / org name) is NEVER read — the script selects `payers.id` and nothing else.
 *
 *   pnpm db:grant:free-tier                       # dry run
 *   pnpm db:grant:free-tier --apply               # write
 *   pnpm db:grant:free-tier --apply --repair-balances
 */
import { eq, ne, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import { creditLedger, matchConfig, payerCredits, payers } from "./schema";
import {
  argFlag,
  asObject,
  finiteOrNull,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "grant:free-tier";

/** Fallback if `match_config` has not been seeded (D1 seeds 50). */
const FALLBACK_FREE_CREDITS = 50;

/** The stable, per-payer idempotency key. Opaque; carries no PII and no value. */
export function freeTierIdempotencyKey(payerId: string): string {
  return `free_tier_grant:${payerId}`;
}

async function readFreeCredits(db: Database): Promise<number> {
  const rows = await db
    .select({ config: matchConfig.config })
    .from(matchConfig)
    .where(eq(matchConfig.isActive, true))
    .limit(1);
  const cfg = asObject(rows[0]?.config);
  const n = cfg ? finiteOrNull(cfg.free_unlock_credits) : null;
  if (n === null || !Number.isInteger(n) || n < 1) {
    console.warn(
      `[${NAME}] no usable match_config.free_unlock_credits — falling back to ` +
        `${FALLBACK_FREE_CREDITS}. Run db:seed:match:vocabulary first.`,
    );
    return FALLBACK_FREE_CREDITS;
  }
  return n;
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  const repairBalances = argFlag("repair-balances");

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    const credits = await readFreeCredits(db);

    // ids ONLY — never touch the encrypted PII columns on `payers`.
    //
    // ADR-0037 — SUSPENDED payers are excluded. This runner grants real spendable credits
    // in BULK and unattended, so without the predicate every re-run tops up every account
    // the platform has banned. It is the one money path that no request guard can protect,
    // because it has no request and no principal: the only place to enforce the lifecycle
    // is in this query.
    //
    // `pending` is deliberately still included — a not-yet-verified signup is exactly who
    // the free tier is FOR, and the credits are unspendable until they verify (every
    // spending route is behind PayerAuthGuard, which requires `active`).
    //
    // NOT reversible by a later re-run: the grant is idempotency-keyed per payer, so a
    // payer suspended today and reinstated tomorrow simply becomes eligible on the next
    // run. Nothing is lost, only deferred.
    const allPayers = await db
      .select({ id: payers.id })
      .from(payers)
      .where(ne(payers.status, "suspended"));

    const granted = await db
      .select({ key: creditLedger.idempotencyKey })
      .from(creditLedger)
      .where(dsql`${creditLedger.idempotencyKey} LIKE 'free_tier_grant:%'`);
    const alreadyGranted = new Set(granted.map((r) => r.key as string));

    const pending = allPayers.filter((p) => !alreadyGranted.has(freeTierIdempotencyKey(p.id)));

    let ledgerWritten = 0;
    let balanceRowsWritten = 0;
    let raced = 0;

    if (opts.apply) {
      for (const p of pending) {
        await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(creditLedger)
            .values({
              payerId: p.id,
              delta: credits,
              reason: "grant",
              idempotencyKey: freeTierIdempotencyKey(p.id),
            })
            .onConflictDoNothing({ target: creditLedger.idempotencyKey })
            .returning({ id: creditLedger.id });

          // The guarantee: no ledger row inserted ⇒ NO balance movement. Never assume.
          if (inserted.length === 0) {
            raced += 1;
            return;
          }
          ledgerWritten += 1;

          const bumped = await tx
            .insert(payerCredits)
            .values({ payerId: p.id, balance: credits })
            .onConflictDoUpdate({
              target: payerCredits.payerId,
              set: {
                balance: dsql`${payerCredits.balance} + ${credits}`,
                updatedAt: dsql`now()`,
              },
            })
            .returning({ id: payerCredits.id });
          balanceRowsWritten += bumped.length;
        });
      }
    }

    // Optional reconciliation: balance vs the ledger sum. Read-only unless --apply.
    let divergent = 0;
    let repaired = 0;
    if (repairBalances) {
      const rows = await sql<{ payer_id: string; balance: number; ledger_sum: number }[]>`
        SELECT pc.payer_id,
               pc.balance,
               COALESCE((SELECT sum(cl.delta)::int FROM credit_ledger cl
                         WHERE cl.payer_id = pc.payer_id), 0) AS ledger_sum
        FROM payer_credits pc
        WHERE pc.balance <> COALESCE((SELECT sum(cl.delta)::int FROM credit_ledger cl
                                      WHERE cl.payer_id = pc.payer_id), 0)
      `;
      divergent = rows.length;
      if (opts.apply) {
        for (const r of rows) {
          // The ledger is the source of truth (ADR-0010 §D5); balance is its
          // materialization. Never repair in the other direction.
          await db
            .update(payerCredits)
            .set({ balance: r.ledger_sum, updatedAt: dsql`now()` })
            .where(eq(payerCredits.payerId, r.payer_id));
          repaired += 1;
        }
      }
    }

    printCounts(NAME, {
      free_unlock_credits: credits,
      // Renamed from "payers total": the set is now payers ELIGIBLE for a grant, which
      // excludes suspended accounts. Reporting it as a total would silently understate
      // the payer base and hide that the runner is deliberately skipping people.
      "payers eligible (excl. suspended)": allPayers.length,
      "already granted (no-op)": allPayers.length - pending.length,
      "pending grant": pending.length,
      "ledger rows written": ledgerWritten,
      "balance rows written": balanceRowsWritten,
      "raced / already keyed": raced,
      ...(repairBalances
        ? { "balances divergent from ledger": divergent, "balances repaired": repaired }
        : {}),
    });
    printFooter(NAME, opts, ledgerWritten + repaired);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
