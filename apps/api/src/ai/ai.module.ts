import { Global, Module } from "@nestjs/common";
import { AiCostRecorder } from "./ai-cost-recorder.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";
import { AiService } from "./ai.service";

/**
 * Global AI client module — chat/profiles/resume all depend on it.
 *
 * `AiCostTotalsRepository` is provided but NOT exported: the running totals have exactly one
 * writer (`AiCostRecorder`), and the whole guarantee — that a total moves only in the same
 * commit as the event it is derived from — rests on there being no second one. A reader for
 * the admin dashboard belongs in the admin module, over its own read-only repository.
 *
 * NO NEW IMPORT EDGE. `DatabaseModule` and `EventsModule` are both `@Global`, so this module's
 * graph is unchanged and the app's boot order is not affected.
 */
@Global()
@Module({
  providers: [AiService, AiCostRecorder, AiCostTotalsRepository],
  exports: [AiService, AiCostRecorder],
})
export class AiModule {}
