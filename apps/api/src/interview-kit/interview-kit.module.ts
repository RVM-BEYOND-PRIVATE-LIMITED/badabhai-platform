import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { AuthModule } from "../auth/auth.module";
import { InterviewKitController } from "./interview-kit.controller";
import { InterviewKitsController } from "./interview-kits.controller";
import { InterviewKitService } from "./interview-kit.service";
import { InterviewKitRenderer } from "./interview-kit-renderer.service";

/**
 * Interview-kit serving (Task 4 + TD54 read routes). EventsService (EventsModule),
 * PdfRenderer (PdfModule) and IpRateLimit (RateLimitModule) are all @Global; only
 * StorageModule (StorageService — kit upload/sign/exists) is imported here.
 *
 * AuthModule is imported for ONE reason: `OptionalWorkerAuthGuard` on the download route.
 * A guard's constructor deps resolve in the IMPORTING module's injector, so `SessionService`
 * must be reachable here — AuthModule exports both. One-directional: AuthModule does not
 * import this module, so there is no cycle. The route stays PUBLIC; see the controller.
 */
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [InterviewKitController, InterviewKitsController],
  providers: [InterviewKitService, InterviewKitRenderer],
})
export class InterviewKitModule {}
