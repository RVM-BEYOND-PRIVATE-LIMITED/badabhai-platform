/**
 * The LLM-led opening, wired into the turn driver.
 *
 * WHAT THIS FILE IS FOR, as distinct from `llm-turn.service.test.ts`. That suite asserts the
 * caps, the gate and the fallback as a DECISION, against a stubbed model. This one asserts what
 * the orchestrator does with that decision — which is where the damage would be: a synthetic key
 * reaching `answerMap`, an answer dropped on the turn the model takes over, a fallback that ends
 * the interview instead of continuing it, or a cold start that silently swaps a conversation for
 * a form.
 *
 * THE STUB IS THE SERVICE'S OWN CONTRACT, not the model's. `take()` returns `ask`, `done` or
 * `null`, and every one of those three is exercised here.
 */
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
import type { LlmTurnResult } from "./llm-turn.service";
import { ProfilingOrchestrator } from "./orchestrator.service";

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

/** The template tail Phase A hands the interview to. `q_city` is what Phase B opens with here. */
const CITY = item({
  question_key: "q_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  is_mandatory: true,
});
const SHIFT = item({ question_key: "q_shift", prompt_text: "Din ya raat ki shift?" });
// The two the LLM-led opening covers in conversation. Ordered AFTER `q_city` and left
// non-mandatory so the tail's own priority order is unaffected by their presence.
const TRADE = item({
  question_key: "primary_trade",
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
});
const YEARS = item({
  question_key: "experience_years",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Is kaam mein aapko kitne saal ho gaye?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 1,
  family_id: "fam_welding",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [CITY, SHIFT, TRADE, YEARS],
};

const ASK: LlmTurnResult = {
  kind: "ask",
  reply: "Aap kaunsi cuisine banate hain?",
  chips: [],
  inputMode: "text",
  patch: {
    llmStage: "skills",
    llmAsks: 1,
    llmDraft: { domain_label: "cooking", role_label: null, skills: [], experiences: [] },
  },
};

const GATE: LlmTurnResult = {
  kind: "ask",
  reply: "Aur koi experience jodna hai?",
  chips: ["Haan", "Nahi"],
  inputMode: "options_only",
  patch: { llmStage: "experience", llmGateOpen: true },
};

const DONE: LlmTurnResult = { kind: "done", patch: { llmStage: "done", llmAsks: 6 } };

function makeWorld(opts: { leads?: boolean; take?: LlmTurnResult | null } = {}) {
  const store = new Map<string, TranscriptBuffer>();

  const buffer = {
    // THROUGH THE REAL NARROWER, exactly as `ChatTranscriptBuffer.load` does — so a field this
    // change added to the envelope but forgot to narrow fails HERE rather than in production,
    // where it would simply reset every turn.
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
  const identify = {
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: vi.fn(() => opts.leads ?? true),
    take: vi.fn(async () => ("take" in opts ? opts.take : ASK)),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
  );
  return { orchestrator, store, llm, events, identify };
}

function seed(store: Map<string, TranscriptBuffer>, envelope: Partial<ProfilingEnvelope> = {}) {
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: { ...emptyProfilingEnvelope(), rev: 1, ...envelope },
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };
const say = (text: string, at: Date = T0) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  ctx: CTX as never,
});

describe("the model's turn reaches the worker", () => {
  it("serves the model's question and spends no ENGINE ask on it", async () => {
    const { orchestrator, store } = makeWorld();
    const result = await orchestrator.takeTurn(say("cook hu"));

    expect(result.reply).toBe(ASK.reply);
    expect(result.kind).toBe("ask");
    // NO PACK KEY. Claiming one would make the next turn capture the answer as that question's.
    expect(result.questionKey).toBeNull();
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.engineAsks).toBe(0);
    expect(saved?.servedQuestionKey).toBeNull();
    expect(saved?.phase).toBe("llm_interview");
    expect(saved?.llmDraft.domain_label).toBe("cooking");
  });

  it("sends `options_only` and the two gate chips down the wire", async () => {
    const { orchestrator, store } = makeWorld({ take: GATE });
    const result = await orchestrator.takeTurn(say("3 saal tandoor pe"));

    expect(result.inputMode).toBe("options_only");
    expect(result.options.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    // DIGIT-FREE SLUGS. `option_key` is `slugKey`, and `narrowLastTurn` parses the cached list
    // all-or-nothing — one `llm_0` would empty the whole offer on a replay.
    expect(result.options.map((o) => o.option_key)).toEqual(["llm_a", "llm_b"]);
    expect(store.get(SESSION)?.profiling?.llmGateOpen).toBe(true);
  });

  it("replays a gate turn WITH its chips and its typing rule intact", async () => {
    // The reply cache promises the response it claims to repeat. A replayed gate that lost
    // `options_only` would show a keyboard where the first delivery showed two buttons.
    const { orchestrator, store } = makeWorld({ take: GATE });
    await orchestrator.takeTurn(say("3 saal tandoor pe"));
    const again = await orchestrator.takeTurn(say("3 saal tandoor pe", new Date(T0.getTime() + 1)));

    expect(again.replayed).toBe(true);
    expect(again.inputMode).toBe("options_only");
    expect(again.options.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    expect(store.get(SESSION)?.profiling?.rev).toBe(1);
  });

  it("names no question key anywhere in `answerMap` — the gate is not a question", async () => {
    // THE LEAK THIS DESIGN CLOSES. `^[a-z_]+$` would have accepted a synthetic key, so a gate
    // answer could be filed as an answer to a question no pack owns and re-read by the worker's
    // NEXT interview.
    const { orchestrator, store } = makeWorld({ take: GATE });
    await orchestrator.takeTurn(say("3 saal tandoor pe"));
    seed(store, {
      ...(store.get(SESSION)?.profiling as ProfilingEnvelope),
      rev: 1,
      llmGateOpen: true,
    });
    await orchestrator.takeTurn(say("Nahi"));

    const keys = (store.get(SESSION)?.profiling?.answerMap ?? []).map((a) => a.question_key);
    expect(keys.every((k) => /^[a-z_]{1,40}$/.test(k))).toBe(true);
    expect(keys).not.toContain("__experience_gate");
  });
});

describe("Phase A ends and the template tail takes over", () => {
  it("serves the pack's next question on the SAME turn Phase A finishes", async () => {
    // Not the model's closing words — that would cost the worker a round trip to see a bubble
    // with no question in it.
    const { orchestrator, store } = makeWorld({ take: DONE });
    const result = await orchestrator.takeTurn(say("bas itna hi"));

    expect(result.reply).toBe(CITY.prompt_text);
    expect(result.questionKey).toBe("q_city");
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.llmStage).toBe("done");
    expect(saved?.engineAsks).toBe(1);
  });

  it("settles what Phase A learned, so the tail does not re-ask the trade", async () => {
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "cooking",
            role_label: "tandoor cook",
            skills: [],
            experiences: [
              { role_label: "tandoor cook", duration_text: "3 saal", duration_months: 36, work_done: "naan" },
              { role_label: "helper", duration_text: "1 saal", duration_months: 12, work_done: "prep" },
            ],
          },
        },
      },
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    // KEYED OFF `target_field`, so it lands on whichever pack question owns the RFS field.
    expect(map.find((a) => a.target_field === "trade")).toMatchObject({
      question_key: "primary_trade",
      value_normalized: "tandoor cook",
      status: "answered",
    });
    expect(map.find((a) => a.target_field === "experience_years")?.value_normalized).toBe(4);
  });

  it("leaves `experience_years` for the pack when an entry carries no duration", async () => {
    // Summing over an entry the model could not put a number on UNDERSTATES the worker, and
    // understating experience is the one direction that costs them jobs.
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "cooking",
            role_label: null,
            skills: [],
            experiences: [
              { role_label: "cook", duration_text: "kaafi saal", duration_months: null, work_done: "" },
            ],
          },
        },
      },
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "experience_years")).toBeUndefined();
    expect(map.find((a) => a.target_field === "trade")?.value_normalized).toBe("cooking");
  });

  it("never overwrites an answer the worker gave against a real question", async () => {
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "catering",
            role_label: null,
            skills: [],
            experiences: [],
          },
        },
      },
    });
    // NOTHING ON SCREEN, so this turn captures nothing of its own: what is under test is the
    // projection, not the ordinary capture path that would legitimately overwrite an answer the
    // worker is being re-asked.
    seed(store, {
      servedQuestionKey: null,
      engineAsks: 1,
      askCounts: { primary_trade: 1 },
      answerMap: [
        {
          question_key: "primary_trade",
          target_field: "trade",
          value_raw: "halwai",
          value_normalized: "halwai",
          status: "answered",
          evidence: null,
          turn: 1,
          history: [],
        },
      ],
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.question_key === "primary_trade")?.value_normalized).toBe("halwai");
  });

  it("stops consulting the model once the stage is done", async () => {
    const { orchestrator, store, llm } = makeWorld({ leads: false });
    seed(store, { llmStage: "done", servedQuestionKey: "q_city", engineAsks: 1 });
    await orchestrator.takeTurn(say("pune"));
    expect(llm.take).not.toHaveBeenCalled();
  });
});

describe("the fallback is a fall-through, not a second engine", () => {
  it("serves a pack question on the turn the model goes away", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    const result = await orchestrator.takeTurn(say("cook hu"));

    expect(result.unavailable).toBe(false);
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.llmFallback).toBe(true);
  });

  it("records the switch, because nothing else about it is visible", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, events } = makeWorld({ take: null });
    await orchestrator.takeTurn(say("cook hu"));

    const emitted = events.emit.mock.calls[0]?.[0] as { event_name: string; payload: unknown };
    expect(emitted.event_name).toBe("profile.llm_interview_fallback");
    expect(emitted.payload).toMatchObject({ reason: "unavailable", stage: "domain", asks: 0 });
  });

  it("closes the gate on the way out, so a stale Yes/No cannot swallow a real answer", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    seed(store, { llmGateOpen: true, llmStage: "experience", llmAsks: 3 });
    await orchestrator.takeTurn(say("Haan"));
    expect(store.get(SESSION)?.profiling?.llmGateOpen).toBe(false);
  });

  it("keeps the answers Phase A had already captured", async () => {
    // A mid-interview fallback must not restart from nothing: the deterministic map is what both
    // the remaining pack questions and the final extraction read.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    seed(store, {
      servedQuestionKey: "q_city",
      engineAsks: 1,
      askCounts: { q_city: 1 },
      llmAsks: 2,
    });
    await orchestrator.takeTurn(say("main pune me rehta hu"));

    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_city")?.status).toBe("answered");
  });
});

describe("reopening mid-Phase-A", () => {
  it("re-serves the MODEL's question rather than falling through to a pack one", async () => {
    // Without this, every cold start and resume-after-kill swapped the conversation for a form.
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("cook hu"));
    const revBefore = store.get(SESSION)?.profiling?.rev;

    const reopened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: new Date(T0.getTime() + 60_000),
      ctx: CTX as never,
    });

    expect(reopened.reply).toBe(ASK.reply);
    expect(reopened.questionKey).toBeNull();
    expect(reopened.replayed).toBe(true);
    // NOTHING WRITTEN. Re-serving is not a turn.
    expect(store.get(SESSION)?.profiling?.rev).toBe(revBefore);
  });

  it("and `viewSession` agrees with it about what is on screen", async () => {
    const { orchestrator } = makeWorld();
    await orchestrator.takeTurn(say("cook hu"));
    const view = await orchestrator.viewSession(SESSION, new Date(T0.getTime() + 60_000));
    expect(view?.served?.promptText).toBe(ASK.reply);
    expect(view?.served?.questionKey).toBeNull();
  });

  it("still opens a BRAND-NEW session on the pack, because the model has nothing to answer yet", async () => {
    const { orchestrator, store } = makeWorld();
    const opened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(opened.reply).toBe(CITY.prompt_text);
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
  });
});
