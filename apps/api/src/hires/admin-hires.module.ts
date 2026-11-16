import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AdminHiresController } from "./admin-hires.controller";
import { HireRecordsEnabledGuard } from "./hires.flag";
import { HiresModule } from "./hires.module";

/**
 * #2753 item 9 — `GET /admin/hires`. Its own module, ABOVE `AdminModule` (for `AdminAuthGuard` and
 * `AdminRolesGuard`) and `HiresModule`, so neither has to import the other: the payer portal
 * imports `HiresModule` for the stage source, and `AdminModule` never sees hires at all.
 */
@Module({
  imports: [AdminModule, HiresModule],
  controllers: [AdminHiresController],
  providers: [HireRecordsEnabledGuard],
})
export class AdminHiresModule {}
