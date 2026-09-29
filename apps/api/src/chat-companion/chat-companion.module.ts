import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { JobsModule } from "../jobs/jobs.module";
import { ResumeModule } from "../resume/resume.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { WorkerEmploymentRepository } from "../profiles/worker-employment.repository";
import { WorkerEmploymentService } from "../profiles/worker-employment.service";
import { WorkerLanguagesRepository } from "../profiles/worker-languages.repository";
import { WorkerLanguagesService } from "../profiles/worker-languages.service";
import { WorkerQualificationsRepository } from "../profiles/worker-qualifications.repository";
import { WorkerQualificationsService } from "../profiles/worker-qualifications.service";
import { WorkerOccupationsRepository } from "../profiles/worker-occupations.repository";
import { WorkerOccupationsService } from "../profiles/worker-occupations.service";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { WorkerPreferencesService } from "../profiles/worker-preferences.service";
import { ResumeImportRepository } from "../profiling/resume-import/resume-import.repository";
import { ResumeSuggestionReader } from "../profiling/resume-import/resume-suggestion-reader";
import { ChatCompanionController } from "./chat-companion.controller";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { ChatCompanionRepository } from "./chat-companion.repository";
import { ChatCompanionService } from "./chat-companion.service";
import { CompanionMemoryStore } from "./v2/companion-memory.store";
import { EditProposalStore } from "./v2/edit-proposal.store";
import { CompanionEditService } from "./v2/companion-edit.service";

/**
 * The post-completion Bada Bhai companion (ADR-0044). Ships INERT: `CHAT_COMPANION_ENABLED`
 * defaults off, and off answers every open with `{mode:"interview"}`.
 *
 * A LEAF MODULE ON PURPOSE. Nothing imports it but `AppModule`, so it cannot close a require
 * cycle; and it imports neither `ChatModule` nor `ProfilesModule`, so it has no route to the
 * chat's writers. What it reaches:
 *   - AuthModule — WorkerAuthGuard + ConsentGuard and their dependencies;
 *   - ResumeModule — `ResumeService.history()` and the ADR-0043 regeneration seam;
 *   - JobsModule — `JobsRepository`, the Jobs tab's own membership rule;
 *   - @Global: AppConfigModule, DatabaseModule, EventsModule, WorkersModule (WorkersRepository),
 *     MatchModule (WorkerSkillsRepository / WorkerSkillsService), AiModule (AiService),
 *     CryptoModule (PiiCryptoService).
 *
 * ADR-0046 T7 — WHY THE SECTION WRITERS ARE PROVIDED HERE. The edit card applies through the
 * SAME writers the forms use, and those writers live in `ProfilesModule`, which imports
 * `ChatModule` (forwardRef) for the transcript reader — importing it would give this leaf a
 * route to the chat module, which the boot egress test forbids. So this module provisions its
 * OWN instances of the five writers and the repositories they need (the `ProfilesModule`
 * precedent for repositories: "a second, independent instance of each", all their dependencies
 * @Global or registered above). Nothing here reaches a chat table, and the guard test asserts it.
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
    // ADR-0046 T7 — the edit path and the section writers it applies through (see the module
    // docblock for why they are provisioned here rather than imported).
    CompanionEditService,
    ProfilesRepository,
    WorkerEmploymentRepository,
    WorkerEmploymentService,
    WorkerLanguagesRepository,
    WorkerLanguagesService,
    WorkerQualificationsRepository,
    WorkerQualificationsService,
    WorkerOccupationsRepository,
    WorkerOccupationsService,
    WorkerAttributesRepository,
    WorkerPreferencesService,
    ResumeImportRepository,
    ResumeSuggestionReader,
  ],
})
export class ChatCompanionModule {}
