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
  // Export the RANK reuse so additive consumers (PACE — ADR-0021) can measure
  // above-floor supply via the SAME repository + job source, never reimplementing
  // ranking. Faceless: both surface opaque ids + signals only.
  exports: [ReachRepository, JOB_SOURCE],
})
export class ReachModule {}
