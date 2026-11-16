import { Module } from "@nestjs/common";
import { WorkerActivityRepository } from "./worker-activity.repository";
import { WorkerActivityService } from "./worker-activity.service";

/**
 * Last active, one definition (#2753 items 4 and 7): `worker_activity` and its one read.
 *
 * A LEAF: it needs only `DATABASE` and `SERVER_CONFIG`, both @Global, and imports nothing, so any
 * module may import it without a cycle. Imported, not @Global, so each consumer names the edge:
 * `ReferralAttributionModule` (the request interceptor), `MatchModule` (the applicant, inbox and
 * search rows' mark and the pre-pay `lastActiveOn`), `AgencyModule` (the referred-workers list)
 * and `CampusJobsModule` (a Campus application). Each consumer injects the service as
 * `@Optional()` so hand-built unit instances compile, which is why
 * `worker-activity.module.test.ts` pins every one of those imports: an import dropped would not
 * fail the boot, it would quietly switch the feature off for that surface.
 */
@Module({
  providers: [WorkerActivityRepository, WorkerActivityService],
  exports: [WorkerActivityService],
})
export class WorkerActivityModule {}
