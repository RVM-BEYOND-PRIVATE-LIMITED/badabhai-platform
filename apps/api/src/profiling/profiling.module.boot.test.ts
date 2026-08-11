import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { IdentifyService } from "./identify.service";
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
      ProfilingOrchestrator,
      ProfilingSessionService,
      ProfilingVoiceRepository,
    ]);
  });

  it("DECLARES the voice-form controller — the assertion that used to say the opposite", () => {
    // Phase 5 asserted `controllers === []`, because an unexercised engine must not be reachable
    // by a real worker. The voice form is the change that deliberately makes it reachable, so the
    // property is inverted rather than dropped.
    expect(getMeta("controllers", ProfilingModule)).toEqual([ProfilingController]);
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
