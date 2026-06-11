import { Module, forwardRef } from "@nestjs/common";
import { ProfilesModule } from "../profiles/profiles.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { ChatRepository } from "./chat.repository";

@Module({
  // forwardRef: ChatService auto-triggers extraction via ProfilesService, while
  // ProfilesModule imports ChatModule for ChatRepository — a genuine cycle.
  imports: [forwardRef(() => ProfilesModule)],
  controllers: [ChatController],
  providers: [ChatService, ChatRepository],
  exports: [ChatRepository],
})
export class ChatModule {}
