/**
 * `ChatService` after the OIE Phase 8 cutover.
 *
 * CONSCIOUSLY REWRITTEN, not repaired. The previous file was ~1,250 lines and most of it
 * asserted properties of a turn loop that no longer exists: the windowed history sent to the
 * model, `force_complete` on the capped turn, `updated_state.turn_count` being distrusted, the
 * R32 name redaction applied to every outbound leg. All of those were true statements about
 * calling an LLM once per turn, and the whole point of this phase is that the turn calls
 * nothing.
 *
 * WHAT SURVIVED, because it was never about the model:
 *   - a turn writes NOTHING to Postgres; the flush is the only write;
 *   - the flush is one transaction, with the original per-message timestamps and stable
 *     idempotency keys, and a rollback keeps the buffer so the next POST retries;
 *   - a session that is not yours is 404, never 403;
 *   - the worker's real name reaches the client reply and nothing durable.
 *
 * WHAT IS NEW HERE: the answer map landing in `worker_pack_answer` as ONE statement, and the
 * plan's headline acceptance criterion — ZERO LLM calls between session start and completion,
 * asserted structurally by the fact that `ChatService` no longer holds an `AiService` at all.
 */
import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import type { ProfilingEnvelope } from "../profiling/conversation-state";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const DTO = { session_id: SESSION, worker_id: WORKER, text: "silai ka kaam karta hoon" };
const T0 = "2026-07-22T00:00:00.000Z";

/** A pinned occupation, as the envelope carries it once retrieval settles. */
const PIN = {
  job_domain_id: "jd_nco_7531_0100",
  label: "darzi",
  isco_unit_code: "7531",
  match_status: "matched_lexical" as const,
  match_score: 0.97,
  match_layer: "l0_exact" as const,
  pack_id: null,
  pack_version: null,
  catalog_version: "cat_2026_08",
};

/** The engine's envelope at the end of a complete interview. */
function envelope(over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope {
  return {
    rev: 4,
    phase: "close",
    occupation: PIN,
    answerMap: [],
    engineAsks: 3,
    askCounts: {},
    servedQuestionKey: null,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
    disambiguationOffer: [],
    identifyAttempts: 0,
    packId: "qp_tailoring",
    packVersion: 2,
    catalogVersion: "cat_2026_08",
    lastTurn: null,
    ...over,
  };
}

/** One `AnswerRecord`, defaulted to a plain answered string. */
function answer(over: Record<string, unknown> = {}) {
  return {
    question_key: "trade",
    target_field: "trade",
    value_raw: "silai",
    value_normalized: "silai",
    status: "answered",
    evidence: null,
    turn: 1,
    history: [],
    ...over,
  };
}

function make(
  opts: {
    /** What the buffer holds BEFORE the turn. `null` = no buffer yet (first turn). */
    buffer?: Partial<TranscriptBuffer> | null;
    /** What the buffer holds AFTER the orchestrator's CAS write. Defaults to `buffer`. */
    written?: Partial<TranscriptBuffer> | null;
    /** The orchestrator's TurnResult, merged over a benign default. */
    turn?: Record<string, unknown>;
    latestProfile?: unknown;
    extractThrows?: boolean;
    workerName?: string | null;
    decryptThrows?: boolean;
    sessionStatus?: string;
    /** `endSession` loses the conditional update: another request flushed first. */
    flushLost?: boolean;
    /** The flush transaction throws (rolled back). */
    flushThrows?: boolean;
    /** The bulk answer INSERT throws — the flush must roll back with it. */
    answersThrow?: boolean;
    oneShotOpener?: boolean;
  } = {},
) {
  const session = {
    id: SESSION,
    workerId: WORKER,
    status: opts.sessionStatus ?? "active",
    conversationState: null,
    startedAt: new Date(),
  };

  let nextMessageId = 0;
  const chat = {
    findSession: vi.fn().mockResolvedValue(session),
    createSession: vi.fn().mockResolvedValue({ id: SESSION, status: "active", startedAt: T0 }),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveConversationState: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      if (opts.flushThrows) throw new Error("deadlock detected");
      return work({ __tx: true });
    }),
    endSession: vi.fn().mockResolvedValue(!opts.flushLost),
    insertMessages: vi.fn(async (_tx: unknown, rows: { direction: string }[]) =>
      rows.map((r) => ({ ...r, id: `msg-${++nextMessageId}` })),
    ),
    insertPackAnswers: vi.fn(async () => {
      if (opts.answersThrow) throw new Error("wpa_answer_shape_chk violated");
    }),
  };

  const workers = {
    latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined),
    findById: vi.fn().mockResolvedValue({
      id: WORKER,
      fullName: opts.workerName == null ? null : "ENC_FULL_NAME_TOKEN",
    }),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (opts.decryptThrows) throw new Error("bad/rotated key");
      return opts.workerName ?? "";
    }),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const profiles = {
    extract: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue({ ai_job_id: "job-1", status: "queued" }),
  };

  const hydrate = (v: Partial<TranscriptBuffer> | null | undefined): TranscriptBuffer | null =>
    v === undefined || v === null
      ? null
      : (JSON.parse(
          JSON.stringify({
            workerId: WORKER,
            turnCount: 0,
            captured: {},
            roleFamily: "",
            messages: [],
            startedAt: T0,
            ...v,
          }),
        ) as TranscriptBuffer);

  // TWO STATES, because that is what really happens: `postMessage` loads once for the
  // ownership/terminal checks, the orchestrator writes under CAS, and `postMessage` RE-READS
  // what actually landed. Modelling them as one object would hide exactly the case this split
  // exists for — a competing writer whose turn won.
  // DEFAULTS TO AN EXISTING BUFFER, not to absent. A missing buffer on the RE-READ is the
  // "vanished after the CAS write" branch, which short-circuits the whole response — so leaving
  // it as the default would make most assertions below silently test that branch instead.
  const before = hydrate(opts.buffer === undefined ? {} : opts.buffer);
  const after = opts.written === undefined ? before : hydrate(opts.written);
  let loads = 0;
  const buffer = {
    load: vi.fn(async () => (loads++ === 0 ? before : after)),
    save: vi.fn(async () => undefined),
    drop: vi.fn(async () => undefined),
  };

  const orchestrator = {
    takeTurn: vi.fn(async () => ({
      reply: "Aap kis sheher mein rehte hain?",
      questionKey: "current_city",
      options: [{ option_key: "pune", label_text: "Pune", value: "Pune" }],
      progress: { answered: 3, total: 12 },
      unansweredEssentials: ["salary_expected"],
      complete: false,
      completionReason: null,
      replayed: false,
      excludeFromParse: false,
      unavailable: false,
      ...opts.turn,
    })),
  };

  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: opts.oneShotOpener ?? false,
    CHAT_MAX_TURNS: 30,
    CHAT_HISTORY_WINDOW_TURNS: 20,
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
  };

  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    buffer as never,
    profiles as never,
    orchestrator as never,
  );
  return { svc, chat, workers, pii, events, buffer, profiles, config, orchestrator };
}

async function run(opts: Parameters<typeof make>[0] = {}) {
  const h = make(opts);
  const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
  return { ...h, res };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

const flushedRows = (chat: { insertMessages: ReturnType<typeof vi.fn> }) =>
  (chat.insertMessages.mock.calls[0]?.[1] ?? []) as {
    direction: string;
    bodyText: string;
    createdAt: Date;
  }[];

const answerRows = (chat: { insertPackAnswers: ReturnType<typeof vi.fn> }) =>
  (chat.insertPackAnswers.mock.calls[0]?.[1] ?? []) as Record<string, unknown>[];

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    workerId: WORKER,
    profileStatus: "draft",
    canonicalTradeId: null,
    canonicalRoleId: null,
    skills: [],
    machines: [],
    experience: {},
    salaryExpectation: {},
    locationPreference: { preferred_cities: [] },
    availability: { status: "unknown" },
    richProfileDraft: null,
    ...over,
  };
}

/** A completed interview: two messages, `completedAt` set, a pack pinned, answers recorded. */
const COMPLETED: Partial<TranscriptBuffer> = {
  turnCount: 3,
  completedAt: T0,
  completionReason: "fields_complete",
  captured: { trade: "silai" },
  messages: [
    { role: "worker", text: "silai ka kaam karta hoon", at: T0 },
    { role: "assistant", text: "Aap kis sheher mein rehte hain?", at: "2026-07-22T00:00:05.000Z" },
  ],
  profiling: envelope({ answerMap: [answer()] as never }),
};

// ---------------------------------------------------------------------------
// The headline: a turn calls no model and writes no row.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — deterministic, in-process, zero LLM calls", () => {
  it("has no AI seam at all — the acceptance criterion, asserted structurally", () => {
    // THE PLAN'S GATE IS "zero LLM calls between session start and completion", and the
    // strongest possible form of that assertion is that the class cannot make one: there is no
    // `AiService` in the constructor to call. A spy asserting `expect(ai.x).not.toHaveBeenCalled()`
    // would keep passing while someone added a second seam beside it.
    const { svc } = make();
    expect(Object.values(svc as unknown as Record<string, unknown>)).not.toContainEqual(
      expect.objectContaining({ profilingRespond: expect.anything() }),
    );
    expect(ChatService.length).toBe(8);
  });

  it("writes NOTHING to Postgres mid-interview", async () => {
    const { chat, events } = await run();
    expect(chat.insertMessage).not.toHaveBeenCalled();
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    expect(chat.saveConversationState).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("delegates the whole turn — the orchestrator owns the buffer write, not this service", async () => {
    const { buffer, orchestrator } = await run();
    expect(orchestrator.takeTurn).toHaveBeenCalledTimes(1);
    // NOT `save`. The orchestrator writes under a compare-and-swap on the envelope's `rev`;
    // a `save` here would be a second, unguarded writer and reintroduce the lost update the
    // CAS exists to remove.
    expect(buffer.save).not.toHaveBeenCalled();
  });

  it("threads the request context through, so a placement is traceable to its request", async () => {
    const { orchestrator } = await run();
    const input = (orchestrator.takeTurn.mock.calls as unknown[][])[0]?.[0] as { ctx: unknown; text: string };
    expect(input.ctx).toBe(CTX);
    expect(input.text).toBe(DTO.text);
  });

  it("issues a BOUNDED, constant set of reads per turn (no N+1)", async () => {
    const { chat, buffer, workers } = await run();
    expect(chat.findSession).toHaveBeenCalledTimes(1);
    // TWO loads, and both are necessary: one before the turn for the ownership and terminal
    // checks, one after to read what the CAS actually wrote.
    expect(buffer.load).toHaveBeenCalledTimes(2);
    expect(workers.findById).toHaveBeenCalledTimes(1);
  });

  it("returns the progress bar and the pinned occupation label", async () => {
    const { res } = await run({ buffer: {}, written: { profiling: envelope() } });
    expect(res.progress).toEqual({ answered: 3, total: 12 });
    // The "you have been understood" moment — vernacular, never `label_en`.
    expect(res.occupation_label).toBe("darzi");
    expect(res.question_kind).toBe("ask");
    expect(res.is_mock).toBe(false);
  });

  it("surfaces the pack's reviewed option LABELS as the chips", async () => {
    const { res } = await run();
    expect(res.suggested_followups).toEqual(["Pune"]);
    expect(res.asked_question_id).toBe("current_city");
  });

  it("reports the mandatory questions still outstanding", async () => {
    const { res } = await run();
    expect(res.unanswered_essentials).toEqual(["salary_expected"]);
  });

  it("marks the closing turn as `close`", async () => {
    const { res } = await run({
      buffer: {},
      written: COMPLETED,
      turn: { complete: true, questionKey: null, completionReason: "fields_complete" },
    });
    expect(res.question_kind).toBe("close");
    expect(res.session_ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degradation, replay, and the terminal session
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — degradation is a true no-op", () => {
  it("orchestrator wrote nothing → nothing is flushed and the worker may retry", async () => {
    const { res, chat } = await run({ turn: { unavailable: true, reply: "Abhi thodi dikkat" } });
    expect(res.session_ended).toBe(false);
    expect(res.extraction_ready).toBe(false);
    expect(res.progress).toBeNull();
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("a replayed turn returns the previous reply and changes nothing", async () => {
    const { res, chat, buffer } = await run({
      turn: { replayed: true, reply: "Aap kis sheher mein rehte hain?" },
    });
    expect(res.reply).toBe("Aap kis sheher mein rehte hain?");
    expect(res.session_ended).toBe(false);
    expect(chat.withTransaction).not.toHaveBeenCalled();
    // The replay short-circuits BEFORE the re-read: there is nothing new to read.
    expect(buffer.load).toHaveBeenCalledTimes(1);
  });

  it("a message posted to an ALREADY FINALIZED session is terminal, free, and idempotent", async () => {
    const { res, orchestrator, chat } = await run({ sessionStatus: "ended" });
    expect(res.session_ended).toBe(true);
    expect(res.extraction_ready).toBe(true);
    expect(orchestrator.takeTurn).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("a session that is not yours is 404, never 403 — no existence oracle", async () => {
    const h = make();
    h.chat.findSession.mockResolvedValue({ id: SESSION, workerId: "someone-else", status: "active" });
    await expect(h.svc.postMessage(WORKER, DTO as never, CTX)).rejects.toThrow(/not found/i);
    expect(h.orchestrator.takeTurn).not.toHaveBeenCalled();
  });

  it("a buffer that vanishes after the CAS write still serves the reply", async () => {
    // A TTL lapse at the worst possible instant. The turn happened; the interview restarts on
    // the next POST. Serving a 500 here would show an error for something that succeeded.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res } = await run({ buffer: {}, written: null });
    expect(res.session_ended).toBe(false);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// The flush — still the only write
// ---------------------------------------------------------------------------

describe("ChatService — flush at end", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };

  it("writes the WHOLE transcript in one transaction, then drops the buffer", async () => {
    const { chat, buffer, res } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(flushedRows(chat)).toHaveLength(2);
    expect(buffer.drop).toHaveBeenCalledTimes(1);
    expect(res.session_ended).toBe(true);
  });

  it("preserves each message's ORIGINAL time, not the flush time", async () => {
    const { chat } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    const rows = flushedRows(chat);
    expect(rows[0]?.createdAt).toEqual(new Date(T0));
    expect(rows[1]?.createdAt).toEqual(new Date("2026-07-22T00:00:05.000Z"));
  });

  it("maps worker→inbound and assistant→outbound", async () => {
    const { chat } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(flushedRows(chat).map((r) => r.direction)).toEqual(["inbound", "outbound"]);
  });

  it("emits one event per message plus the readiness signal, all inside the tx", async () => {
    const { chat, events } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(emittedNames(events)).toEqual([
      "chat.message_received",
      "chat.message_sent",
      "profile.extraction_ready",
    ]);
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { tx: unknown }).tx).toEqual({ __tx: true });
    }
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("every event carries a stable idempotency key", async () => {
    const { events } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { idempotencyKey?: string }).idempotencyKey).toBeTruthy();
    }
  });

  it("IDEMPOTENT: a lost conditional update writes no messages and no answers", async () => {
    const { chat, events, buffer } = await run({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      flushLost: true,
    });
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // The transcript is durable — somebody else wrote it — so the key is ours to clear.
    expect(buffer.drop).toHaveBeenCalledTimes(1);
  });

  it("a FAILED flush keeps the buffer and never 500s the worker", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res, buffer } = await run({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      flushThrows: true,
    });
    expect(res.session_ended).toBe(false);
    expect(res.extraction_ready).toBe(false);
    // NOT dropped. Dropping on a failed flush would destroy the only copy of the interview.
    expect(buffer.drop).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("RETRIES a completed-but-unflushed buffer on the next POST, taking no new turn", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { res, chat, orchestrator } = await run({ buffer: COMPLETED });
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(res.session_ended).toBe(true);
    // The interview is already over. Spending another turn on it would be pure waste.
    expect(orchestrator.takeTurn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("the readiness payload carries slug field ids only — never PII, never a value", async () => {
    const { events } = await run({
      buffer: {},
      written: {
        ...COMPLETED,
        captured: { trade: "silai", "Ramesh Kumar": "x", experience_years: "7" },
      },
      turn: complete,
    });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const ready = events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "profile.extraction_ready",
    );
    const topics = (ready?.[0] as { payload: { answered_topics: string[] } }).payload
      .answered_topics;
    expect(topics).toEqual(["experience_years", "trade"]);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// worker_pack_answer — the Phase 8 addition
// ---------------------------------------------------------------------------

describe("ChatService — the answer map lands in worker_pack_answer", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };

  const withAnswers = (records: Record<string, unknown>[], env: Partial<ProfilingEnvelope> = {}) =>
    run({
      buffer: {},
      written: { ...COMPLETED, profiling: envelope({ answerMap: records as never, ...env }) },
      turn: complete,
    });

  it("writes ONE multi-row INSERT, not one statement per question", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "current_city", value_normalized: "pune" }),
      answer({ question_key: "experience_years", value_normalized: 7 }),
    ]);
    expect(chat.insertPackAnswers).toHaveBeenCalledTimes(1);
    expect(answerRows(chat)).toHaveLength(3);
  });

  it("routes each value to the ONE typed column its type implies", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade", value_normalized: "silai" }),
      answer({ question_key: "experience_years", value_normalized: 7 }),
      answer({ question_key: "can_relocate", value_normalized: true }),
      answer({ question_key: "shifts", value_normalized: ["day", "night"] }),
    ]);
    const rows = answerRows(chat);
    expect(rows[0]).toMatchObject({ answerText: "silai", status: "answered" });
    expect(rows[1]).toMatchObject({ answerNumber: 7 });
    expect(rows[2]).toMatchObject({ answerBool: true });
    expect(rows[3]).toMatchObject({ answerOptionKeys: ["day", "night"] });
    // EXACTLY ONE value column per row — `wpa_answer_shape_chk` is a biconditional, so a row
    // with two would be rejected by Postgres and take the whole flush down with it.
    for (const row of rows) {
      const filled = ["answerText", "answerNumber", "answerBool", "answerOptionKeys"].filter(
        (k) => row[k] !== undefined,
      );
      expect(filled).toHaveLength(1);
    }
  });

  it("persists a DECLINED answer with no value — 'nahi pata' is a fact, not a gap", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "salary_expected", status: "declined", value_normalized: null }),
    ]);
    const row = answerRows(chat)[0];
    expect(row).toMatchObject({ status: "declined" });
    expect(row?.answerText).toBeUndefined();
    expect(row?.answerNumber).toBeUndefined();
  });

  it("skips `unanswered` records — that is a fact about the conversation, not the worker", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "shift_pref", status: "unanswered", value_normalized: null }),
    ]);
    expect(answerRows(chat).map((r) => r.questionKey)).toEqual(["trade"]);
  });

  it("downgrades an `answered` record with an unrepresentable value to `declined`", async () => {
    // Dropping it instead would make the question look never-asked, and a later re-interview
    // would ask it again. The honest reading is "settled, no value".
    const { chat } = await withAnswers([
      answer({ question_key: "trade", value_normalized: { weird: true } }),
    ]);
    expect(answerRows(chat)[0]).toMatchObject({ questionKey: "trade", status: "declined" });
  });

  it("drops a question key that would fail the payload's slug filter", async () => {
    // Inside the flush transaction, so a malformed key must not be allowed to roll the whole
    // interview back — the same asymmetry `slugFieldIds` exists for.
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "Mera Naam Ramesh" }),
    ]);
    expect(answerRows(chat).map((r) => r.questionKey)).toEqual(["trade"]);
  });

  it("writes nothing at all when no pack was ever pinned", async () => {
    // Without a pack pointer a row is unreadable: two packs may legitimately own
    // `experience_years` with different wording.
    const { chat } = await withAnswers([answer()], { packId: null, packVersion: null });
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    // …and the transcript still lands. The answers are a projection of it, not a precondition.
    expect(chat.insertMessages).toHaveBeenCalledTimes(1);
  });

  it("stamps the pack pointer and the session on every row", async () => {
    const { chat } = await withAnswers([answer()]);
    expect(answerRows(chat)[0]).toMatchObject({
      workerId: WORKER,
      chatSessionId: SESSION,
      packId: "qp_tailoring",
      packVersion: 2,
      source: "chat",
    });
  });

  it("a failing answer INSERT rolls the WHOLE flush back — no orphan transcript", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const h = make({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      answersThrow: true,
    });
    // `withTransaction` here runs the work inline, so the throw propagates exactly as a real
    // rollback would — and `finalizeInterview` must swallow it into `false`, not a 500.
    const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.session_ended).toBe(false);
    expect(h.buffer.drop).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Extraction auto-trigger — unchanged behaviour, new turn loop
// ---------------------------------------------------------------------------

describe("ChatService — auto-trigger extraction on completion", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };
  const done = { buffer: {}, written: COMPLETED, turn: complete };

  it("triggers extraction exactly once", async () => {
    const { profiles } = await run(done);
    expect(profiles.extract).toHaveBeenCalledTimes(1);
  });

  it("does not trigger while the interview is not yet complete", async () => {
    const { profiles } = await run();
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a REAL profile", async () => {
    const { profiles } = await run({
      ...done,
      latestProfile: profileRow({ skills: [{ skill_id: "msk_stitching" }] }),
    });
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("RE-TRIGGERS when the stored profile is an empty placeholder (the poison heals)", async () => {
    const { profiles } = await run({ ...done, latestProfile: profileRow() });
    expect(profiles.extract).toHaveBeenCalledTimes(1);
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res } = await run({ ...done, extractThrows: true });
    expect(res.session_ended).toBe(true);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// The worker-name seam (SG-1) — still the client reply only
// ---------------------------------------------------------------------------

describe("ChatService — AI-PERSONA-2 worker-name seam (SG-1 PII boundary)", () => {
  const named = (over: Record<string, unknown> = {}) => ({
    workerName: "Suresh Kumar",
    turn: { reply: "{{worker_name}} ji, aap kis sheher mein rehte hain?" },
    ...over,
  });

  it("interpolates the real FIRST name into the client reply only", async () => {
    const { res, buffer } = await run(named());
    expect(res.reply).toBe("Suresh ji, aap kis sheher mein rehte hain?");
    // Nothing durable was rewritten: the orchestrator buffered the RAW reply, and this service
    // never writes the buffer at all.
    expect(buffer.save).not.toHaveBeenCalled();
  });

  it("inserts a name with `$` special-replacement chars literally (no pattern expansion)", async () => {
    const { res } = await run(named({ workerName: "A$&B Kumar" }));
    expect(res.reply).toBe("A$&B ji, aap kis sheher mein rehte hain?");
  });

  it("null name → clean no-vocative reply, no residual {{ }} token", async () => {
    const { res } = await run(named({ workerName: null }));
    expect(res.reply).not.toContain("{{");
    expect(res.reply).toContain("aap kis sheher");
  });

  it("undecryptable name (rotated/tampered key) degrades to no-vocative, never 500s", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { res } = await run(named({ decryptThrows: true }));
    expect(res.reply).not.toContain("{{");
    vi.restoreAllMocks();
  });

  it("exactly ONE name read per turn", async () => {
    const { workers, pii } = await run(named());
    expect(workers.findById).toHaveBeenCalledTimes(1);
    expect(pii.decrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The opener
// ---------------------------------------------------------------------------

describe("ChatService.startSession — the opener is reviewed copy, not a model call", () => {
  it("omits opening_text entirely when the flag is off", async () => {
    const { svc } = make();
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect("opening_text" in res).toBe(false);
  });

  it("serves the static opener when the flag is on, with no outbound call", async () => {
    const { svc } = make({ oneShotOpener: true });
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect(res.opening_text).toContain("Namaste");
    // ON-PERSONA, mechanically: one question mark, no exclamation, no emoji.
    const text = res.opening_text as string;
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text).not.toMatch(/!/);
  });

  it("still emits chat.session_started", async () => {
    const { svc, events } = make();
    await svc.startSession(WORKER, CTX);
    expect(emittedNames(events)).toEqual(["chat.session_started"]);
  });
});
