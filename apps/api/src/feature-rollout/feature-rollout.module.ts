import { Module } from "@nestjs/common";
import { FeaturePilotSubjectsRepository } from "./feature-pilot-subjects.repository";
import { FeaturePilotRepository } from "./feature-pilot.repository";
import { FeatureRolloutService } from "./feature-rollout.service";

/**
 * The shared pilot helper (#2746 item 1). DATABASE and SERVER_CONFIG come from global modules.
 * Import this module wherever a feature asks "is this on for this company?" (#2746, #2747–#2750),
 * or "is the theme open for this login?" (#2820: worker, company or admin).
 */
@Module({
  providers: [FeaturePilotRepository, FeaturePilotSubjectsRepository, FeatureRolloutService],
  exports: [FeatureRolloutService],
})
export class FeatureRolloutModule {}
