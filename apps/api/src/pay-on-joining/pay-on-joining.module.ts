import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { EventsModule } from "../events/events.module";
import { PayOnJoiningHiresController } from "./pay-on-joining-hires.controller";
import { PayOnJoiningHiresRepository } from "./pay-on-joining-hires.repository";
import { PayOnJoiningHiresService } from "./pay-on-joining-hires.service";
import { PayOnJoiningFlagGuard } from "./pay-on-joining.flag.guard";

/**
 * #2753 item 11 — the pay-on-joining pilot's hire record: `/admin/pay-on-joining-hires`.
 *
 * A leaf module above `AdminModule` (for its guards), one-directional like `AdminPostingsModule`:
 * nothing imports it back. INERT until `PAY_ON_JOINING_RECORDS_ENABLED` is on — every route is a
 * neutral 404 before any query. A record only: no invoice, payout or eligibility code lives here.
 */
@Module({
  imports: [AdminModule, EventsModule],
  controllers: [PayOnJoiningHiresController],
  providers: [PayOnJoiningHiresRepository, PayOnJoiningHiresService, PayOnJoiningFlagGuard],
})
export class PayOnJoiningModule {}
