import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import { recordAnswer, toAnswerArray, type AnswerMap } from "./answer-map";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import { OPTIONAL_OFFER_OPTIONS, OPTIONAL_OFFER_PROMPT_TEXT } from "./optional-offer";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { outstandingOptionalOffer } from "./turn-shapes";

/**
 * ═══ THE OPTIONAL-DEPTH OFFER, END TO END THROUGH THE ORCHESTRATOR ═══
 *
 * Middle-Way C2 stop rule, P3b: once the 8 required slots settle with optional
 * depth still unasked, the worker is OFFERED the rest instead of walked through
 * it. Accept continues into optional; decline (or an unreadable reply) closes
 * required_complete with the plain closing line — the Bas-ho-gaya line was
 * already served as the offer.
 *
 * WHAT IS ACTUALLY AT RISK HERE, mirroring the form-offer suite:
 *
 *   1. A worker with optional depth left must be OFFERED, not walked — the
 *      intercept fires on the engine's ask, never after the drain.
 *   2. Accept must continue the SAME interview (optional next, nothing settled).
 *   3. Decline must END it, once, with the plain closing (never the Bas line twice).
 *   4. Unclear counts as decline for the interview and apart for measurement.
 *   5. No optional left means no offer — straight to required_complete.
 *   6. The offer is never served twice, and survives a reload via envelope state.
 */

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-30T10:00:00.000Z");
const CTX = { correlationId: "c1", requestId: "r1" };

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "attribute",
    target_field: partial.question_key,
    target_skill_id: null,
    answer_type: "single_select",
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
    options: [
      { option_key: "a", label_text: "A", value: "a", implies_skill_id: null, is_none_of_above: false },
      { option_key: "b", label_text: "B", value: "b", implies_skill_id: null, is_none_of_above: false },
    ],
    ...partial,
  };
}

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 3,
    family_id: "fam_test",
    locale: "hi-IN",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

const OCCUPATION_PACK = pack("qp_cnc_turning", [
  item({ question_key: "turning_experience", is_mandatory: true }),
  item({ question_key: "turning_machine", is_mandatory: true }),
  item({ question_key: "turning_level", is_mandatory: true }),
  item({ question_key: "controller_brand", is_mandatory: true }),
  item({ question_key: "turning_operation" }),
  item({ question_key: "material_worked" }),
]);

const UNIVERSAL_PACK = pack("qp_universal", [
  item({ question_key: "primary_trade", is_mandatory: true }),
  item({ question_key: "current_city", is_mandatory: true }),
  item({ question_key: "salary_expected" }),
  item({ question_key: "availability" }),
  item({ question_key: "education" }),
]);

const REQUIRED_8 = [
  "primary_trade",
  "turning_machine",
  "turning_experience",
  "turning_level",
  "controller_brand",
  "current_city",
  "salary_expected",
  "availability",
];

function answerMapFor(keys: string[]): AnswerMap {
  let map: AnswerMap = {} as AnswerMap;
  keys.forEach((key, i) => {
    map = recordAnswer(
      map,
      { questionKey: key, targetField: key, valueRaw: `v${i}`, valueNormalized: `v${i}`, evidence: null },
      i + 1,
    );
  });
  return map;
}

function makeWorld(occupation: QuestionPack | null = OCCUPATION_PACK) {
  const store = new Map<string, TranscriptBuffer>();
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: { ...emptyProfilingEnvelope(), rev: 1 },
  } as TranscriptBuffer);

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
    loadPinned: vi.fn(async () => occupation),
    resolveForOccupation: vi.fn(async () => occupation),
  };
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = { leads: () => false, take: vi.fn(async () => null) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    { pendingForChat: async () => null, forImport: async () => new Map(), identityForChat: async () => null } as never,
    { findCurrentCity: async () => null } as never,
  );
  return { orchestrator, store, events };
}

const say = (text: string) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  knownName: async () => null,
  ctx: CTX as never,
});

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

function seedAnswers(store: Map<string, TranscriptBuffer>, keys: string[], turnCount = 1) {
  const held = store.get(SESSION);
  if (!held) throw new Error("no session");
  const answers = answerMapFor(keys);
  store.set(SESSION, {
    ...held,
    turnCount,
    profiling: {
      ...(held.profiling as ProfilingEnvelope),
      packId: "qp_cnc_turning",
      packVersion: 3,
      answerMap: toAnswerArray(answers),
    },
  });
}

type EmittedEvent = { event_name: string; payload: Record<string, unknown> };
const emitted = (
  events: { emit: { mock: { calls: unknown[][] } } },
  name: string,
): EmittedEvent[] =>
  events.emit.mock.calls
    .map(([params]) => params as EmittedEvent)
    .filter((e) => e.event_name === name);

describe("the optional-depth offer", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  it("is served instead of the next optional once the 8 settle", async () => {
    const { orchestrator, store, events } = makeWorld();
    seedAnswers(store, REQUIRED_8);
    const result = await orchestrator.takeTurn(say("kuch nahi"));

    expect(result.kind).toBe("ask");
    expect(result.complete).toBe(false);
    expect(result.questionKey).toBeNull();
    expect(result.reply).toBe(OPTIONAL_OFFER_PROMPT_TEXT);
    expect(result.options).toEqual([...OPTIONAL_OFFER_OPTIONS]);
    expect(saved(store)?.optionalOffer).toEqual({ state: "pending", accepted: false });
    const offered = emitted(events, "profile.optional_offered");
    expect(offered).toHaveLength(1);
  });

  it("ACCEPTING continues into optional depth on the same interview", async () => {
    const { orchestrator, store } = makeWorld();
    seedAnswers(store, REQUIRED_8);
    await orchestrator.takeTurn(say("kuch nahi"));
    const result = await orchestrator.takeTurn(say("optional_offer_yes"));

    expect(result.kind).toBe("ask");
    expect(result.complete).toBe(false);
    expect(result.questionKey).toBe("turning_operation");
    expect(saved(store)?.optionalOffer).toEqual({ state: "settled", accepted: true });
  });

  it("DECLINING ends the interview with the plain closing, never the Bas line twice", async () => {
    const { orchestrator, store, events } = makeWorld();
    seedAnswers(store, REQUIRED_8);
    await orchestrator.takeTurn(say("kuch nahi"));
    const result = await orchestrator.takeTurn(say("optional_offer_no"));

    expect(result.kind).toBe("close");
    expect(result.complete).toBe(true);
    expect(result.completionReason).toBe("required_complete");
    expect(result.reply).toBe("Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.");
    expect(saved(store)?.optionalOffer).toEqual({ state: "settled", accepted: false });
    const declined = emitted(events, "profile.optional_offer_declined");
    expect(declined).toHaveLength(1);
    expect(declined[0]!.payload.reply).toBe("declined");
  });

  it("treats an unreadable reply as a decline — never a re-ask, counted apart", async () => {
    const { orchestrator, store, events } = makeWorld();
    seedAnswers(store, REQUIRED_8);
    await orchestrator.takeTurn(say("kuch nahi"));
    // No affirmation or negation in it — the lexicon cannot read it at all.
    const result = await orchestrator.takeTurn(say("offer kya hota hai bhai"));

    expect(result.kind).toBe("close");
    expect(result.completionReason).toBe("required_complete");
    expect(saved(store)?.optionalOffer?.state).toBe("settled");
    const declined = emitted(events, "profile.optional_offer_declined");
    expect(declined).toHaveLength(1);
    expect(declined[0]!.payload.reply).toBe("unclear");
  });

  it("is skipped when no optional depth remains — straight to required_complete", async () => {
    const { orchestrator, store, events } = makeWorld();
    seedAnswers(store, [
      ...REQUIRED_8,
      "turning_operation",
      "material_worked",
      "education",
    ]);
    const result = await orchestrator.takeTurn(say("kuch nahi"));

    expect(result.kind).toBe("close");
    expect(result.completionReason).toBe("required_complete");
    expect(result.reply).toBe("Bas ho gaya. Resume ban raha hai.");
    expect(saved(store)?.optionalOffer).toBeNull();
    expect(emitted(events, "profile.optional_offered")).toHaveLength(0);
  });

  it("is never served twice — the settled offer stays settled", async () => {
    const { orchestrator, store } = makeWorld();
    seedAnswers(store, REQUIRED_8);
    await orchestrator.takeTurn(say("kuch nahi"));
    await orchestrator.takeTurn(say("optional_offer_yes"));
    const later = await orchestrator.takeTurn(say("kuch nahi"));
    expect(later.reply).not.toBe(OPTIONAL_OFFER_PROMPT_TEXT);
    expect(saved(store)?.optionalOffer).toEqual({ state: "settled", accepted: true });
  });

  it("the 20-turn cap closes an accepted optional stretch with the plain closing", async () => {
    const { orchestrator, store } = makeWorld();
    seedAnswers(store, REQUIRED_8, 21);
    // Offer already accepted on an earlier turn; optional depth still unasked.
    const held = store.get(SESSION);
    if (!held) throw new Error("no session");
    store.set(SESSION, {
      ...held,
      profiling: {
        ...(held.profiling as ProfilingEnvelope),
        optionalOffer: { state: "settled", accepted: true },
      },
    });
    const result = await orchestrator.takeTurn(say("kuch nahi"));
    expect(result.kind).toBe("close");
    expect(result.completionReason).toBe("required_complete");
    expect(result.reply).toBe("Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.");
  });

  it("no offer past 20 turns — the drain close serves instead", async () => {
    const { orchestrator, store, events } = makeWorld();
    seedAnswers(store, REQUIRED_8, 21);
    const result = await orchestrator.takeTurn(say("kuch nahi"));
    expect(result.reply).not.toBe(OPTIONAL_OFFER_PROMPT_TEXT);
    expect(saved(store)?.optionalOffer).toBeNull();
    expect(emitted(events, "profile.optional_offered")).toHaveLength(0);
  });

  it("rebuilds the pending offer on a reopen, from envelope state", () => {
    const pending = {
      ...emptyProfilingEnvelope(),
      optionalOffer: { state: "pending", accepted: false },
    } as ProfilingEnvelope;
    const rebuilt = outstandingOptionalOffer(pending);
    expect(rebuilt?.prompt).toBe(OPTIONAL_OFFER_PROMPT_TEXT);
    expect(rebuilt?.options).toEqual([...OPTIONAL_OFFER_OPTIONS]);
    const settled = {
      ...emptyProfilingEnvelope(),
      optionalOffer: { state: "settled", accepted: true },
    } as ProfilingEnvelope;
    expect(outstandingOptionalOffer(settled)).toBeNull();
    expect(outstandingOptionalOffer(emptyProfilingEnvelope())).toBeNull();
  });
});
