import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { INTAKE_COPY, INTAKE_HANDOFF_TEXT } from "../profiling/identity-intake/identity-intake";
import type { TurnResult } from "../profiling/orchestrator.service";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import { StartSessionResponseSchema } from "./chat.dto";

/**
 * ═══ THE IDENTITY INTAKE ON THE CHAT WIRE (ADR-0048, #1858) ═══
 *
 * `POST /chat/session` is where the intake opens and `POST /chat/message` is where it continues;
 * the orchestrator is stubbed here so what is under test is only what `ChatService` does with it:
 *
 *   1. FLAG OFF IS TODAY, BYTE FOR BYTE — the orchestrator is not even asked, and the body is the
 *      one a build that has never heard of the intake already parses.
 *   2. FLAG ON opens a NEW session on the first missing question, with the two additive opening
 *      fields — and only when the client renders a served opening and the worker has a gap.
 *   3. It DEGRADES, never fails: a throw or a null is today's opening.
 *   4. The flush stores the intake's lines verbatim with a closed `metadata` flag, and every
 *      other row exactly as before.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const T0 = new Date("2026-09-30T10:00:00.000Z");

/** What `openIdentityIntake` returns for a worker with no name on file. */
const FIRST_NAME_TURN: TurnResult = {
  reply: INTAKE_COPY.first_name.prompt,
  kind: "ask",
  questionKey: "worker_first_name",
  options: [],
  whyText: INTAKE_COPY.first_name.why,
  answerType: "text",
  inputMode: "text",
  progress: { answered: 0, total: 8 },
  unansweredEssentials: ["primary_trade"],
  complete: false,
  completionReason: null,
  replayed: false,
  excludeFromParse: true,
  unavailable: false,
  checkpointDue: false,
};

interface Opts {
  intakeEnabled?: boolean;
  worker?: { fullName: string | null; currentState: string | null; currentCity: string | null };
  liveSession?: { id: string; status: string; startedAt: Date };
  openIntake?: TurnResult | null | "throws";
  turn?: Partial<TurnResult>;
  buffer?: Partial<TranscriptBuffer> | null;
}

function make(opts: Opts = {}) {
  const chat = {
    findSession: vi.fn().mockResolvedValue({
      id: SESSION,
      workerId: WORKER,
      status: "active",
      conversationState: null,
      startedAt: T0,
    }),
    findActiveSessionByWorker: vi.fn().mockResolvedValue(opts.liveSession),
    createSession: vi.fn().mockResolvedValue({ id: SESSION, status: "active", startedAt: T0 }),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    abandonSession: vi.fn().mockResolvedValue(true),
    insertMessages: vi.fn(async (_tx: unknown, rows: Record<string, unknown>[]) =>
      rows.map((row, i) => ({ ...row, id: `msg-${i}`, voiceNoteId: null })),
    ),
    insertPackAnswers: vi.fn(async () => undefined),
  };
  const workers = {
    findById: vi.fn().mockResolvedValue({
      id: WORKER,
      ...(opts.worker ?? { fullName: null, currentState: null, currentCity: null }),
    }),
  };
  const pii = { decrypt: vi.fn(() => "") };
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
  const buffer = {
    load: vi.fn(async () => hydrate(opts.buffer === undefined ? {} : opts.buffer)),
    drop: vi.fn(async () => undefined),
  };
  const orchestrator = {
    openIdentityIntake: vi.fn(async () => {
      if (opts.openIntake === "throws") throw new Error("redis down");
      return opts.openIntake === undefined ? FIRST_NAME_TURN : opts.openIntake;
    }),
    openResumeConfirm: vi.fn(async () => null),
    takeTurn: vi.fn(async () => ({ ...FIRST_NAME_TURN, ...opts.turn })),
  };
  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: false,
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
    ...(opts.intakeEnabled === undefined
      ? {}
      : { CHAT_IDENTITY_INTAKE_ENABLED: opts.intakeEnabled }),
  };
  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    buffer as never,
    {} as never,
    orchestrator as never,
  );
  return { svc, chat, orchestrator, events };
}

const CONFIRM_FIRST = { confirmFirst: true };

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("POST /chat/session — flag OFF is today's opening, byte for byte", () => {
  it("never asks the orchestrator, and serves the body a flag-less build already gets", async () => {
    const off = make({ intakeEnabled: false });
    const absent = make();
    const a = await off.svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    const b = await absent.svc.startSession(WORKER, CTX, CONFIRM_FIRST);

    expect(off.orchestrator.openIdentityIntake).not.toHaveBeenCalled();
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(["session_id", "started_at", "status"]);
    // Today's résumé-confirm open still runs exactly as it did.
    expect(off.orchestrator.openResumeConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat/session — flag ON opens a NEW session on the first missing question", () => {
  it("serves the question, its Devanagari twin, its key and its answer type — and no résumé field", async () => {
    const { svc, orchestrator } = make({ intakeEnabled: true });
    const res = (await svc.startSession(WORKER, CTX, CONFIRM_FIRST)) as Record<string, unknown>;

    expect(res).toEqual({
      session_id: SESSION,
      status: "active",
      started_at: T0,
      opening_text: "Aapka pehla naam kya hai?",
      opening_tts_text: "आपका पहला नाम क्या है?",
      opening_question_key: "worker_first_name",
      opening_answer_type: "text",
    });
    expect(StartSessionResponseSchema.safeParse(res).success).toBe(true);
    // The gaps are read off the row as presence booleans — never the values.
    expect(orchestrator.openIdentityIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        workerId: WORKER,
        gaps: { hasName: false, hasState: false, hasCity: false },
      }),
    );
    // D6 — the intake comes first; the résumé turn is its handoff, not a second opening.
    expect(orchestrator.openResumeConfirm).not.toHaveBeenCalled();
  });

  it("passes the PARTIAL gaps of a worker who already has some of it", async () => {
    const { svc, orchestrator } = make({
      intakeEnabled: true,
      worker: { fullName: "v1:token", currentState: "Bihar", currentCity: null },
    });
    await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(orchestrator.openIdentityIntake).toHaveBeenCalledWith(
      expect.objectContaining({ gaps: { hasName: true, hasState: true, hasCity: false } }),
    );
  });

  it("asks a worker with NO gap nothing — the orchestrator is not asked (D9)", async () => {
    const { svc, orchestrator } = make({
      intakeEnabled: true,
      worker: { fullName: "v1:token", currentState: "Bihar", currentCity: "Patna" },
    });
    const res = (await svc.startSession(WORKER, CTX, CONFIRM_FIRST)) as Record<string, unknown>;
    expect(orchestrator.openIdentityIntake).not.toHaveBeenCalled();
    expect("opening_question_key" in res).toBe(false);
  });

  it("opens nothing for a client that did not ask for a served opening (confirm_first absent)", async () => {
    const { svc, orchestrator } = make({ intakeEnabled: true });
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect(orchestrator.openIdentityIntake).not.toHaveBeenCalled();
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
  });

  it("opens nothing on a REATTACH — the thread redraw shows a pending question", async () => {
    const { svc, orchestrator } = make({
      intakeEnabled: true,
      liveSession: { id: SESSION, status: "active", startedAt: T0 },
    });
    await svc.startSession(WORKER, CTX, CONFIRM_FIRST);
    expect(orchestrator.openIdentityIntake).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", "throws" as const],
    ["returns null", null],
  ])("DEGRADES to today's opening when the open %s", async (_label, openIntake) => {
    const { svc, orchestrator } = make({ intakeEnabled: true, openIntake });
    const res = (await svc.startSession(WORKER, CTX, CONFIRM_FIRST)) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect(orchestrator.openResumeConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat/message — flag OFF is today's turn, byte for byte", () => {
  /** An ordinary pack question — what every turn of a session the intake never opened returns. */
  const PACK_TURN: Partial<TurnResult> = {
    reply: "Aap kaunsa kaam karte hain?",
    questionKey: "primary_trade",
    whyText: null,
    excludeFromParse: false,
  };

  it("hands the orchestrator today's input and returns the body a flag-less build returns", async () => {
    const off = make({ intakeEnabled: false, turn: PACK_TURN });
    const absent = make({ turn: PACK_TURN });
    const dto = { session_id: SESSION, text: "welder hoon" };
    const a = await off.svc.postMessage(WORKER, dto, CTX);
    const b = await absent.svc.postMessage(WORKER, dto, CTX);

    expect(a).toEqual(b);
    // The turn's input, less the wall clock each call stamps for itself and the name lookup each
    // request builds for itself (a fresh closure, so never reference-equal across two calls).
    // ADR-0051 — the free chat's input rides every chat turn, and its lock read (and Release 2's
    // summary read) is a fresh closure too; its DATA fields are compared instead.
    const inputOf = (world: ReturnType<typeof make>) => {
      const [input] = world.orchestrator.takeTurn.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      const { now, knownName, freeChat, ...rest } = input;
      expect(now).toBeInstanceOf(Date);
      expect(knownName).toBeTypeOf("function");
      const { locked, summary, ...freeChatData } = freeChat as Record<string, unknown>;
      expect(locked).toBeTypeOf("function");
      expect(summary).toBeTypeOf("function");
      return { ...rest, freeChat: freeChatData };
    };
    expect(inputOf(off)).toEqual(inputOf(absent));
    expect(Object.keys(inputOf(off)).sort()).toEqual([
      "armGeneralRoad",
      "ctx",
      "freeChat",
      "sessionId",
      "submissionId",
      "text",
      "voiceNoteId",
      "workerId",
    ]);
    for (const key of Object.keys(a)) expect(key).not.toMatch(/intake|opening_/);
  });

  it("flushes a session with no intake line with NO metadata key on any row", async () => {
    const { svc, chat } = make({
      intakeEnabled: false,
      buffer: {
        messages: [
          { role: "assistant", text: "Namaste", at: T0.toISOString(), voiceNoteId: null },
          { role: "worker", text: "welder hoon", at: T0.toISOString(), voiceNoteId: null },
        ],
      },
    });
    await svc.abandonInterview({ id: SESSION, workerId: WORKER, conversationState: null }, 30, CTX);
    const rows = chat.insertMessages.mock.calls[0]![1] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect("metadata" in row).toBe(false);
  });
});

describe("POST /chat/message — a later intake step is an ordinary typed question", () => {
  it("carries the step's key, `text`, and the Devanagari twin — and no prediction", async () => {
    const { svc } = make({
      intakeEnabled: true,
      turn: { reply: INTAKE_COPY.state.prompt, questionKey: "worker_state" },
    });
    const res = await svc.postMessage(WORKER, { session_id: SESSION, text: "Kumar" }, CTX);
    expect(res).toMatchObject({
      reply: "Aap kis state mein rehte hain?",
      tts_text: "आप किस स्टेट में रहते हैं?",
      asked_question_id: "worker_state",
      answer_type: "text",
      question_kind: "ask",
      suggested_options: [],
      lookahead: null,
      session_ended: false,
    });
  });
});

describe("the flush — intake lines are stored verbatim, flagged, and nothing else changes", () => {
  it("marks ONLY the intake's rows with the closed metadata flag", async () => {
    const { svc, chat } = make({
      buffer: {
        messages: [
          {
            role: "assistant",
            text: INTAKE_COPY.city.prompt,
            at: T0.toISOString(),
            voiceNoteId: null,
            intake: true,
          },
          { role: "worker", text: "Pune", at: T0.toISOString(), voiceNoteId: null, intake: true },
          {
            role: "assistant",
            text: INTAKE_HANDOFF_TEXT,
            at: T0.toISOString(),
            voiceNoteId: null,
            intake: true,
          },
          { role: "worker", text: "welder hoon", at: T0.toISOString(), voiceNoteId: null },
        ],
      },
    });
    await svc.abandonInterview({ id: SESSION, workerId: WORKER, conversationState: null }, 30, CTX);

    const rows = chat.insertMessages.mock.calls[0]![1] as Record<string, unknown>[];
    expect(rows.map((row) => row.bodyText)).toEqual([
      INTAKE_COPY.city.prompt,
      "Pune",
      INTAKE_HANDOFF_TEXT,
      "welder hoon",
    ]);
    for (const row of rows.slice(0, 3)) expect(row.metadata).toEqual({ identity_intake: true });
    // Every other row is inserted exactly as before — no metadata key, the column default applies.
    expect("metadata" in rows[3]!).toBe(false);
  });
});
