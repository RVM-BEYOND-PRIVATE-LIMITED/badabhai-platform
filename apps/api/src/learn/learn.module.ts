import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { LEARN_LABELS_QUEUE } from "../queue/queue.constants";
import { LearnLabelsRepository } from "./learn-labels.repository";
import { LearnLabelsService } from "./learn-labels.service";
import { LearnLabelsSweepProcessor } from "./learn-labels-sweep.processor";

/**
 * LEARN label producer (migration 0091) — drains spine events into `learn_labels`
 * so the offline reach-learn calibrator can finally train on REAL feed/application
 * outcomes instead of synthetic fixtures (its 2026-06-17 eval had zero real rows).
 *
 * Ships INERT: `LEARN_LABELS_ENABLED` defaults false, so every tick is a dry-run count
 * until explicitly armed. No controllers; the sweep is its own module because nothing
 * else consumes labels at runtime.
 */
@Module({
  imports: [
    // The producer's clock. The tick carries no payload and nothing else produces to it.
    BullModule.registerQueue({ name: LEARN_LABELS_QUEUE }),
  ],
  providers: [LearnLabelsRepository, LearnLabelsService, LearnLabelsSweepProcessor],
  exports: [LearnLabelsService],
})
export class LearnModule {}
