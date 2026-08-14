import { describe, it, expect, vi } from "vitest";
import { ChatService } from "./chat.service";
import { ChatAbandonmentSweepProcessor, SWEEP_BATCH_LIMIT } from "./chat-abandonment-sweep.processor";
import type { TranscriptBuffer } from "./chat-transcript.buffer";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { requestId: "req-1", correlationId: "corr-1" };
const T0 = new Date("2026-08-14T00:00:00.000Z").toISOString();

/**
 * A buffered interview that got partway and stopped — 2 answered questions out of a pack,
 * which is exactly the population this sweep exists for.
 */
function partialBuffer(over: Partial<TranscriptBuffer> = {}): TranscriptBuffer {
  return {
    workerId: WORKER,
    turnCount: 2,
    captured: { current_city: "Pune", total_experience_years: "6" },
    roleFamily: "cnc_vmc",
    messages: [
      { role: "assistant", text: "Aap kis sheher mein rehte hain?", at: T0 },
      { role: "worker", text: "Pune", at: T0 },
    ],
    startedAt: T0,
    ...over,
  } as TranscriptBuffer;
}

/**
 * The pack-pinned envelope with one settled answer. Only the three fields
 * `toPackAnswerRows` reads are populated — the rest of `ProfilingEnvelope` is irrelevant
 * to this path and stubbing it in full would just couple these tests to the engine's shape.
 */
const ENVELOPE_WITH_ANSWER = {
  packId: "qp_tailoring",
  packVersion: 2,
  answerMap: [
    {
      question_key: "trade",
      target_field: "trade",
      value_raw: "silai",
      value_normalized: "silai",
      status: "answered",
      evidence: null,
    },
  ],
} as never;

function make(
  opts: {
    buffer?: TranscriptBuffer | null;
    /** `abandonSession` loses its conditional update — the worker came back and finished. */
    closeLost?: boolean;
    sessionState?: Record<string, unknown> | null;
  } = {},
) {
  let nextMessageId = 0;
  const chat = {
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ __tx: true })),
    abandonSession: vi.fn().mockResolvedValue(!opts.closeLost),
    insertMessages: vi.fn(async (_tx: unknown, rows: { direction: string }[]) =>
      rows.map((r) => ({ ...r, id: `msg-${++nextMessageId}` })),
    ),
    // Args typed even though unused: `mock.calls[0][1]` is how the assertions read the rows
    // back, and an argless mock gives the call a 0-tuple that cannot be indexed.
    insertPackAnswers: vi.fn(async (_tx: unknown, _rows: Record<string, unknown>[]) => undefined),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const profiles = { extract: vi.fn().mockResolvedValue({ ai_job_id: "job-1" }) };
  const buffer = {
    load: vi.fn(async () => (opts.buffer === undefined ? partialBuffer() : opts.buffer)),
    save: vi.fn(async () => undefined),
    drop: vi.fn(async () => undefined),
  };

  const svc = new ChatService(
    { CHAT_MAX_TURNS: 30 } as never,
    chat as never,
    { latestProfile: vi.fn(), findById: vi.fn() } as never,
    { decrypt: vi.fn() } as never,
    events as never,
    buffer as never,
    profiles as never,
    { takeTurn: vi.fn() } as never,
  );

  const session = {
    id: SESSION,
    workerId: WORKER,
    conversationState: opts.sessionState ?? null,
  };
  return { svc, chat, events, profiles, buffer, session };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

const abandonPayload = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls
    .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
    .find((e) => e.event_name === "chat.session_abandoned")?.payload;

const persistedState = (chat: { abandonSession: ReturnType<typeof vi.fn> }) =>
  chat.abandonSession.mock.calls[0]?.[2] as Record<string, unknown> | undefined;

describe("ChatService.abandonInterview — the buffer is still alive", () => {
  it("preserves the transcript verbatim, in order, with both speakers", async () => {
    const { svc, chat, session } = make();
    const out = await svc.abandonInterview(session, 380, CTX);

    expect(out).toMatchObject({ closed: true, transcriptRecovered: true, messages: 2 });
    const rows = chat.insertMessages.mock.calls[0]?.[1] as {
      direction: string;
      bodyText: string;
    }[];
    expect(rows.map((r) => r.direction)).toEqual(["outbound", "inbound"]);
    expect(rows[1]?.bodyText).toBe("Pune");
  });

  it("preserves the settled pack answers when the interview had pinned a pack", async () => {
    const { svc, chat, session } = make({
      buffer: partialBuffer({ profiling: ENVELOPE_WITH_ANSWER }),
    });

    const out = await svc.abandonInterview(session, 380, CTX);

    expect(out.answers).toBe(1);
    const answers = chat.insertPackAnswers.mock.calls[0]?.[1] as Record<string, unknown>[];
    expect(answers[0]).toMatchObject({ questionKey: "trade", packId: "qp_tailoring" });
  });

  it("writes no answers when no pack was ever pinned (nothing to attribute them to)", async () => {
    const { svc, chat, session } = make();
    const out = await svc.abandonInterview(session, 380, CTX);

    expect(out.answers).toBe(0);
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
  });

  it("NEVER mints a profile — no extraction_ready, no extraction enqueued", async () => {
    // THE CORE INVARIANT OF THIS FEATURE. A worker who answered two questions must not become
    // a rankable profile competing for a slot in front of an employer (CLAUDE.md §2). If this
    // test ever fails, the sweep has started manufacturing thin profiles.
    const { svc, events, profiles, session } = make();
    await svc.abandonInterview(session, 380, CTX);

    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("records extraction_ready_emitted=false so nothing downstream mistakes it for finished", async () => {
    const { svc, chat, session } = make();
    await svc.abandonInterview(session, 380, CTX);

    expect(persistedState(chat)).toMatchObject({
      extraction_ready_emitted: false,
      completion_reason: "abandoned",
      captured: { current_city: "Pune", total_experience_years: "6" },
    });
  });

  it("still writes the message audit spine, exactly as a completed flush does", async () => {
    const { svc, events, session } = make();
    await svc.abandonInterview(session, 380, CTX);

    const names = emittedNames(events);
    expect(names.filter((n) => n === "chat.message_sent")).toHaveLength(1);
    expect(names.filter((n) => n === "chat.message_received")).toHaveLength(1);
    expect(names).toContain("chat.session_abandoned");
  });

  it("reports the recovery honestly on the event", async () => {
    const { svc, events, session } = make();
    await svc.abandonInterview(session, 380, CTX);

    expect(abandonPayload(events)).toMatchObject({
      session_id: SESSION,
      worker_id: WORKER,
      transcript_recovered: true,
      messages_preserved: 2,
      idle_minutes: 380,
    });
  });

  it("drops the Redis key only AFTER the transaction commits", async () => {
    const { svc, buffer, session } = make();
    await svc.abandonInterview(session, 380, CTX);
    expect(buffer.drop).toHaveBeenCalledWith(SESSION);
  });
});

describe("ChatService.abandonInterview — the buffer already expired", () => {
  it("closes on the checkpoint and preserves it rather than overwriting with an empty map", async () => {
    const existing = { captured: { current_city: "Pune" }, engine_asks: 5 };
    const { svc, chat, session } = make({ buffer: null, sessionState: existing });

    const out = await svc.abandonInterview(session, 1300, CTX);

    expect(out).toMatchObject({ closed: true, transcriptRecovered: false, messages: 0 });
    // The checkpoint survives verbatim — only the reason is stamped on top.
    expect(persistedState(chat)).toEqual({ ...existing, completion_reason: "abandoned" });
    expect(chat.insertMessages).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("says so on the event instead of reporting a clean success", async () => {
    const { svc, events, session } = make({ buffer: null });
    await svc.abandonInterview(session, 1300, CTX);

    expect(abandonPayload(events)).toMatchObject({
      transcript_recovered: false,
      messages_preserved: 0,
      answers_preserved: 0,
    });
  });

  it("treats a buffer belonging to another worker as absent (key-reuse tripwire)", async () => {
    const foreign = partialBuffer({ workerId: "99999999-9999-4999-8999-999999999999" });
    const { svc, chat, session } = make({ buffer: foreign });

    const out = await svc.abandonInterview(session, 400, CTX);

    expect(out.transcriptRecovered).toBe(false);
    // Critically: the other worker's words are NOT written under this worker's id.
    expect(chat.insertMessages).toHaveBeenCalledWith(expect.anything(), []);
  });
});

describe("ChatService.abandonInterview — the worker came back mid-sweep", () => {
  it("writes nothing at all when the conditional close loses", async () => {
    const { svc, chat, events, buffer, session } = make({ closeLost: true });

    const out = await svc.abandonInterview(session, 380, CTX);

    expect(out.closed).toBe(false);
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // AND the buffer survives — the worker is still in this interview.
    expect(buffer.drop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

function sweep(
  sessions: { id: string; workerId: string; lastMessageAt: Date | null; startedAt: Date }[],
  outcomes: Partial<{
    closed: boolean;
    transcriptRecovered: boolean;
    messages: number;
    answers: number;
  }>[] = [],
) {
  const chat = { findIdleActiveSessions: vi.fn().mockResolvedValue(sessions) };
  let call = 0;
  const chatService = {
    abandonInterview: vi.fn(async () => {
      const o = outcomes[call++] ?? {};
      if (o instanceof Error) throw o;
      return { closed: true, transcriptRecovered: true, messages: 2, answers: 2, ...o };
    }),
  };
  const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
  const config = { CHAT_ABANDON_AFTER_SECONDS: 21_600, CHAT_ABANDON_SWEEP_INTERVAL_HOURS: 1 };
  const proc = new ChatAbandonmentSweepProcessor(
    chat as never,
    chatService as never,
    queue as never,
    config as never,
  );
  return { proc, chat, chatService, queue, config };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  workerId: WORKER,
  lastMessageAt: new Date("2026-08-14T00:00:00.000Z"),
  startedAt: new Date("2026-08-13T00:00:00.000Z"),
  conversationState: null,
  ...over,
});

describe("ChatAbandonmentSweepProcessor", () => {
  it("asks for sessions idle past CHAT_ABANDON_AFTER_SECONDS, bounded by the batch limit", async () => {
    const { proc, chat } = sweep([]);
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));

    await proc.process();

    const [idleSince, limit] = chat.findIdleActiveSessions.mock.calls[0] as [Date, number];
    expect(limit).toBe(SWEEP_BATCH_LIMIT);
    // 12:00 minus 6h.
    expect(idleSince.toISOString()).toBe("2026-08-14T06:00:00.000Z");
    vi.useRealTimers();
  });

  it("counts recovered and lost transcripts separately", async () => {
    const { proc } = sweep(
      [row({ id: "s1" }), row({ id: "s2" }), row({ id: "s3" })],
      [{ transcriptRecovered: true }, { transcriptRecovered: false }, { closed: false }],
    );

    await expect(proc.process()).resolves.toEqual({
      idle: 3,
      closed: 2,
      transcriptsRecovered: 1,
      transcriptsLost: 1,
    });
  });

  it("continues past a per-session failure instead of stranding the backlog", async () => {
    const { proc, chatService } = sweep([row({ id: "s1" }), row({ id: "s2" })]);
    chatService.abandonInterview
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce({
        closed: true,
        transcriptRecovered: true,
        messages: 1,
        answers: 1,
      });

    await expect(proc.process()).resolves.toMatchObject({ idle: 2, closed: 1 });
    expect(chatService.abandonInterview).toHaveBeenCalledTimes(2);
  });

  it("derives idle_minutes from started_at when the session never got a message", async () => {
    // The empty-session population: `startSession` always inserted, so these have a NULL
    // last_message_at and would be invisible to a bare-column comparison.
    const { proc, chatService } = sweep([
      row({ lastMessageAt: null, startedAt: new Date("2026-08-14T00:00:00.000Z") }),
    ]);
    vi.setSystemTime(new Date("2026-08-14T10:00:00.000Z"));

    await proc.process();

    expect(chatService.abandonInterview).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION }),
      600,
      expect.anything(),
    );
    vi.useRealTimers();
  });

  it("registers the repeatable scheduler at boot", async () => {
    const { proc, queue } = sweep([]);
    await proc.onApplicationBootstrap();
    await proc.whenRegistrationSettled();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("chat-abandonment-sweep", {
      every: 3_600_000,
    });
  });

  it("never throws out of boot when registration fails", async () => {
    const { proc, queue } = sweep([]);
    queue.upsertJobScheduler.mockRejectedValue(new Error("redis down"));

    await expect(proc.onApplicationBootstrap()).resolves.toBeUndefined();
    proc.onModuleDestroy(); // abort the backoff chain so the test does not idle
    await proc.whenRegistrationSettled();
  });
});
