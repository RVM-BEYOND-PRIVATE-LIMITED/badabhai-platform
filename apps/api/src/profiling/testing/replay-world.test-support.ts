import { vi } from "vitest";
import type { QuestionPack } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import { narrowProfilingEnvelope, type ProfilingEnvelope } from "../conversation-state";
import { packFromCorpus } from "../form/corpus-pack.test-support";
import { LlmTurnService } from "../llm-turn.service";
import { ProfilingOrchestrator } from "../orchestrator.service";

/**
 * A REAL turn-loop world for #1505's replay tests — `ProfilingOrchestrator` and `LlmTurnService`
 * exactly as production wires them, over the REAL `qp_universal@2` corpus, with only the network
 * boundary (`AiService.llmTurn`) and the two read-only collaborators no test in this directory
 * needs to exercise (`IdentifyService`, `ResumeSuggestionReader`) stubbed.
 *
 * WHY REAL `LlmTurnService` RATHER THAN A STUB (unlike `llm-interview.orchestrator.test.ts`,
 * which replaces the whole service with `opts.take`). #1505 F5's guard
 * (`classifyLlmReply`/`llm-reply-guard.ts`) lives INSIDE `LlmTurnService.take`'s final ask
 * branch — a suite that stubs the service past that branch would be asserting nothing about the
 * guard at all. `AiService.llmTurn` is the one HTTP seam this class owns, and scripting ITS
 * output is what keeps the model itself out of the test while everything downstream of it —
 * caps, the gate, the guard, cross-fill, settlement — runs for real.
 *
 * REUSES `corpus-pack.test-support.ts` (PR-1) FOR THE PACK, rather than a second hand-built
 * fixture: `#1503`'s whole defect was two forms disagreeing about the SAME corpus, and a
 * hand-rolled pack here could silently drift from what `qp_universal@2` actually asks.
 */

export const SESSION = "22222222-2222-4222-8222-222222222222";
export const WORKER = "11111111-1111-4111-8111-111111111111";
export const T0 = new Date("2026-08-06T10:00:00.000Z");

/** Every `LlmTurnOutputSchema` field a scripted step needs, defaulted to an inert ask. */
export function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reply_text: "Aur kuch bataiye.",
    stage: "domain",
    input_mode: "text",
    suggested_answers: [],
    domain_label: null,
    role_label: null,
    skills: [],
    experience_entry: null,
    phase_a_done: false,
    blocked: false,
    blocked_reason: null,
    is_mock: false,
    ai_metadata: null,
    ...over,
  };
}

export interface ReplayWorldOptions {
  /** `AiService.llmTurn` outputs, ONE PER CALL, in order — `undefined` reads as a dead network. */
  readonly turns?: readonly (Record<string, unknown> | null)[];
  readonly enabled?: boolean;
  /** Defaults to the real `qp_universal@2` — every fixture's PACK_QUESTION_KEYs come from it. */
  readonly universal?: QuestionPack;
  readonly resumeSuggestions?: {
    pendingForChat: (workerId: string) => Promise<unknown>;
    forImport: (workerId: string, importId: string) => Promise<unknown>;
  };
  /** #1504 item 5 (city-seed). Defaults to a stub that never finds a city. */
  readonly workers?: {
    findCurrentCity: (workerId: string) => Promise<string | null>;
  };
}

export function buildReplayWorld(opts: ReplayWorldOptions = {}) {
  const store = new Map<string, TranscriptBuffer>();

  const buffer = {
    // THROUGH THE REAL NARROWER, exactly as `ChatTranscriptBuffer.load` does — see
    // `llm-interview.orchestrator.test.ts`'s identical note on why.
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      const current = store.get(id)?.profiling?.rev ?? 0;
      if (current !== expectedRev) return false;
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
  };

  const universal = opts.universal ?? packFromCorpus("qp_universal@2");
  const registry = {
    loadUniversal: vi.fn(async () => universal),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const identify = {
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };

  // ONE QUEUE, CONSUMED IN ORDER — a call past the end returns `null`, the same "the model is
  // unreachable" shape `AiService.llmTurn` returns on a real transport failure, so a fixture that
  // under-scripts its turns degrades exactly like production rather than throwing a test-only
  // error.
  const queue = [...(opts.turns ?? [])];
  const ai = { llmTurn: vi.fn(async (_input: unknown, _ctx?: unknown) => queue.shift() ?? null) };
  const config = { CHAT_LLM_INTERVIEW_ENABLED: opts.enabled ?? true };
  const cost = { record: vi.fn(async () => undefined) };
  const traces = { capture: vi.fn(async () => undefined) };

  const llm = new LlmTurnService(ai as never, config as never, cost as never, traces as never);

  const resumeSuggestions = opts.resumeSuggestions ?? {
    pendingForChat: async () => null,
    forImport: async () => new Map(),
  };

  // #1504 item 5 (city-seed, merged after this file was written): the orchestrator now takes a
  // read-only WorkersRepository to seed current_city from /name. No replay fixture in this file
  // exercises seeding (they all construct sessions mid-flight, not fresh), so a stub that never
  // finds a city — the orchestrator's own documented fail-open path — is the correct default.
  const workers = opts.workers ?? { findCurrentCity: vi.fn(async () => null) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm,
    resumeSuggestions as never,
    workers as never,
  );

  return { orchestrator, store, ai, llm, events, identify, universal };
}

/** One turn's input, everything but the worker's words defaulted. */
export function turnInput(text: string, now: Date = T0): {
  sessionId: string;
  workerId: string;
  text: string;
  now: Date;
  submissionId: string | null;
  voiceNoteId: string | null;
  ctx: { requestId: string; correlationId: string };
} {
  return {
    sessionId: SESSION,
    workerId: WORKER,
    text,
    now,
    submissionId: null,
    voiceNoteId: null,
    ctx: { requestId: "req_1", correlationId: "corr_1" },
  };
}
