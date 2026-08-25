import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { WorkerFeedbackController } from "./worker-feedback.controller";
import { FeedbackService } from "./feedback.service";
import { FeedbackRepository } from "./feedback.repository";

/**
 * Worker app feedback (#997) — one worker-authed front door over one service.
 *
 * THE FIRST IMPORT IS THE GUARDS'. `AuthModule` supplies `WorkerAuthGuard` and `ConsentGuard`
 * together with THEIR OWN deps (`SessionService`, `ConsentRepository`), which is the part that is
 * easy to miss: a guard class is resolved in the injector of the module that references it, so
 * naming one in `@UseGuards` without this import is a BOOT-TIME failure — `WorkerAuthGuard
 * { dependencies: [null, "SERVER_CONFIG", null] }` — that no unit test constructing the
 * controller by hand can see. `feedback.module.boot.test.ts` is the guard against exactly that.
 *
 * SINCE #1191, A SECOND IMPORT: `StorageModule`, which is NOT global. `FeedbackService` mints the
 * signed upload url for a feedback image through `StorageService`, and a missing import here
 * would be the same boot-time failure this module's one import already guards against — visible
 * only to `feedback.module.boot.test.ts` and the E2E boot, never to a unit test that constructs
 * the service by hand.
 *
 * Nothing else was needed: `WorkersRepository`, `EventsService`, `SERVER_CONFIG`, `SubjectRateLimit`,
 * `IpRateLimit` and `DATABASE` all come from @Global modules.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [WorkerFeedbackController],
  providers: [FeedbackService, FeedbackRepository],
})
export class FeedbackModule {}
