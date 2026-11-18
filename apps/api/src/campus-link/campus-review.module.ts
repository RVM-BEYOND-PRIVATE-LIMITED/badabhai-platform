import { Module } from "@nestjs/common";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayersModule } from "../payers/payers.module";
import { CampusLinkModule } from "./campus-link.module";
import { CampusPostingReviewRepository } from "./campus-posting-review.repository";
import { CampusPostingReviewService } from "./campus-posting-review.service";
import { CampusReviewController } from "./campus-review.controller";
import { CampusTargetingOptionsRepository } from "./campus-targeting-options.repository";
import { CampusTargetingOptionsService } from "./campus-targeting-options.service";

/**
 * #2746 PR 5 — Campus's review and targeting-options routes, behind `CampusServiceGuard`.
 *
 * ITS OWN MODULE, so `CampusLinkModule` (#2752's, edited by its open PRs) is imported, not
 * changed. Imports:
 *   - `CampusLinkModule` for the guard's audit repository (a guard is instantiated in the module
 *     of the controller that mounts it, from that module's providers and imports);
 *   - `FeatureRolloutModule` for the `job_audience` switch;
 *   - `PayersModule` for `PayerTenantScopeService`, which resolves a posting owner's tenant key.
 * DATABASE, SERVER_CONFIG, EventsService and SubjectRateLimit come from global modules.
 *
 * `PostingAudienceRepository` (#2746 PR 4, database access only) is provided here too, for its
 * active-option read, rather than copied: `JobPostingsModule` does not export it.
 */
@Module({
  imports: [CampusLinkModule, FeatureRolloutModule, PayersModule],
  controllers: [CampusReviewController],
  providers: [
    CampusPostingReviewRepository,
    CampusPostingReviewService,
    CampusTargetingOptionsRepository,
    CampusTargetingOptionsService,
    PostingAudienceRepository,
  ],
})
export class CampusReviewModule {}
