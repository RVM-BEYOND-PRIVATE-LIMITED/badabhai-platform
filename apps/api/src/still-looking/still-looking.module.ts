import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PushQueueModule } from "../push/push-queue.module";
import { STILL_LOOKING_SWEEP_QUEUE } from "../queue/queue.constants";
import { SearchExitModule } from "../search-exit/search-exit.module";
import { WorkerActivityModule } from "../worker-activity/worker-activity.module";
import { StillLookingController } from "./still-looking.controller";
import { StillLookingRepository } from "./still-looking.repository";
import { StillLookingService } from "./still-looking.service";
import { StillLookingSweepProcessor } from "./still-looking.sweep.processor";

/**
 * #2753 item 5 — THE MONTHLY "STILL LOOKING?" CHECK: `workers/me/still-looking` and the daily sweep.
 *
 * ITS OWN MODULE, a leaf nothing imports, so no realm's module is edited and no cycle can close.
 *  - `AuthModule`: `WorkerAuthGuard` and `ConsentGuard` (a guard is instantiated in the module of
 *    the controller that mounts it), and `DevicesRepository` (the push targets).
 *  - `SearchExitModule`: `SearchExitService` ("not now" out of company search, "yes" back in, on
 *    this module's transaction).
 *  - `WorkerActivityModule`: the last-active read and mark, and the touch after an answer.
 *  - `PushQueueModule`: `PushEnqueuer`, the producer-only half of push (the cycle-free seam).
 * DATABASE, SERVER_CONFIG and EventsService come from global modules. No `HiresModule`: a worker's
 * "hired" names no company or posting, so there is no hire record to write (see the service).
 */
@Module({
  imports: [
    AuthModule,
    SearchExitModule,
    WorkerActivityModule,
    PushQueueModule,
    BullModule.registerQueue({ name: STILL_LOOKING_SWEEP_QUEUE }),
  ],
  controllers: [StillLookingController],
  providers: [StillLookingRepository, StillLookingService, StillLookingSweepProcessor],
})
export class StillLookingModule {}
