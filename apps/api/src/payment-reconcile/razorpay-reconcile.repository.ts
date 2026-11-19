import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The provider value our Razorpay orders carry (`payment_orders.provider`). */
const RAZORPAY = "razorpay";

/** One `payment_orders` row, as the reconciliation reads it. Opaque ids and paise only. */
export interface ReconcileOrder {
  /** `payment_orders.id` (our uuid). */
  readonly orderId: string;
  /** Razorpay's `order_*` id. */
  readonly providerOrderId: string;
  /** `created` | `paid` | `failed` | `held`. */
  readonly status: string;
  /** The `pay_*` id the order settled (or was held) on, or null. */
  readonly providerPaymentRef: string | null;
  /** What the buyer should have paid: `total_paise`, or `amount_inr` × 100 on a pre-0176 row. */
  readonly expectedPaise: number;
  /** True when our refund path holds a live refund for the order (any status but `failed`). */
  readonly refundRecorded: boolean;
}

/** What one reconciliation read from our side. */
export interface ReconcileOrdersSnapshot {
  /** Our orders for the Razorpay order ids the window's payments name, whatever their age. */
  readonly byProviderOrderId: readonly ReconcileOrder[];
  /** Every `paid` Razorpay order CREATED in `[from, to)`. */
  readonly paidInWindow: readonly ReconcileOrder[];
}

type Row = {
  order_id: string;
  provider_order_id: string;
  status: string;
  provider_payment_ref: string | null;
  expected_paise: number | string;
  refund_recorded: boolean;
};

const COLUMNS = sql`
  po.id::text AS order_id,
  po.provider_order_id,
  po.status,
  po.provider_payment_ref,
  coalesce(po.total_paise::bigint, po.amount_inr::bigint * 100) AS expected_paise,
  EXISTS (
    SELECT 1 FROM payment_refunds r WHERE r.payment_order_id = po.id AND r.status <> 'failed'
  ) AS refund_recorded
`;

function toOrder(r: Row): ReconcileOrder {
  return {
    orderId: r.order_id,
    providerOrderId: r.provider_order_id,
    status: r.status,
    providerPaymentRef: r.provider_payment_ref,
    expectedPaise: Number(r.expected_paise),
    refundRecorded: r.refund_recorded === true,
  };
}

/**
 * #2773 — THE NIGHTLY RAZORPAY RECONCILIATION'S ONE READ OF OUR SIDE.
 *
 * Both queries run in one `repeatable read`, `read only` transaction, so an order settling
 * mid-read is seen either before or after its settle, never half-way. Read-only by construction:
 * nothing here can write an order, a wallet or a refund.
 */
@Injectable()
export class RazorpayReconcileRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async read(input: {
    providerOrderIds: readonly string[];
    from: Date;
    to: Date;
  }): Promise<ReconcileOrdersSnapshot> {
    return this.db.transaction(
      async (tx) => {
        const byProviderOrderId =
          input.providerOrderIds.length === 0
            ? []
            : ((await tx.execute(sql`
                SELECT ${COLUMNS}
                FROM payment_orders po
                WHERE po.provider = ${RAZORPAY}
                  AND po.provider_order_id = ANY(${sql.param([...input.providerOrderIds])}::text[])
                ORDER BY po.provider_order_id`)) as unknown as Row[]);
        const paidInWindow = (await tx.execute(sql`
          SELECT ${COLUMNS}
          FROM payment_orders po
          WHERE po.provider = ${RAZORPAY}
            AND po.status = 'paid'
            AND po.created_at >= ${input.from.toISOString()}::timestamptz
            AND po.created_at < ${input.to.toISOString()}::timestamptz
          ORDER BY po.created_at, po.id`)) as unknown as Row[];
        return {
          byProviderOrderId: byProviderOrderId.map(toOrder),
          paidInWindow: paidInWindow.map(toOrder),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
