import { TradeFormController } from "./form/trade-form.controller";
import { ResumeImportController } from "./resume-import/resume-import.controller";
import { ResumeImportRepository } from "./resume-import/resume-import.repository";
import { ResumeImportService } from "./resume-import/resume-import.service";
import { ResumeParseService } from "./resume-import/resume-parse.service";
import { ResumeImportProcessor } from "./resume-import/resume-import.processor";
import { ResumeRouteService } from "./resume-import/resume-route.service";
import { ResumeSuggestionReader } from "./resume-import/resume-suggestion-reader";
import { TradeFormRepository } from "./form/trade-form.repository";
import { TradeFormService } from "./form/trade-form.service";
import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { IdentifyService } from "./identify.service";
import { LlmTurnService } from "./llm-turn.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackCacheService } from "./pack-cache.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";
import { ProfilingController } from "./profiling.controller";
import { ProfilingSessionService } from "./profiling-session.service";
import { ProfilingVoiceRepository } from "./profiling-voice.repository";
import { ProfilingModule } from "./profiling.module";
import { AppModule } from "../app.module";

/**
 * DI WIRING GUARD.
 *
 * `ProfilingOrchestrator` injects `ChatTranscriptBuffer` (from `ChatModule`) and
 * `IdentifyService`, which in turn injects `OccupationService`, `EventsService` and `AiService`.
 * Every one of those resolves at BOOT and not before, so nothing else in this directory would
 * catch a missing import — each test here constructs its subject by hand.
 *
 * ASSERTED ON `@Module` METADATA, NOT BY BOOTING. This repo's vitest does not emit
 * `design:paramtypes`, so a `Test.createTestingModule` here would resolve constructor
 * dependencies as `undefined` and pass regardless. The E2E boot job is what actually proves the
 * graph resolves; this file proves the declarations exist.
 *
 * THE "BUILT DARK" ASSERTION IS INVERTED, NOT DELETED — and the inversion comes with a POSITIVE
 * assertion that this module is in `AppModule.imports`. That pairing is the whole point. The
 * engine spent months in this repository reachable from nothing, guarded by a test that asserted
 * `controllers === []` and was satisfied. Dropping that negative without gaining a positive would
 * leave the same hole with no test at all: a controller declared on a module the application
 * never imports serves nothing, and every unit test in this directory would still be green.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

/** `forwardRef()` yields `{ forwardRef: () => Module }`; unwrap so imports can be compared. */
const resolveImports = (target: unknown): unknown[] =>
  getMeta("imports", target).map((entry) => {
    const ref = entry as { forwardRef?: () => unknown };
    return typeof ref?.forwardRef === "function" ? ref.forwardRef() : entry;
  });

describe("ProfilingModule wiring", () => {
  it("imports the four modules its providers inject from", async () => {
    const imports = resolveImports(ProfilingModule);
    const names = imports.map((m) => (m as { name?: string })?.name);
    // ChatModule -> ChatTranscriptBuffer, the ONE Redis key the envelope shares with the
    // transcript. OccupationModule -> the retrieval ladder, called in-process. EventsModule ->
    // the two occupation events. AiModule -> the pseudonymization gateway, and nothing else.
    expect(names).toContain("ChatModule");
    expect(names).toContain("OccupationModule");
    expect(names).toContain("EventsModule");
    expect(names).toContain("AiModule");
    // The synchronous transcription leg. One-way: VoiceModule does not import this one.
    expect(names).toContain("VoiceModule");
  });

  it("imports AuthModule, which is where its routes' two guards come from", () => {
    // A controller whose guards cannot resolve does not fail closed — it fails to BOOT, which is
    // the good case. This asserts the declaration so the failure is caught here rather than by
    // the E2E boot job.
    expect(resolveImports(ProfilingModule).map((m) => (m as { name?: string })?.name)).toContain(
      "AuthModule",
    );
  });

  it("provides the repository, the registry, identification, the orchestrator and the seam", () => {
    expect(getMeta("providers", ProfilingModule)).toEqual([
      PackRepository,
      // The shared (Redis) tier behind the registry. Listed here rather than left implicit
      // because `PackRegistryService` takes it as a CONSTRUCTOR dependency: omitting the provider
      // does not fail a metadata test, it fails BOOT — the same class of defect this file's
      // header comment on `PackRegistryService` already documents for value-vs-type imports.
      PackCacheService,
      PackRegistryService,
      IdentifyService,
      // The LLM-led opening. A CONSTRUCTOR dependency of the orchestrator, so omitting it here
      // does not fail a metadata test — it fails BOOT, exactly as `PackCacheService` above.
      LlmTurnService,
      ProfilingOrchestrator,
      ProfilingSessionService,
      ProfilingVoiceRepository,
      // The trade form. Both are CONSTRUCTOR dependencies of `TradeFormService`, so omitting
      // either does not fail a metadata test — it fails BOOT, exactly as `PackCacheService`
      // and `LlmTurnService` above.
      TradeFormRepository,
      TradeFormService,
      // ADR-0041 RI-1 — the upload seam. `ResumeImportService` takes `StorageService` as a
      // CONSTRUCTOR dependency, so a missing `StorageModule` import does not fail a metadata
      // test either — it fails BOOT, which is the whole reason this list is pinned.
      ResumeImportRepository,
      ResumeImportService,
      // ADR-0041 RI-3 — the parse leg. `ResumeParseService` takes `AiService`,
      // `AiCostRecorder` and `EventsService` as CONSTRUCTOR dependencies, so this entry is
      // pinned here for the same reason as the two above: a missing module import is
      // invisible to a metadata test and fails BOOT. One new module edge has already made
      // this app fail to boot while typecheck, lint and every unit test passed.
      ResumeParseService,
      // ADR-0041 RI-4 — the routing leg and the two things it needed wiring for. Same reason
      // again, and this list has now caught it once: `ResumeRouteService` takes
      // `PackRegistryService`, `OccupationService`, `PiiCryptoService` and `EventsService`,
      // `ResumeSuggestionReader` is a CONSTRUCTOR dependency of `TradeFormService` (so its
      // absence breaks the FORM, not the résumé feature), and `ResumeImportProcessor` is the
      // only thing that ever calls the parse at all — without it the queue fills and nothing
      // drains it, which no other test in this repository can see.
      ResumeRouteService,
      ResumeSuggestionReader,
      ResumeImportProcessor,
    ]);
  });

  it("DECLARES the voice-form controller — the assertion that used to say the opposite", () => {
    // Phase 5 asserted `controllers === []`, because an unexercised engine must not be reachable
    // by a real worker. The voice form is the change that deliberately makes it reachable, so the
    // property is inverted rather than dropped.
    // The trade form is the THIRD surface and the first that is not an interview: every
    // question known up front, answered in any order, resumable across sessions. Listed here
    // for the same reason the voice form is — a declared controller that AppModule does not
    // mount serves nothing, and the assertion below is the half that proves it does.
    // Résumé import is the FOURTH surface and a third kind again — an upload rather than an
    // interview or a form. It shares neither the turn machinery nor the answer table, and by
    // ruling D2 it cannot write an answer at all: a parsed value is a suggestion until the
    // worker confirms it, and confirming goes back through the trade form like any other answer.
    expect(getMeta("controllers", ProfilingModule)).toEqual([
      ProfilingController,
      TradeFormController,
      ResumeImportController,
    ]);
  });

  it("is imported by AppModule, which is what makes that controller serve anything", () => {
    // THE HALF THAT IS EASY TO FORGET. Inverting the negative above proves a route is DECLARED;
    // this proves the application actually mounts it. Without this, `ProfilingModule` could be
    // dropped from `AppModule.imports` tomorrow and every test in this file would still pass
    // while `POST /profiling/answer` 404'd for every worker.
    expect(resolveImports(AppModule)).toContain(ProfilingModule);
  });

  it("exports pack resolution, so the matcher cannot grow a second fallback chain", () => {
    // Two implementations of the chain is exactly how the engine and the matcher would come to
    // disagree about which questions a worker was asked.
    expect(getMeta("exports", ProfilingModule)).toContain(PackRegistryService);
  });

  it("exports the orchestrator, which is what ChatService now runs the turn through", () => {
    expect(getMeta("exports", ProfilingModule)).toContain(ProfilingOrchestrator);
  });
});
