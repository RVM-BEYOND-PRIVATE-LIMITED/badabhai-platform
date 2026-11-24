import { Module } from "@nestjs/common";
import { TradeReleaseRepository } from "./trade-release.repository";
import { TradeReleaseService } from "./trade-release.service";

/**
 * #3002 — the per-trade release switch. Exports {@link TradeReleaseService} (the admin
 * GET/PUT read and write through it) and {@link TradeReleaseRepository} (the posting
 * catalogue, posting validation and the Campus translation target read through it in
 * #3005, #3006 and #3014). DATABASE and EventsService come from global modules.
 */
@Module({
  providers: [TradeReleaseRepository, TradeReleaseService],
  exports: [TradeReleaseRepository, TradeReleaseService],
})
export class TradeReleaseModule {}
