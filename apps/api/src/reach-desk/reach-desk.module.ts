import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { REACH_DESK_DEADLINE_QUEUE } from "../queue/queue.constants";
import { UnlockOutcomesModule } from "../unlock-outcomes/unlock-outcomes.module";
import { PayerReachController } from "./payer-reach.controller";
import { ReachDeskDeadlineProcessor } from "./reach-desk-deadline.processor";
import { ReachDeskRepository } from "./reach-desk.repository";
import { ReachDeskService } from "./reach-desk.service";

/**
 * #2750 item 7 — the working-number guarantee and the worker desk. The company's route lives
 * here; the desk's routes are AdminModule's (`AdminReachDeskController`), through the exported
 * service. UnlockOutcomesModule gives the desk's `not_reached` answer (#2753); the queue is
 * registered here because the deadline processor lives here. DATABASE, SERVER_CONFIG and
 * EventsService come from global modules.
 */
@Module({
  imports: [
    CreditRulesModule,
    FeatureRolloutModule,
    PayersModule,
    UnlockOutcomesModule,
    BullModule.registerQueue({ name: REACH_DESK_DEADLINE_QUEUE }),
  ],
  controllers: [PayerReachController],
  providers: [ReachDeskRepository, ReachDeskService, ReachDeskDeadlineProcessor],
  exports: [ReachDeskService],
})
export class ReachDeskModule {}
