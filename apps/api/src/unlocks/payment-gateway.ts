import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealPaymentsEnabled } from "@badabhai/config";
import { CREDIT_PACKS, type CreditPack } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PricingService } from "../pricing/pricing.service";
import { UnlocksRepository, type Tx } from "./unlocks.repository";

/**
 * The PaymentGateway / CreditService seam (ADR-0010 §D5 / Phase-0 F-6) — the single
 * place credit money-adjacent logic lives, mirroring the `AI_ENABLE_REAL_CALLS` seam.
 *
 * ALPHA = MOCK CREDITS ONLY. `real_call` is always the honest `false` here because no
 * real gateway runs (the analogue of `AiCostRecordedPayload.real_call`). A real
 * Razorpay-style implementation slots in behind this same interface, behind
 * `PAYMENTS_ENABLE_REAL` (default false) + a provider key, staging-first, with human
 * sign-off (CLAUDE.md §7). `assertPaymentsConfig` fails the boot CLOSED if the flag is
 * on without a key, so a half-configured real gateway can never silently run as mock.
 *
 * The UNLOCK DEBIT is tx-scoped ({@link debitOneCreditWithinTx}) so it commits ATOMICALLY
 * with the grant write in the chokepoint's single transaction (F-6: no
 * debit-without-grant / grant-without-debit). The DB CHECK (balance >= 0) + the atomic
 * conditional decrement make a negative balance impossible.
 */
@Injectable()
export class PaymentGateway {
  constructor(
    private readonly repo: UnlocksRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pricing: PricingService,
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
}
