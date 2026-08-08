import { Module, forwardRef } from "@nestjs/common";

import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { EventsModule } from "../events/events.module";
import { OccupationModule } from "../occupation/occupation.module";
import { IdentifyService } from "./identify.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";
import { ProfilingController } from "./profiling.controller";
import { ProfilingSessionService } from "./profiling-session.service";

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
 * ladder is called IN-PROCESS by {@link IdentifyService}, never over HTTP. `AiModule` is here for
 * exactly one thing, the pseudonymization gateway on the unresolved-phrase path; no LLM call
 * happens anywhere in this module.
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
  ],
  controllers: [ProfilingController],
  providers: [
    PackRepository,
    PackRegistryService,
    IdentifyService,
    ProfilingOrchestrator,
    ProfilingSessionService,
  ],
  exports: [PackRegistryService, ProfilingOrchestrator],
})
export class ProfilingModule {}
