import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { JobPostingsController } from "./job-postings.controller";
import { JobPostingsService } from "./job-postings.service";
import { JobPostingsRepository } from "./job-postings.repository";

/**
 * Ops-created job postings (ADR-0012). EventsService (global, via EventsModule)
 * is the only external dep; the repository talks to the global DATABASE provider.
 *
 * #1213 — `AdminModule` is imported ONLY so `POST /:id/reach/widen` can mount
 * `AdminAuthGuard` (it exports the guard + `AdminSessionService`). One-directional:
 * `AdminModule` does not import `JobPostingsModule`, so no `forwardRef` is needed.
 */
@Module({
  imports: [AdminModule],
  controllers: [JobPostingsController],
  providers: [JobPostingsService, JobPostingsRepository],
  // Exported so the payer portal can mount a PayerAuthGuard'd self-serve posting
  // surface (PayerJobPostingsController) over the SAME service/repo chokepoint —
  // exactly as ReachModule/ResumeDisclosureModule export their services. The ops
  // InternalServiceGuard-free /job-postings routes are unchanged (one principal per route).
  exports: [JobPostingsService],
})
export class JobPostingsModule {}
