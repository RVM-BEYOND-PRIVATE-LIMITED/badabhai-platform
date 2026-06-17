import { Module } from "@nestjs/common";
import { isDevEnv } from "@badabhai/config";
import { ReachController } from "./reach.controller";
import { ReachService } from "./reach.service";
import { ReachRepository } from "./reach.repository";
import { JOB_SOURCE, createStubJobSourceOrThrow, type JobSource } from "./reach.job-source";
import { JobPostingsJobSource } from "./reach.job-postings-source";
import { JobPostingsModule } from "../job-postings/job-postings.module";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";

/**
 * Reach serving (ADR-0011) — strictly additive. Consumes the unchanged RANK core
 * (`@badabhai/reach-engine`) and renders two read-only ops views. `DATABASE` (global)
 * and `EventsService` (global) are the cross-cutting deps; `JobPostingsModule` is
 * imported only to read postings → `JobSpec` (it exports `JobPostingsRepository`).
 *
 * `JOB_SOURCE` is environment-bound (ADR-0011 §4 SWAP POINT, now wired):
 *   - **dev/test** → `StubJobSource` (in-code fixtures, no table) via the existing
 *     D6-guarded `createStubJobSourceOrThrow` — preserves all existing dev/test behaviour.
 *   - **staging/production** → `JobPostingsJobSource`, which reads the real
 *     `job_postings` (ADR-0012) and maps rows → `JobSpec`. The controller/service are
 *     UNTOUCHED — this is the single-provider swap the port was designed for.
 *
 * D6 PRODUCTION GATE: `isDevEnv()` is fail-closed on the raw `NODE_ENV` (true only for
 * an explicit "development"/"test"), so the stub can NEVER serve fixtures in
 * staging/production — the real `JobPostingsJobSource` is bound there.
 */
@Module({
  imports: [JobPostingsModule],
  controllers: [ReachController],
  providers: [
    ReachService,
    ReachRepository,
    {
      provide: JOB_SOURCE,
      inject: [JobPostingsRepository],
      useFactory: (postings: JobPostingsRepository): JobSource =>
        isDevEnv() ? createStubJobSourceOrThrow() : new JobPostingsJobSource(postings),
    },
  ],
})
export class ReachModule {}
