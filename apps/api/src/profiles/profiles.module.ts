import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import { AiJobsController } from "./ai-jobs.controller";

@Module({
  imports: [ChatModule], // for ChatRepository (transcript)
  controllers: [ProfilesController, AiJobsController],
  providers: [ProfilesService, ProfilesRepository, AiJobsRepository],
  exports: [ProfilesRepository],
})
export class ProfilesModule {}
