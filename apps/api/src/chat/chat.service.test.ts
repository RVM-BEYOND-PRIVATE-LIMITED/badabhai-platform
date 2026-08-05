import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const DTO = { session_id: SESSION, worker_id: WORKER, text: "I run a VMC, 5 years in Pune" };

/**
 * The Resume Field Set as the ai-service returns it once every REQUIRED field is
 * filled. `captured` is what actually matters now — `answered_topics` /
 * `asked_question_ids` survive in the contract for backward compatibility but the
 * LLM-driven interview does not populate them.
 */
const READY_CAPTURED = {
  trade: "VMC operator",
  skills: "tool offset setting, drawing reading",
  experience_years: "5 saal",
  current_city: "Pune",
  preferred_locations: "Pune, Chakan",
  salary_expected: "25000 per month",
  availability: "immediate",
};

const READY_STATE = {
  role_family: "cnc_vmc",
  turn_count: 4,
  answered_topics: [],
  asked_question_ids: [],
  collected: {},
  captured: READY_CAPTURED,
  completion_reason: "fields_complete",
  unanswered_essentials: [],
};

function make(
  opts: {
    /** The buffer `load` resolves to. `undefined` = no buffer yet (first turn). */
    buffer?: Partial<TranscriptBuffer> | null;
    extractionReady?: boolean;
    latestProfile?: unknown;
    extractThrows?: boolean;
    // AI-PERSONA-2: reply_text the (mock) ai-service returns; the DECRYPTED name to
    // simulate (null = not set), and whether decrypt throws (rotated/tampered key).
    replyText?: string;
    workerName?: string | null;
    decryptThrows?: boolean;
    /** The exact updated_state the ai seam returns — including `null` or MALFORMED. */
    updatedState?: unknown;
    /** The whole ai turn is `null`: the ai-service is unreachable. */
    aiDown?: boolean;
    /** The far side's pseudonymize gate fired. */
    blocked?: boolean;
    /** Session row status — "ended" means the interview was already finalized. */
    sessionStatus?: string;
    /** `endSession` loses the conditional update: another request flushed first. */
    flushLost?: boolean;
    /** The flush transaction throws (rolled back). */
    flushThrows?: boolean;
    maxTurns?: number;
    historyWindowTurns?: number;
    /** One-shot opener: the flag, and what the ai seam returns for it. */
    oneShotOpener?: boolean;
    openingText?: string | null;
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
    createSession: vi.fn().mockResolvedValue({
      id: SESSION,
      status: "active",
      startedAt: "2026-07-22T00:00:00.000Z",
    }),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveConversationState: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      if (opts.flushThrows) throw new Error("deadlock detected");
      return work({ __tx: true });
    }),
    endSession: vi.fn().mockResolvedValue(!opts.flushLost),
    // Echo the rows back with ids, exactly as `.returning()` does.
    insertMessages: vi.fn(async (_tx: unknown, rows: { direction: string }[]) =>
      rows.map((r) => ({ ...r, id: `msg-${++nextMessageId}` })),
    ),
  };

  const workers = {
    latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined),
    // full_name is stored ENCRYPTED (TD21); the plaintext lives only behind pii.decrypt.
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

  const aiTurn = opts.aiDown
    ? null
    : {
        reply_text: opts.replyText ?? "Thanks!",
        blocked: opts.blocked ?? false,
        is_mock: false,
        suggested_followups: [],
        asked_question_id: "skills",
        extraction_ready: opts.extractionReady ?? false,
        updated_state:
          opts.updatedState !== undefined
            ? opts.updatedState
            : opts.extractionReady
              ? READY_STATE
              : { ...READY_STATE, captured: { trade: "VMC operator" }, completion_reason: null },
      };

  const ai = {
    profilingOpening: vi.fn().mockResolvedValue(
      opts.openingText === undefined ? "OPENER TEXT" : opts.openingText,
    ),
    profilingRespond: vi.fn().mockResolvedValue(aiTurn),
  };

  const profiles = {
    extract: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue({ ai_job_id: "job-1", status: "queued" }),
  };

  // An in-memory stand-in for the Redis buffer. `saved` is the LAST value written, so
  // a test can assert exactly what would have landed in Redis.
  const stored: { current: TranscriptBuffer | null } = {
    current:
      opts.buffer === undefined || opts.buffer === null
        ? null
        : // DEEP-copied, not spread. `save` in the real buffer serializes to Redis, so
          // the service is free to mutate the object it loaded — and a shallow spread
          // would leave `messages` pointing at a fixture array shared across tests,
          // which silently accumulates turns from every earlier case.
          (JSON.parse(
            JSON.stringify({
              workerId: WORKER,
              turnCount: 0,
              captured: {},
              roleFamily: "cnc_vmc",
              messages: [],
              startedAt: "2026-07-22T00:00:00.000Z",
              ...opts.buffer,
            }),
          ) as TranscriptBuffer),
  };
  const buffer = {
    load: vi.fn(async () => stored.current),
    save: vi.fn(async (_id: string, b: TranscriptBuffer) => {
      stored.current = b;
    }),
    drop: vi.fn(async () => {
      stored.current = null;
    }),
  };

  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: opts.oneShotOpener ?? false,
    CHAT_MAX_TURNS: opts.maxTurns ?? 30,
    CHAT_HISTORY_WINDOW_TURNS: opts.historyWindowTurns ?? 20,
    // The committed default. Load-bearing in the expiry test below, and worth pinning
    // everywhere: an absent value makes the age comparison `age > NaN`, which is
    // silently false — so the expiry warning would never fire and its test would fail
    // for a reason that has nothing to do with the code under test.
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
  };

  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    ai as never,
    buffer as never,
    profiles as never,
  );
  return { svc, chat, workers, pii, events, ai, buffer, stored, profiles, config };
}

/** Run one postMessage turn and return the harness + response. */
async function run(opts: Parameters<typeof make>[0] = {}) {
  const h = make(opts);
  const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
  return { ...h, res };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

/** The rows handed to `insertMessages` at flush — the audit spine as written. */
const flushedRows = (chat: { insertMessages: ReturnType<typeof vi.fn> }) =>
  (chat.insertMessages.mock.calls[0]?.[1] ?? []) as {
    direction: string;
    bodyText: string;
    createdAt: Date;
  }[];

const outboundBody = (chat: { insertMessages: ReturnType<typeof vi.fn> }): string =>
  flushedRows(chat).find((r) => r.direction === "outbound")!.bodyText;

/**
 * A persisted `worker_profiles` row as `WorkersRepository.latestProfile` returns it.
 *
 * DEFAULTS TO THE PLACEHOLDER (T3): every content column at its schema default —
 * byte-for-byte what the processor persists when `AiService.extractProfile` fabricates
 * `DraftProfileSchema.parse({})` because the ai-service was unreachable. Deliberately
 * the default, because the auto-trigger guard's whole job is to tell that row apart
 * from a real extraction. Pass an override for a real one.
 */
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

// ---------------------------------------------------------------------------
// The headline change: a turn writes NOTHING to Postgres.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — the turn buffers, it does not persist", () => {
  it("writes NOTHING to Postgres mid-interview", async () => {
    const { chat, events } = await run({ extractionReady: false });

    // The five writes the old per-turn flow made, all gone: inbound row, outbound row,
    // two events, and the conversation_state UPDATE. Over a 30-turn interview that was
    // ~150 rows recording a conversation nothing downstream reads until it is finished.
    expect(chat.insertMessage).not.toHaveBeenCalled();
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.saveConversationState).not.toHaveBeenCalled();
    expect(chat.touchSession).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("issues a BOUNDED, constant set of reads per turn (no N+1)", async () => {
    const { chat, buffer, workers } = await run({ extractionReady: false });
    // One session read (ownership), one name read, one buffer read, one buffer write.
    expect(chat.findSession).toHaveBeenCalledTimes(1);
    expect(workers.findById).toHaveBeenCalledTimes(1);
    expect(buffer.load).toHaveBeenCalledTimes(1);
    expect(buffer.save).toHaveBeenCalledTimes(1);
    // The transcript is never read from Postgres on the turn path — it is not there.
    expect(chat.listMessages).not.toHaveBeenCalled();
  });

  it("appends BOTH sides verbatim, oldest-first, with a real timestamp", async () => {
    const { stored } = await run({ replyText: "Achha. Kitne saal se?" });
    expect(stored.current!.messages).toHaveLength(2);
    expect(stored.current!.messages[0]).toMatchObject({ role: "worker", text: DTO.text });
    expect(stored.current!.messages[1]).toMatchObject({
      role: "assistant",
      text: "Achha. Kitne saal se?",
    });
    expect(Number.isNaN(Date.parse(stored.current!.messages[0]!.at))).toBe(false);
  });

  it("carries the captured Resume Field Set forward across turns", async () => {
    const { stored } = await run({
      buffer: { turnCount: 2, captured: { trade: "VMC operator" }, messages: [] },
      updatedState: {
        ...READY_STATE,
        turn_count: 3,
        captured: { trade: "VMC operator", experience_years: "5 saal" },
      },
    });
    expect(stored.current!.captured).toEqual({
      trade: "VMC operator",
      experience_years: "5 saal",
    });
    expect(stored.current!.turnCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// History is threaded again — the whole point of the LLM-driven interview.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — history reaches the model", () => {
  it("sends the buffered transcript, oldest-first, in ai-contracts role vocabulary", async () => {
    const { ai } = await run({
      buffer: {
        turnCount: 1,
        messages: [
          { role: "worker", text: "VMC chalata hun", at: "2026-07-22T00:00:00.000Z" },
          { role: "assistant", text: "Achha. Kitne saal se?", at: "2026-07-22T00:00:01.000Z" },
        ],
      },
    });
    const sent = ai.profilingRespond.mock.calls[0]![0] as { history: unknown[] };
    expect(sent.history).toEqual([
      { role: "worker", text: "VMC chalata hun" },
      { role: "assistant", text: "Achha. Kitne saal se?" },
    ]);
  });

  it("WINDOWS the history — re-sending the whole transcript every turn is O(n²) cost", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? "worker" : "assistant") as "worker" | "assistant",
      text: `line ${i}`,
      at: "2026-07-22T00:00:00.000Z",
    }));
    const { ai } = await run({ buffer: { turnCount: 20, messages }, historyWindowTurns: 3 });
    const sent = ai.profilingRespond.mock.calls[0]![0] as { history: { text: string }[] };
    // 3 turns = 6 messages, and they are the MOST RECENT ones (recency is what a
    // follow-up needs; the oldest lines are the ones already answered).
    expect(sent.history).toHaveLength(6);
    expect(sent.history[0]!.text).toBe("line 34");
    expect(sent.history[5]!.text).toBe("line 39");
  });

  it("a window of 0 disables windowing rather than sending nothing", async () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: "worker" as const,
      text: `line ${i}`,
      at: "2026-07-22T00:00:00.000Z",
    }));
    const { ai } = await run({ buffer: { messages }, historyWindowTurns: 0 });
    const sent = ai.profilingRespond.mock.calls[0]![0] as { history: unknown[] };
    expect(sent.history).toHaveLength(6);
  });

  it("sends the captured state so the model never re-asks an answered field", async () => {
    const { ai } = await run({ buffer: { turnCount: 3, captured: { trade: "welder" } } });
    const sent = ai.profilingRespond.mock.calls[0]![0] as {
      conversation_state: { captured: Record<string, string>; turn_count: number };
    };
    expect(sent.conversation_state.captured).toEqual({ trade: "welder" });
    expect(sent.conversation_state.turn_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The turn cap. API-authoritative: a model must never extend its own interview.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — the turn cap", () => {
  it("does not force completion while there is budget left", async () => {
    const { ai } = await run({ buffer: { turnCount: 3 }, maxTurns: 30 });
    const sent = ai.profilingRespond.mock.calls[0]![0] as { force_complete: boolean };
    expect(sent.force_complete).toBe(false);
  });

  it("sends force_complete on the LAST allowed turn", async () => {
    // turnCount 4 → this is turn 5 of at most 5.
    const { ai } = await run({ buffer: { turnCount: 4 }, maxTurns: 5 });
    const sent = ai.profilingRespond.mock.calls[0]![0] as { force_complete: boolean };
    expect(sent.force_complete).toBe(true);
  });

  it("the model is STILL CALLED on the capped turn — it closes, it does not vanish", async () => {
    // One code path. The cap changes what the model is told, never whether it is asked:
    // the worker's last message still deserves an answer, and a warm close is a better
    // final line than a templated one.
    const { ai } = await run({ buffer: { turnCount: 4 }, maxTurns: 5, extractionReady: true });
    expect(ai.profilingRespond).toHaveBeenCalledTimes(1);
  });

  it("records turn_cap as the completion reason when the cap ended it", async () => {
    const { chat } = await run({
      buffer: { turnCount: 4 },
      maxTurns: 5,
      extractionReady: true,
      updatedState: { ...READY_STATE, completion_reason: "turn_cap" },
    });
    const state = chat.endSession.mock.calls[0]![2] as { completion_reason: string };
    expect(state.completion_reason).toBe("turn_cap");
  });
});

// ---------------------------------------------------------------------------
// Degradation. Both failure legs are NO-OPS: nothing buffered, nothing written.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — degradation is a true no-op", () => {
  it("AI service unreachable → the buffer is not touched, so a retry is exactly safe", async () => {
    const { res, buffer, stored } = await run({
      aiDown: true,
      buffer: { turnCount: 2, messages: [] },
    });
    // No half-turn, no duplicated worker line on retry, no topic lost.
    expect(buffer.save).not.toHaveBeenCalled();
    expect(stored.current!.turnCount).toBe(2);
    expect(stored.current!.messages).toHaveLength(0);
    expect(res.blocked).toBe(false);
    expect(res.is_mock).toBe(true);
    expect(res.extraction_ready).toBe(false);
    expect(res.reply).toBeTruthy();
  });

  it("the unreachable reply is on-persona and asks nothing", async () => {
    // No question, because nothing is listening for the answer. And it obeys the same
    // mechanical rules the far-side guard enforces: no exclamation mark, no emoji, no
    // vocative, "aap" not "tu"/"tum".
    const { res } = await run({ aiDown: true });
    expect(res.reply).not.toContain("?");
    expect(res.reply).not.toContain("!");
    expect(res.reply.toLowerCase()).not.toMatch(/\b(bhai|bhaiya|beta|behen|yaar|tu|tum)\b/);
  });

  it("PRIVACY WIN: a message the pseudonymize gate BLOCKED never enters the transcript", async () => {
    // The old flow stored the inbound row BEFORE calling the AI service, so the very
    // message blocked for carrying a phone number still landed verbatim in
    // `chat_messages` and rode into the extraction corpus. Buffering means it never
    // enters at all — the worker rephrases, and only the rephrasing is kept.
    const { res, buffer, stored } = await run({
      blocked: true,
      replyText: "Aapki baat theek se nahi pahunch payi.",
      buffer: { messages: [] },
    });
    expect(buffer.save).not.toHaveBeenCalled();
    expect(stored.current!.messages).toHaveLength(0);
    expect(res.blocked).toBe(true);
  });

  it("a message posted to an ALREADY FINALIZED session is terminal, free, and idempotent", async () => {
    const { res, ai, buffer, chat } = await run({ sessionStatus: "ended" });
    expect(res.extraction_ready).toBe(true);
    expect(ai.profilingRespond).not.toHaveBeenCalled();
    expect(buffer.load).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("a buffer naming a DIFFERENT worker is discarded, never merged", async () => {
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { stored } = await run({
        buffer: {
          workerId: "99999999-9999-4999-8999-999999999999",
          turnCount: 7,
          captured: { trade: "not theirs" },
          messages: [{ role: "worker", text: "someone else", at: "2026-07-22T00:00:00.000Z" }],
        },
      });
      // Restarted, not merged: two workers' answers must never share a transcript.
      expect(stored.current!.workerId).toBe(WORKER);
      expect(stored.current!.messages).toHaveLength(2); // only this turn's pair
      expect(stored.current!.messages.map((m) => m.text)).not.toContain("someone else");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The flush. The ONLY write, and it is atomic.
// ---------------------------------------------------------------------------

describe("ChatService — flush at end", () => {
  const readyBuffer = {
    turnCount: 3,
    captured: { trade: "VMC operator" },
    messages: [
      { role: "worker" as const, text: "VMC chalata hun", at: "2026-07-22T00:00:00.000Z" },
      { role: "assistant" as const, text: "Achha. Kitne saal se?", at: "2026-07-22T00:00:01.000Z" },
    ],
  };

  it("writes the WHOLE transcript in one transaction, then drops the buffer", async () => {
    const { chat, buffer } = await run({ buffer: readyBuffer, extractionReady: true });

    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    // 2 buffered + this turn's pair = 4 rows, in one insert.
    expect(chat.insertMessages).toHaveBeenCalledTimes(1);
    expect(flushedRows(chat)).toHaveLength(4);
    expect(buffer.drop).toHaveBeenCalledTimes(1);
  });

  it("preserves each message's ORIGINAL time, not the flush time", async () => {
    // Defaulting created_at would stamp a thirty-turn interview as thirty simultaneous
    // messages and destroy the ordering `listMessages` and extraction both read.
    const { chat } = await run({ buffer: readyBuffer, extractionReady: true });
    const rows = flushedRows(chat);
    expect(rows[0]!.createdAt.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(rows[1]!.createdAt.toISOString()).toBe("2026-07-22T00:00:01.000Z");
  });

  it("maps worker→inbound and assistant→outbound", async () => {
    const { chat } = await run({ buffer: readyBuffer, extractionReady: true });
    expect(flushedRows(chat).map((r) => r.direction)).toEqual([
      "inbound",
      "outbound",
      "inbound",
      "outbound",
    ]);
  });

  it("emits one event per message plus the readiness signal, all inside the tx", async () => {
    const { chat, events } = await run({ buffer: readyBuffer, extractionReady: true });
    const names = emittedNames(events);
    expect(names.filter((n) => n === "chat.message_received")).toHaveLength(2);
    expect(names.filter((n) => n === "chat.message_sent")).toHaveLength(2);
    expect(names).toContain("profile.extraction_ready");
    // Atomicity is the point: every emit rides the SAME executor as the inserts, so a
    // rollback takes the events with it. An event describing a message that does not
    // exist would corrupt the audit spine.
    const tx = chat.withTransaction.mock.calls[0]![0];
    expect(tx).toBeTypeOf("function");
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { tx?: unknown }).tx).toEqual({ __tx: true });
    }
  });

  it("every event carries a stable idempotency key", async () => {
    const { events } = await run({ buffer: readyBuffer, extractionReady: true });
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { idempotencyKey?: string }).idempotencyKey).toBeTruthy();
    }
    const ready = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; idempotencyKey: string })
      .find((e) => e.event_name === "profile.extraction_ready");
    expect(ready!.idempotencyKey).toBe(`profile.extraction_ready:${SESSION}`);
  });

  it("the readiness payload carries RFS field ids only — never PII, never a value", async () => {
    const { events } = await run({
      buffer: { ...readyBuffer, captured: {} },
      extractionReady: true,
      workerName: "Nitin Kumar",
      updatedState: READY_STATE,
    });
    const ready = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: { answered_topics: string[] } })
      .find((e) => e.event_name === "profile.extraction_ready")!;
    // Sorted field IDS. Not the answers — "Pune" and "25000 per month" stay out of the
    // audit spine, and every id matches the lowercase-slug regex the payload enforces.
    expect(ready.payload.answered_topics).toEqual(Object.keys(READY_CAPTURED).sort());
    for (const id of ready.payload.answered_topics) expect(id).toMatch(/^[a-z_]+$/);
    expect(JSON.stringify(ready.payload)).not.toContain("Nitin");
    expect(JSON.stringify(ready.payload)).not.toContain("Pune");
  });

  it("IDEMPOTENT: a lost conditional update writes no messages and no events", async () => {
    // Two concurrent finalizations both pass a prior read; only one wins the
    // `... AND status = 'active'` update. `chat_messages` has no unique key, so this
    // conditional write is the only thing standing between a retry and a doubled
    // transcript.
    const { chat, events, buffer, profiles } = await run({
      buffer: readyBuffer,
      extractionReady: true,
      flushLost: true,
    });
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // The transcript IS durable (the winner wrote it), so the key is ours to clear —
    // but extraction is the winner's job, not ours.
    expect(buffer.drop).toHaveBeenCalledTimes(1);
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("a FAILED flush keeps the buffer and never 500s the worker", async () => {
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { res, buffer, stored } = await run({
        buffer: readyBuffer,
        extractionReady: true,
        flushThrows: true,
      });
      // The reply was already built; failing the request would tell the worker their
      // completed interview failed when the only thing that failed is a retryable write.
      expect(res.extraction_ready).toBe(true);
      // The buffer survives, `completedAt` set, so the flush can be retried.
      expect(buffer.drop).not.toHaveBeenCalled();
      expect(stored.current!.completedAt).toBeTruthy();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("SAVES the buffer BEFORE flushing — never the other way round", async () => {
    // If the key were dropped first and the flush then failed, the only copy of the
    // interview would be gone. Ordering is the durability guarantee here.
    const order: string[] = [];
    const h = make({ buffer: readyBuffer, extractionReady: true });
    h.buffer.save.mockImplementation(async () => {
      order.push("save");
    });
    h.chat.withTransaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push("flush");
      return work({ __tx: true });
    });
    h.buffer.drop.mockImplementation(async () => {
      order.push("drop");
    });
    await h.svc.postMessage(WORKER, DTO as never, CTX);
    expect(order).toEqual(["save", "flush", "drop"]);
  });
});

// ---------------------------------------------------------------------------
// Auto-trigger extraction — unchanged intent, now hung off the flush.
// ---------------------------------------------------------------------------

describe("ChatService — auto-trigger extraction on completion", () => {
  it("triggers extraction exactly once (no manual /profile/extract)", async () => {
    const { res, profiles, events } = await run({ extractionReady: true });
    expect(res.extraction_ready).toBe(true);
    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER, session_id: SESSION }, CTX);
  });

  it("does not trigger while the interview is not yet complete", async () => {
    const { profiles, events } = await run({ extractionReady: false });
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a REAL profile (no duplicate)", async () => {
    const { profiles, events } = await run({
      extractionReady: true,
      latestProfile: profileRow({
        profileStatus: "extracted",
        canonicalRoleId: "vmc_operator",
        skills: ["skill_milling"],
      }),
    });
    expect(emittedNames(events)).toContain("profile.extraction_ready"); // signal still emitted
    expect(profiles.extract).not.toHaveBeenCalled(); // but no second extraction
  });

  it("T3: RE-TRIGGERS when the stored profile is an empty placeholder (the poison heals)", async () => {
    // The production bug: an interview that completed while the ai-service was down
    // left a contentless profile row, and this guard then treated it as "already
    // profiled" forever — the worker was permanently unprofiled AND permanently unable
    // to become profiled.
    const { profiles, events } = await run({
      extractionReady: true,
      latestProfile: profileRow(),
    });
    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
  });

  it("T3: a content-poor but REAL extraction (TD94) still counts — no re-trigger, no spend loop", async () => {
    const { profiles } = await run({
      extractionReady: true,
      latestProfile: profileRow({ richProfileDraft: { skills: ["machine operation"] } }),
    });
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    const { res, profiles } = await run({ extractionReady: true, extractThrows: true });
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(res.reply).toBe("Thanks!");
    expect(res.extraction_ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AI-PERSONA-2 — the real-name seam. The ai-service emits a {{worker_name}} token;
// the API interpolates the real first name POST-buffer, POST-flush, POST-emit.
// ---------------------------------------------------------------------------

const PLACEHOLDER_REPLY = "{{worker_name}} ji, Aap kaunsa kaam karte hain?";

describe("ChatService — AI-PERSONA-2 worker-name seam (SG-1 PII boundary)", () => {
  it("interpolates the real FIRST name into the client reply only", async () => {
    const { res, chat, events, ai, stored } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      extractionReady: true,
    });
    expect(res.reply).toBe("Nitin ji, Aap kaunsa kaam karte hain?");

    // SG-1: the BUFFER keeps the placeholder…
    const bufferedAssistant = (stored.current ?? { messages: [] as { text: string }[] }).messages;
    expect(JSON.stringify(bufferedAssistant)).not.toContain("Nitin");
    // …and so does the flushed audit row.
    expect(outboundBody(chat)).toContain("{{worker_name}}");
    expect(outboundBody(chat)).not.toContain("Nitin");
    // The name is in NO event payload…
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("Nitin");
    // …and was NEVER sent to the ai-service (LLM input) — only worker_ref + message.
    expect(JSON.stringify(ai.profilingRespond.mock.calls)).not.toContain("Nitin");
  });

  it("inserts a name with `$` special-replacement chars literally (no pattern expansion)", async () => {
    // Worker-controlled name may contain $&, $', $$ — a STRING replacement would expand
    // these; the function replacement must insert them verbatim.
    const { res } = await run({ replyText: PLACEHOLDER_REPLY, workerName: "Om$'" });
    expect(res.reply).toBe("Om$' ji, Aap kaunsa kaam karte hain?");
  });

  it("null name → clean no-vocative reply, no residual {{ }} token", async () => {
    const { res, chat } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: null,
      extractionReady: true,
    });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
    expect(res.reply).not.toContain("ji,");
    expect(outboundBody(chat)).toContain("{{worker_name}}");
  });

  it("undecryptable name (rotated/tampered key) degrades to no-vocative, never 500s", async () => {
    const { res } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      decryptThrows: true,
    });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
  });

  it("never passes the worker name to the logger", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await run({ replyText: PLACEHOLDER_REPLY, workerName: "Nitin Kumar", extractionReady: true });
      const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain("Nitin");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("exactly ONE name read per turn, shared by redaction and the vocative", async () => {
    const { workers, pii } = await run({ replyText: PLACEHOLDER_REPLY, workerName: "Nitin Kumar" });
    expect(workers.findById).toHaveBeenCalledTimes(1);
    expect(pii.decrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// R32 — the worker's OWN name is removed BEFORE it crosses the ai-service boundary.
// ---------------------------------------------------------------------------

describe("ChatService — R32 known-name redaction on the outbound turn", () => {
  const textDto = (text: string) => ({ session_id: SESSION, worker_id: WORKER, text }) as never;

  it("'Suresh Kumar, CNC operator' → the name never reaches the ai-service", async () => {
    const { svc, ai } = make({ workerName: "Suresh Kumar" });
    await svc.postMessage(WORKER, textDto("Suresh Kumar, CNC operator"), CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0] as { message_text: string };
    expect(sent.message_text).toBe("[NAME], CNC operator");
  });

  it("redacts a bare first name typed on a later turn", async () => {
    const { svc, ai } = make({ workerName: "Suresh Kumar" });
    await svc.postMessage(WORKER, textDto("mera naam Suresh hai, VMC chalata hun"), CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0] as { message_text: string };
    expect(sent.message_text).toBe("mera naam [NAME] hai, VMC chalata hun");
  });

  it("REDACTS EVERY HISTORY LEG TOO, not just this turn's message", async () => {
    // New egress surface, new obligation. History used to ship empty (PERF-2), so
    // `message_text` was the only leg that could carry a name. Re-arming history means
    // a name typed on turn two would otherwise ride to the provider on turn twenty.
    const { svc, ai } = make({
      workerName: "Suresh Kumar",
      buffer: {
        messages: [
          { role: "worker", text: "mera naam Suresh Kumar hai", at: "2026-07-22T00:00:00.000Z" },
          { role: "assistant", text: "Theek hai. Kya kaam karte hain?", at: "2026-07-22T00:00:01.000Z" },
        ],
      },
    });
    await svc.postMessage(WORKER, textDto("VMC chalata hun"), CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0];
    expect(JSON.stringify(sent)).not.toContain("Suresh");
    expect((sent as { history: { text: string }[] }).history[0]!.text).toBe("mera naam [NAME] hai");
  });

  it("BUFFERS the raw text — redaction changes only what is SENT", async () => {
    const { svc, stored } = make({ workerName: "Suresh Kumar" });
    await svc.postMessage(WORKER, textDto("Suresh Kumar, CNC operator"), CTX);
    // The buffer (and therefore the flushed audit row) holds the worker's actual words.
    expect(stored.current!.messages[0]!.text).toBe("Suresh Kumar, CNC operator");
  });

  it("a DECRYPT FAILURE does NOT break the turn — it degrades to un-redacted", async () => {
    // Fail SAFE, not closed: the ai-service's fail-closed pseudonymize gate is still in
    // front of the LLM, so an undecryptable name must never make chat unusable.
    const { svc, ai } = make({ workerName: "Suresh Kumar", decryptThrows: true });
    const res = await svc.postMessage(WORKER, textDto("Suresh Kumar, CNC operator"), CTX);
    expect(res.session_id).toBe(SESSION);
    const sent = ai.profilingRespond.mock.calls[0]![0] as { message_text: string };
    expect(sent.message_text).toBe("Suresh Kumar, CNC operator");
  });

  it("no name stored → the turn is sent unchanged", async () => {
    const { svc, ai } = make({ workerName: null });
    await svc.postMessage(WORKER, textDto("Suresh Kumar, CNC operator"), CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0] as { message_text: string };
    expect(sent.message_text).toBe("Suresh Kumar, CNC operator");
  });

  it("leaves real trade vocabulary alone (the gazetteer regression class)", async () => {
    const { svc, ai } = make({ workerName: "Suresh Kumar" });
    const text = "Wire EDM aur Jyoti CNC pe kaam kiya, ITI fitter 2018-2020 kiya";
    await svc.postMessage(WORKER, textDto(text), CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0] as { message_text: string };
    expect(sent.message_text).toBe(text);
  });

  it("never logs the decrypted name", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { svc } = make({ workerName: "Suresh Kumar", decryptThrows: true });
      await svc.postMessage(WORKER, textDto("Suresh Kumar, CNC operator"), CTX);
      const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain("Suresh");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The reply contract. Additive-only: the Flutter client is untouched by this rewrite.
// ---------------------------------------------------------------------------

const EXPECTED_TURN_REPLY = {
  session_id: SESSION,
  reply: "Thanks!",
  blocked: false,
  is_mock: false,
  suggested_followups: [],
  asked_question_id: "skills",
  extraction_ready: false,
  unanswered_essentials: [],
  session_ended: false,
} as const;

describe("ChatService — the reply shape survives the rewrite", () => {
  it("keeps every field the client already reads", async () => {
    const { res } = await run({});
    expect(res).toEqual(EXPECTED_TURN_REPLY);
  });

  it("surfaces the still-missing REQUIRED fields, in the order the service gave them", async () => {
    const { res } = await run({
      updatedState: {
        ...READY_STATE,
        unanswered_essentials: ["salary_expected", "availability"],
      },
    });
    expect(res.unanswered_essentials).toEqual(["salary_expected", "availability"]);
  });

  it("carries the model's CHIPS through unchanged", async () => {
    // Same field the deterministic bank filled from a hardcoded per-topic list, so the
    // Flutter client renders them unchanged — but written by the model for the question
    // it actually asked, which is what makes tap-to-answer work for a trade nobody
    // wrote a question pack for.
    const h = make();
    h.ai.profilingRespond.mockResolvedValueOnce({
      reply_text: "Achha. Kaam kahan karna chahte hain?",
      blocked: false,
      is_mock: false,
      suggested_followups: ["Pune", "Mumbai", "Bengaluru", "Chennai"],
      asked_question_id: "preferred_locations",
      extraction_ready: false,
      updated_state: READY_STATE,
    });
    const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.suggested_followups).toEqual(["Pune", "Mumbai", "Bengaluru", "Chennai"]);
  });

  it("updated_state null → [] and no throw", async () => {
    const { res } = await run({ updatedState: null });
    expect(res.unanswered_essentials).toEqual([]);
  });

  it("malformed value (non-string members) → drops them, and the drop is OBSERVABLE", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { res } = await run({
        updatedState: {
          ...READY_STATE,
          unanswered_essentials: ["availability", 42, null, "salary_expected"],
        },
      });
      expect(res.unanswered_essentials).toEqual(["availability", "salary_expected"]);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("coerced unanswered_essentials");
      expect(logged).toContain("dropped=2");
      // Field name + count, never the members themselves (§2 no-PII-in-logs).
      expect(logged).not.toContain("availability");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("malformed value (not an array at all) → [], never throws — and WARNS non-array", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { res } = await run({
        updatedState: { ...READY_STATE, unanswered_essentials: "availability" },
      });
      expect(res.unanswered_essentials).toEqual([]);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("non-array");
      expect(logged).not.toContain("availability");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("poisoned outbound VALUE → NO throw, constructed object returned, PATHS logged only", async () => {
    // Kills the mutation that swaps `safeParse` for a throwing `parse()`. The DI mock
    // bypasses ProfilingTurnOutputSchema, so the invalid value reaches the outbound gate.
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const h = make();
      h.ai.profilingRespond.mockResolvedValueOnce({
        reply_text: "SECRET_REPLY_TEXT",
        blocked: false,
        is_mock: true,
        suggested_followups: 42, // invalid: schema wants string[]
        asked_question_id: "skills",
        extraction_ready: false,
        updated_state: null,
      });
      const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
      expect(res.session_id).toBe(SESSION);
      expect(res.reply).toBe("SECRET_REPLY_TEXT");
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("outbound validation failed");
      expect(logged).toContain("suggested_followups"); // the field PATH
      expect(logged).not.toContain("SECRET_REPLY_TEXT"); // never the VALUES (§2)
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript hydration — Redis first, Postgres fallback.
// ---------------------------------------------------------------------------

describe("ChatService.listMessages — hydration across the buffer boundary", () => {
  it("serves the BUFFER mid-interview, when Postgres holds nothing at all", async () => {
    // The #349 bug, reintroduced by buffering and closed here: a worker whose app
    // re-locks mid-chat has no `chat_messages` rows to redraw from, because the flush
    // has not happened. A Postgres-only read would show them an empty thread.
    const { svc, chat } = make({
      buffer: {
        messages: [
          { role: "worker", text: "VMC chalata hun", at: "2026-07-22T00:00:00.000Z" },
          { role: "assistant", text: "Achha. Kitne saal se?", at: "2026-07-22T00:00:01.000Z" },
        ],
      },
    });
    const res = await svc.listMessages(WORKER, SESSION);
    expect(res.messages).toEqual([
      { direction: "inbound", body_text: "VMC chalata hun", created_at: "2026-07-22T00:00:00.000Z" },
      {
        direction: "outbound",
        body_text: "Achha. Kitne saal se?",
        created_at: "2026-07-22T00:00:01.000Z",
      },
    ]);
    expect(chat.listMessages).not.toHaveBeenCalled();
  });

  it("falls back to Postgres once the interview is flushed and the buffer is gone", async () => {
    const { svc, chat } = make({ buffer: null });
    chat.listMessages.mockResolvedValue([
      {
        direction: "inbound",
        bodyText: "VMC chalata hun",
        createdAt: new Date("2026-07-22T00:00:00.000Z"),
      },
    ]);
    const res = await svc.listMessages(WORKER, SESSION);
    expect(res.messages).toHaveLength(1);
    expect(chat.listMessages).toHaveBeenCalledTimes(1);
  });

  it("404s a session that is missing OR not yours — never 403 (no existence oracle)", async () => {
    const { svc, chat } = make();
    chat.findSession.mockResolvedValue({ id: SESSION, workerId: "someone-else", status: "active" });
    await expect(svc.listMessages(WORKER, SESSION)).rejects.toThrow(/not found/i);
  });

  it("returns the {{worker_name}} placeholder, never the decrypted name", async () => {
    const { svc } = make({
      workerName: "Nitin Kumar",
      buffer: {
        messages: [{ role: "assistant", text: PLACEHOLDER_REPLY, at: "2026-07-22T00:00:00.000Z" }],
      },
    });
    const res = await svc.listMessages(WORKER, SESSION);
    expect(res.messages[0]!.body_text).toContain("{{worker_name}}");
    expect(JSON.stringify(res)).not.toContain("Nitin");
  });
});

// ---------------------------------------------------------------------------
// Ownership on the write path.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — ownership", () => {
  it("404s another worker's session, and never reads its buffer", async () => {
    const { svc, chat, buffer } = make();
    chat.findSession.mockResolvedValue({ id: SESSION, workerId: "someone-else", status: "active" });
    await expect(svc.postMessage(WORKER, DTO as never, CTX)).rejects.toThrow(/not found/i);
    // Ownership is proved against the ROW, before the cache is touched at all: an
    // absent key must never be able to answer an authorization question.
    expect(buffer.load).not.toHaveBeenCalled();
  });

  it("404s a session that does not exist", async () => {
    const { svc, chat } = make();
    chat.findSession.mockResolvedValue(undefined);
    await expect(svc.postMessage(WORKER, DTO as never, CTX)).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// startSession + the one-shot opener — untouched by the rewrite.
// ---------------------------------------------------------------------------

describe("ChatService.startSession — one-shot opener", () => {
  const ctx = { correlationId: "c-1", requestId: "r-1" } as never;

  it("flag OFF: the body is byte-identical and NO call is made to the ai service", async () => {
    const { svc, ai } = make();
    const res = await svc.startSession(WORKER, ctx);
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect("opening_text" in res).toBe(false);
    expect(ai.profilingOpening).not.toHaveBeenCalled();
  });

  it("flag ON: the opener rides the existing session response", async () => {
    const { svc, ai } = make({ oneShotOpener: true });
    const res = await svc.startSession(WORKER, ctx);
    expect(ai.profilingOpening).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ session_id: SESSION, opening_text: "OPENER TEXT" });
  });

  it("flag ON but the ai service is down: degrades to the 3-key body, never 500s", async () => {
    const { svc } = make({ oneShotOpener: true, openingText: null });
    const res = await svc.startSession(WORKER, ctx);
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
  });

  it("emits chat.session_started with its payload UNCHANGED by the opener", async () => {
    const { svc, events } = make({ oneShotOpener: true });
    await svc.startSession(WORKER, ctx);
    const started = events.emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.event_name === "chat.session_started");
    expect(started).toBeDefined();
    expect(Object.keys(started!.payload).sort()).toEqual(["session_id", "worker_id"]);
  });

  it("creates the session row in POSTGRES — ownership never lives in the cache", async () => {
    const { svc, chat, buffer } = make();
    await svc.startSession(WORKER, ctx);
    expect(chat.createSession).toHaveBeenCalledTimes(1);
    // The buffer is created lazily on the first message, not here.
    expect(buffer.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The terminal-session signal — how the client learns to open a fresh session.
// ---------------------------------------------------------------------------

describe("ChatService — session_ended", () => {
  it("is false on an ordinary mid-interview turn", async () => {
    const { res } = await run({ extractionReady: false });
    expect(res.session_ended).toBe(false);
  });

  it("is TRUE on the turn that completes the interview", async () => {
    // Flush-at-end introduced a terminal state that did not exist before. The app
    // caches its session id in memory and `ensureSession()` short-circuits on it, so
    // without this flag it keeps posting into a dead session for the rest of the
    // process — silently disabling the "start a fresh chat" button on the Resume and
    // Profile tabs, and the "Chat pe wapas jaayein" the profile preview offers when a
    // profile comes out thin. The worker is told to go say more, and cannot.
    const { res } = await run({ extractionReady: true });
    expect(res.session_ended).toBe(true);
  });

  it("is TRUE again on every later message — the client gets a second chance", async () => {
    // Recovery for a client that missed the flag on the completing turn: an old build,
    // a dropped response, a fresh process reusing a persisted id.
    const { res, ai } = await run({ sessionStatus: "ended" });
    expect(res.session_ended).toBe(true);
    expect(ai.profilingRespond).not.toHaveBeenCalled(); // and it stays free
  });

  it("is FALSE on a degraded turn — an outage must not throw away a live session", async () => {
    const { res } = await run({ aiDown: true });
    expect(res.session_ended).toBe(false);
  });

  it("is FALSE on a blocked turn, which is also still live", async () => {
    const { res } = await run({ blocked: true, replyText: "Aapki baat theek se nahi pahunchi." });
    expect(res.session_ended).toBe(false);
  });
});

describe("ChatService — a transcript buffer that expired mid-interview", () => {
  it("WARNS when a session outlived its TTL and has no buffer, then restarts cleanly", async () => {
    // The silent case: a lapse on turn twelve looks exactly like turn one — turnCount
    // resets to 0, captured empties, eleven turns are gone. The session row is the only
    // mid-interview evidence there is, so an age past the TTL is the one unambiguous
    // signal available.
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const h = make({ buffer: null });
      h.chat.findSession.mockResolvedValue({
        id: SESSION,
        workerId: WORKER,
        status: "active",
        startedAt: new Date(Date.now() - 200_000 * 1000), // well past the 86 400s TTL
      });
      await h.svc.postMessage(WORKER, DTO as never, CTX);

      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("older than CHAT_TRANSCRIPT_TTL_SECONDS");
      // The turn still succeeds — a lapse costs the transcript, never the request.
      expect(h.stored.current!.messages).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("stays QUIET on a genuine first turn — no false alarm on every new session", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const h = make({ buffer: null });
      h.chat.findSession.mockResolvedValue({
        id: SESSION,
        workerId: WORKER,
        status: "active",
        startedAt: new Date(),
      });
      await h.svc.postMessage(WORKER, DTO as never, CTX);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("older than CHAT_TRANSCRIPT_TTL_SECONDS");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
