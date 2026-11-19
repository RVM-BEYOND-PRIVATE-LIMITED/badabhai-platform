import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AgencyModule } from "../agency/agency.module";
import { AgencyTwinModule } from "../agency-twin/agency-twin.module";
import { EventsModule } from "../events/events.module";
import { JobPostingsModule } from "../job-postings/job-postings.module";
import { AdminPostingsController } from "./admin-postings.controller";
import { AdminPostingsRepository } from "./admin-postings.repository";
import { AdminPostingsService } from "./admin-postings.service";
import { AdminPostingWorkerVisibilityController } from "./admin-posting-worker-visibility.controller";
import { AdminPostingWorkerVisibilityRepository } from "./admin-posting-worker-visibility.repository";
import { AdminPostingWorkerVisibilityService } from "./admin-posting-worker-visibility.service";
import { AdminPostingAudienceController } from "./admin-posting-audience.controller";
import { AdminPostingAudienceRepository } from "./admin-posting-audience.repository";
import { AdminPostingAudienceService } from "./admin-posting-audience.service";

/**
 * #2566 — the ADMIN posting-control write surface.
 *
 * WHY THIS IS ITS OWN MODULE, not a provider on `AdminModule`: `JobPostingsModule` and
 * `AgencyModule` both import `AdminModule` (for its guards), so injecting their services
 * into `AdminModule` itself would be a cycle. This module sits ABOVE both and depends on
 * them one-directionally. It reuses their SHIPPED patch builders (`JobPostingsService.
 * prepareAdminEdit`, `AgencyService.prepareAdminEdit`) rather than a third copy, and the
 * ADR-0050 twin sync for an agency job's synced copy.
 */
@Module({
  imports: [
    AdminModule,
    EventsModule,
    JobPostingsModule,
    AgencyModule,
    AgencyTwinModule,
    // #2750 item 4 — welcome credits after an approval. No dependency back.
    CreditRulesModule,
  ],
  // #2891 — BadaBhai worker visibility of Campus-origin postings, under the same capability.
  // #2956 — where a posting shows, decided by an admin, under the same capability.
  controllers: [
    AdminPostingsController,
    AdminPostingWorkerVisibilityController,
    AdminPostingAudienceController,
  ],
  providers: [
    AdminPostingsRepository,
    AdminPostingsService,
    AdminPostingWorkerVisibilityRepository,
    AdminPostingWorkerVisibilityService,
    AdminPostingAudienceRepository,
    AdminPostingAudienceService,
  ],
})
export class AdminPostingsModule {}
