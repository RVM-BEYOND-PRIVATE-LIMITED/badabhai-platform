import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { PROFILE_EXTRACTION_QUEUE } from "../queue/queue.constants";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { ChatRepository } from "./chat.repository";
import { ChatTranscriptBuffer } from "./chat-transcript.buffer";

@Module({
  // forwardRef: ChatService auto-triggers extraction via ProfilesService, while
  // ProfilesModule imports ChatModule for ChatRepository — a genuine cycle.
  // AuthModule supplies WorkerAuthGuard + ConsentGuard (and their deps) for the
  // worker-authenticated, consent-gated routes (invariants 4/6).
  imports: [
    forwardRef(() => ProfilesModule),
    AuthModule,
    // NOT for producing jobs — ChatService enqueues extraction through
    // ProfilesService. This registration exists so ChatTranscriptBuffer can borrow the
    // queue's ioredis connection for the transcript buffer, which is the established
    // way to reach Redis here (ResumeRateLimit, SessionService, OtpService all do it)
    // and avoids opening a second client. The queue is the one the flush ends up
    // enqueueing onto anyway, so it is not a new dependency for this path.
    BullModule.registerQueue({ name: PROFILE_EXTRACTION_QUEUE }),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository, ChatTranscriptBuffer],
  // ChatTranscriptBuffer is exported for the EXTRACTION path only: mid-interview the
  // transcript has not been flushed, so `ProfileExtractionProcessor` must be able to
  // read the buffer or the app's "make the profile anyway" escape hatch extracts from
  // nothing. Not a general-purpose export — ChatService remains the only writer.
  exports: [ChatRepository, ChatTranscriptBuffer],
})
export class ChatModule {}
