/**
 * #2750 item 9 — RETURNED CREDITS ON PACK CAPTURE (brief 4C.10, B4C-24, B7-09, B7-10).
 *
 * When a company under the credit rules buys a pack through a real paid order, credits that
 * expired unused on its earlier real paid packs come back, at most `max` in all, if the old pack
 * expired within `windowMonths` before this purchase. They take the new pack's validity.
 *
 * Owner rulings (18 Nov 2026):
 *  - ONLY THE NEXT PACK. The first real pack bought after an old pack expires settles that old
 *    pack: what it returns comes back, any leftover above the cap is gone. A later pack inside the
 *    window brings back nothing more for it.
 *  - REAL PAID ORDERS ONLY, on both sides: the expired lot must be a `pack` lot naming a payment
 *    order, and the caller runs this only on a real order's settle. Mock packs, welcome, goodwill,
 *    Campus-moved and desk-returned credits never count.
 *  - Its own ledger reason, `pack_return`: one line per old pack, keyed `pack_return:<old lot id>`.
 *
 * WHAT COUNTS AS EXPIRED: the lot's ONE `expired` line (key `credit_lot_expired:<lot id>`,
 * delta = −the unspent credits), written by the expiry sweep or a spend. A lot past its date that
 * nothing has expired yet still holds its credits, so it is not a candidate; and because "the next
 * pack" is judged from when the lot was ACTUALLY expired (`expired_at`), a pack bought in that gap
 * does not use up its return — the first real pack after the expiry does. (The settle cannot
 * expire lots itself: `payer.credits_expired` v1 has a frozen trigger list.) The window is counted
 * from the lot's expiry DATE (`expires_at`, B7-10).
 *
 * Call inside the settle's transaction, after the new pack's grant (the wallet row is locked, and
 * the new lot is excluded from "a later pack" by its order id).
 * Exactly once per old lot: the key is checked under the wallet lock by the grant helper, and
 * `credit_ledger_idempotency_key_uq` is the backstop.
 *
 * NOT PII: opaque ids, integers and dates.
 */
import { and, asc, eq, gte, isNotNull, lte, ne, sql } from "drizzle-orm";

import { grantCreditsWithinTx, type WalletTx } from "./credit-wallet";
import { creditLedger, creditLots } from "./schema";

/** The ledger key of the ONE `pack_return` line an expired pack lot can ever produce. */
export function packReturnIdempotencyKey(expiredLotId: string): string {
  return `pack_return:${expiredLotId}`;
}

export interface PackReturnInput {
  /** The wallet key (the tenant key the order is stamped with). */
  readonly payerId: string;
  /** The real paid order just settled (its own lot is never a candidate). */
  readonly paymentOrderId: string;
  /** That order's new pack lot: the returned credits take its `expires_at`. */
  readonly newLotId: string;
  /** The opaque provider payment id of the new order (`pay_*`), stamped on each line. */
  readonly paymentRef: string | null;
  /** Most credits returned with one pack (`returnedCreditsMax`). 0 returns nothing. */
  readonly max: number;
  /** Months after an old pack's expiry date in which a new pack still brings them back. */
  readonly windowMonths: number;
}

/** One old pack whose expired credits came back. */
export interface PackReturnLine {
  readonly fromLotId: string;
  readonly lotId: string;
  readonly ledgerId: string;
  readonly credits: number;
}

export interface PackReturnResult {
  readonly lines: readonly PackReturnLine[];
  /** Σ credits returned. */
  readonly credits: number;
  /** The returned lots' expiry (the new pack's); null = never expires. */
  readonly expiresAt: Date | null;
  /** The wallet balance after the last line (undefined when nothing came back). */
  readonly balanceAfter?: number;
}

/**
 * The old packs this purchase settles, oldest expiry first, with their expired credits: real paid
 * `pack` lots of this wallet whose `expires_at` has passed and falls inside the window, that were
 * expired with credits left, that no real pack lot bought since they were expired has already
 * settled (only the next pack), and that have no `pack_return` line yet.
 */
export async function findReturnablePackLots(
  tx: WalletTx,
  input: Pick<PackReturnInput, "payerId" | "paymentOrderId" | "windowMonths">,
): Promise<{ lotId: string; expiredCredits: number }[]> {
  const rows = await tx
    .select({ lotId: creditLots.id, expiredDelta: creditLedger.delta })
    .from(creditLots)
    .innerJoin(
      creditLedger,
      and(
        eq(creditLedger.payerId, creditLots.payerId),
        eq(creditLedger.reason, "expired"),
        eq(creditLedger.lotId, creditLots.id),
        sql`${creditLedger.idempotencyKey} = 'credit_lot_expired:' || ${creditLots.id}::text`,
      ),
    )
    .where(
      and(
        eq(creditLots.payerId, input.payerId),
        eq(creditLots.source, "pack"),
        isNotNull(creditLots.paymentOrderId),
        ne(creditLots.paymentOrderId, input.paymentOrderId),
        isNotNull(creditLots.expiresAt),
        isNotNull(creditLots.expiredAt),
        lte(creditLots.expiresAt, sql`now()`),
        gte(
          creditLots.expiresAt,
          sql`now() - make_interval(months => ${input.windowMonths}::int)`,
        ),
        // Only the next pack: no OTHER real pack was bought after this one was expired.
        sql`NOT EXISTS (
          SELECT 1 FROM credit_lots later_pack
          WHERE later_pack.payer_id = ${creditLots.payerId}
            AND later_pack.source = 'pack'
            AND later_pack.payment_order_id IS NOT NULL
            AND later_pack.payment_order_id <> ${input.paymentOrderId}::uuid
            AND later_pack.created_at > ${creditLots.expiredAt}
        )`,
        // Never returned before (the key below is unique on the ledger anyway).
        sql`NOT EXISTS (
          SELECT 1 FROM credit_ledger pack_returned
          WHERE pack_returned.idempotency_key = 'pack_return:' || ${creditLots.id}::text
        )`,
      ),
    )
    .orderBy(asc(creditLots.expiresAt), asc(creditLots.id));
  return rows
    .map((r) => ({ lotId: r.lotId, expiredCredits: -r.expiredDelta }))
    .filter((r) => r.expiredCredits > 0);
}

/**
 * Return the expired credits this purchase settles, up to `max`: one `returned` lot and one
 * `pack_return` line per old pack, expiring with the new pack. Nothing when `max` is 0 or no old
 * pack qualifies.
 */
export async function returnExpiredPackCreditsWithinTx(
  tx: WalletTx,
  input: PackReturnInput,
): Promise<PackReturnResult> {
  const [newLot] = await tx
    .select({ expiresAt: creditLots.expiresAt })
    .from(creditLots)
    .where(and(eq(creditLots.id, input.newLotId), eq(creditLots.payerId, input.payerId)))
    .limit(1);
  if (!newLot) throw new Error("credit-pack-return: the new pack lot was not found");
  const expiresAt = newLot.expiresAt;
  if (input.max <= 0) return { lines: [], credits: 0, expiresAt };

  const candidates = await findReturnablePackLots(tx, input);
  const lines: PackReturnLine[] = [];
  let budget = input.max;
  let balanceAfter: number | undefined;
  for (const candidate of candidates) {
    if (budget <= 0) break;
    const credits = Math.min(candidate.expiredCredits, budget);
    const grant = await grantCreditsWithinTx(tx, {
      payerId: input.payerId,
      credits,
      lot: { source: "returned", expiresAt },
      ledger: {
        reason: "pack_return",
        paymentRef: input.paymentRef,
        idempotencyKey: packReturnIdempotencyKey(candidate.lotId),
      },
    });
    // Already returned (a key the NOT EXISTS above should have excluded): never twice.
    if (!grant.applied) continue;
    // To the microsecond: a JS Date keeps milliseconds only, so the new lot's `expires_at` is
    // copied in SQL (the returned credits are valid exactly as long as the new pack).
    await tx
      .update(creditLots)
      .set({
        expiresAt: sql`(SELECT n.expires_at FROM credit_lots n WHERE n.id = ${input.newLotId}::uuid)`,
      })
      .where(eq(creditLots.id, grant.lotId));
    budget -= credits;
    balanceAfter = grant.balanceAfter;
    lines.push({ fromLotId: candidate.lotId, lotId: grant.lotId, ledgerId: grant.ledgerId, credits });
  }
  return {
    lines,
    credits: lines.reduce((sum, l) => sum + l.credits, 0),
    expiresAt,
    ...(balanceAfter !== undefined ? { balanceAfter } : {}),
  };
}
