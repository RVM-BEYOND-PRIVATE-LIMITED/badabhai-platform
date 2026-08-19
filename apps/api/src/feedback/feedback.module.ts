import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { WorkerFeedbackController } from "./worker-feedback.controller";
import { FeedbackService } from "./feedback.service";
import { FeedbackRepository } from "./feedback.repository";

/**
 * Worker app feedback (#997) — one worker-authed front door over one service.
 *
 * ONE IMPORT, AND IT IS THE GUARDS'. `AuthModule` supplies `WorkerAuthGuard` and `ConsentGuard`
 * together with THEIR OWN deps (`SessionService`, `ConsentRepository`), which is the part that is
 * easy to miss: a guard class is resolved in the injector of the module that references it, so
 * naming one in `@UseGuards` without this import is a BOOT-TIME failure — `WorkerAuthGuard
 * { dependencies: [null, "SERVER_CONFIG", null] }` — that no unit test constructing the
 * controller by hand can see. `feedback.module.boot.test.ts` is the guard against exactly that.
 *
 * Nothing else was needed: `WorkersRepository`, `EventsService`, `SERVER_CONFIG`, `SubjectRateLimit`
 * and `DATABASE` all come from @Global modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [WorkerFeedbackController],
  providers: [FeedbackService, FeedbackRepository],
})
export class FeedbackModule {}
