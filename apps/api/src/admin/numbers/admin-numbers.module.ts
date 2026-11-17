import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AdminModule } from "../admin.module";
import { EventsModule } from "../../events/events.module";
import { NUMBERS_WEEKLY_SWEEP_QUEUE } from "../../queue/queue.constants";
import { AdminEventsRepository } from "../admin-events.repository";
import { AdminNumbersController } from "./admin-numbers.controller";
import { AdminNumbersEnabledGuard } from "./admin-numbers.flag";
import { AdminNumbersRepository } from "./admin-numbers.repository";
import { AdminNumbersService } from "./admin-numbers.service";
import { AdminNumbersWeeklyService } from "./admin-numbers-weekly.service";
import { NumbersSnapshotService } from "./numbers-snapshot.service";
import { NumbersSweepProcessor } from "./numbers-sweep.processor";
import { NumbersWeeklyRepository } from "./numbers-weekly.repository";

/**
 * #2755 — the numbers screen, `/admin/numbers/*`, and its nightly snapshot sweep. A leaf module
 * above `AdminModule` (for its guards), one-directional like `AdminHiresModule`: nothing imports it
 * back. INERT until `ADMIN_NUMBERS_ENABLED` is on — every route is a neutral 404 before any query,
 * and the sweep (registered whatever the switch says) returns at once.
 *
 * `AdminEventsRepository` is provided here, not imported: `AdminModule` does not export it, and it
 * is the one admin reader of `events` (the form-completion diagnostic's read), select-only and
 * stateless, so a second instance is the same reader.
 */
@Module({
  imports: [
    AdminModule,
    EventsModule,
    BullModule.registerQueue({ name: NUMBERS_WEEKLY_SWEEP_QUEUE }),
  ],
  controllers: [AdminNumbersController],
  providers: [
    AdminNumbersRepository,
    AdminNumbersService,
    AdminNumbersEnabledGuard,
    AdminEventsRepository,
    NumbersWeeklyRepository,
    NumbersSnapshotService,
    AdminNumbersWeeklyService,
    NumbersSweepProcessor,
  ],
})
export class AdminNumbersModule {}
