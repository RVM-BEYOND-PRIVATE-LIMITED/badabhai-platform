import { Module } from "@nestjs/common";
import { ReachController } from "./reach.controller";
import { ReachService } from "./reach.service";
import { ReachRepository } from "./reach.repository";
import { JOB_SOURCE, createStubJobSourceOrThrow } from "./reach.job-source";

/**
 * Reach serving (ADR-0011) — strictly additive. Consumes the unchanged RANK core
 * (`@badabhai/reach-engine`) and renders two read-only ops views. `DATABASE` (global)
 * and `EventsService` (global) are the cross-cutting deps, so no imports are needed.
 *
 * `JOB_SOURCE` is bound to the alpha `StubJobSource` (in-code fixtures, no table).
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ SWAP POINT (ADR-0011 §4 / D6): when ADR-0010 (`job_postings`) merges, replace  │
 * │ `createStubJobSourceOrThrow` with a `JobPostingsJobSource` provider that reads  │
 * │ the table and maps rows → `JobSpec`. The controller/service are UNTOUCHED — it  │
 * │ is a single provider swap on this one binding.                                 │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * D6 PRODUCTION GATE: the factory throws (via `isDevEnv()`, fail-closed on raw
 * `NODE_ENV`) if booted outside dev/test, so the stub can NEVER silently serve
 * fixtures in staging/production — the real provider is required there.
 */
@Module({
  controllers: [ReachController],
  providers: [
    ReachService,
    ReachRepository,
    {
      provide: JOB_SOURCE,
      useFactory: createStubJobSourceOrThrow,
    },
  ],
})
export class ReachModule {}
