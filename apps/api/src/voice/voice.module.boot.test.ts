import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { VoiceController } from "./voice.controller";
import { VoiceModule } from "./voice.module";
import { VoiceRepository } from "./voice.repository";
import { VoiceService } from "./voice.service";
import { VoiceTranscriptionProcessor } from "./voice-transcription.processor";
import { VoiceTranscriptionService } from "./voice-transcription.service";

/**
 * DI WIRING GUARD for the voice layer (V4b).
 *
 * ASSERTED ON `@Module` METADATA, NOT BY BOOTING — this repo's vitest does not emit
 * `design:paramtypes`, so `Test.createTestingModule` would resolve constructor dependencies as
 * `undefined` and pass regardless. The E2E boot job proves the graph resolves; this file proves
 * the declarations exist.
 *
 * WHY THIS FILE IS NEW. The module had NO `exports` block at all, and nothing noticed, because
 * nothing outside it had yet needed the voice layer. The moment the sync ≤30s answer path lands
 * it will — and a silently dropped `exports` line would surface then as an unresolvable
 * dependency at boot, in a different PR, far from the change that caused it.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("VoiceModule wiring", () => {
  it("provides the transcription SERVICE alongside its queue adapter", () => {
    const providers = getMeta("providers", VoiceModule);
    expect(providers).toContain(VoiceTranscriptionService);
    expect(providers).toContain(VoiceTranscriptionProcessor);
  });

  it("EXPORTS the transcription service — the point of extracting it", () => {
    // CLAUDE.md §4 moved the logic out of the queue handler; this is what makes that useful
    // rather than cosmetic. Without it a second caller can only fabricate a `Job` or fork the
    // code, and a fork would drift on the two things that matter most: which results count as
    // degraded, and what "we already paid for this audio" means.
    expect(getMeta("exports", VoiceModule)).toContain(VoiceTranscriptionService);
  });

  it("exports VoiceService too, so a caller can mint/read through the guarded seam", () => {
    expect(getMeta("exports", VoiceModule)).toContain(VoiceService);
  });

  it("does NOT export the repository — raw row access stays inside the module", () => {
    // The transcript-persistence rules (never into events, never into ai_jobs) live in the
    // service. A caller holding the repository could write a transcript anywhere and bypass
    // them without touching a single line of reviewed code.
    expect(getMeta("exports", VoiceModule)).not.toContain(VoiceRepository);
  });

  it("keeps its own controller — the extraction moved logic, not routes", () => {
    expect(getMeta("controllers", VoiceModule)).toEqual([VoiceController]);
  });
});
