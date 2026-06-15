import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { StorageModule } from "../storage/storage.module";
import {
  RESUME_GENERATE_QUEUE,
  RESUME_RENDER_QUEUE,
} from "../queue/queue.constants";
import { ResumeController } from "./resume.controller";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";
import { ResumeRenderer } from "./resume-renderer.service";
import { ResumeRateLimit } from "./resume-rate-limit.service";
import { ResumeGenerateProcessor } from "./resume-generate.processor";
import { ResumeRenderProcessor } from "./resume-render.processor";

/**
 * Resume generation + async PDF render (TD5).
 *
 * EventsService (EventsModule), AiService (AiModule), WorkersRepository
 * (WorkersModule) and PiiCryptoService (CryptoModule) are all @Global, so only
 * ProfilesModule (ProfilesRepository) and StorageModule are imported here. Both
 * the generate and render queues are registered so the producers (this service /
 * ProfilesService) and the in-process processors agree on the names.
 */
@Module({
  imports: [
    AuthModule, // for WorkerAuthGuard (worker-authenticated PDF download)
    ProfilesModule, // for ProfilesRepository
    StorageModule, // for StorageService (signed URLs + PDF upload)
    BullModule.registerQueue({ name: RESUME_GENERATE_QUEUE }),
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [ResumeController],
  providers: [
    ResumeService,
    ResumeRepository,
    ResumeRenderer,
    ResumeRateLimit,
    ResumeGenerateProcessor,
    ResumeRenderProcessor,
  ],
})
export class ResumeModule {}
