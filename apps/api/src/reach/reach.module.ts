import { Module } from "@nestjs/common";
import { PayersModule } from "../payers/payers.module";
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
  // ADR-0027 B5.x Inc 5: PayersModule exports PayerOrgsRepository — the ReachService owned-read
  // resolves the acting payer's OWNING org through it (the jobs ownership flip). PayersModule
  // imports only Database/Bull/Jwt, so no cycle with ReachModule.
  imports: [PayersModule],
  controllers: [ReachController],
  providers: [
    ReachService,
    ReachRepository,
    {
      provide: JOB_SOURCE,
      useClass: JobsTableJobSource,
    },
  ],
  // Exports serve two additive consumers (union):
  //  - PACE (ADR-0021) measures above-floor supply via the SAME ReachRepository +
  //    JOB_SOURCE, never reimplementing ranking;
  //  - the payer-portal (ADR-0019 R22) reuses ReachService for the payer-self reach
  //    view, exactly as it reuses UnlockService — the controller never re-implements
  //    ranking. Faceless: all surface opaque ids + signals only.
  exports: [ReachRepository, JOB_SOURCE, ReachService],
})
export class ReachModule {}
