import { Module } from "@nestjs/common";
import { PayersModule } from "../payers/payers.module";
import { ProfilingModule } from "../profiling/profiling.module";
import { PostingTradesController } from "./posting-trades.controller";
import { PostingTradesService } from "./posting-trades.service";

/**
 * The 16-trade posting form catalogue.
 *
 * A module of its own because TWO feature modules consume it — `JobPostingsModule` (company
 * postings) and `AgencyModule` (agency demand) — and neither owns the other. It imports
 * `ProfilingModule` for the question-pack registry, so a posting is built from the same
 * checked-in pack the worker interview reads; no second vocabulary exists.
 */
@Module({
  imports: [ProfilingModule, PayersModule],
  controllers: [PostingTradesController],
  providers: [PostingTradesService],
  exports: [PostingTradesService],
})
export class PostingTradesModule {}
