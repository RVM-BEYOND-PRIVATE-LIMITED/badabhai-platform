import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { PayersModule } from "../payers/payers.module";
import { MatchModule } from "../match/match.module";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { CandidateSearchController } from "./candidate-search.controller";
import { CandidateSearchService } from "./candidate-search.service";
import { CandidateSearchRepository } from "./candidate-search.repository";

/**
 * The payer ALL-CANDIDATES search (ADR-0040, phase E2) — its own module, as E2_BUILD item 1 asks.
 *
 *  - {@link PayersModule}: `PayerAuthGuard` (session principal + lifecycle gate).
 *  - {@link MatchModule}: `MatchConfigService` — the live `tier_floor_months` the rank key's
 *    effective tier reads, the same row the applicant lists read.
 *  - {@link PayerDisclosureRateLimit}: the per-payer fail-closed hourly cap, re-provided here on
 *    the result-render queue's Redis connection exactly as `AgencyModule` and `PayerPortalModule`
 *    do (it is not exported by `PayersModule`).
 * Database, config and events are global modules.
 */
@Module({
  imports: [PayersModule, MatchModule, BullModule.registerQueue({ name: RESUME_RENDER_QUEUE })],
  controllers: [CandidateSearchController],
  providers: [CandidateSearchService, CandidateSearchRepository, PayerDisclosureRateLimit],
})
export class CandidatesModule {}
