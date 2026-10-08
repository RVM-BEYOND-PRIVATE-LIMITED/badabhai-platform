import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { EVENT_REGISTRY } from "@badabhai/event-schema";

import { narrowProfilingEnvelope, type ProfilingEnvelope } from "../profiling/conversation-state";
import {
  FREE_CHAT_COPY,
  languageAskLine,
  languageYesLine,
} from "../profiling/free-chat/free-chat.copy";
import { FreeChatService } from "../profiling/free-chat/free-chat.service";
import { ProfilingOrchestrator } from "../profiling/orchestrator.service";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import type { StartSessionResponse } from "./chat.dto";

/**
 * ═══ THE KEPT REPLY LANGUAGE, END TO END ON THE CHAT WIRE (ADR-0051 §11, #2181) ═══
 *
 * A REAL `ChatService` over a REAL orchestrator and a REAL `FreeChatService`; only Redis, Postgres
 * (an in-memory `chat_sessions` carrying the merge's monotonic rule and the replacing writers'
 * live-key carry), the ai-service and the ledger are faked. The journey R41 promises:
 *
 *   1. a worker asks for Marathi ("marathi mai jawab do") and gets the ask; says "Haan, Marathi
 *      mein" — the language is kept, and its record is merged onto the session's row;
 *   2. the session is abandoned (a REPLACING write) and the record survives it;
 *   3. a NEW session opens: the greeting reads the record back, and a Hinglish message's reply is
 *      still asked for in Marathi — "for the whole chat, across returns".
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = {
  correlationId: "33333333-3333-4333-8333-333333333333",
  requestId: "req-wire",
} as never;

const REAL_META = {
  ai_call_id: "call",
  task_type: "profiling_free_classify",
  model_name: "gemini-2.5-flash-lite",
  provider: "google",
  real_call: true,
  input_tokens: 1,
  output_tokens: 1,
  estimated_cost_inr: 0.01,
  latency_ms: 10,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
};

const ITEM: QuestionPackItem = {
  question_key: "primary_trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  display_order: 0,
  target_kind: "rfs",
  target_field: "trade",
  target_skill_id: null,
  answer_type: "text",
  is_mandatory: true,
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
};
const UNIVERSAL: QuestionPack = {
  pack_id: "qp_universal",
  version: 1,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash",
  items: [ITEM],
};

interface Row {
  id: string;
  workerId: string;
  status: string;
  conversationState: Record<string, unknown> | null;
  startedAt: Date;
  lastMessageAt: Date | null;
  endedAt: Date | null;
}

/** The free-chat keys a replacing write keeps from the LIVE row (`keepLiveFreeChatKeys`). */
const LIVE_KEYS = ["free_chat_summary", "free_chat_language"] as const;

function makeWorld() {
  // ── Postgres: `chat_sessions`, with the language merge's monotonic rule ─────────────────────
  const rows = new Map<string, Row>();
  let minted = 0;
  const chat = {
    createSession: vi.fn(async (workerId: string) => {
      minted++;
      const row: Row = {
        id: `${minted}0000000-0000-4000-8000-000000000000`.slice(0, 36),
        workerId,
        status: "active",
        conversationState: null,
        startedAt: new Date(Date.UTC(2026, 9, 8, 10, minted)),
        lastMessageAt: null,
        endedAt: null,
      };
      rows.set(row.id, row);
      return row;
    }),
    findSession: vi.fn(async (id: string) => rows.get(id)),
    findActiveSessionByWorker: vi.fn(async (workerId: string) =>
      [...rows.values()].find((r) => r.workerId === workerId && r.status === "active"),
    ),
    findFreeChatLockDecider: vi.fn(async () => undefined),
    mergeFreeChatLock: vi.fn(async () => true),
    findLatestFreeChatSummary: vi.fn(async () => undefined),
    mergeFreeChatSummary: vi.fn(async () => true),
    // ADR-0051 §11 — the latest SET record across the worker's sessions: by its `set_at`, then
    // the newest-started session — the real query's ORDER BY, so two answers in one millisecond
    // still resolve the way Postgres resolves them.
    findLatestFreeChatLanguage: vi.fn(async (workerId: string) => {
      const setAt = (r: Row) =>
        String((r.conversationState!.free_chat_language as { set_at: string }).set_at);
      const carrier = [...rows.values()]
        .filter((r) => r.workerId === workerId && r.conversationState?.free_chat_language != null)
        .sort((a, b) =>
          setAt(a) !== setAt(b)
            ? setAt(a) < setAt(b)
              ? 1
              : -1
            : b.startedAt.getTime() - a.startedAt.getTime(),
        )[0];
      return carrier
        ? { id: carrier.id, language: carrier.conversationState!.free_chat_language }
        : undefined;
    }),
    mergeFreeChatLanguage: vi.fn(
      async (id: string, workerId: string, record: { set_at: string }) => {
        const row = rows.get(id);
        if (!row || row.workerId !== workerId) return false;
        const stored = row.conversationState?.free_chat_language as
          | { set_at?: unknown }
          | undefined;
        if (stored != null && typeof stored.set_at === "string" && stored.set_at >= record.set_at) {
          return false;
        }
        row.conversationState = { ...(row.conversationState ?? {}), free_chat_language: record };
        return true;
      },
    ),
    touchSession: vi.fn(async () => undefined),
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    abandonSession: vi.fn(
      async (_tx: unknown, id: string, state: Record<string, unknown>, at: Date) => {
        const row = rows.get(id)!;
        if (row.status !== "active") return false;
        // The statement's `state || <the LIVE row's summary> || <the LIVE row's language>` — the
        // operands pinned in chat.repository.test.ts (`keepLiveFreeChatKeys`), mirrored here.
        const merged: Record<string, unknown> = { ...state };
        for (const key of LIVE_KEYS) {
          const live = row.conversationState?.[key];
          if (live != null) merged[key] = live;
        }
        Object.assign(row, { conversationState: merged, status: "abandoned", endedAt: at });
        return true;
      },
    ),
    insertMessages: vi.fn(async (_tx: unknown, inserted: Record<string, unknown>[]) =>
      inserted.map((r, i) => ({ ...r, id: `msg-${i}`, voiceNoteId: null })),
    ),
    insertPackAnswers: vi.fn(async () => undefined),
  };

  // ── Redis: the transcript buffer, through JSON and the real envelope narrower ───────────────
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
      if ((store.get(id)?.profiling?.rev ?? 0) !== expectedRev) return false;
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
    drop: vi.fn(async (id: string) => void store.delete(id)),
  };

  // ── The ai-service, the ledger, the spine ───────────────────────────────────────────────────
  let replies = 0;
  const ai = {
    freeChatClassify: vi.fn(async (_input: unknown) => ({
      category: "career",
      confidence: 0.95,
      blocked: false,
      ai_metadata: REAL_META,
    })),
    freeChatReply: vi.fn(async (_input: unknown) => ({
      status: "answer",
      lines: [`Uttar ${++replies}.`],
      followup_chips: [],
      ai_metadata: { ...REAL_META, task_type: "profiling_free_reply" },
    })),
    freeChatSummarize: vi.fn(async (_input: unknown) => null),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const workers = {
    findById: vi.fn(async () => ({
      id: WORKER,
      fullName: "v1:tok",
      currentState: "Maharashtra",
      currentCity: "Pune",
    })),
    findCurrentCity: vi.fn(async () => null),
    latestProfile: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn(() => "Ramesh") };
  const newsCap = { reserve: vi.fn(async () => null), release: vi.fn(async () => undefined) };
  const freeChat = new FreeChatService(
    ai as never,
    cost as never,
    events as never,
    chat as never,
    newsCap as never,
  );
  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    {
      loadUniversal: vi.fn(async () => UNIVERSAL),
      loadPinned: vi.fn(async () => null),
      resolveForOccupation: vi.fn(async () => null),
    } as never,
    { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) } as never,
    chat as never,
    events as never,
    { leads: () => false, take: vi.fn(async () => null) } as never,
    {
      pendingForChat: vi.fn(async () => null),
      forImport: vi.fn(async () => new Map()),
      identityForChat: vi.fn(async () => null),
      routeForImport: vi.fn(async () => null),
    } as never,
    workers as never,
    undefined,
    undefined,
    { armed: () => false, take: vi.fn() } as never,
    undefined,
    freeChat,
  );
  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: false,
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
    CHAT_IDENTITY_INTAKE_ENABLED: false,
    CHAT_FREE_CHAT_DISABLED: false,
  };
  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    buffer as never,
    { extract: vi.fn(async () => ({ ai_job_id: "job", status: "queued" })) } as never,
    orchestrator,
  );

  let sends = 0;
  const send = (sessionId: string, text: string) =>
    svc.postMessage(
      WORKER,
      {
        session_id: sessionId,
        text,
        submission_id: `00000000-0000-4000-8000-${String(++sends).padStart(12, "0")}`,
      },
      CTX,
    );
  const lastReplyLanguage = () =>
    (ai.freeChatReply.mock.calls.at(-1)![0] as { reply_language: unknown }).reply_language;
  const languageEvents = () =>
    events.emit.mock.calls
      .map(([p]) => p as { event_name: string; payload: Record<string, unknown> })
      .filter((e) => e.event_name === "chat.free_chat_language_changed");
  return { svc, chat, rows, ai, send, lastReplyLanguage, languageEvents };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("§11 R41 — 'Haan, Marathi mein' holds across returns", () => {
  it("is kept, merged onto the row, survives the abandon, and rides a NEW session's replies", async () => {
    const w = makeWorld();

    // ── Session 1: the greeting, "Baad mein", a career question, the request, the ask ─────────
    const first = (await w.svc.startSession(WORKER, CTX, {
      confirmFirst: true,
    })) as StartSessionResponse;
    expect(first.opening_text).toBe(FREE_CHAT_COPY.GREETING.latin);
    const s1 = first.session_id;
    await w.send(s1, "Baad mein");
    await w.send(s1, "welder ki salary kitni hoti hai");
    expect(w.lastReplyLanguage()).toBe("hinglish");

    const asked = await w.send(s1, "marathi mai jawab do");
    expect(asked.reply).toBe(`Uttar 2.\n${languageAskLine("marathi").latin}`);
    expect(asked.read_aloud).toBe(false);
    expect(w.lastReplyLanguage()).toBe("marathi");

    const yes = await w.send(s1, "Haan, Marathi mein");
    expect(yes.reply).toBe(languageYesLine("marathi").latin);
    // A fixed line: read aloud from its Devanagari twin.
    expect(yes.tts_text).toBe(languageYesLine("marathi").dev);

    const stored = w.rows.get(s1)!.conversationState!.free_chat_language;
    expect(stored).toEqual({
      v: 1,
      language: "marathi",
      set_at: expect.any(String),
      session_id: s1,
    });
    const [event] = w.languageEvents();
    expect(event!.payload).toEqual({
      worker_id: WORKER,
      session_id: s1,
      from: null,
      to: "marathi",
      trigger: "accepted",
    });
    expect(
      EVENT_REGISTRY["chat.free_chat_language_changed"].payload.safeParse(event!.payload).success,
    ).toBe(true);

    // Typed in Hinglish, still Marathi.
    await w.send(s1, "aur kya batao");
    expect(w.lastReplyLanguage()).toBe("marathi");

    // ── The sweep abandons session 1: a REPLACING write, and the record survives it ───────────
    await w.svc.abandonInterview(
      { id: s1, workerId: WORKER, conversationState: w.rows.get(s1)!.conversationState },
      400,
      CTX,
    );
    expect(w.rows.get(s1)!.status).toBe("abandoned");
    expect(w.rows.get(s1)!.conversationState!.free_chat_language).toEqual(stored);

    // ── Session 2: the greeting reads it back; a Hinglish message is answered in Marathi ──────
    const second = (await w.svc.startSession(WORKER, CTX, {
      confirmFirst: true,
    })) as StartSessionResponse;
    const s2 = second.session_id;
    expect(s2).not.toBe(s1);
    expect(second.opening_text).toBe(FREE_CHAT_COPY.GREETING.latin);
    await w.send(s2, "Baad mein");
    await w.send(s2, "kaise ho aap");
    expect(w.lastReplyLanguage()).toBe("marathi");
    // Nothing new was written for session 2 — the choice still lives where it was made.
    expect(w.rows.get(s2)!.conversationState?.free_chat_language).toBeUndefined();
  }, 15_000);

  it("a 'Nahi' in a later session is the latest SET value — the session after follows each message", async () => {
    const w = makeWorld();
    const s1 = (await w.svc.startSession(WORKER, CTX, { confirmFirst: true })).session_id;
    await w.send(s1, "Baad mein");
    await w.send(s1, "tamil la sollunga");
    await w.send(s1, "aam");
    await w.svc.abandonInterview(
      { id: s1, workerId: WORKER, conversationState: w.rows.get(s1)!.conversationState },
      400,
      CTX,
    );

    const s2 = (await w.svc.startSession(WORKER, CTX, { confirmFirst: true })).session_id;
    await w.send(s2, "Baad mein");
    await w.send(s2, "kaise ho");
    expect(w.lastReplyLanguage()).toBe("tamil");
    await w.send(s2, "marathi mein bolo");
    await w.send(s2, "Nahi");
    expect(w.rows.get(s2)!.conversationState!.free_chat_language).toMatchObject({
      language: null,
      session_id: s2,
    });
    expect(w.languageEvents().map((e) => e.payload.trigger)).toEqual(["accepted", "declined"]);
    await w.svc.abandonInterview(
      { id: s2, workerId: WORKER, conversationState: w.rows.get(s2)!.conversationState },
      400,
      CTX,
    );

    const s3 = (await w.svc.startSession(WORKER, CTX, { confirmFirst: true })).session_id;
    await w.send(s3, "Baad mein");
    await w.send(s3, "tame kem cho");
    expect(w.lastReplyLanguage()).toBe("gujarati");
  }, 15_000);
});
