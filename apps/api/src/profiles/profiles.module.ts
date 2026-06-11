import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ChatModule } from "../chat/chat.module";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import { AiJobsController } from "./ai-jobs.controller";
import { ProfileExtractionProcessor } from "./profile-extraction.processor";
import { PROFILE_EXTRACTION_QUEUE } from "../queue/queue.constants";

@Module({
  imports: [
    // forwardRef: ChatService also depends on ProfilesService (auto-trigger
    // extraction on the readiness flip), so the two modules reference each other.
    forwardRef(() => ChatModule), // for ChatRepository (transcript)
    BullModule.registerQueue({ name: PROFILE_EXTRACTION_QUEUE }),
  ],
  controllers: [ProfilesController, AiJobsController],
  providers: [ProfilesService, ProfilesRepository, AiJobsRepository, ProfileExtractionProcessor],
  exports: [ProfilesRepository, ProfilesService],
})
export class ProfilesModule {}
