import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayersModule } from "../payers/payers.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import { CampusDriveRequestsController } from "./campus-drive-requests.controller";
import { CampusDriveRequestsRepository } from "./campus-drive-requests.repository";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";
import { PayerCampusDriveRequestsController } from "./payer-campus-drive-requests.controller";

/**
 * #2746 PR 6 — CAMPUS-DRIVE REQUESTS: a company asks (`/payer/campus-drive-requests`, behind
 * `PayerAuthGuard` + `PayerRoleGuard`), RVM's placement team decides from BadaBhai Campus
 * (`/internal/campus/v1/drive-requests`, behind `CampusServiceGuard`). Two controllers, one per
 * principal, never one controller serving both.
 *
 * ITS OWN MODULE, so `CampusLinkModule` (#2752's) is imported, not edited. Imports:
 *   - `CampusLinkModule` for the Campus guard's audit repository (a guard is instantiated in the
 *     module of the controller that mounts it, from that module's providers and imports);
 *   - `FeatureRolloutModule` for the `campus_drive_requests` switch;
 *   - `PayersModule` for `PayerAuthGuard`, `PayerRoleGuard` and `PayerTenantScopeService`;
 *   - BullMQ's Redis connection (client only) for `RequestIdempotency`, as `PayerPortalModule`.
 * DATABASE, SERVER_CONFIG, PiiCryptoService, EventsService and SubjectRateLimit come from global
 * modules.
 *
 * `PostingAudienceRepository` (#2746 PR 4, database access only) is provided here for its
 * active-option read, as #2746 PR 5 does, rather than copied: `JobPostingsModule` does not export it.
 * The DPDP erasure of a contact (`CampusDriveContactErasureRepository`) is provided by
 * `PayersModule`, where the account deletion that calls it lives.
 */
@Module({
  imports: [
    CampusLinkModule,
    FeatureRolloutModule,
    PayersModule,
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [PayerCampusDriveRequestsController, CampusDriveRequestsController],
  providers: [
    CampusDriveRequestsRepository,
    CampusDriveRequestsService,
    CampusDriveDecisionsService,
    PostingAudienceRepository,
    RequestIdempotency,
  ],
})
export class CampusDrivesModule {}
