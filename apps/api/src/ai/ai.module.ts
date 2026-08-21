import { Global, Module } from "@nestjs/common";
import { AiCostRecorder } from "./ai-cost-recorder.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";
import { AiTraceRecorder } from "./ai-trace-recorder.service";
import { AiTracesRepository } from "./ai-traces.repository";
import { AiService } from "./ai.service";

/**
 * Global AI client module — chat/profiles/resume all depend on it.
 *
 * `AiCostTotalsRepository` is provided but NOT exported: the running totals have exactly one
 * writer (`AiCostRecorder`), and the whole guarantee — that a total moves only in the same
 * commit as the event it is derived from — rests on there being no second one. A reader for
 * the admin dashboard belongs in the admin module, over its own read-only repository.
 *
 * `AiTracesRepository` (migration 0083) follows that rule EXACTLY, and for a sharper reason.
 * `ai_call_traces` holds the prompt and the completion of every AI call; its one writer is
 * `AiTraceRecorder`, which is exported so the six provider call sites can reach it, while the
 * repository stays unexported so nothing else can insert, and — the part that matters —
 * nothing under `admin/**` can hold a class capable of writing to that table. The admin read
 * has its OWN select-only repository, the same split `FeedbackRepository` /
 * `AdminFeedbackRepository` already makes.
 *
 * NO NEW IMPORT EDGE. `DatabaseModule` and `EventsModule` are both `@Global`, and
 * `PiiCryptoService` (CryptoModule) is too, so this module's graph is unchanged and the app's
 * boot order is not affected.
 */
@Global()
@Module({
  providers: [AiService, AiCostRecorder, AiCostTotalsRepository, AiTraceRecorder, AiTracesRepository],
  exports: [AiService, AiCostRecorder, AiTraceRecorder],
})
export class AiModule {}
