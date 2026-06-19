import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ReachModule } from "../reach/reach.module";
import { PaceController } from "./pace.controller";
import { PaceService } from "./pace.service";
import { PaceRepository } from "./pace.repository";
import { PaceProcessor } from "./pace.processor";
import { PACE_QUEUE } from "./pace.constants";

/**
 * PACE supply-widening (ADR-0021) — strictly ADDITIVE. The deterministic "release
 * waves" slice of ADR-0011's PACE triad: widen a thin-supply job's served good-fit
 * pool in delayed BullMQ waves (area → [gated] adjacent trade) and raise a PII-free
 * ops alert after the 6–24h window.
 *
 * Reuses, never reimplements: `ReachModule` exports the RANK reuse (`ReachRepository`
 * + `JOB_SOURCE`) so PACE measures above-floor supply via `@badabhai/reach-engine`.
 * `DATABASE`, `SERVER_CONFIG`, and `EventsService` are global. `PACE_QUEUE` is the
 * first DELAYED-job consumer of the live BullMQ wiring.
 */
@Module({
  imports: [BullModule.registerQueue({ name: PACE_QUEUE }), ReachModule],
  controllers: [PaceController],
  providers: [PaceService, PaceRepository, PaceProcessor],
})
export class PaceModule {}
