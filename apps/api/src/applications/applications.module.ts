import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";
import { ApplicationsRepository } from "./applications.repository";

/**
 * Alpha swipe-to-apply (ADR-0009 Stream B): the worker feed + apply/skip and the
 * ops applicant reads. Folds the feed read into this module (ADR §4 allows the
 * engineer's call — a separate feed module would be heavier for one read).
 *
 * Imports AuthModule for the two worker-route guards: WorkerAuthGuard and
 * ConsentGuard. AuthModule EXPORTS both guards AND their dependencies
 * (SessionService, ConsentRepository) so Nest can resolve each guard's ctor deps
 * in THIS module's injector when @UseGuards applies them — the app boots, not just
 * the unit tests. EventsService (EventsModule) and the Drizzle DATABASE
 * (DatabaseModule) are @Global, so they need no import here.
 */
@Module({
  imports: [AuthModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, ApplicationsRepository],
})
export class ApplicationsModule {}
