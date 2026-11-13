import { Module } from "@nestjs/common";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FeatureRolloutService } from "./feature-rollout.service";

/**
 * The shared pilot helper (#2746 item 1). DATABASE and SERVER_CONFIG come from global modules.
 * Import this module wherever a feature asks "is this on for this company?" (#2746, #2747–#2750).
 */
@Module({
  providers: [FeaturePilotRepository, FeatureRolloutService],
  exports: [FeatureRolloutService],
})
export class FeatureRolloutModule {}
