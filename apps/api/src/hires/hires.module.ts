import { Module } from "@nestjs/common";
import { HiresRepository } from "./hires.repository";
import { HiresService } from "./hires.service";

/**
 * #2753 item 9 — HIRE RECORDS (`hires`): the service every source calls on its own transaction.
 *
 * A LEAF: it imports nothing. DATABASE, SERVER_CONFIG and EventsService come from global modules,
 * so the payer portal (the stage board) and the later answer and desk modules can import it
 * without a cycle. The admin list lives in {@link import("./admin-hires.module").AdminHiresModule},
 * which needs `AdminModule`'s guards.
 */
@Module({
  providers: [HiresRepository, HiresService],
  exports: [HiresService],
})
export class HiresModule {}
