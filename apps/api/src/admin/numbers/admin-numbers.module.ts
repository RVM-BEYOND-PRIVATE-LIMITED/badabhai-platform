import { Module } from "@nestjs/common";
import { AdminModule } from "../admin.module";
import { EventsModule } from "../../events/events.module";
import { AdminNumbersController } from "./admin-numbers.controller";
import { AdminNumbersEnabledGuard } from "./admin-numbers.flag";
import { AdminNumbersRepository } from "./admin-numbers.repository";
import { AdminNumbersService } from "./admin-numbers.service";

/**
 * #2755 — the numbers screen, `/admin/numbers/*`. A leaf module above `AdminModule` (for its
 * guards), one-directional like `AdminHiresModule`: nothing imports it back. INERT until
 * `ADMIN_NUMBERS_ENABLED` is on — every route is a neutral 404 before any query.
 */
@Module({
  imports: [AdminModule, EventsModule],
  controllers: [AdminNumbersController],
  providers: [AdminNumbersRepository, AdminNumbersService, AdminNumbersEnabledGuard],
})
export class AdminNumbersModule {}
