import { Module, forwardRef } from "@nestjs/common";

import { AiModule } from "../ai/ai.module";
import { ChatModule } from "../chat/chat.module";
import { EventsModule } from "../events/events.module";
import { OccupationModule } from "../occupation/occupation.module";
import { IdentifyService } from "./identify.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";

/**
 * The deterministic profiling engine — LIVE as of the Phase 8 cutover.
 *
 * NO CONTROLLER, still, and for a better reason than "built dark": this module has no HTTP
 * surface of its own. The worker's turn arrives at `POST /chat/message`, which is
 * `ChatController`'s route and always was; `ChatService` now calls {@link ProfilingOrchestrator}
 * in-process where it used to call `AiService.profilingRespond`. One route, one auth guard, one
 * ownership check — the security spine did not move, only what happens behind it.
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
  ],
  providers: [PackRepository, PackRegistryService, IdentifyService, ProfilingOrchestrator],
  exports: [PackRegistryService, ProfilingOrchestrator],
})
export class ProfilingModule {}
