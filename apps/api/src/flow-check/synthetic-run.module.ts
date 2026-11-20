import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AdminPostingsModule } from "../admin-postings/admin-postings.module";
import { ApplicationsModule } from "../applications/applications.module";
import { CampusJobsModule } from "../campus-link/campus-jobs.module";
import { EventsModule } from "../events/events.module";
import { JobPostingsModule } from "../job-postings/job-postings.module";
import { PayerPortalModule } from "../payer-portal/payer-portal.module";
import { FLOW_SYNTHETIC_RUN_QUEUE } from "../queue/queue.constants";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { SyntheticRunController, SyntheticRunEnabledGuard } from "./synthetic-run.controller";
import { SyntheticRunProcessor } from "./synthetic-run.processor";
import { SyntheticRunService } from "./synthetic-run.service";

/**
 * #2967 — THE DAILY SYNTHETIC RUN: the tick, the ops run-now route and the walk.
 *
 * A LEAF nothing imports back: it imports the feature modules whose services the walk calls (each
 * exports exactly the one service it needs), so every edge points one way and no cycle can close.
 * DATABASE, DB_CLIENT, SERVER_CONFIG, PiiCryptoService and EventsService come from global modules.
 * INERT until `FLOW_SYNTHETIC_RUN_ENABLED` is on: the tick returns at once, the route is a 404.
 */
@Module({
  imports: [
    AdminPostingsModule,
    ApplicationsModule,
    CampusJobsModule,
    EventsModule,
    JobPostingsModule,
    PayerPortalModule,
    UnlocksModule,
    BullModule.registerQueue({ name: FLOW_SYNTHETIC_RUN_QUEUE }),
  ],
  controllers: [SyntheticRunController],
  providers: [SyntheticRunEnabledGuard, SyntheticRunService, SyntheticRunProcessor],
})
export class SyntheticRunModule {}
