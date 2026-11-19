import { Injectable } from "@nestjs/common";
import type { PaymentOrder } from "@badabhai/db";
import type { PaymentOrderProductKind } from "@badabhai/types";
import type { Tx } from "./unlocks.repository";

/** The settle transaction a settler runs on (the repository's own type, re-exported for products). */
export type SettleTx = Tx;

/** The request ids a settle's events carry (the webhook's or the verify call's). */
export interface SettleContext {
  readonly correlationId: string;
  readonly requestId?: string;
}

/**
 * #2751 item 6 — what a captured payment does for a product that is NOT a credit pack. The
 * payment order is claimed `paid` by the ONE settle path (webhook and browser verify alike, the
 * same three layers of exactly-once), and in that SAME transaction the product's settler applies
 * the purchase — so "paid" and "what was bought" commit together or not at all.
 *
 *  - {@link prepare} runs BEFORE the transaction, on the pool (a settings or catalogue read must
 *    never run under the order's row lock). A throw settles nothing: the webhook answers 5xx and
 *    Razorpay redelivers.
 *  - {@link settleWithinTx} runs on the settle's transaction, after the claim, exactly once per
 *    order. A throw rolls the claim back (5xx, redelivery).
 *  - {@link afterCommit} runs after the commit, best effort (a notification). It must not throw;
 *    a throw is logged and swallowed by the gateway.
 */
export interface PaidOrderSettler<P = unknown> {
  prepare(order: PaymentOrder): Promise<P>;
  settleWithinTx(tx: Tx, order: PaymentOrder, prepared: P, ctx: SettleContext): Promise<void>;
  afterCommit?(order: PaymentOrder, ctx: SettleContext): Promise<void>;
}

/**
 * The settlers for every non-pack product kind, registered by the module that owns the product on
 * its `onModuleInit` (so `UnlocksModule` needs no import of it: the dependency points one way). A
 * captured payment for a kind with NO settler is never claimed: the gateway throws before the
 * transaction, so the money is not marked paid for a purchase nothing can apply (fail closed; the
 * webhook retries until the owning module is deployed).
 */
@Injectable()
export class PaidOrderSettlers {
  private readonly settlers = new Map<PaymentOrderProductKind, PaidOrderSettler<unknown>>();

  register<P>(
    kind: Exclude<PaymentOrderProductKind, "credit_pack">,
    settler: PaidOrderSettler<P>,
  ): void {
    if (this.settlers.has(kind)) throw new Error(`a settler for ${kind} is already registered`);
    this.settlers.set(kind, settler as PaidOrderSettler<unknown>);
  }

  forKind(kind: PaymentOrderProductKind): PaidOrderSettler<unknown> | undefined {
    return this.settlers.get(kind);
  }
}
