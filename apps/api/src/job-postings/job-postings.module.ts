import { Module } from "@nestjs/common";
import { JobPostingsController } from "./job-postings.controller";
import { JobPostingsService } from "./job-postings.service";
import { JobPostingsRepository } from "./job-postings.repository";

/**
 * Ops-created job postings (ADR-0012). EventsService (global, via EventsModule)
 * is the only external dep; the repository talks to the global DATABASE provider.
 */
@Module({
  controllers: [JobPostingsController],
  providers: [JobPostingsService, JobPostingsRepository],
  // Exported so the Reach serving layer (ADR-0011 JobSource swap point) can read
  // postings → JobSpec without re-providing the repo. Read-only consumer.
  exports: [JobPostingsRepository],
})
export class JobPostingsModule {}
