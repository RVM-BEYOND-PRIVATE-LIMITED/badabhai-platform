/**
 * The disambiguation offer and the type-your-trade prompt, under repeated non-answers — with the
 * REAL `IdentifyService`, not the no-op stub every other orchestrator suite uses (#1506 HIGH-1).
 *
 * WHY THIS FILE EXISTS SEPARATELY. `orchestrator.service.test.ts` and
 * `llm-interview.orchestrator.test.ts` both stub `identify` deliberately — "the turn machinery,
 * not retrieval" — and that is the right call for what THEY test. The bug this file guards
 * against lives in neither file alone: `identify.service.ts` decided when to re-serve an offer,
 * `orchestrator.service.ts` decided whether to trust that decision, and the loop was only visible
 * with BOTH real. A stubbed `identify` that always returns the same fixed offer cannot fail this
 * way — it has no state to get stuck in.
 *
 * THE BUG, MEASURED. Before this fix, `identify.service.ts`'s non-tap branch re-served a live
 * disambiguation offer or the type-your-trade prompt on every non-answer turn — silence, ".", a
 * hardship line, "pata nahi", an abusive message — with no bound. `nextQuestion` is the only place
 * `abuse_cap`, `ask_budget` and `turn_cap` are decided, and the re-serve returned before ever
 * reaching it. A worker who never typed an actual trade word saw the same chips forever.
 *
 * STUBBED AT THE AI BOUNDARY ONLY: `OccupationService.resolve/describeDomain/recordUnresolved`
 * and `AiService.pseudonymize`. `IdentifyService`, `ProfilingOrchestrator` and `nextQuestion` are
 * all real, wired exactly as `ProfilingModule` wires them.
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import { IdentifyService, MAX_IDENTIFY_ATTEMPTS, MAX_IDENTIFY_STALLED_TURNS } from "./identify.service";
import { MAX_ABUSIVE_TURNS } from "./next-question";
import { CLOSING_REPLY, ProfilingOrchestrator } from "./orchestrator.service";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-08-06T10:00:00.000Z");

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 1,
    family_id: "fam_welding",
    locale: "hi-IN",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

// ONE mandatory question is all this suite needs: the point is whether the interview EVER reaches
// it, not how long the tail is once it does.
const CITY = item({
  question_key: "q_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  is_mandatory: true,
});
const UNIVERSAL_PACK = pack("qp_universal", [CITY]);

/** Chips on screen: two real trades plus the escape, exactly as `IdentifyService.offer` builds one. */
const OFFER = [
  { label: "Welder", jobDomainId: "jd_welder", familyId: "fam_welding" },
  { label: "Fitter", jobDomainId: "jd_fitter", familyId: "fam_fitting" },
  { label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null },
];

/**
 * A world with the REAL `IdentifyService` wired in, retrieval stubbed at the boundary.
 *
 * `occupation.resolve` defaults to `unresolved` and is not expected to be called by either test
 * below: both seed `identifyAttempts` at the budget already spent, which is what an offer already
 * on screen means (the budget rule in `IdentifyService.identify`), so nothing in these turns runs
 * the ladder again. It is stubbed anyway so a future change that DOES reach it fails on an
 * assertion instead of a null-dereference.
 */
function makeWorld() {
  const store = new Map<string, TranscriptBuffer>();

  const buffer = {
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
  const registry = {
    loadUniversal: vi.fn(async () => UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };

  const occupation = {
    resolve: vi.fn(async () => ({
      status: "unresolved" as const,
      catalogVersion: "cat_2026_08",
      pinned: null,
      candidates: [],
      disambiguationOptions: [],
      needsDisambiguation: false,
      embedSpent: false,
      reason: "not expected to run in this suite",
    })),
    recordUnresolved: vi.fn(async () => ({ count: 1 })),
    describeDomain: vi.fn(() => null),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: "stub", blocked: false })),
  };
  // THE ONE SUBSTITUTION from `orchestrator.service.test.ts`'s `makeWorld`: a REAL service, not a
  // fixed-return mock, wired exactly as `ProfilingModule` wires it.
  const identify = new IdentifyService(occupation as never, events as never, ai as never);

  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const llm = { leads: () => false, take: vi.fn(async () => null) };
  const resumeSuggestions = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify,
    chat as never,
    events as never,
    llm as never,
    resumeSuggestions as never,
  );
  return { orchestrator, store, events, occupation };
}

/** Seed a session with the disambiguation offer already on screen — the budget already spent. */
function seedWithOffer(store: Map<string, TranscriptBuffer>, over: Partial<ProfilingEnvelope> = {}) {
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: {
      ...emptyProfilingEnvelope(),
      rev: 1,
      needsDisambiguation: true,
      disambiguationOffer: OFFER,
      identifyAttempts: MAX_IDENTIFY_ATTEMPTS,
      servedQuestionKey: null,
      ...over,
    },
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };
const say = (text: string, at: Date) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

describe("the disambiguation offer under repeated non-answers (#1506 HIGH-1)", () => {
  it("terminates well under MAX_ENGINE_TURNS instead of re-serving chips forever", async () => {
    const { orchestrator, store } = makeWorld();
    seedWithOffer(store);

    // A bound generous enough to prove nothing accidental terminates it, and nowhere near
    // MAX_ENGINE_TURNS (in the hundreds) — see `MAX_IDENTIFY_STALLED_TURNS`.
    const TURN_BUDGET = MAX_IDENTIFY_STALLED_TURNS + 5;
    let last;
    for (let i = 0; i < TURN_BUDGET; i++) {
      // ONE MINUTE APART — well past `STALE_RESPONSE_WINDOW_MS` (30 s) — so byte-identical text
      // is never absorbed by the reply-replay cache and each iteration is a REAL turn. A tighter
      // spacing would make this loop measure the replay budget, not the stall bound.
      last = await orchestrator.takeTurn(say("pata nahi", new Date(T0.getTime() + i * 60_000)));
      if (last.complete) break;
    }

    expect(last?.complete).toBe(true);
    // NOT a blank disambiguate turn and not the chips again: the interview drained its one
    // question (declined, not answered — "pata nahi" is a complete non-answer) and closed.
    expect(last?.reply).not.toBe("");
    expect(store.get(SESSION)?.profiling?.answerMap.find((a) => a.question_key === "q_city"))
      .toMatchObject({ status: "declined" });
  });

  it("closes with `abuse_cap`, not chips, after repeated abuse under a live offer", async () => {
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld();
    seedWithOffer(store);

    let last;
    // One MORE than MAX_ABUSIVE_TURNS: the orchestrator's own abusive-turn branch owns turns
    // 1..MAX_ABUSIVE_TURNS-1 (de-escalates, never calls `identify`); only the turn that pushes
    // `abusiveTurns` to the cap reaches `identify`, and that is the turn this bounds.
    for (let i = 0; i < MAX_ABUSIVE_TURNS + 1; i++) {
      // See the spacing note in the test above — the same reply-replay cache applies here.
      last = await orchestrator.takeTurn(say("madarchod", new Date(T0.getTime() + i * 60_000)));
      if (last.complete) break;
    }

    expect(last?.complete).toBe(true);
    expect(last?.completionReason).toBe("abuse_cap");
    expect(last?.reply).toBe(CLOSING_REPLY);
    // NEVER RE-SERVED past the cap: the chips were abandoned, not shown one more time.
    expect(last?.options).toEqual([]);
    expect(store.get(SESSION)?.profiling?.needsDisambiguation).toBe(false);
    vi.restoreAllMocks();
  });
});
