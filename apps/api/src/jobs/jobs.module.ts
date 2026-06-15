import { Module } from "@nestjs/common";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { JobsRepository } from "./jobs.repository";

/**
 * Phase-2 Job entity + lifecycle.
 *
 * EventsService (EventsModule) is @Global, so no imports are needed here — the
 * service depends on it directly via DI.
 */
@Module({
  controllers: [JobsController],
  providers: [JobsService, JobsRepository],
})
export class JobsModule {}
