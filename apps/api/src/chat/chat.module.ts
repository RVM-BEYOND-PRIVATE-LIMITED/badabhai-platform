import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { ChatRepository } from "./chat.repository";

@Module({
  // forwardRef: ChatService auto-triggers extraction via ProfilesService, while
  // ProfilesModule imports ChatModule for ChatRepository — a genuine cycle.
  // AuthModule supplies WorkerAuthGuard + ConsentGuard (and their deps) for the
  // worker-authenticated, consent-gated routes (invariants 4/6).
  imports: [forwardRef(() => ProfilesModule), AuthModule],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository],
  exports: [ChatRepository],
})
export class ChatModule {}
