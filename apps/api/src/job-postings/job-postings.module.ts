import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { PostingTradesModule } from "../posting-trades/posting-trades.module";
import { JobPostingsController } from "./job-postings.controller";
import { JobPostingsService } from "./job-postings.service";
import { JobPostingsRepository } from "./job-postings.repository";
import { PostingAudienceRepository } from "./posting-audience.repository";
import { PostingAudienceService } from "./posting-audience.service";

/**
 * Ops-created job postings (ADR-0012). EventsService (global, via EventsModule)
 * is the only external dep; the repository talks to the global DATABASE provider.
 *
 * #1213 — `AdminModule` is imported ONLY so `POST /:id/reach/widen` can mount
 * `AdminAuthGuard` (it exports the guard + `AdminSessionService`). One-directional:
 * `AdminModule` does not import `JobPostingsModule`, so no `forwardRef` is needed.
 *
 * ADR-0053 — `PayersModule` is imported for `PayerTenantScopeService`, the tenant resolver the
 * payer path of `JobPostingsService` injects. One-directional too: `PayersModule` imports
 * nothing that reaches back here.
 *
 * #2746 — `FeatureRolloutModule` for the `job_audience` switch that `PostingAudienceService`
 * reads per company. It imports nothing (DATABASE and SERVER_CONFIG are global).
 */
@Module({
  imports: [AdminModule, FeatureRolloutModule, PayersModule, PostingTradesModule],
  controllers: [JobPostingsController],
  providers: [
    JobPostingsService,
    JobPostingsRepository,
    PostingAudienceService,
    PostingAudienceRepository,
  ],
  // Exported so the payer portal can mount a PayerAuthGuard'd self-serve posting
  // surface (PayerJobPostingsController) over the SAME service/repo chokepoint —
  // exactly as ReachModule/ResumeDisclosureModule export their services. The ops
  // InternalServiceGuard-free /job-postings routes are unchanged (one principal per route).
  exports: [JobPostingsService],
})
export class JobPostingsModule {}
