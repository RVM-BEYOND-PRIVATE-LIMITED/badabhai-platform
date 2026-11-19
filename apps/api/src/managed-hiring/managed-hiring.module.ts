import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { ConsentModule } from "../consent/consent.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PayersModule } from "../payers/payers.module";
import { PricingModule } from "../pricing/pricing.module";
import { MANAGED_HIRING_SWEEP_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { ManagedHiringMailer } from "./managed-hiring.mailer";
import { ManagedHiringRepository } from "./managed-hiring.repository";
import { ManagedHiringService } from "./managed-hiring.service";
import { ManagedHiringSweepProcessor } from "./managed-hiring-sweep.processor";
import { PayerManagedHiringController } from "./payer-managed-hiring.controller";

/**
 * #2751 items 4 to 13 — Managed Hiring. The company routes and the sweep live here; the desk routes
 * are AdminModule's (it imports this module; this module never imports AdminModule). The order's
 * activation rides the ONE payment settle path: the service registers its settler with
 * UnlocksModule's `PaidOrderSettlers` (the dependency points one way, here → unlocks).
 *
 * `RequestIdempotency` guards the order route's `Idempotency-Key`; it reuses BullMQ's Redis
 * connection through the `RESUME_RENDER_QUEUE` client, as `CampusDrivesModule` and
 * `PayerPortalModule` do.
 */
@Module({
  imports: [
    UnlocksModule,
    PricingModule,
    PayersModule,
    FeatureRolloutModule,
    ConsentModule,
    // #2749 part 4: the checkout's invoice gate (the invoice itself is issued on the settle path).
    InvoicesModule,
    BullModule.registerQueue({ name: MANAGED_HIRING_SWEEP_QUEUE }),
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [PayerManagedHiringController],
  providers: [
    ManagedHiringRepository,
    ManagedHiringService,
    ManagedHiringMailer,
    ManagedHiringSweepProcessor,
    RequestIdempotency,
  ],
  exports: [ManagedHiringService],
})
export class ManagedHiringModule {}
