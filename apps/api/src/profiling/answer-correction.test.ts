import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { AnswerRecord, QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import { ProfilingOrchestrator, MAX_CORRECTIONS_PER_SESSION } from "./orchestrator.service";
import { answerSetHash, toAnswerMap } from "./answer-map";

/**
 * THE ENGINE HALF OF THE CORRECTION PATH (#700, owner ruling 2026-08-08: targeted write).
 *
 * This is the only write in an interview that `nextQuestion` does not authorize. It exists because
 * the review screen is the last moment before the profile is built — a worker who sees a wrong
 * value there and cannot fix it submits it or abandons, and the wrong value is what reaches the
 * matcher.
 *
 * A SEPARATE FILE FROM `orchestrator.service.test.ts` deliberately. That suite's `chat` fake is
 * two methods wide — the turn loop is only allowed to read the pin and win it once — while this
 * path reads `chat_sessions` and writes two stores in a transaction. Widening the shared fake to
 * cover it would let a turn-loop test accidentally pass against a repository the turn loop is not
 * supposed to have.
 */

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" } as never;

const item = (over: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem =>
  ({
    prompt_text: `${over.question_key}?`,
    display_order: 0,
    target_kind: "rfs",
    target_field: over.question_key,
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
    ...over,
  }) as QuestionPackItem;

const answered = (questionKey: string, value: unknown, turn = 3): AnswerRecord =>
  ({
    question_key: questionKey,
    target_field: questionKey,
    value_raw: null,
    value_normalized: value,
    status: "answered",
    evidence: null,
    turn,
    history: [],
  }) as AnswerRecord;

const pack = (packId: string, items: QuestionPackItem[]): QuestionPack =>
  ({ pack_id: packId, version: 1, family_id: `fam_${packId}`, locale: "hi-IN", items }) as never;

function makeWorld(
  opts: {
    answerMap?: AnswerRecord[];
    correctionCount?: number;
    items?: QuestionPackItem[];
    pin?: { packId: string; packVersion: number } | null;
    state?: Record<string, unknown>;
  } = {},
) {
  const items = opts.items ?? [item({ question_key: "current_city" })];
  const pin = opts.pin === undefined ? { packId: "qp_universal", packVersion: 1 } : opts.pin;

  const saved: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[][] = [];
  const chat = {
    findSession: vi.fn(async () => ({
      id: SESSION,
      workerId: WORKER,
      status: "ended",
      packId: pin?.packId ?? null,
      packVersion: pin?.packVersion ?? null,
      conversationState: {
        // A field this path must PRESERVE rather than rebuild — the v1 half of the column is
        // owned by the transcript buffer, and a correction that dropped it would erase the
        // interview's own record to fix one answer.
        role_family: "welding",
        answer_map: opts.answerMap ?? [answered("current_city", "Mumbai")],
        correction_count: opts.correctionCount,
        ...opts.state,
      },
    })),
    // A REAL pass-through, so the write actually runs and its arguments are observable. A
    // transaction fake that swallowed the callback would make every assertion below vacuous.
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true })),
    saveConversationState: vi.fn(async (_id: string, state: Record<string, unknown>) => {
      saved.push(state);
    }),
    insertPackAnswers: vi.fn(async (_tx: unknown, rows: Record<string, unknown>[]) => {
      inserted.push(rows);
    }),
  };
  const registry = {
    loadUniversal: vi.fn(async () => pack("qp_universal", items)),
    loadPinned: vi.fn(async () => pack("qp_universal", items)),
    resolveForOccupation: vi.fn(async () => null),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };

  const orchestrator = new ProfilingOrchestrator(
    {} as never,
    registry as never,
    {} as never,
    chat as never,
    events as never,
    // The correction path never takes a turn, so the LLM seam is unreachable from here.
    { leads: () => false } as never,
  );
  return { orchestrator, chat, events, saved, inserted };
}

const correction = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  workerId: WORKER,
  questionKey: "current_city",
  text: "Pune",
  method: "text" as const,
  profileAlreadyBuilt: false,
  now: new Date("2026-08-08T12:00:00Z"),
  ctx: CTX,
  ...over,
});

describe("a correction supersedes rather than replaces", () => {
  it("keeps the previous value on history, marked superseded", async () => {
    // THE POINT OF THE WHOLE DESIGN. A correction that overwrote in place would leave no way to
    // tell a mis-capture from a worker who changed their mind, and the parse call reads history
    // to know which of two wordings won.
    const { orchestrator, saved } = makeWorld();

    const outcome = await orchestrator.correctAnswer(correction());

    expect(outcome).toEqual({
      kind: "corrected",
      value: "Pune",
      correctionCount: 1,
      // The rebuild trigger's key, handed back rather than recomputed by the caller — a hash of
      // anything other than exactly what landed would dedupe against the wrong answer set.
      answerSetHash: answerSetHash(toAnswerMap(saved[0]?.answer_map as AnswerRecord[])),
    });
    const map = saved[0]?.answer_map as AnswerRecord[];
    const record = map.find((r) => r.question_key === "current_city") as AnswerRecord;
    expect(record.value_normalized).toBe("Pune");
    expect(record.status).toBe("answered");
    expect(record.history).toEqual([
      expect.objectContaining({ value_normalized: "Mumbai", status: "superseded" }),
    ]);
  });

  it("does not grow history when the corrected value is the same one", async () => {
    // A worker re-confirming is not a correction, and a history of identical entries would make a
    // real one impossible to see.
    const { orchestrator, saved } = makeWorld();
    await orchestrator.correctAnswer(correction({ text: "Mumbai" }));
    const map = saved[0]?.answer_map as AnswerRecord[];
    expect((map.find((r) => r.question_key === "current_city") as AnswerRecord).history).toEqual(
      [],
    );
  });
});

describe("both durable stores, in one transaction", () => {
  it("writes conversation_state AND worker_pack_answer, and emits inside the transaction", async () => {
    // Writing only `worker_pack_answer` would leave a correction the worker can SEE and the
    // profile can never reflect: the extraction processor reads `conversation_state.answer_map`.
    const { orchestrator, chat, events, saved, inserted } = makeWorld();

    await orchestrator.correctAnswer(correction());

    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(inserted[0]).toEqual([
      expect.objectContaining({
        workerId: WORKER,
        chatSessionId: SESSION,
        packId: "qp_universal",
        packVersion: 1,
        questionKey: "current_city",
        answerText: "Pune",
        status: "answered",
        // `form`, not `chat` — this is the one write where the affordance is known.
        source: "form",
      }),
    ]);
    // Inside the transaction, so a rolled-back correction does not leave an event claiming it
    // happened.
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "profile.answer_corrected", tx: { tx: true } }),
    );
  });

  it("preserves the rest of conversation_state and refreshes the flattened projection", async () => {
    const { orchestrator, saved } = makeWorld();
    await orchestrator.correctAnswer(correction());

    expect(saved[0]?.role_family).toBe("welding");
    // `captured` is the v1 flattened map every pre-cutover reader still uses. Rebuilt from the
    // same corrected map, so the two halves of the column cannot disagree.
    expect(saved[0]?.captured).toEqual({ current_city: "Pune" });
    expect(saved[0]?.correction_count).toBe(1);
  });

  it("carries NO worker value in the event payload", async () => {
    // A correction is by nature about a value, which is exactly why the payload must not hold one.
    const { orchestrator, events } = makeWorld();
    await orchestrator.correctAnswer(correction());

    const payload = (events.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
      .payload;
    expect(JSON.stringify(payload)).not.toContain("Pune");
    expect(JSON.stringify(payload)).not.toContain("Mumbai");
    expect(payload).toEqual({
      worker_id: WORKER,
      session_id: SESSION,
      question_key: "current_city",
      pack_id: "qp_universal",
      pack_version: 1,
      method: "text",
      profile_already_built: false,
      correction_count: 1,
    });
  });
});

describe("the guards the turn loop is not here to provide", () => {
  it("returns `unreadable` and writes NOTHING when the words parse to no value", async () => {
    // `experience_years` runs a typed normalizer; "bakwaas" produces nothing for it. Fail closed:
    // this path cannot re-ask, so storing the sentence would confirm a correction that corrected
    // nothing.
    const { orchestrator, chat } = makeWorld({
      items: [item({ question_key: "experience_years", target_field: "experience_years" })],
      answerMap: [answered("experience_years", 8)],
    });

    const outcome = await orchestrator.correctAnswer(
      correction({ questionKey: "experience_years", text: "bakwaas" }),
    );

    expect(outcome).toEqual({ kind: "unreadable" });
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("caps the corrections one interview may take, and writes nothing at the cap", async () => {
    const { orchestrator, chat } = makeWorld({ correctionCount: MAX_CORRECTIONS_PER_SESSION });

    const outcome = await orchestrator.correctAnswer(correction());

    expect(outcome).toEqual({ kind: "capped", cap: MAX_CORRECTIONS_PER_SESSION });
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("counts up from whatever the session already recorded", async () => {
    const { orchestrator, saved } = makeWorld({ correctionCount: 4 });
    const outcome = await orchestrator.correctAnswer(correction());
    expect(outcome).toEqual(expect.objectContaining({ correctionCount: 5 }));
    expect(saved[0]?.correction_count).toBe(5);
  });

  it("throws rather than guessing when the session pinned no pack", async () => {
    const { orchestrator } = makeWorld({ pin: null });
    await expect(orchestrator.correctAnswer(correction())).rejects.toThrow(/no pinned pack/i);
  });

  it("throws rather than writing a question that is not in the pinned pack", async () => {
    const { orchestrator, chat } = makeWorld();
    await expect(
      orchestrator.correctAnswer(correction({ questionKey: "not_a_question" })),
    ).rejects.toThrow(/not in this session's pack/i);
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });
});

describe("viewSettled — the finished interview, read from Postgres", () => {
  it("reads the answers out of conversation_state, not out of Redis", async () => {
    // The buffer is DROPPED the instant the flush commits, which is the same instant the review
    // screen becomes reachable — so the orchestrator here is constructed with NO buffer at all
    // (`{} as never`), and every test above passing is the proof that none of this touches it.
    const { orchestrator } = makeWorld();
    const view = await orchestrator.viewSettled(SESSION, new Date());

    expect(view?.packId).toBe("qp_universal");
    expect(Object.keys(view?.answers ?? {})).toEqual(["current_city"]);
    expect(view?.correctionCount).toBe(0);
  });

  it("returns null for a session with no pin, rather than a pack it guessed", async () => {
    const { orchestrator } = makeWorld({ pin: null });
    expect(await orchestrator.viewSettled(SESSION, new Date())).toBeNull();
  });

  it("ignores an answer_map entry the contract rejects, and keeps the rest", async () => {
    const { orchestrator } = makeWorld({
      answerMap: [answered("current_city", "Mumbai"), { nonsense: true } as never],
    });
    const view = await orchestrator.viewSettled(SESSION, new Date());
    expect(Object.keys(view?.answers ?? {})).toEqual(["current_city"]);
  });
});
