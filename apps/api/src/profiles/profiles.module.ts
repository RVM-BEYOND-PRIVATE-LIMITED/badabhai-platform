import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import { AiJobsController } from "./ai-jobs.controller";
import { ProfileExtractionProcessor } from "./profile-extraction.processor";
import { AiJobsRetentionSweepProcessor } from "./ai-jobs-retention-sweep.processor";
import {
  AI_JOBS_RETENTION_QUEUE,
  PROFILE_EXTRACTION_QUEUE,
  RESUME_GENERATE_QUEUE,
} from "../queue/queue.constants";

@Module({
  imports: [
    // forwardRef: ChatService also depends on ProfilesService (auto-trigger
    // extraction on the readiness flip), so the two modules reference each other.
    forwardRef(() => ChatModule), // for ChatRepository (transcript)
    AuthModule, // WorkerAuthGuard + ConsentGuard for the worker AI routes (inv. 4/6)
    BullModule.registerQueue({ name: PROFILE_EXTRACTION_QUEUE }),
    // Auto-enqueue a resume render once a profile is confirmed (TD5).
    BullModule.registerQueue({ name: RESUME_GENERATE_QUEUE }),
    // PERF-3 — the ai_jobs retention sweep queue (repeatable tick; the prune
    // predicate is authoritative; dry-run by default). Lives here because this
    // module owns ai_jobs data access (AiJobsRepository).
    BullModule.registerQueue({ name: AI_JOBS_RETENTION_QUEUE }),
  ],
  controllers: [ProfilesController, AiJobsController],
  providers: [
    ProfilesService,
    ProfilesRepository,
    AiJobsRepository,
    ProfileExtractionProcessor,
    AiJobsRetentionSweepProcessor,
  ],
  exports: [ProfilesRepository, ProfilesService],
})
export class ProfilesModule {}
