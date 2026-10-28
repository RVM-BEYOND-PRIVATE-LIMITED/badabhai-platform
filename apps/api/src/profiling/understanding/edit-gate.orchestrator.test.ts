import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type {
  ProfilingTurnUnderstandOutput,
  QuestionPack,
  QuestionPackItem,
} from "@badabhai/ai-contracts";
import { validateEvent } from "@badabhai/event-schema";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "../conversation-state";
import { ROLE_CHANGE_POINTER_PAIR, STEER_BACK_TEXT } from "../next-question";
import { ProfilingOrchestrator } from "../orchestrator.service";
import { EDIT_DELETE_WARNING } from "./edit-gate";

/**
 * ADR-0057 §3.4 (#2312) — the Haan/Nahi gate on a filled field, through the real orchestrator.
 *
 * The fake understanding service stands in for the model; everything else is the real decision:
 * the walls, capture, the cross-question fill, the proposal's checks, the gate's turn, Haan's
 * write and the question it puts back.
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

const AVAIL = item({
  question_key: "availability",
  target_field: "availability",
  answer_type: "single_select",
  prompt_text: "Aap kab se kaam shuru kar sakte hain?",
  options: [
    { option_key: "immediate", label_text: "Turant", implies_skill_id: null, is_none_of_above: false, value: null },
    { option_key: "month", label_text: "Ek mahine mein", implies_skill_id: null, is_none_of_above: false, value: null },
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
  items: [YEARS, TRAINING, AVAIL, CITY],
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
  verdicts: readonly (ProfilingTurnUnderstandOutput | null)[] = [],
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
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
  };
  const registry = {
    loadUniversal: vi.fn(async () => pack),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = { findPackPin: vi.fn(async () => null), pinPack: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = { leads: () => false, take: vi.fn(async () => null) };
  const resumeSuggestions = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
    identityForChat: vi.fn(async () => null),
  };
  const workers = { findCurrentCity: vi.fn(async () => null) };
  const queue = [...verdicts];
  const understanding = {
    understand: vi.fn(async () => (queue.length > 0 ? queue.shift() ?? null : verdict())),
    bridge: vi.fn(async () => null),
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

/** Experience and training answered; the availability question on screen. */
function seed(store: Map<string, TranscriptBuffer>, envelope: Partial<ProfilingEnvelope> = {}) {
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
      answerMap: [answered("experience_years", 5, "5 saal"), answered("training_name", "CNC Basics", "CNC Basics")],
      servedQuestionKey: "availability",
      engineAsks: 3,
      askCounts: { experience_years: 1, training_name: 1, availability: 1 },
      ...envelope,
    },
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };

let submission = 0;
const say = (text: string) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: T0,
  submissionId: `00000000-0000-4000-8000-${String(++submission).padStart(12, "0")}`,
  voiceNoteId: null,
  understanding: true,
  knownName: async () => null,
  ctx: CTX as never,
});

const held = (store: Map<string, TranscriptBuffer>) => store.get(SESSION)?.profiling as ProfilingEnvelope;
const recordOf = (store: Map<string, TranscriptBuffer>, key: string) =>
  held(store).answerMap.find((a) => a.question_key === key);

function emitted(events: { emit: ReturnType<typeof vi.fn> }, name: string) {
  return events.emit.mock.calls
    .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
    .filter((params) => params.event_name === name);
}

/** Every edit-gate event the turn emitted validates against its registered schema. */
function expectValidEvents(events: { emit: ReturnType<typeof vi.fn> }) {
  for (const [params] of events.emit.mock.calls) {
    const p = params as { event_name: string; payload: unknown };
    if (!p.event_name.startsWith("profiling.field_edit_")) continue;
    const result = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: p.event_name,
      event_version: 1,
      occurred_at: T0.toISOString(),
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "chat_session", subject_id: SESSION },
      source: "api",
      correlation_id: CTX.correlationId,
      causation_id: null,
      payload: p.payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(result.success).toBe(true);
  }
}

const CHANGE_YEARS = verdict({
  intent: "edit",
  edits: [{ op: "edit", key: "experience_years", ref: null, value: "2" }],
});

describe("ADR-0057 #2312 — a change to a filled field is put to the worker, never written", () => {
  it("puts the before → after to the worker, with the tile, and leaves the value alone", async () => {
    const { orchestrator, store, events } = makeWorld([CHANGE_YEARS]);
    seed(store);
    const result = await orchestrator.takeTurn(say("experience 5 nahi, 2 saal hai"));

    expect(result.reply).toBe("Experience: 5 saal se 2 saal kar doon?");
    expect(result.options.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    expect(result.inputMode).toBe("options_only");
    expect(result.questionKey).toBeNull();
    expect(result.editProposal?.rows).toEqual([
      { field_label: "Experience", op: "edit", before: "5 saal", after: "2 saal" },
    ]);
    // Nothing written, and nothing filed under the question on screen.
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(5);
    expect(recordOf(store, "availability")).toBeUndefined();
    // The gate holds the question it displaced; no question is on screen meanwhile.
    expect(held(store).servedQuestionKey).toBeNull();
    expect(held(store).editGate).toMatchObject({ resumeKey: "availability", awaiting: null });
    // The transcript and the replay cache say what the worker read.
    expect(store.get(SESSION)?.messages.at(-1)?.text).toBe(result.reply);
    expect(held(store).lastTurn?.reply).toBe(result.reply);
    expect(emitted(events, "profiling.field_edit_proposed")).toHaveLength(1);
    expectValidEvents(events);
  });

  it("Haan writes it once, keeps the old value as history, and puts the question back", async () => {
    const { orchestrator, store, events } = makeWorld([CHANGE_YEARS]);
    seed(store);
    const proposed = await orchestrator.takeTurn(say("experience 5 nahi, 2 saal hai"));
    const done = await orchestrator.takeTurn(say("Haan"));

    expect(recordOf(store, "experience_years")).toMatchObject({ value_normalized: 2 });
    expect(recordOf(store, "experience_years")?.history[0]).toMatchObject({ value_normalized: 5, status: "superseded" });
    expect(done.reply).toBe(`Theek hai, badal diya. ${AVAIL.prompt_text}`);
    expect(done.questionKey).toBe("availability");
    expect(done.editProposal).toBeUndefined();
    expect(held(store).editGate).toBeNull();
    // The displaced question was asked once, not twice.
    expect(held(store).askCounts.availability).toBe(1);
    const confirmed = emitted(events, "profiling.field_edit_confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.payload).toMatchObject({
      proposal_id: proposed.editProposal?.proposal_id,
      field_key: "experience_years",
      op: "edit",
    });

    // #2313 (R9) — the change is on the ledger the flush persists for the profile build.
    expect(held(store).editLedger).toEqual([
      { key: "experience_years", op: "edit", targetField: "experience_years" },
    ]);

    // A SECOND Haan (a double tap) finds no proposal: nothing is written twice.
    await orchestrator.takeTurn(say("Haan"));
    expect(emitted(events, "profiling.field_edit_confirmed")).toHaveLength(1);
    expect(held(store).editLedger).toHaveLength(1);
    expect(recordOf(store, "experience_years")?.history).toHaveLength(1);
    expectValidEvents(events);
  });

  it("Nahi writes nothing and puts the question back", async () => {
    const { orchestrator, store, events } = makeWorld([CHANGE_YEARS]);
    seed(store);
    await orchestrator.takeTurn(say("experience 5 nahi, 2 saal hai"));
    const done = await orchestrator.takeTurn(say("Nahi"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(5);
    expect(done.reply).toBe(`Theek hai, kuch nahi badla. ${AVAIL.prompt_text}`);
    // Nothing confirmed, nothing for the profile build to honour.
    expect(held(store).editLedger).toEqual([]);
    expect(emitted(events, "profiling.field_edit_cancelled")[0]?.payload).toMatchObject({ reason: "declined" });
    expectValidEvents(events);
  });

  it("a typed message instead lapses it, and is read like any other — here, as a new change", async () => {
    const { orchestrator, store, events } = makeWorld([
      CHANGE_YEARS,
      verdict({ intent: "edit", edits: [{ op: "edit", key: "experience_years", ref: null, value: "3" }] }),
    ]);
    seed(store);
    const first = await orchestrator.takeTurn(say("experience 5 nahi, 2 saal hai"));
    const second = await orchestrator.takeTurn(say("nahi nahi, 3 saal"));
    expect(emitted(events, "profiling.field_edit_cancelled")[0]?.payload).toMatchObject({ reason: "lapsed" });
    expect(second.reply).toBe("Experience: 5 saal se 3 saal kar doon?");
    expect(second.editProposal?.proposal_id).not.toBe(first.editProposal?.proposal_id);
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(5);
    expectValidEvents(events);
  });
});

describe("ADR-0057 #2312 — a removal carries its warning, and the field can be asked again", () => {
  it("warns, removes on Haan, and the removed field is askable again", async () => {
    const { orchestrator, store } = makeWorld([
      verdict({ intent: "delete", edits: [{ op: "delete", key: "training_name", ref: null, value: null }] }),
    ]);
    seed(store);
    const asked = await orchestrator.takeTurn(say("training wali baat hata do"));
    expect(asked.reply).toBe(`Koi training ki hai: CNC Basics hata doon? ${EDIT_DELETE_WARNING}`);
    expect(asked.editProposal?.rows[0]).toMatchObject({ op: "delete", after: null, warning: EDIT_DELETE_WARNING });

    const done = await orchestrator.takeTurn(say("Haan"));
    // Gone, with its ask budget: the engine may ask it again, in the pack's own order.
    expect(recordOf(store, "training_name")).toBeUndefined();
    expect(held(store).askCounts.training_name).toBeUndefined();
    expect(done.reply).toBe(`Theek hai, hata diya. ${AVAIL.prompt_text}`);

    // Answering the question put back, the engine reaches the removed one again.
    await orchestrator.takeTurn(say("Turant"));
    const next = await orchestrator.takeTurn(say("Pune"));
    expect(next.questionKey).toBe("training_name");
  });
});

describe("ADR-0057 #2312 — a field named as wrong with no new value is asked for", () => {
  it("asks for it over the field's own question, then confirms the answer", async () => {
    const { orchestrator, store } = makeWorld([
      verdict({ intent: "edit", edits: [{ op: "edit", key: "experience_years", ref: null, value: null }] }),
    ]);
    seed(store);
    const asked = await orchestrator.takeTurn(say("experience galat likha hai"));
    expect(asked.reply).toBe(`Theek hai, sahi Experience bataiye. ${YEARS.prompt_text}`);
    expect(asked.inputMode).toBe("text");
    expect(held(store).editGate?.awaiting).toMatchObject({ key: "experience_years" });

    const proposed = await orchestrator.takeTurn(say("2 saal"));
    expect(proposed.reply).toBe("Experience: 5 saal se 2 saal kar doon?");
    expect(held(store).editGate?.resumeKey).toBe("availability");

    const done = await orchestrator.takeTurn(say("Haan"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(2);
    expect(done.questionKey).toBe("availability");
  });
});

describe("#2467 — a correction to another field is never the answer to the question on screen", () => {
  const TRAVEL = item({
    question_key: "willing_to_travel",
    target_field: "willing_to_travel",
    answer_type: "boolean",
    prompt_text: "Kya aap ghar se door kaam ke liye ja sakte hain?",
  });
  const WITH_TRAVEL: QuestionPack = { ...UNIVERSAL, items: [YEARS, TRAINING, AVAIL, TRAVEL, CITY] };
  // The production message (28 Oct 2026): a notice-period correction typed over the travel
  // question, with a stray "Nahin" the yes/no parser reads as `false`.
  const CORRECTION =
    "pahle Mujhe yah batao Mera notice period ek mahine ka Nahin Hai Mera 3 mahine ka hai lekin " +
    "vahan per Koi option nahin tha to usko change karke 3 Mahina kar do";
  // Everything else settled, as the engine would have it by the travel question (TRAVEL is built
  // after CITY, so its display order puts it last).
  const travelOnScreen = {
    answerMap: [
      answered("experience_years", 5, "5 saal"),
      answered("training_name", "CNC Basics", "CNC Basics"),
      answered("availability", "month", "Ek mahine mein"),
      answered("current_city", "Pune", "Pune"),
    ],
    servedQuestionKey: "willing_to_travel",
    askCounts: { experience_years: 1, training_name: 1, availability: 1, current_city: 1, willing_to_travel: 1 },
  };

  it("the production correction: a 3-month notice is put to the worker, saved on Haan, travel resumed", async () => {
    const { orchestrator, store } = makeWorld(
      [verdict({ intent: "edit", confidence: 0.8, edits: [{ op: "edit", key: "availability", ref: null, value: "3 months" }] })],
      WITH_TRAVEL,
    );
    seed(store, travelOnScreen);
    const proposed = await orchestrator.takeTurn(say(CORRECTION));
    // Shown in the worker's words, never as the code "notice_period".
    expect(proposed.reply).toBe("Kab join kar sakte hain: Ek mahine mein se 3 months kar doon?");
    expect(recordOf(store, "willing_to_travel")).toBeUndefined();
    expect(held(store).editGate).toMatchObject({ resumeKey: "willing_to_travel" });

    const done = await orchestrator.takeTurn(say("Haan"));
    expect(recordOf(store, "availability")?.value_normalized).toBe("notice_period");
    expect(recordOf(store, "notice_period_days")?.value_normalized).toBe(90);
    expect(done.reply).toBe(`Theek hai, badal diya. ${TRAVEL.prompt_text}`);
    expect(done.questionKey).toBe("willing_to_travel");
    expect(recordOf(store, "willing_to_travel")).toBeUndefined();
    expect(held(store).askCounts.willing_to_travel).toBe(1);
  });

  it("a value the field cannot read asks for the field (with the typed chip), confirms it, then resumes travel", async () => {
    const { orchestrator, store } = makeWorld(
      [verdict({ intent: "edit", confidence: 0.8, edits: [{ op: "edit", key: "availability", ref: null, value: "Diwali ke baad" }] })],
      WITH_TRAVEL,
    );
    seed(store, travelOnScreen);
    const asked = await orchestrator.takeTurn(say(CORRECTION));
    expect(asked.reply).toBe("Theek hai, sahi Kab join kar sakte hain bataiye. Aap kab se kaam shuru kar sakte hain?");
    expect(asked.options.map((o) => o.option_key)).toEqual(["immediate", "month", "kuch_aur"]);
    expect(recordOf(store, "willing_to_travel")).toBeUndefined();
    expect(held(store).editGate).toMatchObject({ resumeKey: "willing_to_travel", awaiting: { key: "availability" } });

    const proposed = await orchestrator.takeTurn(say("Turant"));
    expect(proposed.reply).toMatch(/: Ek mahine mein se Turant kar doon\?$/);
    const done = await orchestrator.takeTurn(say("Haan"));
    expect(recordOf(store, "availability")).toMatchObject({ value_raw: "Turant" });
    expect(recordOf(store, "availability")?.history[0]).toMatchObject({ value_normalized: "month", status: "superseded" });
    expect(done.questionKey).toBe("willing_to_travel");
    expect(recordOf(store, "willing_to_travel")).toBeUndefined();
    expect(held(store).askCounts.willing_to_travel).toBe(1);
  });

  it("availability is served with the typed chip, and a typed '3 mahine' is a 3-month notice", async () => {
    const { orchestrator, store } = makeWorld();
    seed(store, {
      answerMap: [answered("experience_years", 5, "5 saal")],
      servedQuestionKey: "training_name",
      askCounts: { experience_years: 1, training_name: 1 },
    });
    const served = await orchestrator.takeTurn(say("CNC Basics"));
    expect(served.questionKey).toBe("availability");
    expect(served.options.map((o) => o.option_key)).toEqual(["immediate", "month", "kuch_aur"]);

    await orchestrator.takeTurn(say("3 mahine"));
    expect(recordOf(store, "availability")?.value_normalized).toBe("notice_period");
    expect(recordOf(store, "notice_period_days")?.value_normalized).toBe(90);
  });

  it("a change nothing can be proposed for re-asks the question on screen, unspent", async () => {
    const { orchestrator, store } = makeWorld(
      [verdict({ intent: "edit", confidence: 0.8, edits: [{ op: "edit", key: "notice_note", ref: null, value: "3 mahine" }] })],
      WITH_TRAVEL,
    );
    seed(store, travelOnScreen);
    const result = await orchestrator.takeTurn(say(CORRECTION));
    expect(result.reply).toBe(`${STEER_BACK_TEXT} ${TRAVEL.prompt_text}`);
    expect(result.questionKey).toBe("willing_to_travel");
    expect(recordOf(store, "willing_to_travel")).toBeUndefined();
    expect(held(store).askCounts.willing_to_travel).toBe(1);
  });

  it("an edit that names the question on screen is still read as its answer", async () => {
    const { orchestrator, store } = makeWorld(
      [verdict({ intent: "edit", confidence: 0.8, edits: [{ op: "edit", key: "willing_to_travel", ref: null, value: "false" }] })],
      WITH_TRAVEL,
    );
    seed(store, travelOnScreen);
    await orchestrator.takeTurn(say("nahi, door nahi ja sakta"));
    expect(recordOf(store, "willing_to_travel")?.value_normalized).toBe(false);
  });
});

describe("ADR-0057 #2312 — the deterministic correction is put to the worker when armed", () => {
  it("'galat' with one changed field becomes a proposal, not a silent overwrite", async () => {
    const { orchestrator, store } = makeWorld([verdict({ intent: "statement" })]);
    seed(store);
    const result = await orchestrator.takeTurn(say("galat bataya tha, 2 saal ka experience hai"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(5);
    expect(result.editProposal?.rows[0]).toMatchObject({ before: "5 saal", after: "2 saal" });
  });
});

describe("#2379 — a correction typed with a new fact, read as a statement", () => {
  // The model's verdict for this message in the 2026-10-20 eval: the edit row and the fill exact,
  // the intent `statement` (not `edit`).
  const TEXT = "experience 5 nahi 6 saal hai, aur roz 15 km tak aa sakta hoon";
  const MIXED = verdict({
    intent: "statement",
    confidence: 0.85,
    edits: [{ op: "edit", key: "experience_years", ref: null, value: "6" }],
  });

  it("over a free-text question: the change is put to the worker, and the message is not its answer", async () => {
    const { orchestrator, store, events } = makeWorld([MIXED]);
    // Everything before the training in pack order is settled, as the engine would have it.
    seed(store, {
      answerMap: [
        answered("experience_years", 5, "5 saal"),
        answered("availability", "immediate", "Turant"),
        answered("current_city", "Pune", "Pune"),
      ],
      servedQuestionKey: "training_name",
      askCounts: { experience_years: 1, availability: 1, current_city: 1, training_name: 1 },
    });
    const proposed = await orchestrator.takeTurn(say(TEXT));
    expect(proposed.reply).toBe("Experience: 5 saal se 6 saal kar doon?");
    expect(recordOf(store, "training_name")).toBeUndefined();
    expect(held(store).editGate).toMatchObject({ resumeKey: "training_name" });

    const done = await orchestrator.takeTurn(say("Haan"));
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(6);
    expect(done.reply).toBe(`Theek hai, badal diya. ${TRAINING.prompt_text}`);
    expect(held(store).askCounts.training_name).toBe(1);
    expectValidEvents(events);
  });

  it("over a typed question: the question on screen is resumed, never skipped as unanswered", async () => {
    const { orchestrator, store } = makeWorld([MIXED]);
    seed(store);
    const proposed = await orchestrator.takeTurn(say(TEXT));
    expect(proposed.editProposal?.rows).toEqual([
      { field_label: "Experience", op: "edit", before: "5 saal", after: "6 saal" },
    ]);
    expect(recordOf(store, "availability")).toBeUndefined();
    expect(held(store).editGate).toMatchObject({ resumeKey: "availability" });

    const done = await orchestrator.takeTurn(say("Nahi"));
    expect(done.questionKey).toBe("availability");
    expect(held(store).askCounts.availability).toBe(1);
  });
});

describe("ADR-0057 #2312 — the trade is changed on the Profile page, not here", () => {
  it("answers with the pointer above the question, and records why nothing changed", async () => {
    const { orchestrator, store, events } = makeWorld([
      verdict({ intent: "edit", edits: [{ op: "edit", key: "role", ref: null, value: "Welder" }] }),
    ]);
    seed(store, {
      llmDraft: { domain_label: null, role_label: "Fitter", skills: [], experiences: [] },
    });
    const result = await orchestrator.takeTurn(say("main fitter nahi, welder hoon"));
    expect(result.reply).toBe(`${ROLE_CHANGE_POINTER_PAIR[0]} ${AVAIL.prompt_text}`);
    expect(result.editProposal).toBeUndefined();
    expect(held(store).editGate).toBeNull();
    expect(emitted(events, "profiling.field_edit_cancelled")[0]?.payload).toMatchObject({
      field_key: "role",
      reason: "profile_page",
    });
    expectValidEvents(events);
  });
});

describe("ADR-0057 #2312 — the gate survives a retry and a reopen", () => {
  it("a re-sent submission replays the confirmation with its tile", async () => {
    const { orchestrator, store } = makeWorld([CHANGE_YEARS]);
    seed(store);
    const input = say("experience 5 nahi, 2 saal hai");
    const first = await orchestrator.takeTurn(input);
    const again = await orchestrator.takeTurn(input);
    expect(again.replayed).toBe(true);
    expect(again.reply).toBe(first.reply);
    expect(again.editProposal).toEqual(first.editProposal);
    expect(again.inputMode).toBe("options_only");
  });

  it("a reopened session redraws the gate, never the question it displaced", async () => {
    const { orchestrator, store } = makeWorld([CHANGE_YEARS]);
    seed(store);
    const first = await orchestrator.takeTurn(say("experience 5 nahi, 2 saal hai"));
    const reopened = await orchestrator.openTurn({ sessionId: SESSION, workerId: WORKER, now: T0, ctx: CTX as never });
    expect(reopened.reply).toBe(first.reply);
    expect(reopened.questionKey).toBeNull();
    expect(reopened.editProposal).toEqual(first.editProposal);
  });
});

describe("ADR-0057 #2312 — fail safe to today's turn", () => {
  it("with the layer off, a change is never proposed", async () => {
    const { orchestrator, store, understanding } = makeWorld([CHANGE_YEARS]);
    seed(store);
    const result = await orchestrator.takeTurn({ ...say("experience 5 nahi, 2 saal hai"), understanding: false });
    expect(understanding.understand).not.toHaveBeenCalled();
    expect(result.editProposal).toBeUndefined();
    expect(held(store).editGate).toBeNull();
  });

  it("an unavailable verdict keeps today's silent correction", async () => {
    const { orchestrator, store } = makeWorld([null]);
    seed(store);
    const result = await orchestrator.takeTurn(say("galat bataya tha, 2 saal ka experience hai"));
    expect(result.editProposal).toBeUndefined();
    expect(recordOf(store, "experience_years")?.value_normalized).toBe(2);
  });
});
