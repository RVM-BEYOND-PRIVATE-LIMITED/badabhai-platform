import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { OUTBOUND_SIGNALS_QUEUE } from "../queue/queue.constants";
import { OutboundSignalsRepository } from "./outbound-signals.repository";
import { OutboundSignalsSender } from "./outbound-signals.sender";
import { OutboundSignalsService } from "./outbound-signals.service";

/**
 * #2747 item 8 — marks BadaBhai owes another system (`outbound_signals`, migration 0167): the
 * recorder the stage transaction calls, and the sweep that sends.
 *
 * `CampusLinkModule` for the RVM Student API client (it imports only `PayersModule`, so no cycle
 * through the payer portal, which imports this module). DATABASE, SERVER_CONFIG and
 * `PiiCryptoService` come from global modules.
 */
@Module({
  imports: [
    CampusLinkModule,
    FeatureRolloutModule,
    BullModule.registerQueue({ name: OUTBOUND_SIGNALS_QUEUE }),
  ],
  providers: [OutboundSignalsRepository, OutboundSignalsService, OutboundSignalsSender],
  exports: [OutboundSignalsService],
})
export class OutboundSignalsModule {}
