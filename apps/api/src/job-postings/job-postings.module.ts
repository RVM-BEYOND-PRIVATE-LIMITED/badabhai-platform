import { Module } from "@nestjs/common";
import { JobPostingsController } from "./job-postings.controller";
import { JobPostingsService } from "./job-postings.service";
import { JobPostingsRepository } from "./job-postings.repository";

/**
 * Ops-created job postings (ADR-0010). EventsService (global, via EventsModule)
 * is the only external dep; the repository talks to the global DATABASE provider.
 */
@Module({
  controllers: [JobPostingsController],
  providers: [JobPostingsService, JobPostingsRepository],
})
export class JobPostingsModule {}
