import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { emptyProfilingEnvelope, type ProfilingEnvelope } from "../profiling/conversation-state";
import { FREE_CHAT_COPY } from "../profiling/free-chat/free-chat.copy";
import { enterMode, greetingState } from "../profiling/free-chat/free-chat.state";
import type { FreeChatTurnInput, TurnResult } from "../profiling/orchestrator.service";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import { PostMessageResponseSchema, StartSessionResponseSchema } from "./chat.dto";

/**
 * ═══ THE PROFILING-STAGE FREE CHAT ON THE CHAT WIRE (ADR-0051, #2027) ═══
 *
 * The orchestrator is stubbed: what is under test is only what `ChatService` does around it.
 *
 *   1. THE KILL SWITCH IS TODAY, BYTE FOR BYTE — no lock read, no greeting, no new wire field.
 *   2. THE GREETING opens a new session for an unlocked worker, with the existing opening fields;
 *      a LOCKED worker gets none, and the lock is merged onto the new session. Abandoning keeps the
 *      lock; finishing releases it.
 *   3. A MODEL-WRITTEN turn carries `read_aloud: false` and no `tts_text`, on the replay too.
 *   4. The flush flags free-chat rows; every replacing writer carries the lock; a live free chat is
 *      touched so the sweep does not close it.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const NEW_SESSION = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const T0 = new Date("2026-10-06T10:00:00.000Z");
const LOCK = { v: 1, locked_at: T0.toISOString() };

const GREETING_TURN: TurnResult = {
  reply: FREE_CHAT_COPY.GREETING.latin,
  kind: "ask",
  questionKey: null,
  options: [
    {
      option_key: "free_chat_start",
      label_text: "Haan, shuru karein",
      value: "Haan, shuru karein",
      implies_skill_id: null,
      is_none_of_above: false,
    },
    {
      option_key: "free_chat_later",
      label_text: "Baad mein",
      value: "Baad mein",
      implies_skill_id: null,
      is_none_of_above: false,
    },
  ],
  whyText: null,
  answerType: "single_select",
  inputMode: "text",
  progress: { answered: 0, total: 8 },
  unansweredEssentials: [],
  complete: false,
  completionReason: null,
  replayed: false,
  excludeFromParse: true,
  unavailable: false,
  checkpointDue: false,
};

const RESUME_CHIP = {
  option_key: "free_chat_resume",
  label_text: "Resume banayein",
  value: "Resume banayein",
  implies_skill_id: null,
  is_none_of_above: false,
};

interface Opts {
  killSwitch?: boolean;
  /** What `findFreeChatLockDecider` returns, or "throws". */
  decider?: { id: string; status: string } | undefined | "throws";
  liveSession?: { id: string; status: string; startedAt: Date };
  resumeConfirm?: TurnResult | null;
  turn?: Partial<TurnResult>;
  /** The buffer BEFORE the turn (and, unless `written` is given, after it). */
  buffer?: Partial<TranscriptBuffer> | null;
  written?: Partial<TranscriptBuffer> | null;
  conversationState?: Record<string, unknown> | null;
  lastMessageAt?: Date | null;
}

function make(opts: Opts = {}) {
  const session = {
    id: SESSION,
    workerId: WORKER,
    status: "active",
    conversationState: opts.conversationState ?? null,
    startedAt: T0,
    lastMessageAt: opts.lastMessageAt ?? null,
  };
  const chat = {
    findSession: vi.fn().mockResolvedValue(session),
    findActiveSessionByWorker: vi.fn().mockResolvedValue(opts.liveSession),
    createSession: vi.fn().mockResolvedValue({ id: NEW_SESSION, status: "active", startedAt: T0 }),
    findFreeChatLockDecider: vi.fn(async () => {
      if (opts.decider === "throws") throw new Error("statement timeout");
      return opts.decider;
    }),
    mergeFreeChatLock: vi.fn(async (..._args: unknown[]) => true),
    touchSession: vi.fn(async (..._args: unknown[]) => undefined),
    saveConversationState: vi.fn(async (..._args: unknown[]) => undefined),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    abandonSession: vi.fn(async (..._args: unknown[]) => true),
    endSession: vi.fn(async (..._args: unknown[]) => true),
    insertMessages: vi.fn(async (_tx: unknown, rows: Record<string, unknown>[]) =>
      rows.map((row, i) => ({ ...row, id: `msg-${i}`, voiceNoteId: null })),
    ),
    insertPackAnswers: vi.fn(async () => undefined),
    pinPack: vi.fn(async () => true),
  };
  const workers = {
    findById: vi.fn().mockResolvedValue({
      id: WORKER,
      fullName: "v1:token",
      currentState: "Bihar",
      currentCity: "Patna",
    }),
    latestProfile: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn(() => "Ramesh") };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const hydrate = (v: Partial<TranscriptBuffer> | null | undefined) =>
    v == null
      ? null
      : ({
          workerId: WORKER,
          turnCount: 0,
          captured: {},
          roleFamily: "",
          messages: [],
          startedAt: T0.toISOString(),
          ...v,
        } as TranscriptBuffer);
  const before = hydrate(opts.buffer === undefined ? {} : opts.buffer);
  const after = opts.written === undefined ? before : hydrate(opts.written);
  let loads = 0;
  const buffer = {
    load: vi.fn(async () => (loads++ === 0 ? before : after)),
    drop: vi.fn(async () => undefined),
  };
  const orchestrator = {
    openIdentityIntake: vi.fn(async () => null),
    openResumeConfirm: vi.fn(async () => opts.resumeConfirm ?? null),
    openFreeChatGreeting: vi.fn(async () => GREETING_TURN),
    takeTurn: vi.fn(async (_input: unknown) => ({ ...GREETING_TURN, ...opts.turn })),
  };
  const profiles = { extract: vi.fn(async () => ({ ai_job_id: "job-1", status: "queued" })) };
  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: false,
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
    ...(opts.killSwitch === undefined ? {} : { CHAT_FREE_CHAT_DISABLED: opts.killSwitch }),
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
  const turnInput = () =>
    (orchestrator.takeTurn.mock.calls[0]![0] as { freeChat?: FreeChatTurnInput }).freeChat;
  return { svc, chat, orchestrator, buffer, turnInput };
}

const CONFIRM_FIRST = { confirmFirst: true };
const DTO = { session_id: SESSION, text: "kaise ho" };

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// POST /chat/session
// ---------------------------------------------------------------------------

describe("POST /chat/session — the kill switch is today's opening, byte for byte", () => {
  it("reads no lock, opens no greeting, and serves the body a pre-ADR build serves", async () => {
    const off = make({ killSwitch: true });
    const res = await off.svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(res).toEqual({ session_id: NEW_SESSION, status: "active", started_at: T0 });
    expect(off.chat.findFreeChatLockDecider).not.toHaveBeenCalled();
    expect(off.orchestrator.openFreeChatGreeting).not.toHaveBeenCalled();
    expect(off.chat.mergeFreeChatLock).not.toHaveBeenCalled();
  });
});

describe("POST /chat/session — the greeting opens a new session (ADR-0051 (b))", () => {
  it("serves the greeting through the existing opening fields, with its Devanagari twin", async () => {
    const { svc, orchestrator } = make();
    const res = await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(res).toEqual({
      session_id: NEW_SESSION,
      status: "active",
      started_at: T0,
      opening_text: FREE_CHAT_COPY.GREETING.latin,
      opening_tts_text: FREE_CHAT_COPY.GREETING.dev,
      opening_options: [
        { option_key: "free_chat_start", label_text: "Haan, shuru karein" },
        { option_key: "free_chat_later", label_text: "Baad mein" },
      ],
    });
    expect(StartSessionResponseSchema.safeParse(res).success).toBe(true);
    expect(orchestrator.openFreeChatGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: NEW_SESSION, workerId: WORKER }),
    );
  });

  it("a worker whose last résumé session was FINISHED is free again — completion releases the lock", async () => {
    const { svc, chat } = make({ decider: { id: SESSION, status: "ended" } });
    const res = (await svc.startSession(WORKER, CTX, CONFIRM_FIRST)) as Record<string, unknown>;
    expect(res.opening_text).toBe(FREE_CHAT_COPY.GREETING.latin);
    expect(chat.mergeFreeChatLock).not.toHaveBeenCalled();
  });

  it("a LOCKED worker gets no greeting, and the lock is merged onto the new session", async () => {
    const { svc, chat, orchestrator } = make({ decider: { id: SESSION, status: "abandoned" } });
    const res = await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect(orchestrator.openFreeChatGreeting).not.toHaveBeenCalled();
    expect(chat.mergeFreeChatLock).toHaveBeenCalledWith(NEW_SESSION, WORKER, expect.any(String));
  });

  it("an unreadable lock DEGRADES to today's opening, writing nothing", async () => {
    const { svc, chat, orchestrator } = make({ decider: "throws" });
    const res = await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect(orchestrator.openFreeChatGreeting).not.toHaveBeenCalled();
    expect(chat.mergeFreeChatLock).not.toHaveBeenCalled();
  });

  it("opens nothing for a client that did not ask for a served opening", async () => {
    const { svc, chat } = make();
    const res = await svc.startSession(WORKER, CTX);
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect(chat.findFreeChatLockDecider).not.toHaveBeenCalled();
  });

  it("a résumé-import opening wins — and it is opened as the chat's, so it enters résumé mode", async () => {
    const { svc, orchestrator } = make({
      resumeConfirm: { ...GREETING_TURN, reply: "Resume se ye mila" },
    });
    await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(orchestrator.openFreeChatGreeting).not.toHaveBeenCalled();
    expect(orchestrator.openResumeConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ freeChat: true }),
    );
  });

  it("under the kill switch the résumé-import open is NOT the free chat's (it stamps nothing)", async () => {
    const { svc, orchestrator } = make({ killSwitch: true });
    await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(orchestrator.openResumeConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ freeChat: false }),
    );
  });

  it("`mint` skips the reattach entirely — the voice form's escape from a live free chat", async () => {
    const { svc, chat } = make({ liveSession: { id: SESSION, status: "active", startedAt: T0 } });
    const res = await svc.startSession(WORKER, CTX, { mint: true });
    expect(chat.findActiveSessionByWorker).not.toHaveBeenCalled();
    expect(chat.createSession).toHaveBeenCalledOnce();
    expect(res.session_id).toBe(NEW_SESSION);
  });

  it("opens no greeting on a REATTACH — the thread redraw shows it", async () => {
    const { svc, orchestrator } = make({
      liveSession: { id: SESSION, status: "active", startedAt: T0 },
    });
    await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(orchestrator.openFreeChatGreeting).not.toHaveBeenCalled();
  });
});

describe("abandon → a new session → still locked; a finished session releases it", () => {
  it("the abandon sweep's REPLACING write carries the lock of a résumé-mode session", async () => {
    const env: ProfilingEnvelope = {
      ...emptyProfilingEnvelope(),
      freeChat: enterMode(null, "resume", "chip", T0),
    };
    const { svc, chat } = make({ buffer: { profiling: env } });
    await svc.abandonInterview(
      { id: SESSION, workerId: WORKER, conversationState: null },
      400,
      CTX,
    );
    const state = chat.abandonSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual(LOCK);

    // The next session's decider reads that abandoned row: locked, no greeting.
    const next = make({ decider: { id: SESSION, status: "abandoned" } });
    const res = (await next.svc.startSession(WORKER, CTX, CONFIRM_FIRST)) as Record<
      string,
      unknown
    >;
    expect(res.opening_text).toBeUndefined();
  });

  it("a session that never entered résumé mode writes NO lock key — byte-identical to today", async () => {
    const env: ProfilingEnvelope = { ...emptyProfilingEnvelope(), freeChat: greetingState() };
    const { svc, chat } = make({ buffer: { profiling: env } });
    await svc.abandonInterview(
      { id: SESSION, workerId: WORKER, conversationState: null },
      400,
      CTX,
    );
    const state = chat.abandonSession.mock.calls[0]![2] as Record<string, unknown>;
    expect("free_chat_lock" in state).toBe(false);
  });

  it("the mid-interview checkpoint carries the lock too", async () => {
    const env: ProfilingEnvelope = {
      ...emptyProfilingEnvelope(),
      freeChat: enterMode(null, "resume", "chip", T0),
    };
    const { svc, chat } = make({
      turn: { checkpointDue: true, replayed: false },
      written: { profiling: env },
    });
    await svc.postMessage(WORKER, DTO, CTX);
    const state = chat.saveConversationState.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual(LOCK);
  });
});

describe("a lock that lives only on the ROW survives every replacing writer (N3)", () => {
  /** An envelope rebuilt without the lock: a lost buffer, a session that opened locked, the switch. */
  const rebuilt = (): ProfilingEnvelope => ({ ...emptyProfilingEnvelope(), freeChat: null });
  const ROW = { turn_count: 2, free_chat_lock: LOCK };

  it("the mid-interview checkpoint", async () => {
    const { svc, chat } = make({
      conversationState: ROW,
      turn: { checkpointDue: true },
      written: { profiling: rebuilt() },
    });
    await svc.postMessage(WORKER, DTO, CTX);
    const state = chat.saveConversationState.mock.calls[0]![1] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual(LOCK);
  });

  it("the abandon sweep", async () => {
    const { svc, chat } = make({ buffer: { profiling: rebuilt() } });
    await svc.abandonInterview({ id: SESSION, workerId: WORKER, conversationState: ROW }, 400, CTX);
    const state = chat.abandonSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual(LOCK);
  });

  it("the completion flush", async () => {
    const { svc, chat } = make({
      conversationState: ROW,
      turn: { complete: true, completionReason: "complete", kind: "close" },
      written: { profiling: rebuilt() },
    });
    await svc.postMessage(WORKER, DTO, CTX);
    const state = chat.endSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual(LOCK);
  });

  it("the envelope's own lock wins over the row's when it has one", async () => {
    const later = new Date(T0.getTime() + 60_000);
    const env: ProfilingEnvelope = {
      ...emptyProfilingEnvelope(),
      freeChat: enterMode(null, "resume", "chip", later),
    };
    const { svc, chat } = make({ buffer: { profiling: env } });
    await svc.abandonInterview({ id: SESSION, workerId: WORKER, conversationState: ROW }, 400, CTX);
    const state = chat.abandonSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(state.free_chat_lock).toEqual({ v: 1, locked_at: later.toISOString() });
  });
});

// ---------------------------------------------------------------------------
// POST /chat/message
// ---------------------------------------------------------------------------

describe("POST /chat/message — the free chat's turn input", () => {
  it("carries the switch, the session's own lock, and a lazy, memoised worker lock read", async () => {
    const { svc, chat, turnInput } = make({ decider: { id: SESSION, status: "abandoned" } });
    await svc.postMessage(WORKER, DTO, CTX);
    const input = turnInput()!;
    expect(input).toMatchObject({ enabled: true, sessionLocked: false });
    // Not read on an ordinary turn — only when the orchestrator asks.
    expect(chat.findFreeChatLockDecider).not.toHaveBeenCalled();
    expect(await input.locked()).toBe(true);
    expect(await input.locked()).toBe(true);
    expect(chat.findFreeChatLockDecider).toHaveBeenCalledOnce();
  });

  it("reads the session's own lock off the row it already loaded — no query", async () => {
    const { svc, chat, turnInput } = make({ conversationState: { free_chat_lock: LOCK } });
    await svc.postMessage(WORKER, DTO, CTX);
    const input = turnInput()!;
    expect(input.sessionLocked).toBe(true);
    expect(await input.locked()).toBe(true);
    expect(chat.findFreeChatLockDecider).not.toHaveBeenCalled();
  });

  it("under the kill switch the input says so; an unreadable lock reads as locked", async () => {
    const { svc, turnInput } = make({ killSwitch: true, decider: "throws" });
    await svc.postMessage(WORKER, DTO, CTX);
    expect(turnInput()!.enabled).toBe(false);
    expect(await turnInput()!.locked()).toBe(true);
  });
});

describe("POST /chat/message — only fixed lines are read aloud (R17, ADR-0051 §3.8)", () => {
  it("a MODEL-WRITTEN turn carries read_aloud:false and NO tts_text", async () => {
    const { svc } = make({
      turn: { reply: "Aapka din accha jaaye.", options: [RESUME_CHIP], readAloud: false },
    });
    const res = await svc.postMessage(WORKER, DTO, CTX);
    expect(res.read_aloud).toBe(false);
    expect("tts_text" in res).toBe(false);
    expect(PostMessageResponseSchema.safeParse(res).success).toBe(true);
  });

  it("a fixed line carries its Devanagari twin, and no read_aloud key at all", async () => {
    const { svc } = make({ turn: { reply: FREE_CHAT_COPY.JOBS.latin, options: [RESUME_CHIP] } });
    const res = await svc.postMessage(WORKER, DTO, CTX);
    expect(res.tts_text).toBe(FREE_CHAT_COPY.JOBS.dev);
    expect("read_aloud" in res).toBe(false);
    expect(res.suggested_options).toEqual([
      { option_key: "free_chat_resume", label_text: "Resume banayein", is_none_of_above: false },
    ]);
  });

  it("a REPLAYED model turn is not read aloud either", async () => {
    const { svc } = make({ turn: { reply: "Sab badhiya.", replayed: true, readAloud: false } });
    const res = await svc.postMessage(WORKER, DTO, CTX);
    expect(res.read_aloud).toBe(false);
    expect("tts_text" in res).toBe(false);
  });

  it("a deflection over a known question reads aloud as the composed twin", async () => {
    const question = "Shukriya. Aap kaun sa kaam karte hain, aur kitna tajurba hai?";
    const { svc } = make({ turn: { reply: `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${question}` } });
    const res = await svc.postMessage(WORKER, DTO, CTX);
    expect(res.tts_text).toMatch(new RegExp(`^${FREE_CHAT_COPY.LOCK_DEFLECT.dev}`));
  });
});

describe("POST /chat/message — a live free chat is not idle (ADR-0051 §3.6)", () => {
  const asideWritten = {
    messages: [
      {
        role: "worker" as const,
        text: "kaise ho",
        at: T0.toISOString(),
        voiceNoteId: null,
        aside: true as const,
      },
      {
        role: "assistant" as const,
        text: "Theek hai.",
        at: T0.toISOString(),
        voiceNoteId: null,
        aside: true as const,
      },
    ],
  };

  it("touches a session whose clock is unset after an aside", async () => {
    const { svc, chat } = make({ written: asideWritten });
    await svc.postMessage(WORKER, DTO, CTX);
    expect(chat.touchSession).toHaveBeenCalledWith(SESSION, expect.any(Date));
  });

  it("does not touch again inside the throttle window", async () => {
    const { svc, chat } = make({ written: asideWritten, lastMessageAt: new Date() });
    await svc.postMessage(WORKER, DTO, CTX);
    expect(chat.touchSession).not.toHaveBeenCalled();
  });

  it("does not touch after an interview turn — the checkpoint owns that clock", async () => {
    const { svc, chat } = make({
      written: {
        messages: [
          { role: "worker", text: "welder", at: T0.toISOString(), voiceNoteId: null },
          { role: "assistant", text: "Kitne saal?", at: T0.toISOString(), voiceNoteId: null },
        ],
      },
    });
    await svc.postMessage(WORKER, DTO, CTX);
    expect(chat.touchSession).not.toHaveBeenCalled();
  });
});

describe("the flush — free-chat rows are flagged, every other row is inserted as before", () => {
  it("marks ONLY the aside rows with metadata.free_chat", async () => {
    const { svc, chat } = make({
      buffer: {
        messages: [
          {
            role: "assistant",
            text: "Aapka pehla naam kya hai?",
            at: T0.toISOString(),
            voiceNoteId: null,
            intake: true,
          },
          {
            role: "assistant",
            text: FREE_CHAT_COPY.GREETING.latin,
            at: T0.toISOString(),
            voiceNoteId: null,
            aside: true,
          },
          {
            role: "worker",
            text: "Baad mein",
            at: T0.toISOString(),
            voiceNoteId: null,
            aside: true,
          },
          { role: "worker", text: "welder hoon", at: T0.toISOString(), voiceNoteId: null },
        ],
      },
    });
    await svc.abandonInterview({ id: SESSION, workerId: WORKER, conversationState: null }, 30, CTX);
    const rows = chat.insertMessages.mock.calls[0]![1] as Record<string, unknown>[];
    expect(rows.map((row) => row.metadata)).toEqual([
      { identity_intake: true },
      { free_chat: true },
      { free_chat: true },
      undefined,
    ]);
    expect("metadata" in rows[3]!).toBe(false);
  });
});
