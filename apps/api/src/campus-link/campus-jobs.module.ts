import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { JobPostingsModule } from "../job-postings/job-postings.module";
import { PayersModule } from "../payers/payers.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { CampusApplicationsController } from "./campus-applications.controller";
import { CampusApplicationsRepository } from "./campus-applications.repository";
import { CampusApplicationsService } from "./campus-applications.service";
import { CampusJobsController } from "./campus-jobs.controller";
import { CampusLinkModule } from "./campus-link.module";
import { CampusPostingsRepository } from "./campus-postings.repository";
import { CampusPostingsService } from "./campus-postings.service";
import { WorkerActivityModule } from "../worker-activity/worker-activity.module";

/**
 * The Campus jobs and applications routes (#2752 part E), behind the same `CampusServiceGuard`.
 *
 * A MODULE OF ITS OWN, and nothing imports it but `AppModule`: it needs `JobPostingsModule`
 * (`createForCampus`, so a posting the placement team makes goes through the company form's own
 * create), whose tree reaches the profiles, résumé, profiling and voice modules that import
 * `CampusLinkModule` for its AI gate. Inside `CampusLinkModule` that edge would close a cycle;
 * here every edge points one way.
 *
 * `CampusLinkModule` gives the guard, its audit repository and the link service.
 * `RequestIdempotency` (with the queue whose Redis connection it reuses) guards
 * `POST job-postings`, which has no lasting ref of its own.
 */
@Module({
  imports: [
    CampusLinkModule,
    JobPostingsModule,
    PayersModule,
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
    // #2753 - a Campus application records the student's last-active day. A leaf module.
    WorkerActivityModule,
  ],
  controllers: [CampusJobsController, CampusApplicationsController],
  providers: [
    CampusApplicationsRepository,
    CampusApplicationsService,
    CampusPostingsRepository,
    CampusPostingsService,
    RequestIdempotency,
  ],
})
export class CampusJobsModule {}
