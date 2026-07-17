import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";
import { JobsRepository } from "./jobs.repository";

/**
 * Worker-scoped job detail read (ADR-0024 final addendum, 2026-07-16): the
 * single `GET /jobs/:jobId` projection that replaces the worker-app's
 * client-side job-detail mock. One read, one module — deliberately separate from
 * ApplicationsModule (the swipe surface) so the ADR-0024 privacy projection has
 * one obvious home.
 *
 * Imports AuthModule for the two worker-route guards: WorkerAuthGuard and
 * ConsentGuard. AuthModule EXPORTS both guards AND their dependencies
 * (SessionService, ConsentRepository) so Nest can resolve each guard's ctor deps
 * in THIS module's injector when @UseGuards applies them (mirrors
 * ApplicationsModule). The Drizzle DATABASE (DatabaseModule) is @Global, so it
 * needs no import here. NO EventsModule dependency — the detail read emits no
 * event by ruling (ADR-0024 final addendum §"Event ruling").
 */
@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [JobsService, JobsRepository],
})
export class JobsModule {}
