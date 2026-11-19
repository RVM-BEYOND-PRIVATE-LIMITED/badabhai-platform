import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { RAZORPAY_RECONCILE_QUEUE } from "../queue/queue.constants";
import { RazorpayClient } from "../unlocks/razorpay.client";
import { RazorpayReconcileProcessor } from "./razorpay-reconcile.processor";
import { RazorpayReconcileRepository } from "./razorpay-reconcile.repository";
import { RazorpayReconcileService } from "./razorpay-reconcile.service";

/**
 * #2773 — THE NIGHTLY RAZORPAY RECONCILIATION: a daily, read-only comparison of the payments
 * Razorpay captured with our `payment_orders`.
 *
 * ITS OWN MODULE, a leaf nothing imports, so no realm's module is edited and no cycle can close.
 * It provides its own {@link RazorpayClient} (as `PaymentRefundsModule` does): the class reads only
 * SERVER_CONFIG and builds its SDK lazily, so this copy is never constructed with a key while the
 * switch is off. DATABASE, SERVER_CONFIG and EventsService come from global modules. INERT until
 * RAZORPAY_RECONCILE_ENABLED is on: a tick returns at once without a call or a query.
 */
@Module({
  imports: [BullModule.registerQueue({ name: RAZORPAY_RECONCILE_QUEUE })],
  providers: [
    RazorpayClient,
    RazorpayReconcileRepository,
    RazorpayReconcileService,
    RazorpayReconcileProcessor,
  ],
})
export class RazorpayReconcileModule {}
