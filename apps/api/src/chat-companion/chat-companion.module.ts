import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { JobsModule } from "../jobs/jobs.module";
import { ResumeModule } from "../resume/resume.module";
import { ChatCompanionController } from "./chat-companion.controller";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { ChatCompanionRepository } from "./chat-companion.repository";
import { ChatCompanionService } from "./chat-companion.service";

/**
 * The post-completion Bada Bhai companion (ADR-0044). Ships INERT: `CHAT_COMPANION_ENABLED`
 * defaults off, and off answers every open with `{mode:"interview"}`.
 *
 * A LEAF MODULE ON PURPOSE. Nothing imports it but `AppModule`, so it cannot close a require
 * cycle; and it imports neither `ChatModule` nor `ProfilesModule`, so it has no route to the
 * chat's writers. What it reaches:
 *   - AuthModule — WorkerAuthGuard + ConsentGuard and their dependencies;
 *   - ResumeModule — `ResumeService.history()`, the Resume tab's own projection;
 *   - JobsModule — `JobsRepository`, the Jobs tab's own membership rule;
 *   - @Global: AppConfigModule, DatabaseModule, EventsModule, WorkersModule (WorkersRepository),
 *     MatchModule (WorkerSkillsRepository).
 */
@Module({
  imports: [AuthModule, ResumeModule, JobsModule],
  controllers: [ChatCompanionController],
  providers: [ChatCompanionService, ChatCompanionPolicy, ChatCompanionRepository],
})
export class ChatCompanionModule {}
