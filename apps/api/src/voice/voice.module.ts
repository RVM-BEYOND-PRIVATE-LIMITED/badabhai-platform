import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";
import { VoiceRepository } from "./voice.repository";

@Module({
  imports: [ChatModule], // for ChatRepository (session lookup)
  controllers: [VoiceController],
  providers: [VoiceService, VoiceRepository],
})
export class VoiceModule {}
