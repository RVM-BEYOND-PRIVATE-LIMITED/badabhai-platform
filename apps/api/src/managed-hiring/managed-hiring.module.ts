import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConsentModule } from "../consent/consent.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { PricingModule } from "../pricing/pricing.module";
import { MANAGED_HIRING_SWEEP_QUEUE } from "../queue/queue.constants";
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
 */
@Module({
  imports: [
    UnlocksModule,
    PricingModule,
    PayersModule,
    FeatureRolloutModule,
    ConsentModule,
    BullModule.registerQueue({ name: MANAGED_HIRING_SWEEP_QUEUE }),
  ],
  controllers: [PayerManagedHiringController],
  providers: [
    ManagedHiringRepository,
    ManagedHiringService,
    ManagedHiringMailer,
    ManagedHiringSweepProcessor,
  ],
  exports: [ManagedHiringService],
})
export class ManagedHiringModule {}
