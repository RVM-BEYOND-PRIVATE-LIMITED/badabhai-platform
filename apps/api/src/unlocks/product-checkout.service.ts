import { Injectable } from "@nestjs/common";
import type { PaymentOrder } from "@badabhai/db";
import type { GstPriceLine } from "@badabhai/pricing";
import type { PaymentOrderProductKind } from "@badabhai/types";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PaymentGateway, type OrderOrigin, type RealProductOrderHandoff } from "./payment-gateway";
import type { SettleTx } from "./paid-order-settlers";

/**
 * #2751 item 6 — the NARROW face of the payment gateway that a product module outside `unlocks`
 * (Managed Hiring) may use: create a real checkout for a non-pack product, re-hand an unpaid one,
 * read an order, and ask whether money is real. The gateway itself — the credit debits and the
 * settle — stays unexported (the module's single-writer rule); a product applies its purchase only
 * through a {@link PaidOrderSettlers} settler, which the ONE settle path calls.
 */
@Injectable()
export class ProductCheckoutService {
  constructor(private readonly gateway: PaymentGateway) {}

  /** True when a REAL gateway is fully wired (`PAYMENTS_ENABLE_REAL` + the credentials). */
  get realPaymentsLive(): boolean {
    return this.gateway.realCall;
  }

  create<T>(
    tenant: TenantKey,
    input: {
      productKind: Exclude<PaymentOrderProductKind, "credit_pack">;
      line: GstPriceLine;
      productCode: string;
      origin: OrderOrigin;
    },
    withinTx: (tx: SettleTx, order: PaymentOrder) => Promise<T>,
  ): Promise<{ handoff: RealProductOrderHandoff; result: T }> {
    return this.gateway.createRealProductOrder(tenant, input, withinTx);
  }

  handoffFor(order: PaymentOrder): RealProductOrderHandoff | null {
    return this.gateway.handoffFor(order);
  }

  findOrderById(id: string): Promise<PaymentOrder | undefined> {
    return this.gateway.findOrderById(id);
  }
}
