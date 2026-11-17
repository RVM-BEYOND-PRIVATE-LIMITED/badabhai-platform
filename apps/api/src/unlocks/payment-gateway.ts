import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealPaymentsEnabled } from "@badabhai/config";
import type { CreditPack, ExpiredCreditLot, PaymentOrder } from "@badabhai/db";
import type { GstPriceLine } from "@badabhai/pricing";
import type { PaymentOrderOrigin } from "@badabhai/types";
import { SERVER_CONFIG } from "../config/config.module";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PricingService } from "../pricing/pricing.service";
import { creditPackSale, findCreditPackTier } from "../pricing/credit-pack-sale";
import { UnlocksRepository, type Tx } from "./unlocks.repository";
import {
  RAZORPAY_CAPTURED_STATUS,
  RAZORPAY_CURRENCY,
  RazorpayClient,
  capturedStatusLabel,
} from "./razorpay.client";
import {
  captureMismatch,
  expectedOrderPaise,
  type CapturedAmount,
  type CaptureMismatch,
} from "./capture-amount";

/**
 * A credit pack a purchase may charge for (#2749): a `contact_unlock` tier that `creditPackSale`
 * calls sellable now — the same answer the payer catalogue shows packs on — priced through
 * `chargeQuote`.
 *
 * `priceInr` stays the LIST price before GST (the catalogue contract, and what
 * `expected_price_inr` is compared with). What a purchase CHARGES is `priceLine.totalPaise`, the
 * GST-inclusive total (#2749 PR 3) — the same line the payer catalogue shows as `price`.
 */
export interface ResolvedPack extends CreditPack {
  /** How long the pack's credits last, in days, or null when the catalogue sets none. */
  readonly validityDays: number | null;
  /** The list price taxed, in paise — computed once by `creditPackSale`. */
  readonly priceLine: GstPriceLine;
}

/** The whole-rupee total a pack charges (`priceLine.totalPaise` is always a whole rupee). */
export function chargedInr(pack: Pick<ResolvedPack, "priceLine">): number {
  const inr = pack.priceLine.totalPaise / 100;
  if (!Number.isSafeInteger(inr) || inr <= 0) {
    // Unreachable: gstPriceLine rounds the total to the rupee. A hard stop rather than a guess.
    throw new Error("credit pack total is not a positive whole rupee");
  }
  return inr;
}

/**
 * Where a purchase started (#2749 item 9): the button, and the job posting when it is PROVEN the
 * buyer tenant's own (the service checks; this seam stores what it is given).
 */
export interface OrderOrigin {
  readonly origin: PaymentOrderOrigin | null;
  readonly jobPostingId: string | null;
}

export const NO_ORDER_ORIGIN: OrderOrigin = Object.freeze({ origin: null, jobPostingId: null });

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
 *
 * THE WALLET IS A TENANT KEY (ADR-0053 §6). Every method that moves or stamps money takes the
 * {@link TenantKey} the service resolved — the org wallet in mode `on` (the anchor's existing
 * `payer_credits` row), the session payer's own wallet in `off`. No method here resolves a
 * tenant itself, and settlement never re-resolves: it credits the wallet the order row names.
 */
/** A real Razorpay order, ready to hand to the browser checkout. Carries NO secret. */
export interface RealOrderHandoff {
  /** Our own `payment_orders.id` (opaque uuid). */
  orderRowId: string;
  /** The provider's `order_*` id. */
  providerOrderId: string;
  /** The `rzp_*` KEY ID — public by design; the key SECRET never appears in this shape. */
  keyId: string;
  /**
   * ₹ charged, whole rupees — resolved from the pricing catalog, never from the client. Since
   * #2749 PR 3 the GST-inclusive TOTAL (`price.totalPaise / 100`), not the list price.
   */
  amountInr: number;
  /** The same amount in paise (what checkout.js expects) — `price.totalPaise`. */
  amountPaise: number;
  currency: string;
  packCode: string;
  credits: number;
  /** The price line the order was stamped with: taxable, GST, round-off and total, in paise. */
  price: GstPriceLine;
  /** How long the credits last once granted, in days; null = they never expire. */
  validityDays: number | null;
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
  /**
   * #2749 hardening 5 — THIS call held the order: the capture's amount is not the order total, so
   * nothing was granted and the order is now `held`. Only a webhook capture (which carries an
   * amount) can produce it; the caller's `onHeld` ran on the hold's transaction.
   */
  | { outcome: "held"; order: PaymentOrder; mismatch: CaptureMismatch }
  /** The order was already `held`: nothing granted, nothing changed (a replay, or a verify). */
  | { outcome: "on_hold"; order: PaymentOrder }
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
   * Returns `{ ok: true, balanceAfter, lotId }` on success — `lotId` is the lot the credit came
   * from, the soonest-expiring open one (#2749) — or `{ ok: false }` when the payer has no
   * credit left once due lots are expired. The caller (chokepoint) appends the ledger row, naming
   * `lotId`, in the SAME tx so balance + lots + ledger never drift.
   *
   * `expiredLots` (possibly empty): the lots this spend expired before it spent. Their `expired`
   * lines are written in the caller's transaction, and the caller emits `payer.credits_expired`
   * on that SAME transaction. `{ ok: false }` means NOTHING was written (#2749 review, F-1/F-3).
   *
   * IDEMPOTENCY (F-6): the chokepoint only calls this on the grant path AFTER it has
   * established there is no pre-existing live grant for (payer, worker) within the same
   * locked transaction — so a retried request converges on the existing grant and never
   * debits twice. The unique (payer_id, worker_id) is the natural idempotency key.
   */
  /**
   * #2750 item 2 — debit `credits` (the cost the credit rules priced) in the unlock transaction.
   * One take per lot; the caller writes one ledger line per take. `ok: false` wrote nothing.
   */
  async debitCreditsWithinTx(
    tx: Tx,
    tenant: TenantKey,
    credits: number,
  ): Promise<
    | {
        ok: true;
        balanceAfter: number;
        takes: readonly { lotId: string; credits: number }[];
        expiredLots: readonly ExpiredCreditLot[];
      }
    | { ok: false }
  > {
    const debited = await this.repo.tryDebitCredits(tx, tenant, credits);
    if (debited === undefined) return { ok: false };
    return { ok: true, ...debited };
  }

  async debitOneCreditWithinTx(
    tx: Tx,
    tenant: TenantKey,
  ): Promise<
    | { ok: true; balanceAfter: number; lotId: string; expiredLots: readonly ExpiredCreditLot[] }
    | { ok: false }
  > {
    const debited = await this.repo.tryDebit(tx, tenant, 1);
    if (debited === undefined) return { ok: false };
    return {
      ok: true,
      balanceAfter: debited.balanceAfter,
      lotId: debited.lotId,
      expiredLots: debited.expiredLots ?? [],
    };
  }

  /**
   * Resolve a credit pack a purchase may charge for: a `contact_unlock` tier the ACTIVE
   * catalogue lists and `creditPackSale` calls sellable at `now`, else null (→ the caller's 404).
   * ASYNC since D-6.
   *
   * WHY ONE SOURCE (D-6 MEDIUM-1): the portal RENDERS the live `contact_unlock` tiers, so the
   * CHARGE must read the SAME source or an ops price edit makes advertised ≠ charged (and, worse,
   * advertised-credits ≠ granted-credits). What `getActiveCatalog` falls back to, and what that
   * means here: with NO stored row it serves DEFAULT_CATALOG, so the DEFAULT packs are sold (this
   * is production today). With a stored row that FAILS validation it also serves DEFAULT_CATALOG,
   * and selling from that would put the default packs back on sale in place of the catalogue ops
   * published — so in that state (#2749) this sells NOTHING. Either way it never resolves an
   * unvalidated price.
   *
   * SELLABLE ONLY (#2749): `creditPackSale` is the same answer the payer catalogue read shows
   * packs on, so a pack a payer cannot see cannot be ordered — `offered:false`, a future
   * `onSaleFrom`, a rejected row and a price whose GST line cannot be computed all resolve to
   * null. There is NO constant fallback any more: a code the catalogue does not list (`pack_10`,
   * `pack_25`, or any old code a published catalogue drops) is null too. Old codes stay READABLE
   * where they are history (`credit_ledger.pack_code`, `payment_orders.pack_code`, the admin
   * views), none of which call this.
   *
   * A catalog read failure propagates deliberately: unlike the DISPLAY seam (payer-web fails OPEN
   * to cached prices), the CHARGE path must never invent a price — the caller surfaces the error
   * and no money moves.
   */
  async resolvePack(packCode: string, now: Date = new Date()): Promise<ResolvedPack | null> {
    const active = await this.pricing.getActiveCatalog();
    const tier = findCreditPackTier(active.catalog, packCode);
    if (!tier) return null;
    const sale = creditPackSale(active, tier, now);
    if (!sale.sellable) {
      if (sale.reason === "gst_error") {
        this.logger.warn(
          `credit pack refused: GST line failed pack=${tier.code} error=${sale.errorClass}`,
        );
      }
      return null;
    }
    return {
      code: packCode,
      // #2085: priced through `chargeQuote`, the ONE charge function the payer catalog also
      // displays through (list price — see `chargeQuote` on why credit packs take no offer).
      priceInr: sale.pack.quote.finalInr,
      // The grant, not just the price, follows the live tier.
      credits: sale.pack.credits,
      // #2749 PR 3: stamped on the order (real path) and counted from the grant on the lot.
      validityDays: tier.validityDays ?? null,
      // What the purchase charges: the GST-inclusive total of this line (#2749 PR 3).
      priceLine: sale.pack.priceLine,
    };
  }

  /**
   * MOCK pack purchase / ops top-up (alpha). Grants the pack's credits + appends the
   * ledger atomically. NO real money — `real_call` is false. A real Razorpay purchase
   * (authorize→capture against an order) is a LATER human-gated stream; the seam (this
   * method + the events) is what it slots into.
   *
   * The `pack` is whatever {@link resolvePack} returned (an on-sale live catalog tier), so
   * credits GRANTED and ₹ STAMPED are both that one resolved tier — never a second,
   * possibly-drifted lookup.
   *
   * #2749 PR 3 — THE ₹ STAMPED STAYS THE LIST PRICE (`pack.priceInr`, before GST), deliberately
   * NOT the GST total a real order charges. This route is live in production, grants packs with
   * no money taken, and is retired when real payments switch on (hardening 1); restamping it at
   * the total now would only mix two conventions into the company's payment history for credits
   * nobody paid for. The pack lot DOES expire `validityDays` after this grant when the pack sets
   * one (database clock), else never; production's default packs set no validity.
   */
  async purchasePackMock(
    tenant: TenantKey,
    pack: ResolvedPack,
  ): Promise<{ balanceAfter: number; credits: number; priceInr: number; realCall: false }> {
    const priceInr = pack.priceInr; // the list price: see the header
    const balanceAfter = await this.repo.creditPack({
      payerId: tenant,
      credits: pack.credits,
      reason: "pack_purchase",
      packCode: pack.code,
      paymentRef: null, // no external order id in the mock path
      // D-6: stamp the pack's price onto the ledger row so History shows what this purchase
      // was sold at, immune to any later ops price edit.
      priceInr,
      validityDays: pack.validityDays,
    });
    return { balanceAfter, credits: pack.credits, priceInr, realCall: false };
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
   *
   * #2749 PR 3 — THE GST-INCLUSIVE TOTAL. The provider order is created for
   * `pack.priceLine.totalPaise` (₹999 → 1,17,900 paise), and the row stamps the whole line
   * (taxable, GST, round-off, total, rate) beside `amount_inr` = the whole-rupee total, plus the
   * pack's credit validity (so the settle never re-reads the catalogue) and the purchase origin.
   */
  async createRealOrder(
    tenant: TenantKey,
    pack: ResolvedPack,
    origin: OrderOrigin = NO_ORDER_ORIGIN,
  ): Promise<RealOrderHandoff> {
    const keyId = this.razorpay.keyId;
    if (!this.razorpay.isLive || keyId === null) {
      // Unreachable through the gated controller; a hard stop keeps it unreachable if a
      // future caller forgets the gate. Real money never runs on a partial config.
      throw new Error("real payments are not enabled");
    }
    const line = pack.priceLine;
    const totalInr = chargedInr(pack);

    // Reserve our own row id first so the provider receipt + notes can carry it, giving a
    // two-way link (our row ⇄ provider order) for reconciliation without any PII. The row is
    // written WITH this id (before #2749 PR 3 it took a fresh default, breaking the link).
    const orderRowId = randomUUID();
    const created = await this.razorpay.createOrder({
      amountInr: totalInr,
      receipt: orderRowId,
      notes: { pack_code: pack.code, payment_order_id: orderRowId },
    });
    // RAZORPAY'S echo (the amount and currency its response names), not the number we sent: if
    // the provider's order is not for exactly the total we are about to stamp, in INR, persist
    // NOTHING — the unpaid provider order expires harmlessly and no checkout is handed out.
    if (created.amountPaise !== line.totalPaise || created.currency !== RAZORPAY_CURRENCY) {
      this.logger.error(
        `provider order does not match the pack total; refusing the order pack=${pack.code} expected_paise=${line.totalPaise} provider_paise=${created.amountPaise} provider_currency_ok=${created.currency === RAZORPAY_CURRENCY}`,
      );
      throw new ServiceUnavailableException(
        "Checkout is unavailable right now; nothing was charged. Please try again.",
      );
    }

    const row = await this.repo.createPaymentOrder({
      id: orderRowId,
      // The wallet this order will credit, stamped at INTENT (ADR-0053 §6).
      payerId: tenant,
      packCode: pack.code,
      // BOTH sides of the transaction are stamped, from ONE catalog read, at this instant.
      // The settle path reads them back off the row and never re-resolves the pack.
      amountInr: totalInr,
      creditsGranted: pack.credits,
      providerOrderId: created.orderId,
      money: {
        taxablePaise: line.taxablePaise,
        gstPaise: line.gstPaise,
        roundOffPaise: line.roundOffPaise,
        totalPaise: line.totalPaise,
        gstRateBps: line.gstRateBps,
      },
      creditValidityDays: pack.validityDays,
      origin: origin.origin,
      originJobPostingId: origin.jobPostingId,
    });

    return {
      orderRowId: row.id,
      providerOrderId: row.providerOrderId,
      keyId, // KEY ID only — the key SECRET never leaves this process
      amountInr: row.amountInr,
      amountPaise: created.amountPaise,
      currency: created.currency,
      packCode: pack.code, // = the row's pack_code (a credit-pack order always has one)
      credits: row.creditsGranted, // echo the STAMPED value, not the local `pack`
      // The line the row was just written from (its five money columns hold exactly these).
      price: line,
      validityDays: row.creditValidityDays,
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
   *     {@link UnlocksRepository.claimAndCreditPaymentOrderWithinTx}) — a single statement, so
   *     there is no read-then-write window; concurrent settlers serialize on the row lock
   *     and exactly one gets a row back.
   *  3. `credit_ledger.idempotency_key = payment_order:<row id>`, checked under the wallet
   *     lock (a key already on the ledger grants nothing), with the full UNIQUE index
   *     `credit_ledger_idempotency_key_uq` and the one-lot-per-order `credit_lots_payment_order_uq`
   *     (#2749) behind it. Even if (2) were somehow bypassed, the balance cannot double.
   *
   * The claim and the grant run in ONE transaction, so "order marked paid" and "credits
   * granted" are inseparable — no crash window can produce one without the other.
   *
   * @param expectedTenantKey when set (the verify path), the order must belong to the caller's
   *        TENANT — the wallet stamped on the row at intent, so in mode `on` any member of the
   *        org may verify the org's order (ADR-0053 §6). A mismatch returns the SAME
   *        `unknown_order` as a non-existent order — a payer cannot use this endpoint to probe
   *        another tenant's order ids (no-oracle). Settlement never re-resolves the tenant.
   *
   * THE AMOUNT CHECK (#2749 hardening 5). `captured` is what a WEBHOOK capture reported. When it
   * does not match the order ({@link captureMismatch}: other paise, no amount, not INR) NOTHING is
   * granted: the order moves `created`/`failed` → `held` in one compare-and-set, `onHeld` runs on
   * that transaction (the service's `payment.held` event), and the outcome is `held`. A held order
   * can never be settled afterwards — every later call (a replay, a verify) reads `on_hold` — so
   * ops resolve it by hand. BOTH channels pass `captured`: the webhook from the delivery's payment
   * entity, the browser VERIFY from the payment it fetched back from Razorpay
   * ({@link fetchCapturedAmount}) — so neither can grant on a payment of the wrong amount.
   * (`createRealOrder` also refused, up front, any provider order whose echoed amount was not the
   * stamped total.) A mismatched capture reported for an order ALREADY paid changes nothing — the
   * grant stands — but is logged at ERROR and handed to `onPaidMismatch` (the service records a
   * `payment.held` with `order_status: "paid"`).
   */
  async settleOrder(
    input: {
      providerOrderId: string;
      providerPaymentRef: string;
      expectedTenantKey?: TenantKey;
      captured?: CapturedAmount;
    },
    hooks: {
      onHeld?: (tx: Tx, held: PaymentOrder, mismatch: CaptureMismatch) => Promise<void>;
      /** A mismatched capture for an order already PAID (nothing changes; the caller records it). */
      onPaidMismatch?: (paid: PaymentOrder, mismatch: CaptureMismatch) => Promise<void>;
    } = {},
  ): Promise<SettleResult> {
    const existing = await this.repo.findPaymentOrder(input.providerOrderId);
    if (!existing) return { outcome: "unknown_order" };
    if (input.expectedTenantKey !== undefined && existing.payerId !== input.expectedTenantKey) {
      return { outcome: "unknown_order" }; // byte-identical to "no such order" (no-oracle)
    }
    // A held order grants nothing, ever — whichever channel asks.
    if (existing.status === "held") return { outcome: "on_hold", order: existing };
    const mismatch = input.captured ? captureMismatch(existing, input.captured) : null;
    // Fast path: already settled by the other channel. Skips the write entirely.
    if (existing.status === "paid") {
      if (mismatch) {
        this.logMismatch("capture reported for a SETTLED order", existing, mismatch);
        if (hooks.onPaidMismatch) await hooks.onPaidMismatch(existing, mismatch);
      }
      return { outcome: "already_settled", order: existing };
    }

    if (mismatch) {
      const onHeld = hooks.onHeld;
      const held = await this.repo.holdPaymentOrder(
        { providerOrderId: input.providerOrderId, providerPaymentRef: input.providerPaymentRef },
        onHeld ? (tx, row) => onHeld(tx, row, mismatch) : undefined,
      );
      if (held) {
        this.logMismatch("capture HELD, nothing granted", held, mismatch);
        return { outcome: "held", order: held, mismatch };
      }
      // Lost the compare-and-set: another delivery paid or held it first. Report that state.
      return this.terminalState(input.providerOrderId);
    }

    // THE CATALOG IS NOT CONSULTED HERE. Both the ₹ charged and the credits bought were
    // resolved once, at order creation, and stamped on this immutable row. Re-resolving
    // either at capture would reintroduce the drift this design exists to remove: an ops
    // re-price/re-size between creation and capture would charge the stamped amount and
    // grant a different number of credits, over a window bounded only by how long a
    // checkout tab stays open.
    await this.warnOnCatalogDrift(existing);

    // Claim + grant in ONE repository call and ONE transaction. The wallet, the credits and the
    // ₹ are all the CLAIMED row's stamped values — what this order was sold as and the wallet it
    // was sold to (ADR-0053 §6, never re-resolved), not what the pack or the caller's tenancy is
    // today. `undefined` = lost the race: the winner granted, so we must not.
    const settled = await this.repo.withTransaction((tx) =>
      this.repo.claimAndCreditPaymentOrderWithinTx(tx, {
        providerOrderId: input.providerOrderId,
        providerPaymentRef: input.providerPaymentRef,
      }),
    );

    if (!settled) {
      // Someone else claimed (or held) it inside the race window. Re-read for the caller's
      // response so both channels report the same, correct terminal state.
      return this.terminalState(input.providerOrderId);
    }

    return {
      outcome: "granted",
      order: settled.order,
      balanceAfter: settled.balanceAfter,
      credits: settled.order.creditsGranted,
      priceInr: settled.order.amountInr,
    };
  }

  /**
   * #2749 hardening 5 — what Razorpay says was paid on `paymentId`, for the browser VERIFY path:
   * the payment fetched back from the provider (`GET /payments/:id`), reduced to the amount and
   * currency the settle checks. Null — and the caller settles NOTHING — when the fetch fails
   * (network, a provider 5xx) or the payment does not belong to `providerOrderId`; the webhook
   * remains the other channel. Never logs the payment entity.
   *
   * ONLY A CAPTURED PAYMENT SETTLES (#2749 review). A checkout's success callback can fire while
   * the payment is only `authorized` (money held, not taken), and a `failed` payment carries an
   * amount too. Any status but `captured` is null here — nothing settles and the verify answers its
   * neutral refusal — and the webhook settles the order once Razorpay reports `payment.captured`
   * (automatic capture must be on in the Razorpay account). Only the status word is logged.
   */
  async fetchCapturedAmount(
    paymentId: string,
    providerOrderId: string,
  ): Promise<CapturedAmount | null> {
    try {
      const payment = await this.razorpay.fetchPayment(paymentId);
      if (payment.orderId !== providerOrderId) {
        this.logger.warn("verify: the fetched payment names another order; not settling");
        return null;
      }
      if (payment.status !== RAZORPAY_CAPTURED_STATUS) {
        this.logger.warn(
          `verify: the payment is not captured yet (status=${capturedStatusLabel(payment.status)}); not settling, the webhook will`,
        );
        return null;
      }
      return { amountPaise: payment.amountPaise, currency: payment.currency };
    } catch {
      // The client already logged the error class. Not settling is the safe answer.
      this.logger.warn(
        "verify: the payment could not be read back from the provider; not settling",
      );
      return null;
    }
  }

  /** The state a settle that lost a race reports: held stays held, anything else is settled. */
  private async terminalState(providerOrderId: string): Promise<SettleResult> {
    const current = await this.repo.findPaymentOrder(providerOrderId);
    if (!current) return { outcome: "unknown_order" };
    if (current.status === "held") return { outcome: "on_hold", order: current };
    return { outcome: "already_settled", order: current };
  }

  /**
   * ERROR, for ops: a capture that does not match its order. Ids and integers only — our order row,
   * the pack, the reason and both amounts in paise. Never a provider payment id, contact or secret.
   */
  private logMismatch(what: string, order: PaymentOrder, mismatch: CaptureMismatch): void {
    this.logger.error(
      `${what} order_row=${order.id} pack=${order.packCode ?? "none"} reason=${mismatch.reason} expected_paise=${mismatch.expectedPaise} captured_paise=${mismatch.capturedPaise ?? "none"}`,
    );
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
   * A pack that no longer resolves at all (gone from the catalogue, or off sale since #2749) is
   * logged too — under the old design that was a stranded payment, and it is now merely
   * informational, which is the point.
   *
   * PII-free: opaque row id, catalog code, integer ₹/counts.
   */
  private async warnOnCatalogDrift(order: PaymentOrder): Promise<void> {
    // A non-pack order (#2751) has no pack to compare with.
    if (order.packCode === null) return;
    try {
      const pack = await this.resolvePack(order.packCode);
      if (!pack) {
        this.logger.warn(
          `catalog no longer offers a settled order's pack (grant unaffected — stamped on the order) order_row=${order.id} pack=${order.packCode}`,
        );
        return;
      }
      // #2749 PR 3: compared on the CHARGED total (paise). An order from before the paise columns
      // was charged its list price, so it reads as drifted here — informational, as always.
      const stampedPaise = expectedOrderPaise(order);
      const catalogPaise = pack.priceLine.totalPaise;
      if (catalogPaise !== stampedPaise || pack.credits !== order.creditsGranted) {
        this.logger.warn(
          `catalog drifted between order and capture (grant unaffected — stamped on the order) order_row=${order.id} pack=${order.packCode} stamped_paise=${stampedPaise} catalog_paise=${catalogPaise} stamped_credits=${order.creditsGranted} catalog_credits=${pack.credits}`,
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
