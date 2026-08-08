import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { StorageModule } from "../storage/storage.module";
import { AiJobsRepository } from "../profiles/ai-jobs.repository";
import { VOICE_TRANSCRIPTION_QUEUE } from "../queue/queue.constants";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";
import { VoiceRepository } from "./voice.repository";
import { VoiceTranscriptionService } from "./voice-transcription.service";
import { VoiceTranscriptionProcessor } from "./voice-transcription.processor";

@Module({
  imports: [
    // forwardRef, AND IT IS LOAD-ORDER RATHER THAN INJECTION. The cycle is a triangle and every
    // edge of it is real: this module needs `ChatRepository` to look a session up, `ChatModule`
    // needs `ProfilingOrchestrator` to run a turn, and `ProfilingModule` needs
    // `VoiceTranscriptionService` for the voice form's synchronous answer leg. Without the
    // forwardRef this file is EVALUATED while `chat.module.ts` is still mid-evaluation, so
    // `ChatModule` is literally `undefined` in this array and Nest refuses to build the graph —
    // `UndefinedModuleException`, at boot, on every environment.
    forwardRef(() => ChatModule), // for ChatRepository (session lookup)
    AuthModule, // WorkerAuthGuard + ConsentGuard for the worker AI routes (inv. 4/6)
    StorageModule, // signed upload URLs into the private voice-notes bucket
    BullModule.registerQueue({ name: VOICE_TRANSCRIPTION_QUEUE }),
  ],
  controllers: [VoiceController],
  // AiJobsRepository depends only on DATABASE (a global module), so providing it
  // here is decoupled; AiService comes from the @Global() AiModule.
  providers: [
    VoiceService,
    VoiceRepository,
    AiJobsRepository,
    VoiceTranscriptionService,
    VoiceTranscriptionProcessor,
  ],
  // THE MODULE HAD NO `exports` AT ALL, so every provider above was private to it and no other
  // module could reach the voice layer even to read a transcript. That was fine while the only
  // consumer was this module's own controller and queue; it stops being fine the moment a second
  // surface needs the SAME transcription sequence rather than a copy of it.
  //
  // Deliberately narrow: the two collaborators another module would legitimately need.
  // `VoiceRepository` stays private — a caller reaching past the service into raw row writes is
  // how the transcript-persistence rules (never in events, never in jobs) get bypassed.
  exports: [VoiceService, VoiceTranscriptionService],
})
export class VoiceModule {}
