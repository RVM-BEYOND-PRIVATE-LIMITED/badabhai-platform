import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import { ProfilingOrchestrator } from "./orchestrator.service";
import { RESUME_CONFIRM_OPTIONS } from "./resume-confirm";
import type { ResumeSuggestion } from "./resume-import/resume-suggestions";

/**
 * ═══ THE RÉSUMÉ CONFIRM AS THE SESSION'S FIRST TURN (Task 1 B3; ADR-0042 D8) ═══
 *
 * A résumé routed to the chat used to open on the generic greeting and serve the confirm
 * as the REPLY to the worker's first message. This file pins the change: when the client
 * asks (`confirm_first`, see `ChatService.tryOpenResumeConfirm`), the confirm IS the first
 * bubble, its pending state is persisted so the chip tap is captured as its answer, and
 * the interview continues in the same bubble on accept — asking only what the document
 * did not already answer.
 *
 * WHAT IS AT RISK, and what these tests are shaped around:
 *   1. A session WITHOUT a pending résumé must be untouched — `openResumeConfirm` returns
 *      null and `openTurn` is never called, so no first question is pre-served.
 *   2. A confirm that was already served, settled, or belongs to a mid-conversation session
 *      must never be re-opened.
 *   3. The opening must SPEND AN ASK and persist `pending` in one guarded write — without
 *      the write, the worker's chip tap would fall through to ordinary capture and the
 *      confirm would be asked twice.
 *   4. Accept prefills through the same ruling-D2 path the reply-turn version used, and
 *      declines are counted, not dropped.
 */

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "44444444-4444-4444-8444-444444444444";
const T0 = new Date("2026-09-16T10:00:00.000Z");
const CTX = { correlationId: "c1", requestId: "r1" };

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

const TRADE = item({
  question_key: "primary_trade",
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  is_mandatory: true,
});
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
});
/** A third question, so "the interview continues" is observable as an ASK after an accept
 * settles the two facts the résumé covered. */
const EXPERIENCE = item({
  question_key: "experience_years",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Kitna tajurba hai?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 2,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE, CITY, EXPERIENCE],
};

const suggestion = (text: string): ResumeSuggestion => ({
  values: { option_keys: [], text, number: null, bool: null },
  source: "resume",
  confidence: 0.9,
});

const SUGGESTIONS = new Map<string, ResumeSuggestion>([
  ["primary_trade", suggestion("CNC Turner")],
  ["current_city", suggestion("Pune")],
]);

function makeWorld(
  opts: {
    pending?: { importId: string; suggestions: ReadonlyMap<string, ResumeSuggestion> } | null;
    seed?: Partial<ProfilingEnvelope>;
  } = {},
) {
  const store = new Map<string, TranscriptBuffer>();
  const seeded: ProfilingEnvelope = { ...emptyProfilingEnvelope(), rev: 1, ...opts.seed };
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 0,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: seeded,
  } as TranscriptBuffer);

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through the REAL narrower, as `ChatTranscriptBuffer.load` does.
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
  const identify = {
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done",
    take: vi.fn(async () => null),
  };
  const resume = {
    pendingForChat: vi.fn(async () => opts.pending ?? null),
    forImport: vi.fn(async () => SUGGESTIONS),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    resume as never,
    { findCurrentCity: async () => null } as never,
  );
  return { orchestrator, store, events, buffer, resume };
}

const say = (text: string) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

const open = () => ({ sessionId: SESSION, workerId: WORKER, now: T0, ctx: CTX as never });

const saved = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling;

const PENDING = { importId: IMPORT, suggestions: SUGGESTIONS };
const CONFIRM_REPLY = "Resume se ye mila: CNC Turner · Pune. Sahi hai?";

describe("the résumé confirm opens the session (Task 1 B3)", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

  it("serves the confirm as the FIRST turn, persists pending, and spends an ask", async () => {
    const { orchestrator, store } = makeWorld({ pending: PENDING });
    const result = await orchestrator.openResumeConfirm(open());

    expect(result).not.toBeNull();
    expect(result!.reply).toBe(CONFIRM_REPLY);
    expect(result!.kind).toBe("ask");
    expect(result!.questionKey).toBeNull();
    expect(result!.options).toEqual([...RESUME_CONFIRM_OPTIONS]);
    expect(result!.answerType).toBe("single_select");
    expect(result!.replayed).toBe(false);

    // THE WRITE IS THE CONTRACT: without `pending`, the chip tap is not captured as the
    // confirm's answer and the same question is served again.
    expect(saved(store)?.resumeConfirm).toEqual({ importId: IMPORT, state: "pending" });
    // IT SPENDS AN ASK, AND MUST — it is a question the worker can decline.
    expect(saved(store)?.engineAsks).toBe(1);
    // ONE assistant line, no invented worker message, `turnCount` untouched (nothing was said).
    const held = store.get(SESSION)!;
    expect(held.messages).toHaveLength(1);
    expect(held.messages[0]!.role).toBe("assistant");
    expect(held.turnCount).toBe(0);
  });

  it("the chip tap PREFILLS the facts and the interview continues in the same bubble", async () => {
    const { orchestrator, store, events, resume } = makeWorld({ pending: PENDING });
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_confirm_yes"));

    // Ruling D2 — confirmed values land in the answer map with the worker as their source.
    const map = saved(store)?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "trade")?.value_normalized).toBe("CNC Turner");
    expect(map.find((a) => a.target_field === "current_city")?.value_normalized).toBe("Pune");
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    // FALLS THROUGH to ordinary selection — the next question arrives in the SAME bubble,
    // and it is NOT the trade or the city the confirm just settled.
    expect(result.kind).toBe("ask");
    expect(result.reply).not.toBe(CONFIRM_REPLY);
    expect(result.questionKey).toBe("experience_years");
    // The funnel event counts the offer and the accept; both come from the staged import.
    const applied = events.emit.mock.calls
      .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "profile.resume_prefill_applied");
    expect(applied).toBeDefined();
    expect(applied!.payload).toMatchObject({ offered: expect.any(Number), accepted: 2 });
    expect(resume.forImport).toHaveBeenCalledWith(WORKER, IMPORT);
  });

  it("a decline settles the offer, writes no facts, and the interview continues", async () => {
    const { orchestrator, store, events } = makeWorld({ pending: PENDING });
    await orchestrator.openResumeConfirm(open());

    const result = await orchestrator.takeTurn(say("resume_confirm_no"));

    const map = saved(store)?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "trade")).toBeUndefined();
    expect(saved(store)?.resumeConfirm?.state).toBe("settled");
    // A DECLINE IS NOT A DEAD END: the trade question comes back, because the declaration
    // is exactly what the résumé failed to establish.
    expect(result.kind).toBe("ask");
    expect(result.questionKey).toBe("primary_trade");
    const applied = events.emit.mock.calls
      .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "profile.resume_prefill_applied");
    expect(applied!.payload).toMatchObject({ accepted: 0 });
  });

  it("a second open re-serves the confirm WITHOUT spending a second ask", async () => {
    const { orchestrator, store } = makeWorld({ pending: PENDING });
    await orchestrator.openResumeConfirm(open());

    const again = await orchestrator.openTurn(open());

    expect(again.reply).toBe(CONFIRM_REPLY);
    expect(again.options).toEqual([...RESUME_CONFIRM_OPTIONS]);
    expect(again.replayed).toBe(true);
    expect(saved(store)?.engineAsks).toBe(1); // unchanged
    expect(store.get(SESSION)!.messages).toHaveLength(1); // no second bubble
  });

  it("NO pending import ⇒ null, and NOTHING is written (no first question pre-served)", async () => {
    const { orchestrator, store, buffer } = makeWorld({ pending: null });
    const result = await orchestrator.openResumeConfirm(open());

    expect(result).toBeNull();
    expect(buffer.saveWithCas).not.toHaveBeenCalled();
    expect(saved(store)?.engineAsks).toBe(0);
    expect(store.get(SESSION)!.messages).toHaveLength(0);
  });

  it("a confirm already SETTLED is never reopened", async () => {
    const { orchestrator, buffer } = makeWorld({
      pending: PENDING,
      seed: { resumeConfirm: { importId: IMPORT, state: "settled" } },
    });
    expect(await orchestrator.openResumeConfirm(open())).toBeNull();
    expect(buffer.saveWithCas).not.toHaveBeenCalled();
  });

  it("a session WITH TURNS is never opened on the confirm — the turn path owns it", async () => {
    const { orchestrator, store } = makeWorld({ pending: PENDING });
    const held = store.get(SESSION)!;
    store.set(SESSION, { ...held, turnCount: 3 } as TranscriptBuffer);
    expect(await orchestrator.openResumeConfirm(open())).toBeNull();
  });

  it("no servable facts ⇒ the ordinary opening is served, and it is NOT announced as the confirm", async () => {
    // Every fact already settled: the import is pending but nothing is worth confirming.
    const { orchestrator, store } = makeWorld({
      pending: PENDING,
      seed: {
        answerMap: [
          {
            question_key: "primary_trade",
            target_field: "trade",
            value_raw: "cnc",
            value_normalized: "cnc",
            status: "answered",
            evidence: null,
            turn: 1,
            history: [],
          },
          {
            question_key: "current_city",
            target_field: "current_city",
            value_raw: "pune",
            value_normalized: "pune",
            status: "answered",
            evidence: null,
            turn: 1,
            history: [],
          },
        ],
      },
    });
    const result = await orchestrator.openResumeConfirm(open());

    // The wrapper refuses to label the ordinary first question as the confirm. The question
    // itself may have been pre-served by `openTurn` — that is benign, and the caller sees null.
    expect(result).toBeNull();
    expect(saved(store)?.resumeConfirm ?? null).toBeNull();
  });
});
