import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { areRealPaymentsEnabled } from "@badabhai/config";
import { CREDIT_PACKS, type CreditPack } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
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

  /** Resolve a config-driven credit pack by code, or undefined if unknown. */
  resolvePack(packCode: string): CreditPack | undefined {
    return CREDIT_PACKS[packCode];
  }

  /**
   * MOCK pack purchase / ops top-up (alpha). Grants the pack's credits + appends the
   * ledger atomically. NO real money — `real_call` is false. A real Razorpay purchase
   * (authorize→capture against an order) is a LATER human-gated stream; the seam (this
   * method + the events) is what it slots into.
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
    });
    return { balanceAfter, credits: pack.credits, priceInr: pack.priceInr, realCall: false };
  }
}
