import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type {
  ProfilingTurnUnderstandOutput,
  QuestionPack,
  QuestionPackItem,
} from "@badabhai/ai-contracts";
import { ProfilingTurnUnderstoodPayload } from "@badabhai/event-schema";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "../conversation-state";
import { PROFILE_PAGE_POINTER_TEXT } from "../next-question";
import { ProfilingOrchestrator } from "../orchestrator.service";

/**
 * ADR-0057 (#2311) — the profiling turn, understood, through the real orchestrator.
 *
 * The fake understanding service stands in for both model calls; everything else is the real
 * decision: the deterministic walls, capture, `applyFills`, question selection and the lead-ins.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-16T10:00:00.000Z");

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "rfs",
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

const AVAIL = item({
  question_key: "availability",
  target_field: "availability",
  answer_type: "single_select",
  prompt_text: "Aap kab se kaam shuru kar sakte hain?",
  options: [
    { option_key: "immediate", label_text: "Turant", implies_skill_id: null, is_none_of_above: false },
    { option_key: "month", label_text: "Ek mahine mein", implies_skill_id: null, is_none_of_above: false },
  ],
});
const YEARS = item({
  question_key: "experience_years",
  target_field: "experience_years",
  prompt_text: "Kitne saal ka kaam ka tajurba hai?",
});
const CITY = item({
  question_key: "current_city",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
});
const TRAINING = item({
  question_key: "training_name",
  target_field: "training_name",
  prompt_text: "Koi training ki hai? Uska naam bataiye.",
});
const UNIVERSAL: QuestionPack = {
  pack_id: "qp_universal",
  version: 4,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [AVAIL, YEARS, CITY, TRAINING],
};

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_turn_understand",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  created_at: "2026-10-16T10:00:00Z",
};

function verdict(over: Partial<ProfilingTurnUnderstandOutput> = {}): ProfilingTurnUnderstandOutput {
  return {
    intent: "answer",
    confidence: 0.9,
    fills: [],
    edits: [],
    page_owned_mentions: [],
    blocked: false,
    ai_metadata: META as never,
    ...over,
  };
}

function makeWorld(opts: {
  verdict?: ProfilingTurnUnderstandOutput | null;
  bridge?: string | null;
} = {}) {
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
    loadUniversal: vi.fn(async () => UNIVERSAL),
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
  const llm = { leads: () => false, take: vi.fn(async () => null) };
  const resumeSuggestions = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
    identityForChat: vi.fn(async () => null),
  };
  const workers = { findCurrentCity: vi.fn(async () => null) };
  const understanding = {
    understand: vi.fn(async () => (opts.verdict === undefined ? verdict() : opts.verdict)),
    bridge: vi.fn(async () => (opts.bridge === undefined ? "Theek hai, likh liya." : opts.bridge)),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    resumeSuggestions as never,
    workers as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    understanding as never,
  );
  return { orchestrator, store, events, understanding };
}

function seed(
  store: Map<string, TranscriptBuffer>,
  envelope: Partial<ProfilingEnvelope> = {},
) {
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
      servedQuestionKey: "availability",
      engineAsks: 1,
      askCounts: { availability: 1 },
      ...envelope,
    },
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };

const say = (text: string, understanding = true) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  ...(understanding ? { understanding: true } : {}),
  knownName: async () => null,
  ctx: CTX as never,
});

const answered = (key: string, value: unknown, raw: string) => ({
  question_key: key,
  target_field: key,
  value_raw: raw,
  value_normalized: value,
  status: "answered" as const,
  evidence: null,
  turn: 1,
  history: [],
});

const recordOf = (store: Map<string, TranscriptBuffer>, key: string) =>
  store.get(SESSION)?.profiling?.answerMap.find((a) => a.question_key === key);

function understoodEvent(events: { emit: ReturnType<typeof vi.fn> }) {
  const call = events.emit.mock.calls.find(
    ([params]) => (params as { event_name: string }).event_name === "profiling.turn_understood",
  );
  return call ? ProfilingTurnUnderstoodPayload.parse((call[0] as { payload: unknown }).payload) : null;
}

describe("ADR-0057 — the flag off is today's turn exactly", () => {
  it("never calls the model and emits nothing", async () => {
    const { orchestrator, store, events, understanding } = makeWorld();
    seed(store);
    await orchestrator.takeTurn(say("kal se, aur 7 saal ka experience", false));
    expect(understanding.understand).not.toHaveBeenCalled();
    expect(understanding.bridge).not.toHaveBeenCalled();
    expect(understoodEvent(events)).toBeNull();
  });
});

describe("ADR-0057 — a volunteered value fills its empty field", () => {
  it("fills a field no parser could catch, skips its question, and leads into the next one", async () => {
    // A free-text field: the deterministic cross-question fill never claims one (it would swallow
    // the whole message), so only the model's fill can write it.
    const { orchestrator, store, events } = makeWorld({
      verdict: verdict({ fills: [{ key: "training_name", value: "ITI Welding" }] }),
    });
    seed(store);
    const result = await orchestrator.takeTurn(say("turant, ITI se welding ki training li thi"));
    expect(recordOf(store, "training_name")?.value_raw).toBe("ITI Welding");
    // The filled question is never asked: the engine moves past it.
    expect(result.questionKey).not.toBe("training_name");
    expect(result.reply.startsWith("Theek hai, likh liya. ")).toBe(true);
    // The same reply in the transcript and the replay cache.
    const held = store.get(SESSION);
    expect(held?.messages.at(-1)?.text).toBe(result.reply);
    expect(held?.profiling?.lastTurn?.reply).toBe(result.reply);
    expect(understoodEvent(events)).toMatchObject({
      fills_applied: 1,
      fill_keys: ["training_name"],
      bridge_served: true,
      pointer_served: false,
    });
  });

  it("acknowledges what the deterministic cross-fill caught too", async () => {
    // "7 saal" is caught by the typed parser before the model's fill is even considered; the
    // model's fill is then a no-op, but the worker still hears that it was noted.
    const { orchestrator, store, events, understanding } = makeWorld({
      verdict: verdict({ fills: [{ key: "experience_years", value: "7" }] }),
    });
    seed(store);
    await orchestrator.takeTurn(say("kal se join kar lunga, 7 saal ka experience hai"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(7);
    expect(understanding.bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "filled",
        noted: expect.arrayContaining([expect.stringContaining("Kitne saal")]),
      }),
      expect.anything(),
    );
    expect(understoodEvent(events)).toMatchObject({ fills_applied: 0, bridge_served: true });
  });

  it("NEVER overwrites a filled field — that is a change for the worker to confirm", async () => {
    const { orchestrator, store, understanding } = makeWorld({
      verdict: verdict({ fills: [{ key: "experience_years", value: "7" }] }),
    });
    seed(store, { answerMap: [answered("experience_years", 5, "5 saal")] });
    await orchestrator.takeTurn(say("turant, 7 saal"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(5);
    // Nothing was noted, so no bridge line is asked for.
    expect(understanding.bridge).not.toHaveBeenCalled();
  });

  it("a failed bridge line leaves the bare question", async () => {
    const { orchestrator, store, events } = makeWorld({
      verdict: verdict({ fills: [{ key: "current_city", value: "Pune" }] }),
      bridge: null,
    });
    seed(store);
    const result = await orchestrator.takeTurn(say("turant, Pune mein rehta hoon"));
    expect(recordOf(store, "current_city")?.value_normalized).toBe("Pune");
    expect(result.reply.startsWith("Theek hai")).toBe(false);
    expect(understoodEvent(events)).toMatchObject({ bridge_served: false });
  });
});

describe("ADR-0057 — a side message never lands as an answer", () => {
  it("re-serves the free-text question unspent, records nothing, and replies above it", async () => {
    const { orchestrator, store, understanding } = makeWorld({
      verdict: verdict({ intent: "chat" }),
      bridge: "Haan, garmi bahut hai.",
    });
    seed(store, { servedQuestionKey: "training_name", askCounts: { training_name: 1 } });
    const result = await orchestrator.takeTurn(say("aaj bahut garmi hai"));
    expect(recordOf(store, "training_name")).toBeUndefined();
    expect(result.questionKey).toBe("training_name");
    expect(result.reply).toBe(`Haan, garmi bahut hai. ${TRAINING.prompt_text}`);
    expect(store.get(SESSION)?.profiling?.askCounts.training_name).toBe(1);
    expect(understanding.bridge).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "chat", nextQuestion: TRAINING.prompt_text }),
      expect.anything(),
    );
  });

  it("an unsure chat verdict is not acted on — today's capture runs", async () => {
    const { orchestrator, store } = makeWorld({ verdict: verdict({ intent: "chat", confidence: 0.4 }) });
    seed(store, { servedQuestionKey: "training_name", askCounts: { training_name: 1 } });
    await orchestrator.takeTurn(say("ITI welding"));
    expect(recordOf(store, "training_name")?.value_raw).toBe("ITI welding");
  });
});

describe("ADR-0057 — a progress question only the model caught", () => {
  it("gets the #2308 answer: the real count and the question again", async () => {
    const { orchestrator, store } = makeWorld({ verdict: verdict({ intent: "progress" }) });
    seed(store);
    const result = await orchestrator.takeTurn(say("yaar ye sab kitni der chalega"));
    expect(result.reply).toMatch(/^Thoda sa aur\. Bas \d+ sawaal bache hain\. /);
    expect(result.questionKey).toBe("availability");
    expect(recordOf(store, "availability")).toBeUndefined();
  });
});

describe("ADR-0057 — a Profile-page fact gets the pointer", () => {
  it("puts the pointer above the question, and the event says so", async () => {
    const { orchestrator, store, events } = makeWorld({
      verdict: verdict({ intent: "statement", page_owned_mentions: ["expected_salary"] }),
    });
    seed(store);
    const result = await orchestrator.takeTurn(say("mujhe 25000 chahiye"));
    expect(result.reply.startsWith(`${PROFILE_PAGE_POINTER_TEXT} `)).toBe(true);
    expect(understoodEvent(events)).toMatchObject({
      page_owned_mentions: 1,
      pointer_served: true,
    });
  });
});

describe("ADR-0057 — fail safe to today's turn", () => {
  it("an unavailable verdict runs the turn exactly as today and emits nothing", async () => {
    const { orchestrator, store, events } = makeWorld({ verdict: null });
    seed(store, { servedQuestionKey: "training_name", askCounts: { training_name: 1 } });
    await orchestrator.takeTurn(say("ITI welding"));
    expect(recordOf(store, "training_name")?.value_raw).toBe("ITI welding");
    expect(understoodEvent(events)).toBeNull();
  });

  it("a tapped chip is never sent to the model", async () => {
    const { orchestrator, store, understanding } = makeWorld();
    seed(store, {
      lastTurn: {
        inboundHash: "unrelated",
        submissionId: null,
        reply: AVAIL.prompt_text,
        formOffer: null,
        gateKind: null,
        generalFormOffer: null,
        kind: "ask",
        questionKey: "availability",
        at: T0.toISOString(),
        options: AVAIL.options,
        progress: { answered: 0, total: 4 },
        whyText: null,
        answerType: "single_select",
        lookahead: null,
        inputMode: "text",
        replays: 0,
      } as never,
    });
    await orchestrator.takeTurn(say("Turant"));
    expect(understanding.understand).not.toHaveBeenCalled();
  });
});
