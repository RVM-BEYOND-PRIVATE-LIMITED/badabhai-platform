import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConsentRepository } from "../consent/consent.repository";
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
 *
 * `ConsentRepository` (#2753 item 13 — the model-training gate's reader) is PROVIDED HERE rather
 * than imported from ConsentModule, as CampusLinkModule does: its only dependency is the @Global
 * DATABASE, while importing ConsentModule would pull in AuthModule through its forwardRef.
 */
@Module({
  imports: [
    // The producer's clock. The tick carries no payload and nothing else produces to it.
    BullModule.registerQueue({ name: LEARN_LABELS_QUEUE }),
  ],
  providers: [
    ConsentRepository,
    LearnLabelsRepository,
    LearnLabelsService,
    LearnLabelsSweepProcessor,
  ],
  exports: [LearnLabelsService],
})
export class LearnModule {}
