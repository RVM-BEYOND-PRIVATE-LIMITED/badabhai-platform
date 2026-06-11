import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ChatModule } from "../chat/chat.module";
import { AiJobsRepository } from "../profiles/ai-jobs.repository";
import { VOICE_TRANSCRIPTION_QUEUE } from "../queue/queue.constants";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";
import { VoiceRepository } from "./voice.repository";
import { VoiceTranscriptionProcessor } from "./voice-transcription.processor";

@Module({
  imports: [
    ChatModule, // for ChatRepository (session lookup)
    BullModule.registerQueue({ name: VOICE_TRANSCRIPTION_QUEUE }),
  ],
  controllers: [VoiceController],
  // AiJobsRepository depends only on DATABASE (a global module), so providing it
  // here is decoupled; AiService comes from the @Global() AiModule.
  providers: [VoiceService, VoiceRepository, AiJobsRepository, VoiceTranscriptionProcessor],
})
export class VoiceModule {}
