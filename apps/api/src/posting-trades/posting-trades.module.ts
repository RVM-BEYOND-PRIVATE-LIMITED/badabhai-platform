import { Module } from "@nestjs/common";
import { PayersModule } from "../payers/payers.module";
import { ProfilingModule } from "../profiling/profiling.module";
import { TradeReleaseModule } from "../trade-release/trade-release.module";
import { PostingTradesController } from "./posting-trades.controller";
import { PostingTradesService } from "./posting-trades.service";

/**
 * The posting form catalogue (60 declared trades; offered while each one's release switch is on).
 *
 * A module of its own because TWO feature modules consume it — `JobPostingsModule` (company
 * postings) and `AgencyModule` (agency demand) — and neither owns the other. It imports
 * `ProfilingModule` for the question-pack registry, so a posting is built from the same
 * checked-in pack the worker interview reads; no second vocabulary exists. It imports
 * `TradeReleaseModule` for the per-trade posting switch (#3002, #3005).
 */
@Module({
  imports: [ProfilingModule, PayersModule, TradeReleaseModule],
  controllers: [PostingTradesController],
  providers: [PostingTradesService],
  exports: [PostingTradesService],
})
export class PostingTradesModule {}
