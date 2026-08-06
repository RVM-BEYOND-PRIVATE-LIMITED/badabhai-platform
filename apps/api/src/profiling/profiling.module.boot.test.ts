import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { ChatModule } from "../chat/chat.module";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { PackRegistryService } from "./pack-registry.service";
import { PackRepository } from "./pack.repository";
import { ProfilingModule } from "./profiling.module";

/**
 * DI WIRING GUARD, plus the guard that keeps this module DARK.
 *
 * `ProfilingOrchestrator` injects `ChatTranscriptBuffer`, which only `ChatModule` provides. A
 * missing import resolves at BOOT and not before, so nothing else in the suite would catch it —
 * every test in this directory constructs the orchestrator by hand.
 *
 * The controller assertion is the more important one. Phase 5's objective is a state machine
 * "built dark"; the moment this module declares a controller, an unexercised engine is reachable
 * by a real worker. Wiring it in is a deliberate, separate change, and this is what makes
 * "deliberate" mechanical rather than remembered.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("ProfilingModule wiring", () => {
  it("imports ChatModule — the only provider of the transcript buffer it writes through", () => {
    expect(getMeta("imports", ProfilingModule)).toContain(ChatModule);
  });

  it("provides the repository, the registry and the orchestrator", () => {
    expect(getMeta("providers", ProfilingModule)).toEqual([
      PackRepository,
      PackRegistryService,
      ProfilingOrchestrator,
    ]);
  });

  it("declares NO controller — the engine is built dark and reaches no worker yet", () => {
    expect(getMeta("controllers", ProfilingModule)).toEqual([]);
  });

  it("exports pack resolution, so Phase 7 cannot grow a second fallback chain", () => {
    // Two implementations of the chain is exactly how the engine and the matcher would come to
    // disagree about which questions a worker was asked.
    expect(getMeta("exports", ProfilingModule)).toContain(PackRegistryService);
  });
});
