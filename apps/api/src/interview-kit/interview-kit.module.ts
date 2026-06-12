import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { InterviewKitController } from "./interview-kit.controller";
import { InterviewKitService } from "./interview-kit.service";
import { InterviewKitRenderer } from "./interview-kit-renderer.service";

/**
 * Interview-kit serving (Task 4). EventsService (EventsModule), PdfRenderer
 * (PdfModule) and IpRateLimit (RateLimitModule) are all @Global; only StorageModule
 * (StorageService — kit upload/sign/exists) is imported here.
 */
@Module({
  imports: [StorageModule],
  controllers: [InterviewKitController],
  providers: [InterviewKitService, InterviewKitRenderer],
})
export class InterviewKitModule {}
