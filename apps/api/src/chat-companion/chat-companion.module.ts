import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ConsentModule } from "../consent/consent.module";
import { JobsModule } from "../jobs/jobs.module";
import { ResumeModule } from "../resume/resume.module";
import { COMPANION_HISTORY_SWEEP_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
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
import { FreeChatModelCalls } from "../profiling/free-chat/free-chat-model-calls";
import { FreeChatNewsCap } from "../profiling/free-chat/free-chat-news-cap.store";
import { FreeChatSummaryReader } from "../profiling/free-chat/free-chat-summary.reader";
import { FreeChatFoldLock } from "../profiling/free-chat/free-chat-fold.lock";
import { WorkerNameReader } from "../workers/worker-name-sources";
import { ChatCompanionController } from "./chat-companion.controller";
import { CompanionResumeStatus } from "./companion-resume-status";
import { CompanionBrain } from "./v2/companion-brain";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { ChatCompanionRepository } from "./chat-companion.repository";
import { ChatCompanionService } from "./chat-companion.service";
import { EmployersModule } from "../employers/employers.module";
import { CompanionMemoryStore } from "./v2/companion-memory.store";
import { CompanionConversationMemory } from "./v2/companion-conversation-memory";
import { CompanionSummaryService } from "./v2/companion-summary.service";
import { CompanionHistoryRepository } from "./companion-history.repository";
import { CompanionHistoryService } from "./companion-history.service";
import { CompanionHistorySweepProcessor } from "./companion-history-sweep.processor";
import { EditProposalStore } from "./v2/edit-proposal.store";
import { FaltuStore } from "./v2/faltu.store";
import { PendingIntentStore } from "./v2/pending-intent.store";
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
 *
 * ADR-0055 — WHY THE FREE CHAT'S MODEL CALLS ARE PROVIDED HERE TOO. The Bada Bhai chat runs the
 * profiling free chat's brain. `FreeChatService` cannot come with it: it writes the profiling chat's
 * session row through `ChatRepository`, and `ProfilingModule` imports `ChatModule` — either would
 * give this leaf the route to a chat writer the boot egress test forbids. So the model calls were
 * split into `FreeChatModelCalls` (AI client, cost recorder, news cap — no chat table), and this
 * module provisions its OWN instance of it and of `FreeChatNewsCap`, the section-writer precedent
 * above. Their dependencies are @Global (`AiModule`) or registered here (the render queue the news
 * cap borrows its Redis connection from): two providers, and no module edge. The cap's Redis key is
 * the worker's, so the profiling chat and this one share one daily news allowance.
 *
 * ADR-0055 — THE ONE READ OF THE WORKERS ROW, AND WHAT IT IS FOR. `WorkerNameReader` reads
 * `workers.full_name` (that column alone) and decrypts it through the @Global PII crypto service,
 * solely so the free-chat brain can REMOVE the worker's own name from its model inputs — the
 * profiling chat's own-name redaction, with `ChatService`'s exact semantics (one shared definition,
 * `workerNameSources`). ADR-0044 R8 ("never reads the workers row") is NARROWED to exactly this: the
 * name is never shown, logged, evented or stored here. The reader lives under `workers/`, so no file
 * in this module imports the crypto service (the egress guard still holds); its dependencies are
 * @Global (`WorkersModule`, `CryptoModule`): one provider, and no module edge.
 *
 * ADR-0055 R4 — THE ONE READ OF A CHAT TABLE. `FreeChatSummaryReader` runs one SELECT on
 * `chat_sessions` (the profiling chat's rolling summary, read-only, for the brain's reply) on the
 * @Global database handle. It shares its query with `ChatRepository` through a leaf file and never
 * touches that class, so no chat-table WRITER is reachable from here: one provider, no module edge.
 *
 * #2297 (ADR-0056) — THE BADA BHAI CHAT'S OWN CONVERSATION. `companion_messages` and
 * `companion_conversation_summaries` (migration 0135) are this module's own tables, read and
 * written only through `CompanionHistoryRepository` on the @Global database handle — never a chat
 * table. The rolling summary's fold borrows the free chat's lock (`FreeChatFoldLock`, on the
 * render queue's Redis connection already registered here) under its own per-worker key, and the
 * daily retention sweep runs on its own queue.
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
    // #2297 — the daily retention sweep of the stored conversation.
    BullModule.registerQueue({ name: COMPANION_HISTORY_SWEEP_QUEUE }),
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
    // TD146/WP6 — the one-shot pending intent a task-chip tap leaves for the next message.
    PendingIntentStore,
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
    // ADR-0055 — the free-chat brain, the free chat's model calls and news cap (see the module
    // docblock for why they are provisioned here), and the résumé read behind the download answer.
    CompanionBrain,
    FreeChatModelCalls,
    FreeChatNewsCap,
    CompanionResumeStatus,
    // ADR-0055 — the worker's own name, read only to redact it from the brain's model inputs.
    WorkerNameReader,
    // ADR-0055 R4 — the profiling chat's rolling summary, READ-ONLY, for the brain's reply alone:
    // one SELECT on the @Global database handle, no ChatRepository, so no chat-table writer.
    FreeChatSummaryReader,
    // #2297 (ADR-0056) — the stored 7-day conversation, the recent turns read from it (Redis as the
    // fallback), the rolling summary folded from it (under the free chat's lock, per worker) and
    // the daily retention sweep.
    CompanionHistoryRepository,
    CompanionHistoryService,
    CompanionConversationMemory,
    CompanionSummaryService,
    FreeChatFoldLock,
    CompanionHistorySweepProcessor,
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
