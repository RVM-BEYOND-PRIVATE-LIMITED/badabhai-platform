import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealPaymentsEnabled } from "@badabhai/config";
import { CREDIT_PACKS, type CreditPack, type PaymentOrder } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PricingService } from "../pricing/pricing.service";
import { UnlocksRepository, type Tx } from "./unlocks.repository";
import { RazorpayClient } from "./razorpay.client";

/**
 * The PaymentGateway / CreditService seam (ADR-0010 §D5 / Phase-0 F-6) — the single
 * place credit money-adjacent logic lives, mirroring the `AI_ENABLE_REAL_CALLS` seam.
 *
 * TWO PATHS, ONE SEAM. `PAYMENTS_ENABLE_REAL` (default FALSE) chooses between them HERE,
 * at the gateway — never at a controller:
 *  - OFF (the default, unchanged): {@link purchasePackMock} grants credits with no money
 *    movement and `real_call:false` — the honest mock flag (the analogue of
 *    `AiCostRecordedPayload.real_call`).
 *  - ON (+ the full Razorpay credential set): {@link createRealOrder} →
 *    {@link settleOrder}, driven by a verified webhook or the verified browser fallback.
 *
 * `assertPaymentsConfig` fails the boot CLOSED if the flag is on without ALL THREE secrets
 * (key id, key secret, webhook secret), so a half-configured real gateway can neither run
 * nor silently degrade to mock. Flipping the flag stays human-gated + staging-first
 * (CLAUDE.md §7).
 *
 * The UNLOCK DEBIT is tx-scoped ({@link debitOneCreditWithinTx}) so it commits ATOMICALLY
 * with the grant write in the chokepoint's single transaction (F-6: no
 * debit-without-grant / grant-without-debit). The DB CHECK (balance >= 0) + the atomic
 * conditional decrement make a negative balance impossible.
 */
/** A real Razorpay order, ready to hand to the browser checkout. Carries NO secret. */
export interface RealOrderHandoff {
  /** Our own `payment_orders.id` (opaque uuid). */
  orderRowId: string;
  /** The provider's `order_*` id. */
  providerOrderId: string;
  /** The `rzp_*` KEY ID — public by design; the key SECRET never appears in this shape. */
  keyId: string;
  /** ₹ charged, whole rupees — resolved from the pricing catalog, never from the client. */
  amountInr: number;
  /** The same amount in paise (what checkout.js expects). */
  amountPaise: number;
  currency: string;
  packCode: string;
  credits: number;
}

/**
 * The result of settling an order. Exactly ONE settle attempt per order can be "granted";
 * every later or concurrent attempt gets `already_settled`. Callers use this to decide
 * whether to emit `payment.captured` — so the event spine inherits the same exactly-once
 * property as the money.
 */
export type SettleResult =
  | {
      outcome: "granted";
      order: PaymentOrder;
      balanceAfter: number;
      credits: number;
      priceInr: number;
    }
  | { outcome: "already_settled"; order: PaymentOrder }
  /** No such order for this provider (or, on the verify path, not the caller's order). */
  | { outcome: "unknown_order" };
//
// THERE IS DELIBERATELY NO "cannot size the grant" OUTCOME. It existed while credits were
// re-resolved from the catalog at capture, and it meant a captured payment could be
// stranded by an ops edit. Now the grant is stamped on the order row, so a settle can only
// succeed, be a no-op, or not find an order. A genuine INFRASTRUCTURE failure (DB down, the
// layer-3 unique index firing) still throws, which surfaces as a 5xx and makes Razorpay
// redeliver — the correct retry signal, without a special-case return value to forget.

@Injectable()
export class PaymentGateway {
  private readonly logger = new Logger(PaymentGateway.name);

  constructor(
    private readonly repo: UnlocksRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pricing: PricingService,
    private readonly razorpay: RazorpayClient,
  ) {}

  /**
   * Whether a REAL gateway is wired. Alpha is always false (mock). Exposed so the
   * service can stamp `real_call` honestly on every payment.* event and so a future
   * real path is observable. Never flips true without the flag AND a provider key.
   */
  get realCall(): boolean {
    return areRealPaymentsEnabled(this.config);
  }

  /**
   * Debit ONE credit for an unlock, inside the caller's transaction (F-6 atomicity).
   * Returns `{ ok: true, balanceAfter }` on success, or `{ ok: false }` when the payer
   * has insufficient credits (atomic conditional decrement updated no row). The caller
   * (chokepoint) appends the ledger row in the SAME tx so balance + ledger never drift.
   *
   * IDEMPOTENCY (F-6): the chokepoint only calls this on the grant path AFTER it has
   * established there is no pre-existing live grant for (payer, worker) within the same
   * locked transaction — so a retried request converges on the existing grant and never
   * debits twice. The unique (payer_id, worker_id) is the natural idempotency key.
   */
  async debitOneCreditWithinTx(
    tx: Tx,
    payerId: string,
  ): Promise<{ ok: true; balanceAfter: number } | { ok: false }> {
    const balanceAfter = await this.repo.tryDebit(tx, payerId, 1);
    if (balanceAfter === undefined) return { ok: false };
    return { ok: true, balanceAfter };
  }

  /**
   * Resolve a credit pack by code from the LIVE catalog, falling back to the legacy
   * compile-time constants. ASYNC since D-6.
   *
   * WHY (D-6 MEDIUM-1): the portal RENDERS the live `contact_unlock` tiers, so the CHARGE
   * must read the SAME source or an ops price edit makes advertised ≠ charged (and, worse,
   * advertised-credits ≠ granted-credits). Both sides were compile-time before D-6 and the
   * values happened to match; that coupling is now explicit rather than coincidental. This
   * mirrors what PostingPlansService already does for plan/boost/capacity/topup — one engine,
   * one price. `getActiveCatalog` is itself fail-closed (an invalid stored row serves the
   * typed default), so this can never resolve an unvalidated/negative price.
   *
   * LEGACY FALLBACK (invariant #8): `pack_10`/`pack_25` are RETAINED-but-not-OFFERED — they
   * are absent from the catalog yet must still resolve for historical `credit_ledger.pack_code`
   * references. A code the live catalog does not carry falls through to {@link CREDIT_PACKS};
   * only a code in NEITHER is unknown (→ the caller's 404). The live catalog WINS on conflict
   * (it is the ops-editable source of truth); the constant is a floor, never an override.
   */
  async resolvePack(packCode: string): Promise<CreditPack | undefined> {
    const live = await this.resolveLivePack(packCode);
    return live ?? CREDIT_PACKS[packCode];
  }

  /**
   * The `contact_unlock` tier for `packCode` from the ACTIVE catalog, or undefined when the
   * catalog has no such tier (→ the legacy-constant fallback above). A catalog read failure
   * propagates deliberately: unlike the DISPLAY seam (payer-web fails OPEN to cached prices),
   * the CHARGE path must never invent a price — the caller surfaces the error and no money moves.
   */
  private async resolveLivePack(packCode: string): Promise<CreditPack | undefined> {
    const { catalog } = await this.pricing.getActiveCatalog();
    const product = catalog.products.find(
      (p) => p.kind === "credit_pack" && p.code === "contact_unlock",
    );
    if (!product || product.kind !== "credit_pack") return undefined;
    const tier = product.tiers.find((t) => t.code === packCode);
    // Map the catalog tier onto the CreditPack shape the purchase path consumes. `credits`
    // comes from the LIVE tier too — the grant, not just the price, follows the catalog.
    return tier ? { code: tier.code, priceInr: tier.priceInr, credits: tier.credits } : undefined;
  }

  /**
   * MOCK pack purchase / ops top-up (alpha). Grants the pack's credits + appends the
   * ledger atomically. NO real money — `real_call` is false. A real Razorpay purchase
   * (authorize→capture against an order) is a LATER human-gated stream; the seam (this
   * method + the events) is what it slots into.
   *
   * The `pack` is whatever {@link resolvePack} returned (live catalog, else the legacy
   * constant), so credits GRANTED and ₹ STAMPED are both that one resolved tier — never a
   * second, possibly-drifted lookup.
   */
  async purchasePackMock(
    payerId: string,
    pack: CreditPack,
  ): Promise<{ balanceAfter: number; credits: number; priceInr: number; realCall: false }> {
    const balanceAfter = await this.repo.creditPack({
      payerId,
      credits: pack.credits,
      reason: "pack_purchase",
      packCode: pack.code,
      paymentRef: null, // no external order id in the mock path
      // D-6: stamp the amount CHARGED onto the ledger row so History shows what this
      // purchase actually cost, immune to any later ops price edit.
      priceInr: pack.priceInr,
    });
    return { balanceAfter, credits: pack.credits, priceInr: pack.priceInr, realCall: false };
  }

  // ===========================================================================
  // REAL Razorpay path (behind PAYMENTS_ENABLE_REAL + the full credential set).
  // The mock path above is UNCHANGED and remains the default.
  // ===========================================================================

  /**
   * Create a REAL provider order for a credit pack.
   *
   * THE PRICE IS SERVER-RESOLVED, ALWAYS. `pack` comes from {@link resolvePack} — the same
   * live-catalog path the portal renders from (D-6) — so the amount charged is the amount
   * advertised. There is no amount parameter anywhere on this call chain: a client cannot
   * supply, hint at, or influence the charge. That is the whole reason the controller only
   * accepts a pack CODE.
   *
   * ORDER OF OPERATIONS: create at the provider FIRST, then persist. A provider failure
   * therefore leaves no row (nothing to reconcile); a persist failure after a successful
   * provider call leaves an unpaid provider order the payer never sees a checkout for,
   * which expires harmlessly. The reverse order would risk a paid order we cannot match.
   */
  async createRealOrder(payerId: string, pack: CreditPack): Promise<RealOrderHandoff> {
    const keyId = this.razorpay.keyId;
    if (!this.razorpay.isLive || keyId === null) {
      // Unreachable through the gated controller; a hard stop keeps it unreachable if a
      // future caller forgets the gate. Real money never runs on a partial config.
      throw new Error("real payments are not enabled");
    }

    // Reserve our own row id first so the provider receipt + notes can carry it, giving a
    // two-way link (our row ⇄ provider order) for reconciliation without any PII.
    const orderRowId = randomUUID();
    const created = await this.razorpay.createOrder({
      amountInr: pack.priceInr,
      receipt: orderRowId,
      notes: { pack_code: pack.code, payment_order_id: orderRowId },
    });

    const row = await this.repo.createPaymentOrder({
      payerId,
      packCode: pack.code,
      // BOTH sides of the transaction are stamped, from ONE catalog read, at this instant.
      // The settle path reads them back off the row and never re-resolves the pack.
      amountInr: pack.priceInr,
      creditsGranted: pack.credits,
      providerOrderId: created.orderId,
    });

    return {
      orderRowId: row.id,
      providerOrderId: row.providerOrderId,
      keyId, // KEY ID only — the key SECRET never leaves this process
      amountInr: row.amountInr,
      amountPaise: created.amountPaise,
      currency: created.currency,
      packCode: row.packCode,
      credits: row.creditsGranted, // echo the STAMPED value, not the local `pack`
    };
  }

  /**
   * SETTLE an order — the ONE idempotent grant path, shared by the webhook and the
   * browser-verify fallback. Whichever arrives first grants; every other arrival (a
   * Razorpay retry, a duplicate delivery, the racing verify call) is a no-op that reports
   * `already_settled`.
   *
   * THREE LAYERS OF EXACTLY-ONCE, deliberately redundant because this is money:
   *  1. UNIQUE (provider, provider_order_id) — one order id can only ever be one row.
   *  2. The conditional `status <> 'paid' → 'paid'` UPDATE (see
   *     {@link UnlocksRepository.claimPaymentOrderPaidWithinTx}) — a single statement, so
   *     there is no read-then-write window; concurrent settlers serialize on the row lock
   *     and exactly one gets a row back.
   *  3. `credit_ledger.idempotency_key = payment_order:<row id>` — a partial UNIQUE index.
   *     Even if (2) were somehow bypassed, the second ledger insert violates the index and
   *     aborts the transaction, so the balance cannot double.
   *
   * The claim and the grant run in ONE transaction, so "order marked paid" and "credits
   * granted" are inseparable — no crash window can produce one without the other.
   *
   * @param expectedPayerId when set (the verify path), the order must belong to this payer;
   *        a mismatch returns the SAME `unknown_order` as a non-existent order — a payer
   *        cannot use this endpoint to probe another tenant's order ids (no-oracle).
   */
  async settleOrder(input: {
    providerOrderId: string;
    providerPaymentRef: string;
    expectedPayerId?: string;
  }): Promise<SettleResult> {
    const existing = await this.repo.findPaymentOrder(input.providerOrderId);
    if (!existing) return { outcome: "unknown_order" };
    if (input.expectedPayerId !== undefined && existing.payerId !== input.expectedPayerId) {
      return { outcome: "unknown_order" }; // byte-identical to "no such order" (no-oracle)
    }
    // Fast path: already settled by the other channel. Skips the write entirely.
    if (existing.status === "paid") return { outcome: "already_settled", order: existing };

    // THE CATALOG IS NOT CONSULTED HERE. Both the ₹ charged and the credits bought were
    // resolved once, at order creation, and stamped on this immutable row. Re-resolving
    // either at capture would reintroduce the drift this design exists to remove: an ops
    // re-price/re-size between creation and capture would charge the stamped amount and
    // grant a different number of credits, over a window bounded only by how long a
    // checkout tab stays open.
    await this.warnOnCatalogDrift(existing);

    const settled = await this.repo.withTransaction(async (tx) => {
      const claimed = await this.repo.claimPaymentOrderPaidWithinTx(tx, {
        providerOrderId: input.providerOrderId,
        providerPaymentRef: input.providerPaymentRef,
      });
      if (!claimed) return null; // lost the race — the winner granted; we must not.
      const balanceAfter = await this.repo.creditPackWithinTx(tx, {
        payerId: claimed.payerId,
        // The STAMPED grant — what this order was sold as, not what the pack is today.
        credits: claimed.creditsGranted,
        reason: "pack_purchase",
        packCode: claimed.packCode,
        // OPAQUE provider payment id only (`pay_*`) — never a card/UPI/contact value.
        paymentRef: input.providerPaymentRef,
        // The STAMPED receipt amount, not the current catalog price.
        priceInr: claimed.amountInr,
        // Layer 3: one ledger row per order row, enforced by a unique index.
        idempotencyKey: `payment_order:${claimed.id}`,
      });
      return { claimed, balanceAfter };
    });

    if (!settled) {
      // Someone else claimed it inside the race window. Re-read for the caller's response
      // so both channels report the same, correct terminal state.
      const current = await this.repo.findPaymentOrder(input.providerOrderId);
      return current
        ? { outcome: "already_settled", order: current }
        : { outcome: "unknown_order" };
    }

    return {
      outcome: "granted",
      order: settled.claimed,
      balanceAfter: settled.balanceAfter,
      credits: settled.claimed.creditsGranted,
      priceInr: settled.claimed.amountInr,
    };
  }

  /**
   * OPS SIGNAL, NOT A CONTROL: log when the live catalog no longer matches what an order
   * was sold as.
   *
   * Nothing downstream reads this — the grant comes off the order row either way. Its whole
   * purpose is to tell ops "you changed a pack while live orders were open against it", so
   * a support query about a mismatched receipt has an answer. It deliberately runs AFTER
   * the settle decision is already determined and BEFORE the transaction, so a catalog read
   * failure can neither block a grant nor hold a row lock.
   *
   * A pack that no longer resolves at all is logged too — under the old design that was a
   * stranded payment, and it is now merely informational, which is the point.
   *
   * PII-free: opaque row id, catalog code, integer ₹/counts.
   */
  private async warnOnCatalogDrift(order: PaymentOrder): Promise<void> {
    try {
      const pack = await this.resolvePack(order.packCode);
      if (!pack) {
        this.logger.warn(
          `catalog no longer offers a settled order's pack (grant unaffected — stamped on the order) order_row=${order.id} pack=${order.packCode}`,
        );
        return;
      }
      if (pack.priceInr !== order.amountInr || pack.credits !== order.creditsGranted) {
        this.logger.warn(
          `catalog drifted between order and capture (grant unaffected — stamped on the order) order_row=${order.id} pack=${order.packCode} stamped_inr=${order.amountInr} catalog_inr=${pack.priceInr} stamped_credits=${order.creditsGranted} catalog_credits=${pack.credits}`,
        );
      }
    } catch {
      // A catalog read failure must NEVER affect a capture. Under the old design this path
      // could strand a real payment; now it cannot, so it is swallowed deliberately.
      this.logger.warn(
        `catalog unavailable during drift check (grant unaffected) order_row=${order.id}`,
      );
    }
  }

  /**
   * Mark an order failed after a provider failure event. Never touches a 'paid' order (the
   * repository's `status <> 'paid'` guard), because Razorpay does not guarantee webhook
   * ordering and a late failure event must not undo a completed capture.
   */
  async failOrder(providerOrderId: string): Promise<PaymentOrder | undefined> {
    return this.repo.markPaymentOrderFailed(providerOrderId);
  }

  /** The order row for a provider order id, or undefined. Read-only; PII-free. */
  async findOrder(providerOrderId: string): Promise<PaymentOrder | undefined> {
    return this.repo.findPaymentOrder(providerOrderId);
  }
}
