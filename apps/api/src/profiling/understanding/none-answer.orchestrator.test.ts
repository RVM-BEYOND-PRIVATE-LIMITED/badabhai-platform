import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type {
  ProfilingTurnUnderstandOutput,
  QuestionPack,
  QuestionPackItem,
} from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "../conversation-state";
import { ProfilingOrchestrator } from "../orchestrator.service";

/**
 * #2328 — the device test of 2026-10-16, through the real orchestrator: "maine koi course nahin
 * kiya" to the training question was stored as the training's NAME, and both follow-ups were then
 * asked. A "none" answer is recorded DECLINED, and the pack's own `ask_if` skips the follow-ups.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-16T10:00:00.000Z");

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "attribute",
    target_field: partial.question_key,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 1,
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

// The universal pack's own three items (qp_universal@4), conditions verbatim.
const TRAINING = item({
  question_key: "training_name",
  prompt_text: "Aapne kaunsi training ya course ki hai?",
});
const PROVIDER = item({
  question_key: "training_provider",
  prompt_text: "Training aapne kahan se ki thi?",
  ask_if: { op: "answered", field: "training_name" },
});
const YEAR = item({
  question_key: "training_year",
  prompt_text: "Training kis saal ki thi?",
  answer_type: "number",
  ask_if: { op: "answered", field: "training_name" },
});
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
});
const UNIVERSAL: QuestionPack = {
  pack_id: "qp_universal",
  version: 4,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRAINING, PROVIDER, YEAR, CITY],
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
    on_screen_none: false,
    blocked: false,
    ai_metadata: META as never,
    ...over,
  };
}

function makeWorld(
  answer: ProfilingTurnUnderstandOutput | null = verdict(),
  servedKey = "training_name",
  pack: QuestionPack = UNIVERSAL,
) {
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
      store.set(id, { ...next, profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 } });
      return true;
    }),
  };
  const understanding = {
    understand: vi.fn(async () => answer),
    bridge: vi.fn(async () => null),
  };
  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    {
      loadUniversal: vi.fn(async () => pack),
      loadPinned: vi.fn(async () => null),
      resolveForOccupation: vi.fn(async () => null),
    } as never,
    { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) } as never,
    { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) } as never,
    { emit: vi.fn(async () => undefined) } as never,
    { leads: () => false, take: vi.fn(async () => null) } as never,
    {
      pendingForChat: vi.fn(async () => null),
      forImport: vi.fn(async () => new Map()),
      identityForChat: vi.fn(async () => null),
    } as never,
    { findCurrentCity: vi.fn(async () => null) } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    understanding as never,
  );
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 3,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: {
      ...emptyProfilingEnvelope(),
      rev: 1,
      llmStage: "done",
      servedQuestionKey: servedKey,
      engineAsks: 1,
      askCounts: { [servedKey]: 1 },
    },
  });
  return { orchestrator, store, understanding };
}

const say = (text: string, understanding = true) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  ...(understanding ? { understanding: true } : {}),
  knownName: async () => null,
  ctx: { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" } as never,
});

const recordOf = (store: Map<string, TranscriptBuffer>, key: string) =>
  store.get(SESSION)?.profiling?.answerMap.find((a) => a.question_key === key);

describe("#2328 — 'I have none' to the training question skips its follow-ups", () => {
  it("the device sentence: the model says none — declined, and neither follow-up is asked", async () => {
    const { orchestrator, store } = makeWorld(verdict({ on_screen_none: true }));
    const result = await orchestrator.takeTurn(
      say("maine koi course nahin kiya bhai mere ko profile villager"),
    );
    expect(recordOf(store, "training_name")).toMatchObject({ status: "declined", value_raw: null });
    expect(result.questionKey).toBe("current_city");
  });

  it("a bare 'nahi ki' needs no model — the same with the layer off", async () => {
    const { orchestrator, store, understanding } = makeWorld();
    const result = await orchestrator.takeTurn(say("nahi ki", false));
    expect(understanding.understand).not.toHaveBeenCalled();
    expect(recordOf(store, "training_name")?.status).toBe("declined");
    expect(result.questionKey).toBe("current_city");
  });

  it("a real answer is stored as today, and its follow-up is asked", async () => {
    const { orchestrator, store } = makeWorld(verdict());
    const result = await orchestrator.takeTurn(say("ITI se welding ka course"));
    expect(recordOf(store, "training_name")).toMatchObject({
      status: "answered",
      value_raw: "ITI se welding ka course",
    });
    expect(result.questionKey).toBe("training_provider");
  });

  it("an unsure 'none' is not acted on — the words are stored as today", async () => {
    const { orchestrator, store } = makeWorld(verdict({ on_screen_none: true, confidence: 0.4 }));
    await orchestrator.takeTurn(say("koi course nahi kiya"));
    expect(recordOf(store, "training_name")?.status).toBe("answered");
  });
});

// The v5 trio's conditions, verbatim (qp_universal@5): the gate opens the group, and the year
// additionally requires the provider NOT declined.
const GATE = item({
  question_key: "training_done",
  prompt_text: "Kya aapne koi training ya course kiya hai?",
  answer_type: "boolean",
});
const V5: QuestionPack = {
  ...UNIVERSAL,
  version: 5,
  content_hash: "hash_universal_v5",
  items: [
    GATE,
    item({
      ...TRAINING,
      ask_if: { op: "eq", left: { field: "training_done" }, right: { const: true } },
    }),
    item({ ...PROVIDER }),
    item({
      ...YEAR,
      ask_if: {
        op: "all",
        predicates: [
          { op: "answered", field: "training_name" },
          { op: "not", predicate: { op: "declined", field: "training_provider" } },
        ],
      },
    }),
    item({ ...CITY }),
  ],
};

describe("2026-10-17 — a refusal exits the trio and is never stored as an answer", () => {
  it("'not interested' on the boolean GATE declines it — the trio never opens", async () => {
    const { orchestrator, store } = makeWorld(
      verdict({ on_screen_none: false }),
      "training_done",
      V5,
    );
    const result = await orchestrator.takeTurn(say("not interested"));
    expect(recordOf(store, "training_done")).toMatchObject({ status: "declined", value_raw: null });
    expect(recordOf(store, "training_name")).toBeUndefined();
    expect(result.questionKey).toBe("current_city");
  });

  it("a real 'nahi' on the gate is its ANSWER (false), never a decline", async () => {
    const { orchestrator, store } = makeWorld(verdict(), "training_done", V5);
    const result = await orchestrator.takeTurn(say("nahi"));
    expect(recordOf(store, "training_done")?.status).toBe("answered");
    expect(recordOf(store, "training_name")).toBeUndefined();
    expect(result.questionKey).toBe("current_city");
  });

  it("'not interested' on the free-text NAME declines it — the follow-ups are skipped", async () => {
    const { orchestrator, store } = makeWorld(verdict(), "training_name", V5);
    const result = await orchestrator.takeTurn(say("not interested"));
    expect(recordOf(store, "training_name")).toMatchObject({ status: "declined", value_raw: null });
    expect(recordOf(store, "training_provider")).toBeUndefined();
    expect(result.questionKey).toBe("current_city");
  });

  it("the model's 'does not apply' reading declines the NAME the same way", async () => {
    const { orchestrator, store } = makeWorld(
      verdict({ on_screen_none: true }),
      "training_name",
      V5,
    );
    const result = await orchestrator.takeTurn(say("main driver hoon, yeh mera kaam nahi"));
    expect(recordOf(store, "training_name")).toMatchObject({ status: "declined", value_raw: null });
    expect(result.questionKey).toBe("current_city");
  });
});
