import { Module } from "@nestjs/common";
import { ReachController } from "./reach.controller";
import { ReachService } from "./reach.service";
import { ReachRepository } from "./reach.repository";
import { JOB_SOURCE, JobsTableJobSource } from "./reach.job-source";

/**
 * Reach serving (ADR-0011) — strictly additive. Consumes the unchanged RANK core
 * (`@badabhai/reach-engine`) and renders two read-only ops views. `DATABASE` (global)
 * and `EventsService` (global) are the cross-cutting deps, so no imports are needed.
 *
 * `JOB_SOURCE` is bound to `JobsTableJobSource` — the real read over the live
 * ADR-0009 `jobs` entity (the ADR-0011 §4 swap point, now EXECUTED; it replaced the
 * dev-only `StubJobSource` + its `isDevEnv` D6 gate). The swap was a single provider
 * change on this one binding — `reach.controller.ts` / `reach.service.ts` are
 * untouched. `StubJobSource` is retained in `reach.job-source.ts` for unit tests,
 * which inject a fake `JobSource` directly rather than booting this module.
 */
@Module({
  controllers: [ReachController],
  providers: [
    ReachService,
    ReachRepository,
    {
      provide: JOB_SOURCE,
      useClass: JobsTableJobSource,
    },
  ],
  // Export ONLY the service (the ranking orchestration + faceless boundary). The
  // payer-portal reuses it for the payer-self reach view (ADR-0019 R22), exactly as it
  // reuses UnlockService — the controller never re-implements ranking. ReachRepository
  // stays unexported (the projection-discipline owner; reached only via the service).
  exports: [ReachService],
})
export class ReachModule {}
