import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import { EVENT_REGISTRY } from "@badabhai/event-schema";

import { narrowProfilingEnvelope, type ProfilingEnvelope } from "../profiling/conversation-state";
import { FREE_CHAT_COPY } from "../profiling/free-chat/free-chat.copy";
import { FreeChatService } from "../profiling/free-chat/free-chat.service";
import { FreeChatSummaryService } from "../profiling/free-chat/free-chat-summary.service";
import { ProfilingOrchestrator } from "../profiling/orchestrator.service";
import { ChatService } from "./chat.service";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import type { StartSessionResponse } from "./chat.dto";

/**
 * ═══ THE ROLLING SUMMARY, END TO END ON THE CHAT WIRE (ADR-0051 §8, #2027 Release 2) ═══
 *
 * A REAL `ChatService` over a REAL orchestrator, a REAL `FreeChatService` and a REAL
 * `FreeChatSummaryService`; only Redis, Postgres (an in-memory `chat_sessions` with the merge's
 * monotonic rule), the ai-service and the ledger are faked. The journey the release exists for:
 *
 *   1. a worker opens the chat, says "Baad mein" and chats casually for six exchanges — the fifth
 *      reply ages four lines out of the reply's window, a fold runs OFF the request path, and the
 *      summary is stored on the session's row;
 *   2. the session is abandoned (a replacing write) and the summary survives it;
 *   3. a NEW session opens: the summary is copied onto it at the greeting, and its first casual
 *      reply's model input carries it — while no classifier input ever does.
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

function makeWorld() {
  // ── Postgres: `chat_sessions`, with the summary merge's monotonic rule ─────────────────────
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
        startedAt: new Date(Date.UTC(2026, 9, 7, 10, minted)),
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
    findLatestFreeChatSummary: vi.fn(async (workerId: string) => {
      const carrier = [...rows.values()]
        .filter((r) => r.workerId === workerId && r.conversationState?.free_chat_summary != null)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      return carrier
        ? { id: carrier.id, summary: carrier.conversationState!.free_chat_summary }
        : undefined;
    }),
    mergeFreeChatSummary: vi.fn(
      async (
        id: string,
        workerId: string,
        summary: { session_id: string; folded_lines: number },
      ) => {
        const row = rows.get(id);
        if (!row || row.workerId !== workerId) return false;
        const stored = row.conversationState?.free_chat_summary as
          | { session_id?: unknown; folded_lines?: unknown }
          | undefined;
        const writes =
          stored == null ||
          stored.session_id !== summary.session_id ||
          typeof stored.folded_lines !== "number" ||
          stored.folded_lines < summary.folded_lines;
        if (!writes) return false;
        row.conversationState = { ...(row.conversationState ?? {}), free_chat_summary: summary };
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
        // The statement's `state || <the LIVE row's free_chat_summary>` — the operand pinned
        // in chat.repository.test.ts (`keepLiveFreeChatSummary`), mirrored here.
        const live = row.conversationState?.free_chat_summary;
        const merged = live != null ? { ...state, free_chat_summary: live } : state;
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
      category: "casual",
      confidence: 0.95,
      blocked: false,
      ai_metadata: REAL_META,
    })),
    freeChatReply: vi.fn(async (_input: unknown) => ({
      status: "answer",
      lines: [`Theek hai, baat ${++replies}.`],
      followup_chips: [],
      ai_metadata: { ...REAL_META, task_type: "profiling_free_reply" },
    })),
    freeChatSummarize: vi.fn(async (_input: unknown) => ({
      summary: "- Worker chats casually about cricket and his day.",
      ai_metadata: { ...REAL_META, task_type: "profiling_free_summary" },
    })),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const workers = {
    findById: vi.fn(async () => ({
      id: WORKER,
      fullName: "v1:tok",
      currentState: "Bihar",
      currentCity: "Patna",
    })),
    findCurrentCity: vi.fn(async () => null),
    latestProfile: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn(() => "Ramesh") };
  const lock = { acquire: vi.fn(async () => "tok"), release: vi.fn(async () => undefined) };

  // ADR-0054 — the live-news cap; no turn here asks for news.
  const newsCap = { reserve: vi.fn(async () => null), release: vi.fn(async () => undefined) };
  const freeChat = new FreeChatService(
    ai as never,
    cost as never,
    events as never,
    chat as never,
    newsCap as never,
  );
  const summary = new FreeChatSummaryService(
    ai as never,
    cost as never,
    events as never,
    chat as never,
    lock as never,
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
    summary,
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
  /** One message on the wire, then wait for any fold it scheduled — the test's clock, not the turn's. */
  const send = async (sessionId: string, text: string) => {
    const res = await svc.postMessage(
      WORKER,
      {
        session_id: sessionId,
        text,
        submission_id: `00000000-0000-4000-8000-${String(++sends).padStart(12, "0")}`,
      },
      CTX,
    );
    await summary.idle();
    return res;
  };
  const summaryEvents = () =>
    events.emit.mock.calls
      .map(([p]) => p as { event_name: string; payload: Record<string, unknown> })
      .filter((e) => e.event_name === "chat.free_chat_summary_updated");
  return { svc, chat, rows, ai, summary, send, summaryEvents };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("Release 2 — six casual exchanges fold into a summary a NEW session's reply reads", () => {
  it("folds off the request path, survives the abandon, is copied at the next greeting, and rides its reply", async () => {
    const w = makeWorld();

    // ── Session 1: the greeting, "Baad mein", six casual exchanges ───────────────────────────
    const first = (await w.svc.startSession(WORKER, CTX, {
      confirmFirst: true,
    })) as StartSessionResponse;
    expect(first.opening_text).toBe(FREE_CHAT_COPY.GREETING.latin);
    expect(first.free_chat_mode).toBe("greeting");
    const s1 = first.session_id;
    expect((await w.send(s1, "Baad mein")).free_chat_mode).toBe("free");

    for (let n = 1; n <= 6; n++) {
      const res = await w.send(
        s1,
        `${n === 1 ? "main Ramesh hoon, " : ""}aaj ka din kaisa tha ${n}`,
      );
      expect(res.reply.startsWith(`Theek hai, baat ${n}.`)).toBe(true);
      expect(res.read_aloud).toBe(false);
      expect(res.free_chat_mode).toBe("free");
      // Nothing folds until the fifth reply has aged four foldable lines out of the window.
      expect(w.ai.freeChatSummarize).toHaveBeenCalledTimes(n >= 5 ? 1 : 0);
    }

    // The fold sent the four oldest exchange lines, the worker's own name redacted (G2)…
    const sent = w.ai.freeChatSummarize.mock.calls[0]![0] as {
      previous_summary: unknown;
      turns: { role: string; text: string }[];
    };
    expect(sent.previous_summary).toBeNull();
    expect(sent.turns.map((t) => t.text)).toEqual([
      "main [NAME] hoon, aaj ka din kaisa tha 1",
      "Theek hai, baat 1.",
      "aaj ka din kaisa tha 2",
      "Theek hai, baat 2.",
    ]);
    // …and the summary is on session 1's row, its count this session's.
    const stored = w.rows.get(s1)!.conversationState!.free_chat_summary as Record<string, unknown>;
    expect(stored).toMatchObject({
      v: 1,
      text: "- Worker chats casually about cricket and his day.",
      session_id: s1,
      folded_lines: 4,
    });
    const [event] = w.summaryEvents();
    expect(event!.payload).toMatchObject({ outcome: "updated", folded_lines: 4 });
    expect(
      EVENT_REGISTRY["chat.free_chat_summary_updated"].payload.safeParse(event!.payload).success,
    ).toBe(true);

    // ── The sweep abandons session 1: a REPLACING write, and the summary survives it ──────────
    const row1 = w.rows.get(s1)!;
    await w.svc.abandonInterview(
      { id: s1, workerId: WORKER, conversationState: row1.conversationState },
      400,
      CTX,
    );
    expect(w.rows.get(s1)!.status).toBe("abandoned");
    expect(w.rows.get(s1)!.conversationState!.free_chat_summary).toEqual(stored);

    // ── Session 2: the greeting copies it on, re-stamped at 0; the first casual reply reads it ─
    const second = await w.svc.startSession(WORKER, CTX, { confirmFirst: true });
    const s2 = second.session_id;
    expect(s2).not.toBe(s1);
    expect(w.rows.get(s2)!.conversationState!.free_chat_summary).toEqual({
      ...stored,
      session_id: s2,
      folded_lines: 0,
    });

    await w.send(s2, "Baad mein");
    w.ai.freeChatReply.mockClear();
    await w.send(s2, "phir se namaste");
    const reply = w.ai.freeChatReply.mock.calls[0]![0] as { summary: unknown; category: string };
    expect(reply.category).toBe("casual");
    expect(reply.summary).toBe("- Worker chats casually about cricket and his day.");
    // The classifier never got it (R24) — in either session.
    for (const [input] of w.ai.freeChatClassify.mock.calls) {
      expect("summary" in (input as object)).toBe(false);
    }
  }, 15_000);
});
