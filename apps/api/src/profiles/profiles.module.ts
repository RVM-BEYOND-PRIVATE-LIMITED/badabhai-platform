import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";

@Module({
  imports: [ChatModule], // for ChatRepository (transcript)
  controllers: [ProfilesController],
  providers: [ProfilesService, ProfilesRepository, AiJobsRepository],
  exports: [ProfilesRepository],
})
export class ProfilesModule {}
