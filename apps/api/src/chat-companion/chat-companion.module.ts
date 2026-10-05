import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ConsentModule } from "../consent/consent.module";
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
import { EmployersModule } from "../employers/employers.module";
import { CompanionMemoryStore } from "./v2/companion-memory.store";
import { EditProposalStore } from "./v2/edit-proposal.store";
import { FaltuStore } from "./v2/faltu.store";
import { CompanionTurnReplayStore } from "./v2/turn-replay.store";
import { CompanionEditService } from "./v2/companion-edit.service";
import { CompanionV2Orchestrator } from "./v2/companion-v2.orchestrator";
import { CompanionHandlerRegistry } from "./v2/handlers/registry";
import { CareerTalkHandler } from "./v2/handlers/career-talk.handler";
import { EditResumeHandler } from "./v2/handlers/edit-resume.handler";
import { FaltuHandler } from "./v2/handlers/faltu.handler";
import { NewResumeHandler } from "./v2/handlers/new-resume.handler";
import {
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./v2/handlers/fixed-line.handlers";

/**
 * The post-completion Bada Bhai companion (ADR-0044). Ships INERT: `CHAT_COMPANION_ENABLED`
 * defaults off, and off answers every open with `{mode:"interview"}`.
 *
 * A LEAF MODULE ON PURPOSE. Nothing imports it but `AppModule`, so it cannot close a require
 * cycle; and it imports neither `ChatModule` nor `ProfilesModule`, so it has no route to the
 * chat's writers. What it reaches:
 *   - AuthModule — WorkerAuthGuard + ConsentGuard and their dependencies;
 *   - ConsentModule — `ConsentRepository`, read (never written) by the P2 new-résumé handler's
 *     fail-closed `resume_generation` gate;
 *   - ResumeModule — `ResumeService.history()` and the ADR-0043 regeneration seam;
 *   - JobsModule — `JobsRepository`, the Jobs tab's own membership rule;
 *   - @Global: AppConfigModule, DatabaseModule, EventsModule, WorkersModule (WorkersRepository),
 *     MatchModule (WorkerSkillsRepository / WorkerSkillsService), AiModule (AiService),
 *     CryptoModule (the PII crypto service, reached only inside `employers/`).
 *   - EmployersModule — the TD147/WP7 employer-name index the career validator checks against.
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
    ConsentModule,
    ResumeModule,
    JobsModule,
    // TD147/WP7 — the employer-name index the career validator checks answers against. Its own
    // module because it decrypts employer ORG names through the PII crypto service, which this
    // leaf may not import (the egress boot test forbids that import under chat-companion/).
    EmployersModule,
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
    // ADR-0046 v2 — Redis-only stores (memory + the pending edit card + the P2 strikes and
    // cool-down + the served-turn replay that makes a retried message idempotent). All are
    // inert until the v2 flags are on and the pipeline calls them.
    CompanionMemoryStore,
    EditProposalStore,
    FaltuStore,
    CompanionTurnReplayStore,
    // ADR-0046 T6 — the v2 turn pipeline: the orchestrator, its intent→handler registry and the
    // Phase 1 handlers. Inert while CHAT_COMPANION_V2_ENABLED is off.
    CompanionV2Orchestrator,
    CompanionHandlerRegistry,
    EditResumeHandler,
    // ADR-0046 P2/P3 — the new-résumé handler (consent-gated redo flow), the faltu handler
    // (strikes, cool-down, the strike event) and the career handler (the one model-written
    // answer, behind its own flag).
    NewResumeHandler,
    FaltuHandler,
    CareerTalkHandler,
    JobsDeferredHandler,
    PhaseOffHandler,
    UnclearHandler,
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
