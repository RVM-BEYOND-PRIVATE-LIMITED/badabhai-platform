import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type {
  ProfilingTurnUnderstandOutput,
  QuestionPack,
  QuestionPackItem,
} from "@badabhai/ai-contracts";

import type { BufferedMessage, TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "../conversation-state";
import type { LlmTurnResult } from "../llm-turn.service";
import { ProfilingOrchestrator } from "../orchestrator.service";

/**
 * Token-audit fix Q2 — a message the turn understanding read as CHAT ONLY, through the real
 * orchestrator: which lines are flagged for the extraction to leave out, and the city guard.
 *
 * The fake understanding service stands in for the model and returns the verdicts the audit's run 7
 * recorded (`chat`, 0.95, nothing filled, no Profile-page mention). Everything else is the real
 * decision. Two stretches: a pack question on screen, and the AI-led stretch after the worker
 * confirmed his trade and declined the form — where run 7's first three side questions were asked.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-22T10:00:00.000Z");
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };

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

const TRADE = item({
  question_key: "primary_trade",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  is_mandatory: true,
});
const AVAIL = item({
  question_key: "availability",
  target_field: "availability",
  answer_type: "single_select",
  prompt_text: "Aap kaam kab se shuru kar sakte hain?",
  options: [
    {
      option_key: "immediate",
      label_text: "Turant",
      implies_skill_id: null,
      is_none_of_above: false,
      value: null,
    },
    {
      option_key: "month",
      label_text: "Ek mahine mein",
      implies_skill_id: null,
      is_none_of_above: false,
      value: null,
    },
  ],
});
const CITY = item({
  question_key: "current_city",
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
  items: [TRADE, AVAIL, CITY],
};

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_turn_understand",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  created_at: "2026-10-22T10:00:00Z",
};

/** Run 7's reading of each side question: chat, 0.95, nothing in it. */
function chatVerdict(
  over: Partial<ProfilingTurnUnderstandOutput> = {},
): ProfilingTurnUnderstandOutput {
  return {
    intent: "chat",
    confidence: 0.95,
    fills: [],
    edits: [],
    page_owned_mentions: [],
    on_screen_none: false,
    blocked: false,
    ai_metadata: META as never,
    ...over,
  };
}

/** What Phase A hands back each turn: the trade it named, and its next question. */
function led(skills: string[] = []): LlmTurnResult {
  return {
    kind: "ask",
    reply: "Theek hai. Aap programme feed kar sakte ho?",
    chips: [],
    inputMode: "text",
    patch: {
      llmStage: "role",
      llmLedTurns: 1,
      llmAsks: 1,
      llmDraft: {
        domain_label: "CNC Machining",
        role_label: "CNC Turner",
        skills,
        experiences: [],
      },
    },
  };
}

function makeWorld(opts: {
  /** The AI-led stretch (the model leads until its stage is done) or the pack stretch. */
  readonly leads: boolean;
  /** The layer's reading of a message; null (no verdict) for any message not listed. */
  readonly verdicts?: Readonly<Record<string, ProfilingTurnUnderstandOutput>>;
  readonly turn?: LlmTurnResult;
}) {
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
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: (envelope: ProfilingEnvelope) =>
      opts.leads && envelope.llmStage !== "done" && !envelope.llmFallback,
    take: vi.fn(async () => opts.turn ?? led()),
  };
  const understanding = {
    understand: vi.fn(async (input: { text: string }) => opts.verdicts?.[input.text] ?? null),
    bridge: vi.fn(async () => "Haan, Gurgaon mein bahut companies hain."),
  };
  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
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
  return { orchestrator, store, llm, understanding };
}

/** An empty buffer on the pack stretch, `availability` on screen. */
function seedPackStretch(
  store: Map<string, TranscriptBuffer>,
  envelope: Partial<ProfilingEnvelope> = {},
) {
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [
      {
        role: "assistant",
        text: AVAIL.prompt_text,
        at: T0.toISOString(),
        voiceNoteId: null,
        options: ["Turant", "Ek mahine mein"],
      },
    ],
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

function seedFresh(store: Map<string, TranscriptBuffer>) {
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: { ...emptyProfilingEnvelope(), rev: 1 },
  });
}

interface SayOpts {
  readonly flag?: boolean;
  readonly cityGuard?: boolean;
}

const say = (text: string, o: SayOpts = {}) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: null,
  voiceNoteId: null,
  understanding: true,
  ...(o.flag === true ? { flagChatOnly: true } : {}),
  ...(o.cityGuard === true ? { chatOnlyCityGuard: true } : {}),
  knownName: async () => null,
  ctx: CTX as never,
});

const lines = (store: Map<string, TranscriptBuffer>): BufferedMessage[] =>
  store.get(SESSION)?.messages ?? [];
const lastTwo = (store: Map<string, TranscriptBuffer>) => lines(store).slice(-2);
const cityOf = (store: Map<string, TranscriptBuffer>) =>
  store.get(SESSION)?.profiling?.answerMap.find((a) => a.question_key === "current_city");

const GURGAON = "gurgaon mein koi company hai jo 38 de de turner ko?";
const PUNE = "bhai pune mein 10 saal wale CNC turner ko kitna milta hai?";

/**
 * The AI-led stretch, as run 7 reached it: the opener names the trade, Haan confirms it, the form
 * is offered and declined. The next message is the model's to answer.
 */
async function intoTheLedStretch(world: ReturnType<typeof makeWorld>) {
  seedFresh(world.store);
  await world.orchestrator.takeTurn(say("main cnc turner hoon"));
  await world.orchestrator.takeTurn(say("Haan"));
  await world.orchestrator.takeTurn(say("form_offer_no"));
  // Nothing so far was read as chat only, so nothing is flagged.
  expect(lines(world.store).some((line) => line.chatOnly === true)).toBe(false);
  expect(world.store.get(SESSION)?.profiling?.formOfferPrompt).toEqual({
    kind: "cnc_turner",
    state: "settled",
  });
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("fix Q2 — the switches off are today's turn exactly", () => {
  it("a chat-only message over a pack question flags nothing", async () => {
    const { orchestrator, store } = makeWorld({
      leads: false,
      verdicts: { [GURGAON]: chatVerdict() },
    });
    seedPackStretch(store);
    await orchestrator.takeTurn(say(GURGAON));
    // The turn itself is #2311's side message, exactly as before: the question again, unspent.
    expect(lastTwo(store).map((line) => line.text)).toEqual([
      GURGAON,
      `Haan, Gurgaon mein bahut companies hain. ${AVAIL.prompt_text}`,
    ]);
    expect(lines(store).every((line) => !("chatOnly" in line))).toBe(true);
  });

  it("on the AI-led stretch the cross-fill still takes the city a question names (the defect)", async () => {
    const world = makeWorld({ leads: true, verdicts: { [PUNE]: chatVerdict() } });
    await intoTheLedStretch(world);
    await world.orchestrator.takeTurn(say(PUNE, { flag: true }));
    // Pinned as today's behaviour: the guard is what changes it.
    expect(cityOf(world.store)?.value_normalized).toBe("Pune");
    // A turn that wrote a fact is never flagged, whatever the layer read.
    expect(lines(world.store).every((line) => !("chatOnly" in line))).toBe(true);
  });
});

describe("fix Q2 — a chat-only message over a pack question", () => {
  it("flags the message and the reply that served the same question again", async () => {
    const { orchestrator, store } = makeWorld({
      leads: false,
      verdicts: { [GURGAON]: chatVerdict() },
    });
    seedPackStretch(store);
    const result = await orchestrator.takeTurn(say(GURGAON, { flag: true }));
    expect(result.questionKey).toBe("availability");
    const [worker, reply] = lastTwo(store);
    expect(worker).toMatchObject({ role: "worker", text: GURGAON, chatOnly: true });
    expect(reply).toMatchObject({ role: "assistant", text: result.reply, chatOnly: true });
    // The question it served again is still asked by the line before the chat, unflagged.
    expect(lines(store)[0]).toMatchObject({ text: AVAIL.prompt_text });
    expect("chatOnly" in lines(store)[0]!).toBe(false);
    // Nothing was recorded, and the answer that follows is an ordinary line.
    expect(store.get(SESSION)?.profiling?.answerMap).toEqual([]);
    await orchestrator.takeTurn(say("Turant", { flag: true }));
    expect(lines(store).find((line) => line.text === "Turant")).not.toHaveProperty("chatOnly");
  });

  it("flags nothing when the layer heard a Profile-page fact (owner ruling #1505-2)", async () => {
    const { orchestrator, store } = makeWorld({
      leads: false,
      verdicts: { [GURGAON]: chatVerdict({ page_owned_mentions: ["expected_salary"] }) },
    });
    seedPackStretch(store);
    await orchestrator.takeTurn(say(GURGAON, { flag: true }));
    expect(lines(store).every((line) => !("chatOnly" in line))).toBe(true);
  });

  it("flags nothing below the confidence floor", async () => {
    const { orchestrator, store } = makeWorld({
      leads: false,
      verdicts: { [GURGAON]: chatVerdict({ confidence: 0.5 }) },
    });
    seedPackStretch(store);
    await orchestrator.takeTurn(say(GURGAON, { flag: true }));
    expect(lines(store).every((line) => !("chatOnly" in line))).toBe(true);
  });

  it("flags nothing for any other reading: a statement, a filled chat, or no verdict", async () => {
    for (const verdict of [
      chatVerdict({ intent: "statement", fills: [{ key: "current_city", value: "Gurgaon" }] }),
      chatVerdict({ fills: [{ key: "current_city", value: "Gurgaon" }] }),
      null,
    ]) {
      const { orchestrator, store } = makeWorld({
        leads: false,
        ...(verdict === null ? {} : { verdicts: { [GURGAON]: verdict } }),
      });
      seedPackStretch(store);
      await orchestrator.takeTurn(say(GURGAON, { flag: true }));
      expect(lines(store).every((line) => !("chatOnly" in line))).toBe(true);
    }
  });
});

describe("fix Q2 — a chat-only message on the AI-led stretch", () => {
  it("with the city guard, no city is taken, and the message alone is flagged", async () => {
    const world = makeWorld({ leads: true, verdicts: { [PUNE]: chatVerdict() } });
    await intoTheLedStretch(world);
    const result = await world.orchestrator.takeTurn(say(PUNE, { flag: true, cityGuard: true }));
    expect(cityOf(world.store)).toBeUndefined();
    const [worker, reply] = lastTwo(world.store);
    expect(worker).toMatchObject({ role: "worker", text: PUNE, chatOnly: true });
    // The reply is the model's next question, which the next answer needs: it stays.
    expect(reply).toMatchObject({ role: "assistant", text: result.reply });
    expect("chatOnly" in reply!).toBe(false);
  });

  it("the city guard alone changes the city and flags nothing", async () => {
    const world = makeWorld({ leads: true, verdicts: { [PUNE]: chatVerdict() } });
    await intoTheLedStretch(world);
    await world.orchestrator.takeTurn(say(PUNE, { cityGuard: true }));
    expect(cityOf(world.store)).toBeUndefined();
    expect(lines(world.store).every((line) => !("chatOnly" in line))).toBe(true);
  });

  it("the guard keeps the city a message STATES — the cross-fill still takes it", async () => {
    const statement = "main Pune mein rehta hoon";
    // A statement the layer did not fill: the deterministic cross-fill is the only writer, so this
    // is the case that shows the guard is keyed on the reading and not on the switch alone.
    for (const verdict of [
      chatVerdict({ intent: "statement" }),
      chatVerdict({ intent: "statement", fills: [{ key: "current_city", value: "Pune" }] }),
    ]) {
      const world = makeWorld({ leads: true, verdicts: { [statement]: verdict } });
      await intoTheLedStretch(world);
      await world.orchestrator.takeTurn(say(statement, { flag: true, cityGuard: true }));
      expect(cityOf(world.store)?.value_normalized).toBe("Pune");
      expect(lines(world.store).every((line) => !("chatOnly" in line))).toBe(true);
    }
  });

  it("flags nothing below the confidence floor, on a turn that wrote nothing", async () => {
    const vmc = "VMC seekhna chahiye kya? turner mein aage growth hai ya nahi?";
    const flaggedAt = async (confidence: number) => {
      const world = makeWorld({ leads: true, verdicts: { [vmc]: chatVerdict({ confidence }) } });
      await intoTheLedStretch(world);
      const answersBefore = JSON.stringify(world.store.get(SESSION)?.profiling?.answerMap);
      await world.orchestrator.takeTurn(say(vmc, { flag: true }));
      expect(JSON.stringify(world.store.get(SESSION)?.profiling?.answerMap)).toBe(answersBefore);
      expect(lastTwo(world.store)[0]?.text).toBe(vmc);
      return lastTwo(world.store)[0]?.chatOnly === true;
    };
    // The same message and the same empty turn; only the layer's certainty differs.
    expect(await flaggedAt(0.95)).toBe(true);
    expect(await flaggedAt(0.5)).toBe(false);
  });

  it("a model turn that adds to its draft is not flagged — the line carried something", async () => {
    const world = makeWorld({
      leads: true,
      verdicts: { [PUNE]: chatVerdict() },
      turn: led(),
    });
    await intoTheLedStretch(world);
    world.llm.take.mockResolvedValueOnce(led(["CNC lathe operation"]));
    await world.orchestrator.takeTurn(say(PUNE, { flag: true, cityGuard: true }));
    expect(world.store.get(SESSION)?.profiling?.llmDraft.skills).toEqual(["CNC lathe operation"]);
    expect(lines(world.store).every((line) => !("chatOnly" in line))).toBe(true);
  });
});
