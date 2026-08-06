import { Module } from "@nestjs/common";

import { ChatModule } from "../chat/chat.module";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";

/**
 * The deterministic profiling engine (OIE Phase 5).
 *
 * NO CONTROLLER, and that is the point: this module is BUILT DARK. `ChatService.postMessage`
 * still runs the v1 model-driven path, unchanged, and nothing routes a live worker turn here yet.
 * Wiring it in is a separate change with its own rollback lever, so a defect in the engine cannot
 * reach a worker before the engine has been exercised.
 *
 * It imports `ChatModule` for `ChatTranscriptBuffer` rather than opening its own Redis client —
 * the envelope and the transcript are ONE key, so a second store would be a second thing to
 * expire and the two could disagree about whether an interview exists.
 *
 * `PackRepository` and `PackRegistryService` are exported because Phase 7's retrieval service
 * needs pack resolution too, and a second implementation of the fallback chain is exactly how the
 * engine and the matcher would come to disagree about which questions a worker was asked.
 */
@Module({
  imports: [ChatModule],
  providers: [PackRepository, PackRegistryService, ProfilingOrchestrator],
  exports: [PackRegistryService, ProfilingOrchestrator],
})
export class ProfilingModule {}
