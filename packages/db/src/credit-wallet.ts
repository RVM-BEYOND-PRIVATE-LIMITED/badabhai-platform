/**
 * #2749 — THE WALLET, as expiring lots (migration 0168). The one place a balance, its lots and its
 * ledger move together.
 *
 * THE INVARIANT, per wallet key (`payer_id`: the tenant key the api resolves, ADR-0053):
 *   payer_credits.balance = Σ credit_lots.credits_remaining (open lots)
 *   payer_credits.balance = Σ credit_ledger.delta
 * Every writer of a balance — the unlock debit, the mock pack, the Razorpay settle, the admin
 * grant, the free-tier grant (service and D6 script) and the expiry sweep — calls a helper here,
 * so no writer can move one of the three without the others.
 *
 * ONE LOCK ORDER EVERYWHERE: the wallet row (`payer_credits`, `SELECT … FOR UPDATE`), then the
 * wallet's open lots (`FOR UPDATE`), then the ledger insert. The unlock path takes the worker's
 * advisory lock before calling in, and writes the unlock row and its ledger line after; the
 * sweep takes nothing before. So no two wallet paths can wait on each other in opposite orders.
 *
 * TRANSACTION ONLY. Every helper takes the CALLER's Drizzle transaction and never the global
 * pool: the unlock path holds a per-worker advisory lock and one pool connection, and a second
 * connection taken inside it is the pool-vs-lock deadlock `UnlockService` documents. The
 * helpers do not open, commit or roll back anything.
 *
 * BALANCE IS THE SOURCE OF TRUTH FOR WHAT A COMPANY CAN SPEND. Code that predates 0168 (the old
 * build in the window between applying the migration and deploying this code) and the seeds
 * move balances without lots. {@link alignLotsWithBalance} heals that at the next touch, under the
 * wallet lock, without a ledger line and without changing what the company can spend: it tops up
 * a never-expiring `legacy` lot, or removes the excess soonest-expiring first (the order a spend
 * would have taken it). The caller logs one warning when it acts (ids and numbers only, through
 * {@link lotAlignmentWarning}). After the deploy it should never fire outside seeds and tests.
 *
 * NOT PII: opaque ids, integers, closed codes and dates. Nothing here logs.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { CreditLotSource } from "@badabhai/types";

import type { Database } from "./client";
import { creditLedger, creditLots, payerCredits, type CreditReason } from "./schema";

/**
 * Any handle that runs queries: the caller's Drizzle transaction (the normal case — a
 * `db.transaction` callback's argument) or, typed the house way, the client (`Database`).
 */
export type WalletTx = Pick<Database, "select" | "insert" | "update">;

// ---------------------------------------------------------------------------------------------
// Keys and order — pure
// ---------------------------------------------------------------------------------------------

/** The ledger key of a lot's ONE `expired` line: a lot can expire once, ever. */
export function creditLotExpiredIdempotencyKey(lotId: string): string {
  return `credit_lot_expired:${lotId}`;
}

/**
 * The free-tier signup grant's ledger key (ADR-0036 §8). Shared by `FreeTierService` and the
 * `db:grant:free-tier` D6 backfill, so the two deduplicate each other byte for byte.
 */
export function freeTierIdempotencyKey(payerId: string): string {
  return `free_tier_grant:${payerId}`;
}

/**
 * The order credits leave a wallet (brief 7, register B7-08): the lot that expires soonest
 * first, a lot that never expires last, then the oldest, then the id (a total order, so two
 * readers never disagree). SQL twin: {@link CREDIT_LOT_SPEND_ORDER}.
 */
export function compareLotSpendOrder(
  a: Pick<OpenCreditLot, "id" | "expiresAt" | "createdAt">,
  b: Pick<OpenCreditLot, "id" | "expiresAt" | "createdAt">,
): number {
  if (a.expiresAt !== b.expiresAt) {
    if (a.expiresAt === null) return 1;
    if (b.expiresAt === null) return -1;
    const byExpiry = a.expiresAt.getTime() - b.expiresAt.getTime();
    if (byExpiry !== 0) return byExpiry;
  }
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** {@link compareLotSpendOrder} as an ORDER BY (btree ASC is NULLS LAST; stated anyway). */
export const CREDIT_LOT_SPEND_ORDER = [
  sql`${creditLots.expiresAt} ASC NULLS LAST`,
  asc(creditLots.createdAt),
  asc(creditLots.id),
] as const;

// ---------------------------------------------------------------------------------------------
// Alignment — the plan is pure, so it is unit-tested without a database
// ---------------------------------------------------------------------------------------------

/** One open lot of a wallet, as the helpers read it (under the wallet lock). */
export interface OpenCreditLot {
  readonly id: string;
  readonly source: CreditLotSource;
  readonly creditsRemaining: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  /** `expires_at <= now()` by the database clock (the transaction's start), at read time. */
  readonly due: boolean;
}

/** What an alignment did. `none` is the normal case. */
export interface LotAlignment {
  readonly action: "none" | "top_up" | "trim";
  /** Credits added to (`top_up`) or removed from (`trim`) the open lots; 0 for `none`. */
  readonly credits: number;
  /** Σ open `credits_remaining` before the alignment. */
  readonly openBefore: number;
  /** The balance the lots were aligned to. */
  readonly balance: number;
}

/** The writes an alignment needs. */
export type LotAlignmentPlan =
  | { readonly action: "none" }
  | {
      readonly action: "top_up";
      readonly credits: number;
      /** The open never-expiring `legacy` lot to grow, or null to insert one. */
      readonly lotId: string | null;
    }
  | {
      readonly action: "trim";
      readonly credits: number;
      /** Per lot, how many credits to remove, soonest-expiring first. */
      readonly takes: readonly { readonly lotId: string; readonly credits: number }[];
    };

/** Σ credits_remaining over a wallet's open lots. */
export function sumOpenCredits(lots: readonly Pick<OpenCreditLot, "creditsRemaining">[]): number {
  return lots.reduce((sum, lot) => sum + lot.creditsRemaining, 0);
}

/**
 * Plan the writes that make Σ open `credits_remaining` equal `balance`. `lots` must be the
 * wallet's open lots (remaining > 0); their order does not matter (sorted here).
 */
export function planLotAlignment(
  lots: readonly OpenCreditLot[],
  balance: number,
): LotAlignmentPlan {
  if (!Number.isInteger(balance) || balance < 0) {
    throw new RangeError(`planLotAlignment: balance must be a non-negative integer (${balance})`);
  }
  const open = sumOpenCredits(lots);
  if (open === balance) return { action: "none" };
  const ordered = [...lots].sort(compareLotSpendOrder);
  if (open < balance) {
    const legacy = ordered.find((l) => l.source === "legacy" && l.expiresAt === null);
    return { action: "top_up", credits: balance - open, lotId: legacy?.id ?? null };
  }
  let excess = open - balance;
  const takes: { lotId: string; credits: number }[] = [];
  for (const lot of ordered) {
    if (excess === 0) break;
    const take = Math.min(lot.creditsRemaining, excess);
    takes.push({ lotId: lot.id, credits: take });
    excess -= take;
  }
  return { action: "trim", credits: open - balance, takes };
}

/**
 * The ONE warning line a caller logs when an alignment acted, or null when it did nothing.
 * Ids and numbers only.
 */
export function lotAlignmentWarning(walletKey: string, alignment: LotAlignment): string | null {
  if (alignment.action === "none") return null;
  return (
    `credit lots realigned with the balance (balance unchanged) wallet=${walletKey} ` +
    `action=${alignment.action} credits=${alignment.credits} ` +
    `open_before=${alignment.openBefore} balance=${alignment.balance}`
  );
}

const noAlignment = (balance: number, openBefore = balance): LotAlignment => ({
  action: "none",
  credits: 0,
  openBefore,
  balance,
});

// ---------------------------------------------------------------------------------------------
// Database helpers — every one inside the caller's transaction
// ---------------------------------------------------------------------------------------------

/**
 * Take the wallet row's lock and read its balance. With `create` (a grant), the row is first
 * inserted at 0 if absent, so a first grant has a row to lock. Without it (a spend, a sweep), a
 * wallet with no row reads `undefined`: it holds no credits.
 */
export async function lockWallet(
  tx: WalletTx,
  payerId: string,
  opts: { create?: boolean } = {},
): Promise<number | undefined> {
  if (opts.create) {
    await tx
      .insert(payerCredits)
      .values({ payerId, balance: 0 })
      .onConflictDoNothing({ target: payerCredits.payerId });
  }
  const rows = await tx
    .select({ balance: payerCredits.balance })
    .from(payerCredits)
    .where(eq(payerCredits.payerId, payerId))
    .for("update");
  return rows[0]?.balance;
}

/** The wallet's open lots, locked, in spend order. Call under {@link lockWallet}. */
async function readOpenLots(tx: WalletTx, payerId: string): Promise<OpenCreditLot[]> {
  const rows = await tx
    .select({
      id: creditLots.id,
      source: creditLots.source,
      creditsRemaining: creditLots.creditsRemaining,
      expiresAt: creditLots.expiresAt,
      createdAt: creditLots.createdAt,
      due: sql<boolean>`(${creditLots.expiresAt} IS NOT NULL AND ${creditLots.expiresAt} <= now())`,
    })
    .from(creditLots)
    .where(and(eq(creditLots.payerId, payerId), gt(creditLots.creditsRemaining, 0)))
    .orderBy(...CREDIT_LOT_SPEND_ORDER)
    .for("update");
  return rows.map((r) => ({ ...r, due: r.due === true }));
}

/** Apply {@link planLotAlignment} to lots already read; returns the open lots after it. */
async function alignLoaded(
  tx: WalletTx,
  payerId: string,
  balance: number,
  lots: readonly OpenCreditLot[],
): Promise<{ alignment: LotAlignment; openLots: OpenCreditLot[] }> {
  const openBefore = sumOpenCredits(lots);
  const plan = planLotAlignment(lots, balance);
  if (plan.action === "none") {
    return { alignment: noAlignment(balance, openBefore), openLots: [...lots] };
  }
  const alignment: LotAlignment = {
    action: plan.action,
    credits: plan.credits,
    openBefore,
    balance,
  };

  if (plan.action === "top_up") {
    if (plan.lotId !== null) {
      await tx
        .update(creditLots)
        .set({
          creditsGranted: sql`${creditLots.creditsGranted} + ${plan.credits}`,
          creditsRemaining: sql`${creditLots.creditsRemaining} + ${plan.credits}`,
          updatedAt: sql`now()`,
        })
        .where(eq(creditLots.id, plan.lotId));
      const openLots = lots.map((l) =>
        l.id === plan.lotId ? { ...l, creditsRemaining: l.creditsRemaining + plan.credits } : l,
      );
      return { alignment, openLots };
    }
    const [inserted] = await tx
      .insert(creditLots)
      .values({
        payerId,
        source: "legacy",
        creditsGranted: plan.credits,
        creditsRemaining: plan.credits,
        expiresAt: null,
      })
      .returning({ id: creditLots.id, createdAt: creditLots.createdAt });
    if (!inserted) throw new Error("credit-wallet: the alignment lot was not written");
    const openLots = [
      ...lots,
      {
        id: inserted.id,
        source: "legacy" as const,
        creditsRemaining: plan.credits,
        expiresAt: null,
        createdAt: inserted.createdAt,
        due: false,
      },
    ].sort(compareLotSpendOrder);
    return { alignment, openLots };
  }

  for (const take of plan.takes) {
    await tx
      .update(creditLots)
      .set({
        creditsRemaining: sql`${creditLots.creditsRemaining} - ${take.credits}`,
        updatedAt: sql`now()`,
      })
      .where(eq(creditLots.id, take.lotId));
  }
  const taken = new Map(plan.takes.map((t) => [t.lotId, t.credits]));
  const openLots = lots
    .map((l) => ({ ...l, creditsRemaining: l.creditsRemaining - (taken.get(l.id) ?? 0) }))
    .filter((l) => l.creditsRemaining > 0);
  return { alignment, openLots };
}

/**
 * Make Σ open `credits_remaining` equal `balance` (see the file header). Call under
 * {@link lockWallet}, with the balance it returned. Writes lots only: no ledger line, no balance.
 */
export async function alignLotsWithBalance(
  tx: WalletTx,
  payerId: string,
  balance: number,
): Promise<LotAlignment> {
  const lots = await readOpenLots(tx, payerId);
  return (await alignLoaded(tx, payerId, balance, lots)).alignment;
}

/** Expire the due lots among `lots`; returns what it removed and the lots still open. */
async function expireLoaded(
  tx: WalletTx,
  payerId: string,
  lots: readonly OpenCreditLot[],
): Promise<{ credits: number; lotsExpired: number; openLots: OpenCreditLot[] }> {
  const due = lots.filter((l) => l.due && l.creditsRemaining > 0);
  if (due.length === 0) return { credits: 0, lotsExpired: 0, openLots: [...lots] };

  const credits = sumOpenCredits(due);
  // ONE line per lot, ever: the key is the lot. A second expiry of the same lot is impossible
  // (an expired lot holds 0, so it is never read as open again); if it happened anyway, the
  // unique index refuses it and the whole transaction rolls back — corruption fails loud.
  await tx.insert(creditLedger).values(
    due.map((lot) => ({
      payerId,
      delta: -lot.creditsRemaining,
      reason: "expired" as CreditReason,
      lotId: lot.id,
      idempotencyKey: creditLotExpiredIdempotencyKey(lot.id),
    })),
  );
  await tx
    .update(creditLots)
    .set({ creditsRemaining: 0, expiredAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      inArray(
        creditLots.id,
        due.map((l) => l.id),
      ),
    );
  const [wallet] = await tx
    .update(payerCredits)
    .set({ balance: sql`${payerCredits.balance} - ${credits}`, updatedAt: sql`now()` })
    .where(and(eq(payerCredits.payerId, payerId), gte(payerCredits.balance, credits)))
    .returning({ balance: payerCredits.balance });
  // Alignment ran first, so Σ open = balance and the balance holds what expires.
  if (!wallet) throw new Error("credit-wallet: the expired credits exceed the balance");
  const dueIds = new Set(due.map((l) => l.id));
  return {
    credits,
    lotsExpired: due.length,
    openLots: lots.filter((l) => !dueIds.has(l.id)),
  };
}

/**
 * Close every open lot of the wallet whose `expires_at` has passed: one `expired` ledger line
 * per lot (delta = −remaining, its `lot_id`, key `credit_lot_expired:<lot id>`), remaining → 0,
 * `expired_at` stamped, and the balance down by the total. Call under {@link lockWallet} and
 * after {@link alignLotsWithBalance}. Returns the credits removed.
 */
export async function expireDueLots(tx: WalletTx, payerId: string): Promise<number> {
  const lots = await readOpenLots(tx, payerId);
  return (await expireLoaded(tx, payerId, lots)).credits;
}

/** A grant into a wallet: the lot it creates and the ONE ledger line that records it. */
export interface WalletGrant {
  /** The wallet key (the tenant key on the payer paths; the account id on the ops paths). */
  readonly payerId: string;
  /** Credits granted — a positive integer. */
  readonly credits: number;
  readonly lot: {
    readonly source: CreditLotSource;
    readonly packCode?: string | null;
    readonly paymentOrderId?: string | null;
    /** Null or absent = never expires. */
    readonly expiresAt?: Date | null;
    readonly isTest?: boolean;
  };
  readonly ledger: {
    readonly reason: CreditReason;
    readonly packCode?: string | null;
    readonly paymentRef?: string | null;
    readonly priceInr?: number | null;
    /** Exactly-once: a grant whose key is already on the ledger changes nothing. */
    readonly idempotencyKey?: string | null;
  };
}

export type WalletGrantResult =
  | {
      readonly applied: true;
      readonly balanceAfter: number;
      readonly lotId: string;
      readonly ledgerId: string;
      readonly alignment: LotAlignment;
    }
  | {
      /** The idempotency key was already on the ledger: nothing was written. */
      readonly applied: false;
      readonly balanceAfter: number;
      /** The ledger line that already carries the key. */
      readonly ledgerId: string;
      readonly alignment: LotAlignment;
    };

/**
 * Grant credits into a wallet: lock the wallet (creating its row) → if the idempotency key is
 * already on the ledger, change nothing (`applied: false`) → align → insert the lot → insert ONE
 * ledger line naming it → balance += credits.
 *
 * The key check runs under the wallet lock, so two grants with one key on one wallet serialise
 * and the second reads the first's line. `credit_ledger_idempotency_key_uq` stays the backstop:
 * a key reused on ANOTHER wallet violates it and rolls the caller's transaction back.
 */
export async function grantCreditsWithinTx(
  tx: WalletTx,
  input: WalletGrant,
): Promise<WalletGrantResult> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new RangeError(
      `grantCreditsWithinTx: credits must be a positive integer (${input.credits})`,
    );
  }
  const balance = await lockWallet(tx, input.payerId, { create: true });
  if (balance === undefined) throw new Error("credit-wallet: the wallet row was not written");

  const key = input.ledger.idempotencyKey ?? null;
  if (key !== null) {
    const [existing] = await tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, key))
      .limit(1);
    if (existing) {
      return {
        applied: false,
        balanceAfter: balance,
        ledgerId: existing.id,
        alignment: noAlignment(balance),
      };
    }
  }

  const { alignment } = await alignLoaded(
    tx,
    input.payerId,
    balance,
    await readOpenLots(tx, input.payerId),
  );

  const [lot] = await tx
    .insert(creditLots)
    .values({
      payerId: input.payerId,
      source: input.lot.source,
      packCode: input.lot.packCode ?? null,
      paymentOrderId: input.lot.paymentOrderId ?? null,
      creditsGranted: input.credits,
      creditsRemaining: input.credits,
      expiresAt: input.lot.expiresAt ?? null,
      isTest: input.lot.isTest ?? false,
    })
    .returning({ id: creditLots.id });
  if (!lot) throw new Error("credit-wallet: the lot was not written");

  const [line] = await tx
    .insert(creditLedger)
    .values({
      payerId: input.payerId,
      delta: input.credits,
      reason: input.ledger.reason,
      lotId: lot.id,
      packCode: input.ledger.packCode ?? null,
      paymentRef: input.ledger.paymentRef ?? null,
      priceInr: input.ledger.priceInr ?? null,
      idempotencyKey: key,
    })
    .returning({ id: creditLedger.id });
  if (!line) throw new Error("credit-wallet: the ledger line was not written");

  const [wallet] = await tx
    .update(payerCredits)
    .set({ balance: sql`${payerCredits.balance} + ${input.credits}`, updatedAt: sql`now()` })
    .where(eq(payerCredits.payerId, input.payerId))
    .returning({ balance: payerCredits.balance });
  if (!wallet) throw new Error("credit-wallet: the balance was not written");

  return {
    applied: true,
    balanceAfter: wallet.balance,
    lotId: lot.id,
    ledgerId: line.id,
    alignment,
  };
}

export type WalletSpendResult =
  | {
      readonly ok: true;
      readonly balanceAfter: number;
      /** The lot the credit came from — the caller's ledger line names it. */
      readonly lotId: string;
      readonly creditsExpired: number;
      readonly alignment: LotAlignment;
    }
  | {
      /** Not enough credits once due lots were expired (an expiry still commits with the caller). */
      readonly ok: false;
      readonly balanceAfter: number;
      readonly creditsExpired: number;
      readonly alignment: LotAlignment;
    };

/**
 * Spend ONE credit: lock the wallet (no row = no credits) → align → expire the due lots → if
 * fewer than 1 credit is left, `ok: false` (the expiry is still written; the caller commits or
 * rolls back as it would) → take 1 from the first open, unexpired lot in spend order → balance
 * −= 1. The CALLER writes the spend's ledger line (`unlock_debit`, −1) with the returned `lotId`:
 * a one-credit spend touches one lot, so it is one line.
 */
export async function spendOneCreditWithinTx(
  tx: WalletTx,
  payerId: string,
): Promise<WalletSpendResult> {
  const balance = await lockWallet(tx, payerId);
  if (balance === undefined) {
    return { ok: false, balanceAfter: 0, creditsExpired: 0, alignment: noAlignment(0) };
  }
  const aligned = await alignLoaded(tx, payerId, balance, await readOpenLots(tx, payerId));
  const expired = await expireLoaded(tx, payerId, aligned.openLots);
  const available = balance - expired.credits;
  if (available < 1) {
    return {
      ok: false,
      balanceAfter: available,
      creditsExpired: expired.credits,
      alignment: aligned.alignment,
    };
  }

  const lot = expired.openLots.find((l) => !l.due && l.creditsRemaining > 0);
  // Σ open = available ≥ 1 after the alignment and the expiry, so an open lot exists.
  if (!lot) throw new Error("credit-wallet: no open lot holds the balance");
  const [taken] = await tx
    .update(creditLots)
    .set({ creditsRemaining: sql`${creditLots.creditsRemaining} - 1`, updatedAt: sql`now()` })
    .where(and(eq(creditLots.id, lot.id), gte(creditLots.creditsRemaining, 1)))
    .returning({ id: creditLots.id });
  if (!taken) throw new Error("credit-wallet: the lot could not be debited");
  const [wallet] = await tx
    .update(payerCredits)
    .set({ balance: sql`${payerCredits.balance} - 1`, updatedAt: sql`now()` })
    .where(and(eq(payerCredits.payerId, payerId), gte(payerCredits.balance, 1)))
    .returning({ balance: payerCredits.balance });
  if (!wallet) throw new Error("credit-wallet: the balance could not be debited");

  return {
    ok: true,
    balanceAfter: wallet.balance,
    lotId: lot.id,
    creditsExpired: expired.credits,
    alignment: aligned.alignment,
  };
}

/** What one wallet's expiry pass did (the sweep's per-wallet transaction). */
export interface WalletExpiryResult {
  /** False when the wallet has no `payer_credits` row: nothing was touched. */
  readonly walletFound: boolean;
  readonly creditsExpired: number;
  readonly lotsExpired: number;
  readonly balanceAfter: number;
  readonly alignment: LotAlignment;
}

/**
 * The sweep's per-wallet pass: lock → align → expire the due lots. The same lock order as a
 * spend, so a sweep and an unlock on one wallet serialise and never deadlock.
 */
export async function expireWalletWithinTx(
  tx: WalletTx,
  payerId: string,
): Promise<WalletExpiryResult> {
  const balance = await lockWallet(tx, payerId);
  if (balance === undefined) {
    return {
      walletFound: false,
      creditsExpired: 0,
      lotsExpired: 0,
      balanceAfter: 0,
      alignment: noAlignment(0),
    };
  }
  const aligned = await alignLoaded(tx, payerId, balance, await readOpenLots(tx, payerId));
  const expired = await expireLoaded(tx, payerId, aligned.openLots);
  return {
    walletFound: true,
    creditsExpired: expired.credits,
    lotsExpired: expired.lotsExpired,
    balanceAfter: balance - expired.credits,
    alignment: aligned.alignment,
  };
}

/**
 * Up to `limit` wallets holding an open lot whose `expires_at` has passed, the longest-overdue
 * first. Read-only and unlocked (the per-wallet pass locks); served by `credit_lots_due_idx`.
 */
export async function findWalletsWithDueLots(tx: WalletTx, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ payerId: creditLots.payerId })
    .from(creditLots)
    .where(
      and(
        gt(creditLots.creditsRemaining, 0),
        isNotNull(creditLots.expiresAt),
        lte(creditLots.expiresAt, sql`now()`),
      ),
    )
    .groupBy(creditLots.payerId)
    .orderBy(sql`min(${creditLots.expiresAt})`)
    .limit(limit);
  return rows.map((r) => r.payerId);
}
