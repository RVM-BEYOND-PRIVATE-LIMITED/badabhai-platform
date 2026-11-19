import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AdminModule } from "../admin/admin.module";
import { AdminEventsRepository } from "../admin/admin-events.repository";
import { CampusLinkModule } from "../campus-link/campus-link.module";
import { EventsModule } from "../events/events.module";
import { FLOW_CHECK_QUEUE } from "../queue/queue.constants";
import { AdminFlowCheckController } from "./admin-flow-check.controller";
import { CampusApplicationsCheckController } from "./campus-applications-check.controller";
import { FlowCheckEnabledGuard } from "./flow-check.flag";
import { FlowCheckProcessor } from "./flow-check.processor";
import { FlowCheckRepository } from "./flow-check.repository";
import { FlowCheckService } from "./flow-check.service";

/**
 * #2890 — THE DAILY FLOW CHECK: the repeatable tick, Campus's report route and the admin's 14-day
 * read.
 *
 * ITS OWN MODULE, a leaf nothing imports back, so no realm's module is edited and no cycle can
 * close. `AdminModule` gives the admin guards; `CampusLinkModule` gives `CampusServiceGuard` (it is
 * exported for exactly this: one Campus credential for every Campus route). `AdminEventsRepository`
 * is PROVIDED here, not imported (the numbers screen's reason): it is the one select-only admin
 * reader of `events`, stateless, so a second instance is the same reader. DATABASE, SERVER_CONFIG
 * and EventsService come from global modules.
 *
 * INERT until `FLOW_CHECK_ENABLED` is on: the tick returns at once without a query, and both routes
 * are a neutral 404.
 */
@Module({
  imports: [
    AdminModule,
    CampusLinkModule,
    EventsModule,
    BullModule.registerQueue({ name: FLOW_CHECK_QUEUE }),
  ],
  controllers: [AdminFlowCheckController, CampusApplicationsCheckController],
  providers: [
    AdminEventsRepository,
    FlowCheckEnabledGuard,
    FlowCheckRepository,
    FlowCheckService,
    FlowCheckProcessor,
  ],
})
export class FlowCheckModule {}
