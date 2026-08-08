import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { IdentifyService } from "./identify.service";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";
import { ProfilingModule } from "./profiling.module";

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
 * THE "BUILT DARK" ASSERTION IS GONE, DELIBERATELY. It was Phase 5's safety property — an
 * unexercised engine must not be reachable by a real worker — and Phase 8 is the change that
 * deliberately makes it reachable. It is replaced below by the assertion that still holds: this
 * module has no HTTP surface of its own, because the worker's turn arrives at `ChatController`'s
 * route, behind `ChatController`'s guards.
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
  });

  it("provides the repository, the registry, identification and the orchestrator", () => {
    expect(getMeta("providers", ProfilingModule)).toEqual([
      PackRepository,
      PackRegistryService,
      IdentifyService,
      ProfilingOrchestrator,
    ]);
  });

  it("declares NO controller — the turn arrives through ChatController's guarded route", () => {
    // A route here would be a SECOND way into the interview, with its own auth and its own
    // ownership check to get wrong. The security spine did not move in the cutover: one route,
    // one `@CurrentWorker`, one 404-not-403 ownership test.
    expect(getMeta("controllers", ProfilingModule)).toEqual([]);
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
