import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";

import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { EventsModule } from "../events/events.module";
import { OccupationModule } from "../occupation/occupation.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { VoiceModule } from "../voice/voice.module";
import { IdentifyService } from "./identify.service";
import { LlmTurnService } from "./llm-turn.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackCacheService } from "./pack-cache.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";
import { ProfilingController } from "./profiling.controller";
import { ProfilingSessionService } from "./profiling-session.service";
import { ProfilingVoiceRepository } from "./profiling-voice.repository";
import { TradeFormController } from "./form/trade-form.controller";
import { TradeFormRepository } from "./form/trade-form.repository";
import { TradeFormService } from "./form/trade-form.service";

/**
 * The deterministic profiling engine — LIVE as of the Phase 8 cutover, and now with a surface.
 *
 * IT HAS A CONTROLLER AT LAST, and the boot test that used to assert `controllers === []` is
 * inverted rather than deleted — plus a positive assertion that this module is in
 * `AppModule.imports`. Losing the negative without gaining the positive is exactly how this
 * engine came to be built dark the first time: a module nobody imported, asserted by a test that
 * was happy about it.
 *
 * TWO ENTRY POINTS, ONE INTERVIEW. `POST /chat/message` is `ChatController`'s route and always
 * was; `POST /profiling/answer` is the voice form's. Both reach `ChatService.runTurn`, so the
 * turn — ownership, the flush, the checkpoint, the replay cache — exists once. What differs is
 * only how a question is rendered onto the wire, which is the one thing that genuinely must
 * differ: a client whose worker cannot read the screen needs option keys and an `answer_type`
 * where chat needs chip labels.
 *
 * `forwardRef(() => ChatModule)`, and the cycle is real rather than accidental: `ChatModule`
 * needs the orchestrator to run a turn, and this module needs `ChatTranscriptBuffer` to load and
 * CAS the envelope. Opening a second Redis client here instead would make the envelope and the
 * transcript two keys with two TTLs, free to disagree about whether an interview exists.
 *
 * `OccupationModule` is what makes the interview about the worker's actual trade — the retrieval
 * ladder is called IN-PROCESS by {@link IdentifyService}, never over HTTP.
 *
 * `AiModule` USED TO BE HERE FOR EXACTLY ONE THING — the pseudonymization gateway on the
 * unresolved-phrase path — and the Phase 8 cutover's claim that "no LLM call happens anywhere in
 * this module" was true right up until {@link LlmTurnService}. It is now false BY DESIGN and
 * bounded by one flag: `CHAT_LLM_INTERVIEW_ENABLED` off means the deterministic engine runs
 * exactly as it did, with `AiService.llmTurn` never reached. The cutover's economics survive the
 * flag being off; they do not survive it being on, which is the trade the LLM-led phase makes
 * deliberately.
 *
 * `PackRepository` and `PackRegistryService` are exported because the occupation service resolves
 * packs too, and a second implementation of the fallback chain is exactly how the engine and the
 * matcher would come to disagree about which questions a worker was asked.
 */
@Module({
  imports: [
    forwardRef(() => ChatModule),
    forwardRef(() => OccupationModule),
    EventsModule,
    AiModule,
    // WorkerAuthGuard + ConsentGuard for the routes below — the same two, in the same order, as
    // every other worker-facing controller.
    AuthModule,
    // The synchronous ≤30s transcription leg. It exports `VoiceTranscriptionService` and
    // deliberately NOT `VoiceRepository` — the voice-notes table stays behind its own service.
    //
    // This edge CLOSES A TRIANGLE (voice → chat → profiling → voice), which is why
    // `VoiceModule` carries a `forwardRef` on its own `ChatModule` import. Adding this line
    // without that one does not fail a test — it fails BOOT, because module metadata is
    // evaluated at require time and every unit test here asserts metadata rather than a graph.
    forwardRef(() => VoiceModule),
    // The fourth trigger (#700): a correction that lands after the profile was built queues a
    // rebuild through `ProfilesService`. `forwardRef` because ProfilesModule reaches back here
    // through ChatModule, and because THIS is the edge that made the app fail to boot last time —
    // module metadata is evaluated at require time, and only `app.module.graph.test.ts` says so
    // in under a minute.
    forwardRef(() => ProfilesModule),
    // REGISTERED ONLY TO OBTAIN THE REDIS CLIENT — no second connection, and nothing here ever
    // enqueues. The identical idiom `RateLimitModule` uses, and the reason the module doc above
    // gives for not opening one: a second client would make the envelope and the transcript two
    // keys with two TTLs, free to disagree about whether an interview exists.
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  // THREE SURFACES, and the third is a different KIND of thing. Chat and the voice form are
  // interviews reaching one turn engine; the trade form is a form -- every question known up
  // front, answered in any order, resumable across sessions -- so it shares the pack, the
  // answer table and the question shape, and shares no turn machinery at all.
  controllers: [ProfilingController, TradeFormController],
  providers: [
    PackRepository,
    PackCacheService,
    PackRegistryService,
    IdentifyService,
    LlmTurnService,
    ProfilingOrchestrator,
    ProfilingSessionService,
    ProfilingVoiceRepository,
    TradeFormRepository,
    TradeFormService,
  ],
  exports: [PackRegistryService, ProfilingOrchestrator],
})
export class ProfilingModule {}
