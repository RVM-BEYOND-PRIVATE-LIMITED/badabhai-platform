import { Global, Module } from "@nestjs/common";
import { AiCostRecorder } from "./ai-cost-recorder.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";
import { AiTraceRecorder } from "./ai-trace-recorder.service";
import { AiTracesRepository } from "./ai-traces.repository";
import { AiAlertsRepository } from "./ai-alerts.repository";
import { AiAlertsService } from "./ai-alerts.service";
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
 * B13 (#2567) follows the same split for the loud-AI-alert feature: `AiAlertsRepository`
 * is SELECT-ONLY over the spine (like the admin spine reader, but outside admin/** so the
 * single-reader build-blocker still holds and `GET /health` can use it unauthenticated);
 * `AiAlertsService` composes it with `EventsService` for the raised/cleared verdicts and is
 * EXPORTED so the admin endpoint and health can read through it. `AiCostRecorder` drives
 * evaluation after every recorded cost (debounced, never throwing).
 *
 * NO NEW IMPORT EDGE. `DatabaseModule` and `EventsModule` are both `@Global`, and
 * `PiiCryptoService` (CryptoModule), `SERVER_CONFIG` (AppConfigModule) and
 * `EmailNotificationService` (EmailNotificationModule) are too, so this module's graph is
 * unchanged and the app's boot order is not affected.
 */
@Global()
@Module({
  providers: [
    AiService,
    AiCostRecorder,
    AiCostTotalsRepository,
    AiTraceRecorder,
    AiTracesRepository,
    AiAlertsRepository,
    AiAlertsService,
  ],
  exports: [AiService, AiCostRecorder, AiTraceRecorder, AiAlertsService],
})
export class AiModule {}
