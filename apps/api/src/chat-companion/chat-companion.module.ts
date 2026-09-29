import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { JobsModule } from "../jobs/jobs.module";
import { ResumeModule } from "../resume/resume.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { ChatCompanionController } from "./chat-companion.controller";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { ChatCompanionRepository } from "./chat-companion.repository";
import { ChatCompanionService } from "./chat-companion.service";
import { CompanionMemoryStore } from "./v2/companion-memory.store";
import { EditProposalStore } from "./v2/edit-proposal.store";

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
  imports: [
    AuthModule,
    ResumeModule,
    JobsModule,
    // ADR-0046 T5 — the v2 stores need Redis and deliberately reuse BullMQ's existing
    // connection rather than opening a second client (`ResumeRateLimit` /
    // `AdminMfaSecretStore` precedent). Registering an existing queue name here only borrows
    // the connection: nothing in this module enqueues to it.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [ChatCompanionController],
  providers: [
    ChatCompanionService,
    ChatCompanionPolicy,
    ChatCompanionRepository,
    // ADR-0046 v2 — Redis-only stores (memory + the pending edit card). Both are inert until
    // the v2 flags are on and the orchestrator (T6) calls them.
    CompanionMemoryStore,
    EditProposalStore,
  ],
})
export class ChatCompanionModule {}
