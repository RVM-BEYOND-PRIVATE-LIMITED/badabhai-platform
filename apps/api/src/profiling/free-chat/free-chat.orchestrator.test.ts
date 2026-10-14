import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY, isEventName } from "@badabhai/event-schema";

import type { TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import { WorkersService } from "../../workers/workers.service";
import { narrowProfilingEnvelope, type ProfilingEnvelope } from "../conversation-state";
import { IdentityIntakeService } from "../identity-intake/identity-intake.service";
import { INTAKE_HANDOFF_TEXT, type IdentityGaps } from "../identity-intake/identity-intake";
import { DE_ESCALATION_REPLY_TEXT } from "../next-question";
import { ProfilingOrchestrator, type TurnResult } from "../orchestrator.service";
import { RESUME_IDENTITY_OPTIONS } from "../resume-import/resume-identity";
import {
  FREE_CHAT_COPY,
  FREE_CHAT_LANG_NO_KEY,
  FREE_CHAT_LANG_NO_LINE,
  FREE_CHAT_LANG_YES_KEY,
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
  languageAskLine,
  languageYesLine,
} from "./free-chat.copy";
import {
  FREE_CHAT_ASIDE_CAP,
  FREE_CHAT_COOLDOWN_MS,
  FREE_CHAT_NUDGE_EVERY,
} from "./free-chat.state";
import { FreeChatService } from "./free-chat.service";
import { FreeChatSummaryService } from "./free-chat-summary.service";
import type { FreeChatReplyLanguage } from "@badabhai/types";

/**
 * ═══ THE PROFILING-STAGE FREE CHAT, THROUGH THE ORCHESTRATOR (ADR-0051, #2027) ═══
 *
 * `free-chat.router.test.ts` pins the routing table on pure inputs. This file proves the WIRING —
 * a REAL orchestrator over a REAL `FreeChatService`, with only Redis, the database, the AI service
 * and the cost ledger faked — so the buffer lines, the envelope, the events and the model calls
 * asserted here are the ones production makes. What is at risk, and what each block is shaped
 * around:
 *
 *   1. THE KILL SWITCH: every reply is byte-for-byte what the orchestrator without the free chat
 *      serves.
 *   2. FREE MODE: the greeting, Baad mein, the per-category handlers, the nudge, the strikes and
 *      the cool-down, the cap — and that every one of them spends no turn and no ask.
 *   3. RÉSUMÉ MODE (the lock): the skip list, the deflection that re-asks and spends nothing, the
 *      clarify, the forced-abusive pass, and an outage that is today's interview.
 *   4. THE CAS: a lost write never pays for a model call twice.
 *   5. HYGIENE AND THE SPINE: no aside line reaches the model's history, and every event validates.
 */

const SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "44444444-4444-4444-8444-444444444444";
const T0 = new Date("2026-10-06T10:00:00.000Z");
const CTX = { correlationId: "55555555-5555-4555-8555-555555555555", requestId: "req_free" };
const ALL_GAPS: IdentityGaps = { hasName: false, hasState: false, hasCity: false };

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
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
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
  is_mandatory: true,
});
const YEARS = item({
  question_key: "experience_years",
  target_kind: "rfs",
  target_field: "experience_years",
  answer_type: "number",
  prompt_text: "Kitne saal ka tajurba hai?",
});
const TOOLS = item({
  question_key: "own_tools",
  answer_type: "boolean",
  prompt_text: "Kya aapke paas apne auzaar hain?",
});
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Abhi aap kaunse sheher mein hain?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 4,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE, YEARS, TOOLS, CITY],
};

const LINE = {
  importId: IMPORT,
  roleKind: "cnc_grinding",
  experienceText: "2 saal ka tajurba",
  summaryText: "CNC grinder par kaam",
};

/** A real classifier answer — `real_call: true` is what makes it a VERDICT (ADR-0051 §3.2). */
const REAL_META = {
  ai_call_id: "call-classify",
  task_type: "profiling_free_classify",
  model_name: "gemini-2.5-flash-lite",
  provider: "google",
  real_call: true,
  input_tokens: 10,
  output_tokens: 2,
  estimated_cost_inr: 0.01,
  latency_ms: 300,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
};

type Category =
  | "resume"
  | "career"
  | "jobs"
  | "casual"
  | "trash"
  | "off_limits"
  | "distress"
  | "unclear";

const verdict = (category: Category, confidence = 0.92) => ({
  category,
  confidence,
  blocked: false,
  ai_metadata: REAL_META,
});

/** ADR-0054 — the news task's mock while it is unarmed: no real call, nothing found. */
const NEWS_MOCK = {
  status: "no_results" as const,
  search_count: 0,
  ai_metadata: { ...REAL_META, ai_call_id: "call-news", real_call: false },
};

const answer = (lines: string[], chips: string[] = []) => ({
  status: "answer" as const,
  lines,
  followup_chips: chips,
  ai_metadata: { ...REAL_META, ai_call_id: "call-reply", task_type: "profiling_free_reply" },
});

interface WorldOpts {
  /** The free chat service is NOT wired — a pre-ADR orchestrator, the byte-identity baseline. */
  withoutFreeChat?: boolean;
  /** `CHAT_FREE_CHAT_DISABLED=true`. */
  killSwitch?: boolean;
  /** The worker is locked by an earlier session (the decider's answer). */
  workerLocked?: boolean;
  /** This session's row already carries the lock. */
  sessionLocked?: boolean;
  /** A staged résumé identity line — "Haan" then serves "is this you?". */
  identity?: typeof LINE | null;
  /** The general road's flags (ADR-0045). */
  skillsArmed?: boolean;
  /** Phase A leads (the model is asked to take the turn — it returns null, a fallback). */
  llmLeads?: boolean;
  /** Lose the next N CAS writes without anything having changed. */
  loseCas?: number;
  /** Build the identity intake too. */
  withIntake?: boolean;
  /**
   * Release 2 — what the chat's summary thunk resolves to (`"throws"` rejects). ABSENT leaves the
   * thunk off the turn input, as every pre-Release-2 construction is.
   */
  summary?: string | null | "throws";
  /** Release 2 — wire a REAL `FreeChatSummaryService` (its row, lock and model faked) for the fold. */
  realFold?: boolean;
  /** ADR-0054 — news answers the worker already holds today (the cap is five). */
  newsHeld?: number;
  /** ADR-0054 — the news cap store cannot be read. */
  newsCapDown?: boolean;
  /**
   * ADR-0051 §11 — the reply language the worker kept in an EARLIER session (a durable record on
   * another row), or "throws" for a read that fails. Absent: none on file.
   */
  keptLanguage?: FreeChatReplyLanguage | "throws";
  /** The universal pack the registry serves. Absent: {@link UNIVERSAL_PACK}. */
  universal?: QuestionPack;
}

/** ADR-0051 §11 — an earlier session of the same worker, carrying a kept language. */
const EARLIER_SESSION = "77777777-7777-4777-8777-777777777777";
/** ADR-0051 §11 — the worker's NEXT session (persistence across returns). */
const NEXT_SESSION = "88888888-8888-4888-8888-888888888888";

function makeWorld(opts: WorldOpts = {}) {
  const store = new Map<string, TranscriptBuffer>();
  let casToLose = opts.loseCas ?? 0;
  let now = T0;
  // The session every `say` / `greet` addresses — switchable, for a worker's next session.
  let sessionId = SESSION;
  // ADR-0051 §11 — `chat_sessions.conversation_state.free_chat_language`, by session, with the
  // merge's monotonic rule (a record set earlier is replaced; one set at or after it is kept).
  const languageRows = new Map<
    string,
    { v: 1; language: unknown; set_at: string; session_id: string }
  >();
  if (opts.keptLanguage !== undefined && opts.keptLanguage !== "throws") {
    languageRows.set(EARLIER_SESSION, {
      v: 1,
      language: opts.keptLanguage,
      set_at: new Date(T0.getTime() - 86_400_000).toISOString(),
      session_id: EARLIER_SESSION,
    });
  }

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through JSON and the REAL narrower, as `ChatTranscriptBuffer.load` does.
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      if (casToLose > 0) {
        casToLose--;
        return false;
      }
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
    loadUniversal: vi.fn(async () => opts.universal ?? UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const identify = { identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })) };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
    mergeFreeChatLock: vi.fn(async (..._args: unknown[]) => true),
    // Release 2 — the fold's row read and its monotonic merge (the real fold only).
    findSession: vi.fn(async () => ({ id: SESSION, workerId: WORKER, conversationState: null })),
    findLatestFreeChatSummary: vi.fn(async () => undefined),
    mergeFreeChatSummary: vi.fn(async (..._args: unknown[]) => true),
    // ADR-0051 §11 — the kept language: the latest SET record across the worker's sessions.
    findLatestFreeChatLanguage: vi.fn(async (_workerId: string) => {
      if (opts.keptLanguage === "throws") throw new Error("statement timeout");
      const latest = [...languageRows.entries()].sort((a, b) =>
        a[1].set_at < b[1].set_at ? 1 : -1,
      )[0];
      return latest === undefined ? undefined : { id: latest[0], language: latest[1] };
    }),
    mergeFreeChatLanguage: vi.fn(
      async (
        id: string,
        _workerId: string,
        record: { v: 1; language: unknown; set_at: string; session_id: string },
      ) => {
        const stored = languageRows.get(id);
        if (stored !== undefined && stored.set_at >= record.set_at) return false;
        languageRows.set(id, record);
        return true;
      },
    ),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    leads: (envelope: ProfilingEnvelope) => opts.llmLeads === true && envelope.llmStage !== "done",
    take: vi.fn(async (..._args: unknown[]) => null),
  };
  const resume = {
    pendingForChat: vi.fn(async () => null),
    forImport: vi.fn(async () => new Map()),
    identityForChat: vi.fn(async () => opts.identity ?? null),
    routeForImport: vi.fn(async () => null),
  };
  const skills = {
    armed: () => opts.skillsArmed === true,
    take: vi.fn(async (..._args: unknown[]) => {
      throw new Error("skills stage reached");
    }),
  };

  const ai = {
    freeChatClassify: vi.fn(async (_input: unknown): Promise<unknown> => verdict("unclear", 0)),
    freeChatReply: vi.fn(async (_input: unknown): Promise<unknown> => null),
    freeChatSummarize: vi.fn(async (_input: unknown): Promise<unknown> => null),
    // ADR-0054 — the news task's MOCK by default (unarmed, R7): today's NEWS line is served.
    freeChatNews: vi.fn(async (_input: unknown): Promise<unknown> => NEWS_MOCK),
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  // ADR-0054 — the daily cap, in memory: the REAL store's contract (reserve → ok/count, or null).
  const newsCount = { held: opts.newsHeld ?? 0 };
  const newsCap = {
    reserve: vi.fn(async (_workerId: string, _now: Date) => {
      if (opts.newsCapDown === true) return null;
      if (newsCount.held >= 5) return { ok: false, count: newsCount.held };
      newsCount.held += 1;
      return { ok: true, count: newsCount.held };
    }),
    release: vi.fn(async (_workerId: string, _now: Date) => {
      newsCount.held -= 1;
    }),
  };
  const freeChat = new FreeChatService(
    ai as never,
    cost as never,
    events as never,
    chat as never,
    newsCap as never,
  );
  // Release 2 — the fold: a recording fake by default, or the real service over faked seams.
  const foldLock = {
    acquire: vi.fn(async () => "tok"),
    release: vi.fn(async () => undefined),
  };
  const realFold = new FreeChatSummaryService(
    ai as never,
    cost as never,
    events as never,
    chat as never,
    foldLock as never,
  );
  const fold = opts.realFold
    ? realFold
    : ({ schedule: vi.fn((_job: unknown) => undefined) } as unknown as FreeChatSummaryService);
  const summaryThunk = vi.fn(async () => {
    if (opts.summary === "throws") throw new Error("summary read failed");
    return opts.summary ?? null;
  });

  let intake: IdentityIntakeService | undefined;
  const workersRepo = {
    findById: vi.fn(async () => ({ id: WORKER, fullName: null })),
    findCurrentCity: vi.fn(async () => null),
    updateFullName: vi.fn(async () => ({ id: WORKER })),
    updateLocation: vi.fn(async () => ({ id: WORKER })),
    latestResume: vi.fn(async () => undefined),
  };
  if (opts.withIntake) {
    const vault = new Map<string, string>();
    const pii = {
      encrypt: vi.fn((plaintext: string) => {
        const token = `v1:tok_${vault.size + 1}`;
        vault.set(token, plaintext);
        return token;
      }),
      decrypt: vi.fn((token: string) => vault.get(token) ?? ""),
    };
    const workersService = new WorkersService(
      workersRepo as never,
      pii as never,
      events as never,
      {} as never,
      {} as ServerConfig,
      { add: vi.fn() } as never,
    );
    intake = new IdentityIntakeService(workersService, pii as never, events as never);
  }

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    resume as never,
    workersRepo as never,
    undefined,
    undefined,
    skills as never,
    intake,
    opts.withoutFreeChat ? undefined : freeChat,
    opts.withoutFreeChat ? undefined : fold,
  );

  const freeChatInput = () =>
    opts.withoutFreeChat
      ? {}
      : {
          freeChat: {
            enabled: opts.killSwitch !== true,
            sessionLocked: opts.sessionLocked === true,
            locked: async () => opts.workerLocked === true,
            ownName: async () => null,
            ...(opts.summary === undefined ? {} : { summary: summaryThunk }),
          },
        };

  const say = (
    text: string,
    extra: { armGeneralRoad?: boolean; answerSource?: "dialog" | "typed" } = {},
  ): Promise<TurnResult> =>
    orchestrator.takeTurn({
      sessionId,
      workerId: WORKER,
      text,
      now,
      // A distinct id per physical send, so a repeated word is a new turn — never a replay.
      submissionId: randomUUID(),
      voiceNoteId: null,
      ...(extra.armGeneralRoad === true ? { armGeneralRoad: true } : {}),
      answerSource: extra.answerSource ?? "dialog",
      ...freeChatInput(),
      knownName: async () => null,
      ctx: CTX as never,
    });
  const greet = () =>
    orchestrator.openFreeChatGreeting({
      sessionId,
      workerId: WORKER,
      now,
      ctx: CTX as never,
    });
  const openIntake = (gaps: IdentityGaps = ALL_GAPS) =>
    orchestrator.openIdentityIntake({
      sessionId: SESSION,
      workerId: WORKER,
      now,
      ctx: CTX as never,
      gaps,
    });
  const saved = () => store.get(sessionId);
  const envelope = () => saved()!.profiling!;
  const emitted = (name: string) =>
    events.emit.mock.calls
      .map(([params]) => params as { event_name: string; payload: Record<string, unknown> })
      .filter((e) => e.event_name === name);
  const classifyAs = (...answers: unknown[]) => {
    for (const a of answers) ai.freeChatClassify.mockResolvedValueOnce(a);
  };
  const replyWith = (...replies: unknown[]) => {
    for (const r of replies) ai.freeChatReply.mockResolvedValueOnce(r);
  };
  const newsWith = (...outs: unknown[]) => {
    for (const o of outs) ai.freeChatNews.mockResolvedValueOnce(o);
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  /** Address the worker's next session from here on (its own Redis buffer, its own row). */
  const useSession = (id: string) => {
    sessionId = id;
  };

  return {
    orchestrator,
    store,
    buffer,
    chat,
    events,
    llm,
    resume,
    ai,
    cost,
    say,
    greet,
    openIntake,
    saved,
    envelope,
    emitted,
    classifyAs,
    replyWith,
    newsWith,
    newsCap,
    newsCount,
    advance,
    fold,
    summaryThunk,
    useSession,
    languageRows,
  };
}

/** Open the greeting and tap "Baad mein" — a session in free mode. */
async function inFreeMode(world: ReturnType<typeof makeWorld>) {
  await world.greet();
  await world.say("Baad mein");
}

/** Open the greeting, tap "Haan" — a session in résumé mode with the opener on screen. */
async function inResumeMode(world: ReturnType<typeof makeWorld>) {
  await world.greet();
  await world.say("Haan, shuru karein");
}

const optionKeys = (turn: TurnResult) => turn.options.map((o) => o.option_key);

beforeEach(() => {
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 1. The kill switch
// ---------------------------------------------------------------------------

describe("the kill switch — every reply is the orchestrator without the free chat, byte for byte", () => {
  const SCRIPT = ["main welder hoon", "welder", "5 saal", "haan", "Pune", "aaj mausam kaisa hai"];

  it("serves byte-identical turns to a world with no free chat at all", async () => {
    const off = makeWorld({ killSwitch: true });
    const absent = makeWorld({ withoutFreeChat: true });
    for (const text of SCRIPT) {
      const a = await off.say(text);
      const b = await absent.say(text);
      expect(a).toEqual(b);
    }
    // No model was asked anything, and the buffers carry the same lines.
    expect(off.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(off.saved()!.messages).toEqual(absent.saved()!.messages);
    // THE SWITCH WRITES NOTHING: no mode stamped, no lock merged, no free-chat event.
    expect(off.envelope().freeChat).toBeNull();
    expect(off.chat.mergeFreeChatLock).not.toHaveBeenCalled();
    expect(off.emitted("chat.free_chat_turn_served")).toEqual([]);
    expect(off.emitted("chat.free_chat_mode_changed")).toEqual([]);
  });

  it("a session with no mode seen after the switch goes back OFF is stamped as today (first_turn)", async () => {
    const off = makeWorld({ killSwitch: true });
    await off.say("main welder hoon");
    expect(off.envelope().freeChat).toBeNull();
    const on = makeWorld();
    on.store.set(SESSION, off.saved()!);
    await on.say("welder");
    expect(on.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "first_turn" });
  });

  it("opens a résumé-import turn without stamping résumé mode or writing a lock", async () => {
    const off = makeWorld({ killSwitch: true, identity: LINE });
    const opened = await off.orchestrator.openResumeConfirm({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
      // The chat passes `!CHAT_FREE_CHAT_DISABLED` here.
      freeChat: false,
    });
    expect(opened).not.toBeNull();
    expect(off.envelope().freeChat).toBeNull();
    expect(off.chat.mergeFreeChatLock).not.toHaveBeenCalled();
    expect(off.emitted("chat.free_chat_mode_changed")).toEqual([]);
  });

  it("serves the intake's handoff opener byte for byte", async () => {
    const off = makeWorld({ killSwitch: true, withIntake: true });
    const absent = makeWorld({ withoutFreeChat: true, withIntake: true });
    await off.openIntake({ hasName: true, hasState: true, hasCity: false });
    await absent.openIntake({ hasName: true, hasState: true, hasCity: false });
    const a = await off.say("Pune");
    const b = await absent.say("Pune");
    expect(a).toEqual(b);
    expect(a.reply).toBe(INTAKE_HANDOFF_TEXT);
  });

  it("a greeting session started while it was on: the message reaches today's interview, the mode is kept", async () => {
    const world = makeWorld();
    await world.greet();
    const off = makeWorld({ killSwitch: true });
    off.store.set(SESSION, world.saved()!);
    const turn = await off.say("main welder hoon");
    expect(turn.reply).toBe(TRADE.prompt_text);
    expect(off.saved()!.turnCount).toBe(1);
    // KEPT, never re-stamped: the switch writes nothing.
    expect(off.envelope().freeChat).toMatchObject({ mode: "greeting" });
    expect(off.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(off.emitted("chat.free_chat_turn_served")).toEqual([]);
    expect(off.emitted("chat.free_chat_mode_changed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The greeting and free mode
// ---------------------------------------------------------------------------

describe("the greeting (a session with no intake)", () => {
  it("opens on GREETING with its two chips, writing only the assistant line, flagged aside", async () => {
    const world = makeWorld();
    const opened = await world.greet();
    expect(opened).toMatchObject({
      reply: FREE_CHAT_COPY.GREETING.latin,
      kind: "ask",
      questionKey: null,
      answerType: "single_select",
      unavailable: false,
    });
    expect(optionKeys(opened!)).toEqual([FREE_CHAT_START_KEY, FREE_CHAT_LATER_KEY]);
    const saved = world.saved()!;
    expect(saved.turnCount).toBe(0);
    expect(saved.messages).toEqual([
      {
        role: "assistant",
        text: FREE_CHAT_COPY.GREETING.latin,
        at: T0.toISOString(),
        voiceNoteId: null,
        aside: true,
      },
    ]);
    expect(saved.profiling!.freeChat).toMatchObject({ mode: "greeting", trigger: null, asides: 0 });
    // The general road is NOT armed by the greeting — it waits for résumé mode.
    expect(saved.profiling!.generalRoad.armed).toBe(false);
    expect(world.emitted("chat.free_chat_turn_served")[0]!.payload).toMatchObject({
      mode: "greeting",
      decided_by: "flow",
      outcome: "greeting",
      category: null,
    });
  });

  it("opens nothing on a session that is not new", async () => {
    const world = makeWorld();
    await world.say("main welder hoon");
    expect(await world.greet()).toBeNull();
  });

  // #2223 — a yes word or a later phrase followed by anything but filler is a message: it is
  // classified, never read as Haan / Baad mein. "haan marna hai" STARTED before; "abhi nahi jeena"
  // and "baad mein mar jaunga" got the later line; "ha jeena nahi" is the issue's own example.
  it.each([
    "haan marna hai",
    "haan mar jaunga",
    "abhi nahi jeena",
    "baad mein mar jaunga",
    "ha jeena nahi",
  ])(
    "%j is classified, not read as a greeting choice — a distress verdict gets the distress line",
    async (text) => {
      const world = makeWorld();
      await world.greet();
      world.classifyAs(verdict("distress", 0.3));
      const turn = await world.say(text);
      expect(world.ai.freeChatClassify).toHaveBeenCalledTimes(1);
      expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
      expect(world.envelope().freeChat!.mode).toBe("free");
      expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
        decided_by: "classifier",
        category: "distress",
      });
    },
  );

  it.each(["haan ji", "haan shuru karo", "ok"])(
    "%j still starts, with no classifier call",
    async (text) => {
      const world = makeWorld();
      await world.greet();
      const turn = await world.say(text);
      expect(turn.reply).toBe(FREE_CHAT_COPY.OPENER.latin);
      expect(world.envelope().freeChat!.mode).toBe("resume");
      expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    },
  );
});

describe("free mode — greeting → Baad mein → casual → career → refusal → validator failure", () => {
  it("walks the per-category table, spending no turn and no ask anywhere", async () => {
    const world = makeWorld();
    await world.greet();

    // Baad mein: the later line, the résumé chip, free mode — read deterministically.
    const later = await world.say("Baad mein");
    expect(later.reply).toBe(FREE_CHAT_COPY.LATER_ACK.latin);
    expect(optionKeys(later)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(world.envelope().freeChat).toMatchObject({ mode: "free", trigger: "chip" });
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();

    // Three casual messages: model lines, the résumé chip always, the nudge on the THIRD.
    for (let i = 1; i <= 3; i++) {
      world.classifyAs(verdict("casual"));
      world.replyWith(answer([`Aapka din accha jaaye, baat ${i}.`], ["Aur batao kuch"]));
      const turn = await world.say(`kaise ho ${i}`);
      expect(turn.readAloud).toBe(false);
      expect(optionKeys(turn)).toEqual(["fcq_a", FREE_CHAT_RESUME_KEY]);
      const nudged = turn.reply.endsWith(FREE_CHAT_COPY.CASUAL_NUDGE.latin);
      expect(nudged).toBe(i === 3);
    }
    expect(world.envelope().freeChat!.casualReplies).toBe(3);

    // A career answer with a ₹ range and a company name — both allowed by ruling R11.
    world.classifyAs(verdict("career"));
    world.replyWith(
      answer([
        "Aam taur par welder ko 15000 se 20000 milta hai.",
        "Tata Motors mein bhi kaam milta hai.",
      ]),
    );
    const career = await world.say("welder ki salary kitni hoti hai");
    expect(career.reply).toBe(
      "Aam taur par welder ko 15000 se 20000 milta hai.\nTata Motors mein bhi kaam milta hai.",
    );
    expect(career.readAloud).toBe(false);

    // A refusal: the model chose a TOPIC, the worker reads its reviewed line.
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "legal_medical_financial", ai_metadata: null });
    const refused = await world.say("loan kaise milega");
    expect(refused.reply).toBe(FREE_CHAT_COPY.LEGAL_MED_FIN.latin);
    expect(refused.readAloud).toBeUndefined();

    // A reply that fails the gate (an exclamation) — the fallback line, never the model's words.
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Bahut badhiya din hai!"]));
    const failed = await world.say("mast din hai");
    expect(failed.reply).toBe(FREE_CHAT_COPY.REPLY_FALLBACK.latin);

    // A reply call that failed outright — the same fallback.
    world.classifyAs(verdict("career"));
    world.replyWith(null);
    expect((await world.say("ITI karun ya nahi")).reply).toBe(FREE_CHAT_COPY.REPLY_FALLBACK.latin);

    // NOTHING WAS SPENT: no turn, no ask, no question on screen.
    const env = world.envelope();
    expect(world.saved()!.turnCount).toBe(0);
    expect(env.engineAsks).toBe(0);
    expect(env.servedQuestionKey).toBeNull();
    expect(env.answerMap).toEqual([]);

    const outcomes = world.emitted("chat.free_chat_turn_served").map((e) => e.payload.outcome);
    expect(outcomes).toEqual([
      "greeting",
      "fixed_line",
      "answered",
      "answered",
      "answered",
      "answered",
      "refused",
      "fallback",
      "fallback",
    ]);
    const nudges = world.emitted("chat.free_chat_turn_served").map((e) => e.payload.nudge);
    expect(nudges.filter(Boolean)).toHaveLength(1);
  });

  it("rejects a model reply carrying a template token — it is rendered through the vocative", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["{{worker_name}} ji, sab theek hai."]));
    expect((await world.say("sab theek")).reply).toBe(FREE_CHAT_COPY.REPLY_FALLBACK.latin);
  });
});

describe("free mode — the fixed-copy categories", () => {
  it.each([
    ["jobs", FREE_CHAT_COPY.JOBS.latin, [FREE_CHAT_RESUME_KEY]],
    ["off_limits", FREE_CHAT_COPY.OFF_LIMITS.latin, [FREE_CHAT_RESUME_KEY]],
    ["distress", FREE_CHAT_COPY.DISTRESS.latin, []],
  ] as const)("%s → its reviewed line, and no reply call", async (category, line, chips) => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict(category));
    const turn = await world.say("kuch bhi");
    expect(turn.reply).toBe(line);
    expect(optionKeys(turn)).toEqual(chips);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
  });

  it("the DISTRESS WORD LIST answers before the classifier is asked", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await world.say("ab jeene ka mann nahi karta");
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "lexicon",
      category: "distress",
    });
  });

  it.each([
    ["unclear", verdict("unclear", 0.9)],
    ["below the 0.6 floor", verdict("career", 0.55)],
    [
      "unavailable (a mock answer)",
      { ...verdict("career"), ai_metadata: { ...REAL_META, real_call: false } },
    ],
    ["unavailable (blocked)", { ...verdict("career"), blocked: true }],
    ["unavailable (null)", null],
  ])("%s → the clarify line and the résumé chip", async (_label, answered) => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(answered);
    const turn = await world.say("hmm");
    expect(turn.reply).toBe(FREE_CHAT_COPY.FREE_CLARIFY.latin);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
  });
});

describe("free mode — trash strikes and the cool-down (R13)", () => {
  it("warns twice, then cools down for 30 minutes — and the résumé chip still works", async () => {
    const world = makeWorld();
    await inFreeMode(world);

    expect((await world.say("chutiya")).reply).toBe(FREE_CHAT_COPY.TRASH_WARN.latin);
    expect((await world.say("gandu")).reply).toBe(FREE_CHAT_COPY.TRASH_WARN.latin);
    const third = await world.say("bhosdike");
    expect(third.reply).toBe(FREE_CHAT_COPY.TRASH_COOLDOWN.latin);
    const strikes = world.emitted("chat.free_chat_turn_served").slice(-3);
    expect(strikes.map((e) => e.payload.strike_count)).toEqual([1, 2, 3]);
    expect(strikes.map((e) => e.payload.cooldown_started)).toEqual([false, false, true]);

    // Typing during the cool-down: the cool-down line, and NO model call.
    world.advance(60_000);
    expect((await world.say("hello kaise ho")).reply).toBe(FREE_CHAT_COPY.TRASH_COOLDOWN.latin);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();

    // The chip still works: résumé mode, the opener.
    const start = await world.say(FREE_CHAT_RESUME_LABEL);
    expect(start.reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(world.envelope().freeChat!.mode).toBe("resume");
  });

  it("the cool-down ends after 30 minutes and typing is classified again", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    for (const word of ["chutiya", "gandu", "bhosdike"]) await world.say(word);
    world.advance(FREE_CHAT_COOLDOWN_MS + 1_000);
    world.classifyAs(verdict("jobs"));
    expect((await world.say("job chahiye")).reply).toBe(FREE_CHAT_COPY.JOBS.latin);
  });
});

describe("free mode — the per-session aside cap", () => {
  it("serves only the cap line once the session has served its asides, with no model call", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const saved = world.saved()!;
    world.store.set(SESSION, {
      ...saved,
      profiling: {
        ...saved.profiling!,
        freeChat: { ...saved.profiling!.freeChat!, asides: FREE_CHAT_ASIDE_CAP },
      },
    });
    const turn = await world.say("aur batao");
    expect(turn.reply).toBe(FREE_CHAT_COPY.ASIDE_CAP.latin);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });
});

describe("entering résumé mode", () => {
  it('"Resume banayein" serves the OPENER, locks the session, and arms the general road', async () => {
    const world = makeWorld({ skillsArmed: true });
    await inFreeMode(world);
    const turn = await world.say(FREE_CHAT_RESUME_LABEL, { armGeneralRoad: true });
    expect(turn).toMatchObject({
      reply: FREE_CHAT_COPY.OPENER.latin,
      answerType: "text",
      options: [],
    });
    const env = world.envelope();
    expect(env.freeChat).toMatchObject({ mode: "resume", trigger: "chip" });
    expect(env.freeChat!.lockedAt).toBe(T0.toISOString());
    expect(env.freeChat!.held).toMatchObject({ reply: FREE_CHAT_COPY.OPENER.latin });
    expect(env.generalRoad.armed).toBe(true);
    // The durable lock is merged onto the row, after the CAS.
    expect(world.chat.mergeFreeChatLock).toHaveBeenCalledWith(SESSION, WORKER, T0.toISOString());
    expect(world.emitted("chat.free_chat_mode_changed").map((e) => e.payload)).toEqual([
      expect.objectContaining({ from: "greeting", to: "free", trigger: "chip" }),
      expect.objectContaining({ from: "free", to: "resume", trigger: "chip" }),
    ]);
  });

  it("the greeting's Haan reads a short typed variant too", async () => {
    const world = makeWorld();
    await world.greet();
    expect((await world.say("haan ji")).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it("Haan serves the résumé 'is this you?' turn first when one is staged — and leaves the road unarmed", async () => {
    const world = makeWorld({ identity: LINE, skillsArmed: true });
    await world.greet();
    const turn = await world.say("Haan, shuru karein", { armGeneralRoad: true });
    expect(turn.options.map((o) => o.option_key)).toEqual(
      RESUME_IDENTITY_OPTIONS.map((o) => o.option_key),
    );
    const env = world.envelope();
    expect(env.resumeIdentity).toEqual({ importId: IMPORT, state: "pending" });
    expect(env.generalRoad.armed).toBe(false);
    // The worker's Haan is the free chat's line; the résumé turn is its own.
    const [, haan, reply] = world.saved()!.messages;
    expect(haan).toMatchObject({ role: "worker", aside: true });
    expect("aside" in reply!).toBe(false);
  });

  it("a typed résumé intent that already describes the work becomes the interview's FIRST answer", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("resume"));
    const turn = await world.say("main welder hoon, mera resume banao");
    // Not an aside: a real turn, answered by today's interview.
    expect(world.saved()!.turnCount).toBe(1);
    expect(turn.reply).toBe(TRADE.prompt_text);
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "classifier" });
    const last = world.saved()!.messages.at(-2)!;
    expect(last).toMatchObject({ role: "worker", text: "main welder hoon, mera resume banao" });
    expect("aside" in last).toBe(false);
  });

  it("a BARE intent gets the opener", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("resume"));
    expect((await world.say("resume banana hai")).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(world.saved()!.turnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Résumé mode — the lock
// ---------------------------------------------------------------------------

describe("résumé mode — a deflection re-serves the pending question and spends nothing", () => {
  it("deflects an off-topic message over a pack question, then captures the next answer against it", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("resume"));
    const first = await world.say("main welder hoon");
    expect(first.reply).toBe(TRADE.prompt_text);
    const before = world.envelope();

    world.classifyAs(verdict("casual"));
    const deflected = await world.say("aaj cricket match kaun jeeta");
    expect(deflected).toMatchObject({
      reply: `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${TRADE.prompt_text}`,
      questionKey: TRADE.question_key,
      kind: "ask",
    });
    const after = world.envelope();
    // NO TURN, NO ASK, NO MODEL STATE: the interview is exactly where it was.
    expect(world.saved()!.turnCount).toBe(1);
    expect(after.engineAsks).toBe(before.engineAsks);
    expect(after.askCounts).toEqual(before.askCounts);
    expect(after.servedQuestionKey).toBe(TRADE.question_key);
    expect(after.answerMap).toEqual(before.answerMap);
    expect(after.lastTurn!.questionKey).toBe(TRADE.question_key);

    // The next answer lands on the SAME question.
    world.classifyAs(verdict("resume"));
    await world.say("welder");
    const settled = world.envelope().answerMap.find((r) => r.question_key === TRADE.question_key);
    expect(settled?.value_normalized).toBe("welder");
  });

  it("a second deflection in a row still re-asks the bare question, not the previous bubble", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("off_limits"), verdict("jobs"));
    await world.say("modi ji kaise hain");
    const second = await world.say("koi job hai kya");
    expect(second.reply).toBe(
      `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${FREE_CHAT_COPY.OPENER.latin}`,
    );
  });

  it("deflects AT MOST TWICE per pending question — the third off-topic answer reaches the interview", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    // A real answer the classifier keeps misreading as casual (temperature 0: the same every time).
    world.classifyAs(verdict("casual"), verdict("casual"), verdict("casual"));
    const deflected = `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${FREE_CHAT_COPY.OPENER.latin}`;
    expect((await world.say("main welding karta hoon")).reply).toBe(deflected);
    expect((await world.say("main welding karta hoon")).reply).toBe(deflected);
    expect(world.saved()!.turnCount).toBe(0);
    const third = await world.say("main welding karta hoon");
    // Today's interview answered it: a real turn, the loop broken.
    expect(world.saved()!.turnCount).toBe(1);
    expect(third.reply).toBe(TRADE.prompt_text);

    // A NEW question resets the count: two more deflections before the guard passes again.
    world.classifyAs(verdict("jobs"), verdict("jobs"), verdict("jobs"));
    const onTrade = `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${TRADE.prompt_text}`;
    expect((await world.say("koi job hai kya")).reply).toBe(onTrade);
    expect((await world.say("koi job hai kya")).reply).toBe(onTrade);
    expect(world.saved()!.turnCount).toBe(1);
    await world.say("koi job hai kya");
    expect(world.saved()!.turnCount).toBe(2);
  });

  it("the guard caps deflections only — distress is still served after two of them", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("off_limits"), verdict("off_limits"), verdict("distress"));
    await world.say("election kaun jeetega");
    await world.say("election kaun jeetega");
    // The distress LIST, after two deflections.
    expect((await world.say("mujhe jeene ka mann nahi")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    // And the classifier's distress verdict.
    expect((await world.say("bahut bura lag raha hai sab")).reply).toBe(
      FREE_CHAT_COPY.DISTRESS.latin,
    );
    expect(world.saved()!.turnCount).toBe(0);
  });

  it("the deflect guard does not cap trash — two deflections later, trash is still de-escalated", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual"), verdict("casual"), verdict("trash"));
    await world.say("aaj garmi hai");
    await world.say("aaj garmi hai");
    expect((await world.say("tu pagal hai kya")).reply).toBe(
      `${DE_ESCALATION_REPLY_TEXT} ${FREE_CHAT_COPY.OPENER.latin}`,
    );
    expect(world.envelope().abusiveTurns).toBe(0);
  });

  it("re-asks what the envelope NAMES over a stale held copy (the voice form served a question)", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    // The voice form reattached the résumé-mode session and put pack question one on screen.
    await world.orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(world.envelope().servedQuestionKey).toBe(TRADE.question_key);
    world.classifyAs(verdict("casual"));
    expect((await world.say("kal chutti hai")).reply).toBe(
      `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${TRADE.prompt_text}`,
    );
  });

  it("a verdict below the floor asks to clarify, then the question again", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual", 0.4));
    const turn = await world.say("hmm theek");
    expect(turn.reply).toBe(`${FREE_CHAT_COPY.LOCK_CLARIFY.latin} ${FREE_CHAT_COPY.OPENER.latin}`);
    const served = world.emitted("chat.free_chat_turn_served").at(-1)!.payload;
    expect(served).toMatchObject({
      outcome: "clarify",
      decided_by: "classifier",
      confidence_bucket: "lt50",
    });
  });

  it("clarifies AT MOST ONCE per pending question — a second unsure answer reaches the interview", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    // The model answers garbage the same way every time (a real call, `unclear` / 0.0).
    world.classifyAs(verdict("unclear", 0), verdict("unclear", 0));
    const first = await world.say("hmm haan");
    expect(first.reply).toBe(`${FREE_CHAT_COPY.LOCK_CLARIFY.latin} ${FREE_CHAT_COPY.OPENER.latin}`);
    const second = await world.say("hmm haan theek");
    // Today's interview answered it: a real turn, no clarify loop.
    expect(world.saved()!.turnCount).toBe(1);
    expect(second.reply).toBe(TRADE.prompt_text);

    // A NEW question resets the cap: the next unsure answer is clarified once again.
    world.classifyAs(verdict("casual", 0.3));
    const third = await world.say("hmm dekhte hain");
    expect(third.reply).toBe(`${FREE_CHAT_COPY.LOCK_CLARIFY.latin} ${TRADE.prompt_text}`);
  });

  it("an UNAVAILABLE classifier passes the message to today's interview — an outage never degrades it", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(null);
    const turn = await world.say("main welder hoon");
    expect(turn.reply).toBe(TRADE.prompt_text);
    expect(world.saved()!.turnCount).toBe(1);
    expect(world.emitted("chat.free_chat_turn_served").map((e) => e.payload.outcome)).not.toContain(
      "deflected",
    );
  });

  it("a CLASSIFIER-ONLY trash verdict never counts toward MAX_ABUSIVE_TURNS (CLAUDE.md §3)", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("trash"), verdict("trash"), verdict("trash"));
    // The lexicon flags nothing here; only the model called it trash.
    const reAsk = `${DE_ESCALATION_REPLY_TEXT} ${FREE_CHAT_COPY.OPENER.latin}`;
    expect((await world.say("tu pagal hai kya")).reply).toBe(reAsk);
    expect((await world.say("tu pagal hai kya")).reply).toBe(reAsk);
    expect(world.envelope().abusiveTurns).toBe(0);
    expect(world.saved()!.turnCount).toBe(0);
    // The third for the same question passes to the interview — still uncounted.
    await world.say("tu pagal hai kya");
    expect(world.saved()!.turnCount).toBe(1);
    expect(world.envelope().abusiveTurns).toBe(0);
    const served = world.emitted("chat.free_chat_turn_served").slice(-2);
    expect(served.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        category: "trash",
        decided_by: "classifier",
        outcome: "fixed_line",
      }),
      expect.objectContaining({
        category: "trash",
        decided_by: "classifier",
        outcome: "fixed_line",
      }),
    ]);
  });

  it("abuse the LEXICON flags keeps today's behaviour exactly: counted, with no model call", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    const turn = await world.say("chutiya");
    expect(turn.reply).toBe(DE_ESCALATION_REPLY_TEXT);
    expect(world.envelope().abusiveTurns).toBe(1);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it("the distress list answers alone, and the interview resumes where it paused", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    const turn = await world.say("main marna chahta hoon");
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.options).toEqual([]);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    world.classifyAs(verdict("casual"));
    expect((await world.say("acha")).reply).toBe(
      `${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${FREE_CHAT_COPY.OPENER.latin}`,
    );
  });
});

/** Résumé mode with a pack question on screen: the number (YEARS) or the yes/no (TOOLS). */
async function onQuestion(world: ReturnType<typeof makeWorld>, upTo: "years" | "tools") {
  await inResumeMode(world);
  world.classifyAs(verdict("resume"), verdict("resume"));
  await world.say("main welder hoon");
  const next = await world.say("welder");
  expect(next.questionKey).toBe(YEARS.question_key);
  if (upTo === "tools") await world.say("5 saal");
  world.ai.freeChatClassify.mockClear();
}

describe("résumé mode — the skip list asks no model", () => {
  it("a typed number for a number question", async () => {
    const world = makeWorld();
    await onQuestion(world, "years");
    const turn = await world.say("5 saal");
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(turn.questionKey).toBe(TOOLS.question_key);
  });

  it("a typed yes for a yes/no question", async () => {
    const world = makeWorld();
    await onQuestion(world, "tools");
    await world.say("haan hai");
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it.each(["pata nahi", "chutiya", "."])("the lexicon's own class: %j", async (text) => {
    const world = makeWorld();
    await onQuestion(world, "years");
    await world.say(text);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it("the first message of a session with nothing on screen is today's interview, unclassified", async () => {
    const world = makeWorld();
    const turn = await world.say("main welder hoon");
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(turn.reply).toBe(TRADE.prompt_text);
    // …and the session was stamped résumé mode on that first turn, durably.
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "first_turn" });
    expect(world.chat.mergeFreeChatLock).toHaveBeenCalledOnce();
  });

  it("a session that opened LOCKED is stamped locked_at_open, with no second lock write", async () => {
    const world = makeWorld({ sessionLocked: true });
    await world.say("main welder hoon");
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "locked_at_open" });
    expect(world.chat.mergeFreeChatLock).not.toHaveBeenCalled();
    expect(world.emitted("chat.free_chat_mode_changed")[0]!.payload).toMatchObject({
      from: null,
      to: "resume",
      trigger: "locked_at_open",
    });
  });
});

// #2226 — a typed yes/no that carries other words keeps its skip, behind a distress check: the
// classifier runs, and only a distress verdict changes what happens to the answer.
describe("résumé mode — a typed yes/no carrying other words is checked for distress (#2226)", () => {
  const toolsAnswer = (world: ReturnType<typeof makeWorld>) =>
    world.envelope().answerMap.find((r) => r.question_key === TOOLS.question_key);

  it.each(["haan marna hai", "haan mar jaunga", "nahi jeena", "हाँ मरना है"])(
    "%j with a distress verdict gets the helpline, and nothing is stored",
    async (text) => {
      const world = makeWorld();
      await onQuestion(world, "tools");
      world.classifyAs(verdict("distress", 0.3));
      const turn = await world.say(text);
      expect(world.ai.freeChatClassify).toHaveBeenCalledOnce();
      expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
      expect(toolsAnswer(world)).toBeUndefined();
      expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
        mode: "resume",
        decided_by: "classifier",
        category: "distress",
        outcome: "fixed_line",
      });
      // The question is still held: the worker's next bare answer answers it.
      const next = await world.say("haan");
      expect(toolsAnswer(world)?.value_normalized).toBe(true);
      expect(next.questionKey).toBe(CITY.question_key);
    },
  );

  it.each([
    ["haan", true],
    ["haan ji", true],
    ["haan karta hoon", true],
    ["nahi", false],
  ] as const)("%j answers the question with no classifier call", async (text, value) => {
    const world = makeWorld();
    await onQuestion(world, "tools");
    const turn = await world.say(text);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(toolsAnswer(world)?.value_normalized).toBe(value);
    expect(turn.questionKey).toBe(CITY.question_key);
  });

  it.each(["resume", "career", "casual", "jobs", "off_limits", "trash", "unclear"] as const)(
    "a %s verdict never deflects it: it answers the question",
    async (category) => {
      const world = makeWorld();
      await onQuestion(world, "tools");
      world.classifyAs(verdict(category));
      const served = world.emitted("chat.free_chat_turn_served").length;
      const turn = await world.say("haan, 5 saal se karta hoon");
      expect(world.ai.freeChatClassify).toHaveBeenCalledOnce();
      expect(toolsAnswer(world)?.value_normalized).toBe(true);
      expect(turn.questionKey).toBe(CITY.question_key);
      expect(turn.reply).not.toContain(FREE_CHAT_COPY.LOCK_DEFLECT.latin);
      // A pass-through is today's interview, and emits no served turn.
      expect(world.emitted("chat.free_chat_turn_served")).toHaveLength(served);
    },
  );

  it.each([
    // The AI client folds a failed call and a timeout into null; it never throws.
    ["a failed call", () => Promise.resolve(null)],
    [
      "a mock distress (no real call)",
      () =>
        Promise.resolve({
          ...verdict("distress"),
          ai_metadata: { ...REAL_META, real_call: false },
        }),
    ],
  ])("an unavailable classifier (%s) passes it to the interview, as before", async (_l, out) => {
    const world = makeWorld();
    await onQuestion(world, "tools");
    world.ai.freeChatClassify.mockImplementationOnce(out);
    const turn = await world.say("haan marna hai");
    expect(turn.reply).not.toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(toolsAnswer(world)?.value_normalized).toBe(true);
    expect(turn.questionKey).toBe(CITY.question_key);
  });

  it("a number question keeps today's skip, whatever else the answer carries", async () => {
    const world = makeWorld();
    await onQuestion(world, "years");
    await world.say("5 saal se kar raha hoon");
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });
});

describe("résumé mode — a value its field's bound refuses (#2233)", () => {
  it("a future training year is a typed answer: re-asked, with no classifier call", async () => {
    const TRAINING_YEAR = item({
      question_key: "training_year",
      target_kind: "attribute",
      target_field: "training_year",
      answer_type: "number",
      prompt_text: "Training kis saal ki thi?",
    });
    const world = makeWorld({
      universal: { ...UNIVERSAL_PACK, items: [TRADE, TRAINING_YEAR] },
    });
    await inResumeMode(world);
    world.classifyAs(verdict("resume"), verdict("resume"));
    await world.say("main welder hoon");
    expect((await world.say("welder")).questionKey).toBe(TRAINING_YEAR.question_key);
    world.ai.freeChatClassify.mockClear();

    const turn = await world.say("2050");
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(turn.questionKey).toBe(TRAINING_YEAR.question_key);
    expect(turn.reply).toBe(TRAINING_YEAR.prompt_text);
    expect(
      world.envelope().answerMap.find((r) => r.question_key === TRAINING_YEAR.question_key)?.status,
    ).not.toBe("answered");
  });
});

// ---------------------------------------------------------------------------
// The identity intake's handoff
// ---------------------------------------------------------------------------

describe("the identity intake's handoff (ADR-0051 (a))", () => {
  it("serves the GREETING as the handoff, flagged aside, and defers the general-road stamp", async () => {
    const world = makeWorld({ withIntake: true, skillsArmed: true });
    await world.openIntake({ hasName: true, hasState: true, hasCity: false });
    const turn = await world.say("Pune", { armGeneralRoad: true });
    expect(turn.reply).toBe(FREE_CHAT_COPY.GREETING.latin);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_START_KEY, FREE_CHAT_LATER_KEY]);
    const env = world.envelope();
    expect(env.freeChat).toMatchObject({ mode: "greeting" });
    expect(env.generalRoad.armed).toBe(false);
    const reply = world.saved()!.messages.at(-1)!;
    expect(reply).toMatchObject({ aside: true });
    expect("intake" in reply).toBe(false);

    // Haan arms the road exactly as today's first message would.
    await world.say("Haan, shuru karein", { armGeneralRoad: true });
    expect(world.envelope().generalRoad.armed).toBe(true);
  });

  it("a LOCKED worker gets today's handoff opener, in résumé mode", async () => {
    const world = makeWorld({ withIntake: true, workerLocked: true });
    await world.openIntake({ hasName: true, hasState: true, hasCity: false });
    const turn = await world.say("Pune");
    expect(turn.reply).toBe(INTAKE_HANDOFF_TEXT);
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "locked_at_open" });
  });
});

// ---------------------------------------------------------------------------
// The code-review round
// ---------------------------------------------------------------------------

describe("the helpline is never re-served as 'the pending question'", () => {
  it("distress with nothing held, then a casual verdict: the interview answers, not the helpline again", async () => {
    const world = makeWorld();
    // The session's first message — nothing on screen, nothing held.
    expect((await world.say("main marna chahta hoon")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(world.envelope().freeChat!.held).toBeNull();
    world.classifyAs(verdict("casual"));
    const next = await world.say("acha theek hai");
    expect(next.reply).not.toContain(FREE_CHAT_COPY.DISTRESS.latin);
    expect(next.reply).toBe(TRADE.prompt_text);
  });
});

describe("résumé mode — hardship and a question back keep today's handling (owner ruling)", () => {
  it.each([
    ["hardship", "ghar chalana mushkil ho gaya hai"],
    // The lexicon's question back is the job-prospect question (persona §5).
    ["question back", "Sir job milegi kya?"],
  ])("%s skips the classifier", async (_label, text) => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("resume"));
    await world.say("main welder hoon");
    world.ai.freeChatClassify.mockClear();
    await world.say(text);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });
});

describe("résumé mode — a double-tapped free-chat chip is a no-op", () => {
  it.each(["Haan, shuru karein", "free_chat_start", "Resume banayein", "Baad mein"])(
    "%j re-serves the pending question: not captured, not classified, counted toward no cap",
    async (text) => {
      const world = makeWorld();
      await inResumeMode(world);
      const before = world.envelope();
      const turn = await world.say(text);
      expect(turn.reply).toBe(FREE_CHAT_COPY.OPENER.latin);
      expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
      const after = world.envelope();
      expect(world.saved()!.turnCount).toBe(0);
      expect(after.answerMap).toEqual([]);
      expect(after.freeChat!.asides).toBe(before.freeChat!.asides);
      expect(after.freeChat!.deflected).toBeNull();
      // Nothing was decided, so nothing is recorded as served.
      const served = world.emitted("chat.free_chat_turn_served").map((e) => e.payload.outcome);
      expect(served).toEqual(["greeting", "opener"]);
    },
  );
});

describe("the chip no-op yields to whatever owns the words, and is capped", () => {
  it('a typed "baad mein" with "Resume update kar doon?" on screen reaches the OFFER\'s reader', async () => {
    const world = makeWorld();
    await inResumeMode(world);
    const saved = world.saved()!;
    world.store.set(SESSION, {
      ...saved,
      profiling: {
        ...saved.profiling!,
        resumeUpdateOffer: {
          state: "pending",
          accepted: null,
          completionReason: "complete",
          answeredAt: null,
        },
      },
    });
    const turn = await world.say("baad mein");
    // The offer read the answer and closed the interview — no no-op re-serve.
    expect(turn.complete).toBe(true);
    expect(world.envelope().resumeUpdateOffer).toMatchObject({ state: "settled", accepted: false });
  });

  it("at most two no-ops per pending question — the third chip passes to the interview", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    expect((await world.say("Haan, shuru karein")).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect((await world.say("Haan, shuru karein")).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(world.saved()!.turnCount).toBe(0);
    expect(world.envelope().freeChat!.chipNoOps).toEqual({
      key: `text:${FREE_CHAT_COPY.OPENER.latin}`,
      count: 2,
    });
    await world.say("Haan, shuru karein");
    expect(world.saved()!.turnCount).toBe(1);
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
  });
});

describe("the pending-import reads are memoised per turn", () => {
  it('"Resume banayein" in free mode reads the identity line and the pending import ONCE each', async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.resume.identityForChat.mockClear();
    world.resume.pendingForChat.mockClear();
    // The import check at the top of free mode, then the opening "Haan" serves: two looks, one read.
    expect((await world.say(FREE_CHAT_RESUME_LABEL)).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(world.resume.identityForChat).toHaveBeenCalledOnce();
    expect(world.resume.pendingForChat).toHaveBeenCalledOnce();
  });
});

describe("a pending résumé import found at the greeting or in free mode (an upload is résumé intent)", () => {
  it("serves the import's turn on the next message instead of hiding it behind Haan", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.resume.identityForChat.mockResolvedValue(LINE as never);
    const turn = await world.say("kaise ho");
    expect(optionKeys(turn)).toEqual(RESUME_IDENTITY_OPTIONS.map((o) => o.option_key));
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "resume_import" });
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "flow",
      category: "resume",
      outcome: "opener",
    });
  });

  it("distress still outranks it", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.resume.identityForChat.mockResolvedValue(LINE as never);
    expect((await world.say("suicide")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(world.envelope().freeChat!.mode).toBe("free");
  });
});

describe("a classifier distress verdict bypasses the confidence floor", () => {
  it("free mode: distress at 0.3 gives the helpline", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("distress", 0.3));
    expect((await world.say("sab khatam sa lag raha hai")).reply).toBe(
      FREE_CHAT_COPY.DISTRESS.latin,
    );
  });

  it("résumé mode: distress at 0.3 gives the helpline, not a clarify", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("distress", 0.3));
    expect((await world.say("sab khatam sa lag raha hai")).reply).toBe(
      FREE_CHAT_COPY.DISTRESS.latin,
    );
  });
});

describe("the classify memo is keyed by its inputs", () => {
  it("a lost CAS that reloads onto ANOTHER pending question classifies again", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual"), verdict("casual"));
    // The first write loses to a winner that put a pack question on screen.
    world.buffer.saveWithCas.mockImplementationOnce(async (id: string) => {
      const held = world.store.get(id)!;
      world.store.set(id, {
        ...held,
        profiling: {
          ...held.profiling!,
          rev: held.profiling!.rev + 1,
          servedQuestionKey: TRADE.question_key,
        },
      });
      return false;
    });
    const turn = await world.say("aaj garmi hai");
    expect(world.ai.freeChatClassify).toHaveBeenCalledTimes(2);
    expect(turn.reply).toBe(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${TRADE.prompt_text}`);
  });
});

// ---------------------------------------------------------------------------
// 4. The CAS — a lost write never pays twice
// ---------------------------------------------------------------------------

describe("memoisation across a lost CAS", () => {
  it("calls the classifier and the reply model ONCE when the first write loses", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.ai.freeChatClassify.mockClear();
    world.cost.record.mockClear();
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Sab badhiya hai."]));
    // The next CAS write is lost: `decide` runs twice against the same envelope.
    world.buffer.saveWithCas.mockImplementationOnce(async () => false);
    const turn = await world.say("kya haal hai");
    expect(turn.reply).toBe("Sab badhiya hai.");
    expect(world.ai.freeChatClassify).toHaveBeenCalledOnce();
    expect(world.ai.freeChatReply).toHaveBeenCalledOnce();
    // The spend is recorded once per call, never per attempt.
    expect(world.cost.record.mock.calls.map((c) => c[1])).toEqual([
      "profiling_free_classify",
      "profiling_free_reply",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Hygiene and the spine
// ---------------------------------------------------------------------------

describe("transcript hygiene — no aside line reaches a reader of meaning", () => {
  it("flags every free-chat line, and the model's history on the first real turn carries none", async () => {
    const world = makeWorld({ llmLeads: true });
    await world.greet();
    await world.say("Baad mein");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Accha hai."]));
    await world.say("kaise ho");
    await world.say(FREE_CHAT_RESUME_LABEL);
    expect(world.saved()!.messages.every((m) => m.aside === true)).toBe(true);

    world.classifyAs(verdict("resume"));
    await world.say("main welder hoon");
    expect(world.llm.take).toHaveBeenCalledOnce();
    const history = world.llm.take.mock.calls[0]![2];
    expect(history).toEqual([]);
  });
});

describe("the gates beside the turn", () => {
  it("a REATTACH with a pending import at the greeting serves the import and enters résumé mode", async () => {
    const world = makeWorld();
    await world.greet();
    // The worker uploads a résumé, then the app reopens the chat.
    world.resume.identityForChat.mockResolvedValue(LINE as never);
    const opened = await world.orchestrator.openResumeConfirm({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
      freeChat: true,
    });
    expect(optionKeys(opened!)).toEqual(RESUME_IDENTITY_OPTIONS.map((o) => o.option_key));
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "resume_import" });
    expect(world.envelope().resumeIdentity).toEqual({ importId: IMPORT, state: "pending" });
    expect(world.emitted("chat.free_chat_mode_changed")[0]!.payload).toMatchObject({
      from: "greeting",
      to: "resume",
      trigger: "resume_import",
    });
  });

  it("openTurn WITHOUT the chat's flag never opens an import under a greeting (the voice form)", async () => {
    const world = makeWorld();
    await world.greet();
    world.resume.identityForChat.mockResolvedValue(LINE as never);
    const before = world.saved();
    const opened = await world.orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(opened.unavailable).toBe(true);
    expect(world.saved()).toEqual(before);
  });

  it("openResumeConfirm opens nothing beneath a greeting with NO import — and openTurn writes nothing", async () => {
    const world = makeWorld();
    await world.greet();
    const before = world.saved();
    expect(
      await world.orchestrator.openResumeConfirm({
        sessionId: SESSION,
        workerId: WORKER,
        now: T0,
        ctx: CTX as never,
        freeChat: true,
      }),
    ).toBeNull();
    // A free chat's screen is the free chat's: no pack question is ever written under it.
    const opened = await world.orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(opened.unavailable).toBe(true);
    expect(world.saved()).toEqual(before);
  });

  it("a session that OPENS on a résumé-import turn enters résumé mode (resume_import)", async () => {
    const world = makeWorld({ identity: LINE });
    const opened = await world.orchestrator.openResumeConfirm({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
      freeChat: true,
    });
    expect(opened).not.toBeNull();
    expect(world.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "resume_import" });
    expect(world.chat.mergeFreeChatLock).toHaveBeenCalledOnce();
    expect(world.emitted("chat.free_chat_mode_changed")[0]!.payload).toMatchObject({
      from: null,
      to: "resume",
      trigger: "resume_import",
    });
  });

  it("the voice form's open stamps nothing", async () => {
    const world = makeWorld({ identity: LINE });
    await world.orchestrator.openResumeConfirm({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(world.envelope().freeChat).toBeNull();
  });
});

describe("the spine — every event validates, and a pass-through emits no served turn", () => {
  it("validates every payload against the registry it is checked against in production", async () => {
    const world = makeWorld();
    await world.greet();
    await world.say("Baad mein");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Theek hai."], ["Aur kya"]));
    await world.say("hello");
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("aaj ki khabar");
    world.classifyAs(null);
    await world.say("hmm");
    for (const word of ["chutiya", "gandu", "bhosdike"]) await world.say(word);
    await world.say(FREE_CHAT_RESUME_LABEL);
    world.classifyAs(verdict("casual", 0.65));
    await world.say("baarish ho rahi hai");
    world.classifyAs(verdict("resume"));
    await world.say("main welder hoon");

    const calls = world.events.emit.mock.calls.map(
      ([params]) => params as { event_name: string; payload: unknown; idempotencyKey?: string },
    );
    const served = calls.filter((c) => c.event_name === "chat.free_chat_turn_served");
    const changed = calls.filter((c) => c.event_name === "chat.free_chat_mode_changed");
    // greeting, Baad mein, casual, refusal, clarify, three strikes, the chip, the deflection.
    expect(served.length).toBe(10);
    expect(changed.length).toBe(2);
    for (const { event_name: name, payload } of [...served, ...changed]) {
      expect(isEventName(name), name).toBe(true);
      expect(
        EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY].payload.safeParse(payload).success,
        `${name} ${JSON.stringify(payload)}`,
      ).toBe(true);
    }
    // One row per landed turn: every served key is distinct.
    expect(new Set(served.map((c) => c.idempotencyKey)).size).toBe(served.length);
    // The pass-through turn ("main welder hoon") served nothing of the free chat's own.
    expect(JSON.stringify(calls)).not.toContain("main welder hoon");
  });
});

// ---------------------------------------------------------------------------
// Release 2 — the rolling conversation summary (ADR-0051 §8)
// ---------------------------------------------------------------------------

/** The `schedule` spy of the default (fake) fold. */
const scheduled = (world: ReturnType<typeof makeWorld>) =>
  (world.fold as unknown as { schedule: ReturnType<typeof vi.fn> }).schedule;

/** One casual exchange the model answers. */
async function casual(world: ReturnType<typeof makeWorld>, n: number) {
  world.classifyAs(verdict("casual"));
  world.replyWith(answer([`Theek hai, baat ${n}.`]));
  return world.say(`kaise ho ${n}`);
}

describe("Release 2 — only a free-mode casual/career exchange is foldable (R22)", () => {
  it("flags the casual and career pairs, and no greeting, fixed line, refusal, fallback or résumé line", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    await casual(world, 1);
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Aam taur par welding mein accha kaam milta hai."]));
    await world.say("welding kaisa kaam hai");
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("aaj ki khabar");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Bahut badhiya!"]));
    await world.say("mast");
    world.classifyAs(verdict("jobs"));
    await world.say("job chahiye");
    world.classifyAs(verdict("unclear", 0.9));
    await world.say("hmm");
    await world.say("jeene ka mann nahi");
    await world.say("Resume banayein");

    const foldable = world
      .saved()!
      .messages.filter((m) => m.foldable === true)
      .map((m) => m.text);
    expect(foldable).toEqual([
      "kaise ho 1",
      "Theek hai, baat 1.",
      "welding kaisa kaam hai",
      "Aam taur par welding mein accha kaam milta hai.",
    ]);
    // Every foldable line is an aside too — still out of every reader of meaning.
    expect(world.saved()!.messages.filter((m) => m.foldable === true && m.aside !== true)).toEqual(
      [],
    );
  });

  it("résumé mode never flags a line foldable", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual"));
    await world.say("aaj mausam accha hai");
    expect(world.saved()!.messages.some((m) => m.foldable === true)).toBe(false);
  });
});

describe("Release 2 — the summary rides the reply, never the classifier (R24)", () => {
  it("a casual reply's input carries the stored summary; the classifier's has no such field", async () => {
    const world = makeWorld({ summary: "Worker likes cricket." });
    await inFreeMode(world);
    await casual(world, 1);
    const reply = world.ai.freeChatReply.mock.calls[0]![0] as { summary: unknown };
    expect(reply.summary).toBe("Worker likes cricket.");
    for (const [input] of world.ai.freeChatClassify.mock.calls) {
      expect("summary" in (input as object)).toBe(false);
    }
  });

  it("a career reply carries it too", async () => {
    const world = makeWorld({ summary: "Asked about welding before." });
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welding mein kaam milta hai."]));
    await world.say("welding seekhun?");
    expect((world.ai.freeChatReply.mock.calls[0]![0] as { summary: unknown }).summary).toBe(
      "Asked about welding before.",
    );
  });

  it("is read ONLY by a reply — a fixed-line turn costs no summary read", async () => {
    const world = makeWorld({ summary: "Notes." });
    await inFreeMode(world);
    world.classifyAs(verdict("jobs"));
    await world.say("job chahiye");
    expect(world.summaryThunk).not.toHaveBeenCalled();
  });

  it("no summary is null on the wire, and a thunk that rejects costs the summary, never the reply", async () => {
    const none = makeWorld({ summary: null });
    await inFreeMode(none);
    await casual(none, 1);
    expect((none.ai.freeChatReply.mock.calls[0]![0] as { summary: unknown }).summary).toBeNull();

    const broken = makeWorld({ summary: "throws" });
    await inFreeMode(broken);
    const turn = await casual(broken, 1);
    expect(turn.reply).toBe("Theek hai, baat 1.");
    expect((broken.ai.freeChatReply.mock.calls[0]![0] as { summary: unknown }).summary).toBeNull();
  });
});

describe("Release 2 — when a fold is scheduled (R21)", () => {
  it("carries the request's folded count as the job's lower bound (foldedAtLeast)", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Theek hai."]));
    await world.orchestrator.takeTurn({
      sessionId: SESSION,
      workerId: WORKER,
      text: "kaise ho",
      now: T0,
      submissionId: "77777777-7777-4777-8777-777777777777",
      voiceNoteId: null,
      freeChat: {
        enabled: true,
        sessionLocked: false,
        locked: async () => false,
        ownName: async () => null,
        foldedLines: 6,
      },
      knownName: async () => null,
      ctx: CTX as never,
    });
    expect(scheduled(world).mock.calls[0]![0]).toMatchObject({ foldedAtLeast: 6 });
  });

  it("after a free-mode casual/career reply LANDS — with the transcript that landed", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    await casual(world, 1);
    expect(scheduled(world)).toHaveBeenCalledOnce();
    expect(scheduled(world).mock.calls[0]![0]).toEqual({
      workerId: WORKER,
      sessionId: SESSION,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
      knownName: expect.any(Function),
      messages: world.saved()!.messages,
    });
  });

  it("never after a fixed line, a refusal, a fallback, a clarify or a résumé-mode aside", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("jobs"));
    await world.say("job chahiye");
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("khabar");
    world.classifyAs(verdict("casual"));
    world.replyWith(null);
    await world.say("hello");
    world.classifyAs(verdict("unclear", 0.9));
    await world.say("hmm");
    await world.say("Resume banayein");
    world.classifyAs(verdict("casual"));
    await world.say("aaj mausam accha hai");
    expect(scheduled(world)).not.toHaveBeenCalled();
  });

  it("a lost CAS schedules ONE fold, for the decision that landed", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Theek hai."]));
    // Lose the next write: the decision re-runs against the same state and lands on attempt two.
    world.buffer.saveWithCas.mockImplementationOnce(async () => false);
    const turn = await world.say("kaise ho");
    expect(turn.reply).toBe("Theek hai.");
    expect(scheduled(world)).toHaveBeenCalledOnce();
  });

  it("the kill switch schedules nothing", async () => {
    const off = makeWorld({ killSwitch: true });
    for (const text of ["kaise ho", "aaj mausam kaisa hai", "kya haal hai"]) await off.say(text);
    expect(scheduled(off)).not.toHaveBeenCalled();
    expect(off.ai.freeChatSummarize).not.toHaveBeenCalled();
  });
});

describe("Release 2 — the fold is OFF the request path", () => {
  it("every turn returns BEFORE its fold settles, and a failing fold never touches a served turn", async () => {
    const world = makeWorld({ realFold: true });
    await inFreeMode(world);
    // The summarizer does not answer until released: a turn that waited on its fold would hang.
    let release!: (out: unknown) => void;
    world.ai.freeChatSummarize.mockReturnValue(new Promise((resolve) => (release = resolve)));
    for (let n = 1; n <= 5; n++) {
      const turn = await casual(world, n);
      // (The third carries the every-third nudge after the model's line.)
      expect(turn.reply.startsWith(`Theek hai, baat ${n}.`)).toBe(true);
    }
    // The fifth reply aged four foldable lines out — the fold started, and is still waiting.
    await vi.waitFor(() => expect(world.ai.freeChatSummarize).toHaveBeenCalledOnce());
    expect(world.chat.mergeFreeChatSummary).not.toHaveBeenCalled();

    // A fold that FAILS outright (the row read throws): the next turn is served as ever.
    world.chat.findSession.mockRejectedValue(new Error("db down"));
    const after = await casual(world, 6);
    expect(after.reply.startsWith("Theek hai, baat 6.")).toBe(true);

    release(null);
    await (world.fold as FreeChatSummaryService).idle();
    expect(world.chat.mergeFreeChatSummary).not.toHaveBeenCalled();
  }, 10_000);

  it("a real fold stores what the summarizer wrote, once the reply has been served", async () => {
    const world = makeWorld({ realFold: true });
    await inFreeMode(world);
    world.ai.freeChatSummarize.mockResolvedValue({
      summary: "- Worker made small talk.",
      ai_metadata: { ...REAL_META, task_type: "profiling_free_summary" },
    });
    for (let n = 1; n <= 5; n++) await casual(world, n);
    await (world.fold as FreeChatSummaryService).idle();
    expect(world.chat.mergeFreeChatSummary).toHaveBeenCalledWith(SESSION, WORKER, {
      v: 1,
      text: "- Worker made small talk.",
      updated_at: expect.any(String),
      session_id: SESSION,
      folded_lines: 4,
    });
    const [event] = world.emitted("chat.free_chat_summary_updated");
    expect(event!.payload).toEqual({
      worker_id: WORKER,
      session_id: SESSION,
      outcome: "updated",
      folded_lines: 4,
      summary_chars: "- Worker made small talk.".length,
    });
    expect(
      EVENT_REGISTRY["chat.free_chat_summary_updated"].payload.safeParse(event!.payload).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADR-0054 — live news in free mode
// ---------------------------------------------------------------------------

const NEWS_META = {
  ...REAL_META,
  ai_call_id: "call-news-real",
  task_type: "profiling_free_news",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
};
const NEWS_SOURCE = {
  url: "https://www.thehindu.com/news/cities/pune/factory",
  title: "New factory opens in Pune",
  site: "thehindu.com",
};
const newsAnswer = (over: Record<string, unknown> = {}) => ({
  status: "answer" as const,
  kind: "work" as const,
  lines: ["Pune mein ek nayi factory khul rahi hai.", "Bharti agle mahine shuru hogi."],
  sources: [NEWS_SOURCE, { ...NEWS_SOURCE, url: "https://www.livemint.com/a", title: "Mint" }],
  search_count: 1,
  ai_metadata: NEWS_META,
  ...over,
});
const REFUSE_NEWS = { status: "refuse" as const, topic: "news" as const, ai_metadata: null };

/** In free mode, ask a career question whose reply refuses on `news`, with the news call's output. */
async function askNews(world: ReturnType<typeof makeWorld>, newsOut?: unknown) {
  world.classifyAs(verdict("career"));
  world.replyWith(REFUSE_NEWS);
  if (newsOut !== undefined) world.newsWith(newsOut);
  return world.say("Pune mein koi factory khul rahi hai?");
}

const newsServed = (world: ReturnType<typeof makeWorld>) =>
  world.emitted("chat.free_chat_news_served").map((e) => e.payload);
const lastTurnServed = (world: ReturnType<typeof makeWorld>) =>
  world.emitted("chat.free_chat_turn_served").at(-1)!.payload;

describe("ADR-0054 — a reply's `news` refusal runs the searched answer", () => {
  it("ANSWERED: the lines, the tiles, the résumé chip, read_aloud false, and both events", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, newsAnswer());

    expect(turn.reply).toBe(
      "Pune mein ek nayi factory khul rahi hai.\nBharti agle mahine shuru hogi.",
    );
    expect(turn.readAloud).toBe(false);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(turn.newsLinks).toEqual([
      { title: "New factory opens in Pune", url: NEWS_SOURCE.url, site: "thehindu.com" },
      { title: "Mint", url: "https://www.livemint.com/a", site: "livemint.com" },
    ]);
    expect(world.ai.freeChatNews).toHaveBeenCalledOnce();
    expect(world.newsCap.reserve).toHaveBeenCalledWith(WORKER, T0);
    expect(world.newsCap.release).not.toHaveBeenCalled();

    // The bubble carries its tiles (the replay's source); both lines are asides, never foldable.
    const [asked, answered] = world.saved()!.messages.slice(-2);
    expect(asked).toMatchObject({ role: "worker", aside: true });
    expect(answered).toMatchObject({ role: "assistant", aside: true, newsLinks: turn.newsLinks });
    expect(asked!.foldable).toBeUndefined();
    expect(answered!.foldable).toBeUndefined();
    expect(scheduled(world)).not.toHaveBeenCalled();
    // Not a casual reply: the nudge's count does not move.
    expect(world.envelope().freeChat!.casualReplies).toBe(0);

    expect(lastTurnServed(world)).toMatchObject({
      mode: "free",
      category: "career",
      outcome: "answered",
      refusal_topic: null,
    });
    expect(newsServed(world)).toEqual([
      {
        worker_id: WORKER,
        session_id: SESSION,
        outcome: "answered",
        kind: "work",
        search_count: 1,
        source_count: 2,
        daily_count: 1,
        submission_id: expect.any(String),
      },
    ]);
    expect(world.cost.record.mock.calls.map((c) => c[1])).toContain("profiling_free_news");
  });

  it("UNARMED (the mock): today's NEWS line, the slot handed back — the dark merge is invisible", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world);
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS.latin);
    expect(turn.newsLinks).toBeUndefined();
    expect(turn.readAloud).toBeUndefined();
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(world.newsCap.release).toHaveBeenCalledOnce();
    expect(world.newsCount.held).toBe(0);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line", refusal_topic: null });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({
        outcome: "unavailable",
        kind: null,
        search_count: 0,
        source_count: 0,
        daily_count: 0,
      }),
    ]);
  });

  it("SPEND CAP / COOLDOWN (the mock body WITH an error_code): NEWS_UNAVAILABLE, not 'jaldi aayegi'", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, {
      ...NEWS_MOCK,
      ai_metadata: { ...NEWS_MOCK.ai_metadata, error_code: "spend_cap" },
    });
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(world.newsCount.held).toBe(0);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line" });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: 0, daily_count: 0 }),
    ]);
  });

  it("a REAL call that FAILED (real_call true, success false): NEWS_UNAVAILABLE, never no_results", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, {
      status: "no_results",
      search_count: 0,
      ai_metadata: { ...NEWS_META, success: false, error_code: "timeout" },
    });
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    // R5 as revised: it reached Anthropic, so the attempt is counted.
    expect(world.newsCount.held).toBe(1);
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: 0, daily_count: 1 }),
    ]);
  });

  it("NO ai_metadata (a blocked input): NEWS_UNAVAILABLE, never the NEWS line", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, {
      status: "refuse",
      topic: "unsafe_other",
      ai_metadata: null,
    });
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line", refusal_topic: null });
    // It never reached Anthropic: the slot is handed back.
    expect(world.newsCount.held).toBe(0);
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: 0 }),
    ]);
  });

  it("CAPPED: NEWS_CAP and the chip, NO call, no search counted", async () => {
    const world = makeWorld({ newsHeld: 5 });
    await inFreeMode(world);
    const turn = await askNews(world, newsAnswer());
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_CAP.latin);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(world.newsCap.release).not.toHaveBeenCalled();
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line" });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "capped", search_count: null, daily_count: 5 }),
    ]);
  });

  it("an UNREADABLE cap: NEWS_UNAVAILABLE, no call, daily_count null (fail closed)", async () => {
    const world = makeWorld({ newsCapDown: true });
    await inFreeMode(world);
    const turn = await askNews(world, newsAnswer());
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: null }),
    ]);
  });

  it("a SENT call that came back null (timeout): NEWS_UNAVAILABLE, the slot KEPT (may be billed)", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, null);
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(world.newsCount.held).toBe(1);
    expect(world.newsCap.release).not.toHaveBeenCalled();
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: 1 }),
    ]);
  });

  it("NO RESULTS: NEWS_UNAVAILABLE, outcome no_results with its searches", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, {
      status: "no_results",
      search_count: 2,
      ai_metadata: NEWS_META,
    });
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line" });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({
        outcome: "no_results",
        search_count: 2,
        source_count: 0,
        daily_count: 1,
      }),
    ]);
    expect(world.newsCount.held).toBe(1);
  });

  it("a NESTED refusal serves that topic's line — distress without a chip, news unavailable", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const offLimits = await askNews(world, {
      status: "refuse",
      topic: "off_limits",
      ai_metadata: NEWS_META,
    });
    expect(offLimits.reply).toBe(FREE_CHAT_COPY.OFF_LIMITS.latin);
    expect(optionKeys(offLimits)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(lastTurnServed(world)).toMatchObject({
      outcome: "refused",
      refusal_topic: "off_limits",
    });

    const distress = await askNews(world, {
      status: "refuse",
      topic: "distress",
      ai_metadata: NEWS_META,
    });
    expect(distress.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(optionKeys(distress)).toEqual([]);

    const nested = await askNews(world, {
      status: "refuse",
      topic: "news",
      ai_metadata: NEWS_META,
    });
    expect(nested.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "refused", refusal_topic: "news" });

    expect(newsServed(world).map((p) => p.outcome)).toEqual(["refused", "refused", "refused"]);
    // Three real calls: three paid attempts.
    expect(world.newsCount.held).toBe(3);
  });

  it("REJECTED lines (G1, persona): NEWS_UNAVAILABLE, the turn a fallback, the slot KEPT", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(
      world,
      newsAnswer({ lines: ["Bhai, call karein 98765 43210 par."] }),
    );
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(turn.newsLinks).toBeUndefined();
    expect(JSON.stringify(world.saved()!.messages)).not.toContain("98765");
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fallback" });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "rejected", kind: null, source_count: 0 }),
    ]);
    expect(world.newsCount.held).toBe(1);
  });

  it("a LINK in a line (a bare phishing domain): rejected, never served", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(
      world,
      newsAnswer({ lines: ["PMKVY form pmkvy-form.in par bharein."] }),
    );
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(JSON.stringify(world.saved()!.messages)).not.toContain("pmkvy-form");
    expect(newsServed(world)).toEqual([expect.objectContaining({ outcome: "rejected" })]);
  });

  it("R9: a question with an IDENTIFIER is never searched — no slot, no call, daily_count null", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith(REFUSE_NEWS);
    world.newsWith(newsAnswer());
    const turn = await world.say("mera number 98765 43210 hai, job ki khabar bhejo");
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(world.newsCap.reserve).not.toHaveBeenCalled();
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(lastTurnServed(world)).toMatchObject({ outcome: "fixed_line" });
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: null }),
    ]);
  });

  it("R9: a phone typed in DEVANAGARI digits is never searched — NEWS_UNAVAILABLE, unavailable", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith(REFUSE_NEWS);
    world.newsWith(newsAnswer());
    const turn = await world.say("मेरा नंबर ९८७६५४३२१० है, नौकरी की खबर भेजो");
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(world.newsCap.reserve).not.toHaveBeenCalled();
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: null }),
    ]);
  });

  it("R9: an identifier in an EARLIER turn never rides along with 'aur batao'", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Theek hai."]));
    await world.say("mera email ramu@example.in hai");
    await askNews(world, newsAnswer());
    const sent = world.ai.freeChatNews.mock.calls[0]![0] as { recent_turns: { text: string }[] };
    expect(JSON.stringify(sent)).not.toContain("ramu@example.in");
    expect(sent.recent_turns.map((t) => t.text)).toContain("Theek hai.");
  });

  it("G2 FAILS CLOSED for news: a name that could not be DECRYPTED makes no slot and no call", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith(REFUSE_NEWS);
    world.newsWith(newsAnswer());
    const turn = await world.orchestrator.takeTurn({
      sessionId: SESSION,
      workerId: WORKER,
      text: "Pune mein koi factory khul rahi hai?",
      now: T0,
      submissionId: "99999999-9999-4999-8999-999999999999",
      voiceNoteId: null,
      // The decrypt failed: `knownName` reads it as no name (classify and reply go on, unchanged),
      // while the own-name view REJECTS — exactly what `ChatService.workerNameSources` builds.
      freeChat: {
        enabled: true,
        sessionLocked: false,
        locked: async () => false,
        ownName: async () => {
          throw new Error("the worker's own name could not be decrypted");
        },
      },
      knownName: async () => null,
      ctx: CTX as never,
    });
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    // The classifier and the reply keep their fail-open lookup (unchanged); news does not.
    expect(world.ai.freeChatReply).toHaveBeenCalledOnce();
    expect(world.newsCap.reserve).not.toHaveBeenCalled();
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", daily_count: null }),
    ]);
  });

  it("ZERO VALID TILES: rejected — an answer is never served without its source", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(
      world,
      newsAnswer({
        sources: [
          { ...NEWS_SOURCE, url: "http://www.thehindu.com/a" },
          { ...NEWS_SOURCE, url: "https://evilindiatimes.com/a" },
        ],
      }),
    );
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(newsServed(world)).toEqual([expect.objectContaining({ outcome: "rejected" })]);
  });

  it("RÉSUMÉ MODE never runs news — an off-topic question is deflected as today", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual"));
    world.newsWith(newsAnswer());
    const turn = await world.say("aaj ki taaza khabar kya hai");
    expect(turn.reply.startsWith(FREE_CHAT_COPY.LOCK_DEFLECT.latin)).toBe(true);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(world.ai.freeChatNews).not.toHaveBeenCalled();
    expect(world.newsCap.reserve).not.toHaveBeenCalled();
    expect(newsServed(world)).toEqual([]);
  });

  it("a LOST CAS re-decides against the SAME request: one call, one reservation, one event", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.cost.record.mockClear();
    world.buffer.saveWithCas.mockImplementationOnce(async () => false);
    const turn = await askNews(world, newsAnswer());
    expect(turn.newsLinks).toHaveLength(2);
    expect(world.ai.freeChatNews).toHaveBeenCalledOnce();
    expect(world.newsCap.reserve).toHaveBeenCalledOnce();
    expect(world.newsCount.held).toBe(1);
    expect(newsServed(world)).toHaveLength(1);
    expect(world.cost.record.mock.calls.map((c) => c[1])).toEqual([
      "profiling_free_classify",
      "profiling_free_reply",
      "profiling_free_news",
    ]);
  });

  it("the app's CONCURRENT RESEND of one submission: one reservation, one news call", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    // Each concurrent turn classifies and replies on its own; only news is shared.
    world.ai.freeChatClassify.mockResolvedValue(verdict("career"));
    world.ai.freeChatReply.mockResolvedValue(REFUSE_NEWS);
    let finish: (value: unknown) => void = () => undefined;
    world.ai.freeChatNews.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const input = {
      sessionId: SESSION,
      workerId: WORKER,
      text: "kal ka match kisne jeeta",
      now: T0,
      submissionId: "abababab-abab-4bab-8bab-abababababab",
      voiceNoteId: null,
      freeChat: {
        enabled: true,
        sessionLocked: false,
        locked: async () => false,
        ownName: async () => null,
      },
      knownName: async () => null,
      ctx: CTX as never,
    };
    const first = world.orchestrator.takeTurn(input);
    // The app gave up at 15 s and resent the SAME submission while the first is still searching.
    const resend = world.orchestrator.takeTurn({ ...input, now: new Date(T0.getTime() + 15_000) });
    await vi.waitFor(() => expect(world.ai.freeChatNews).toHaveBeenCalledOnce());
    finish(newsAnswer());
    const [a, b] = await Promise.all([first, resend]);
    expect(world.newsCap.reserve).toHaveBeenCalledOnce();
    expect(world.ai.freeChatNews).toHaveBeenCalledOnce();
    expect(world.newsCount.held).toBe(1);
    expect(a.reply).toBe(b.reply);
    expect(a.newsLinks).toEqual(b.newsLinks);
    expect(newsServed(world)).toHaveLength(1);
  });

  it("a DUPLICATE submit replays the answer WITH its tiles, and runs nothing again", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith(REFUSE_NEWS);
    world.newsWith(newsAnswer());
    const input = {
      sessionId: SESSION,
      workerId: WORKER,
      text: "kal ka match kisne jeeta",
      now: T0,
      submissionId: "88888888-8888-4888-8888-888888888888",
      voiceNoteId: null,
      freeChat: {
        enabled: true,
        sessionLocked: false,
        locked: async () => false,
        ownName: async () => null,
      },
      knownName: async () => null,
      ctx: CTX as never,
    };
    const first = await world.orchestrator.takeTurn(input);
    const again = await world.orchestrator.takeTurn(input);
    expect(again.replayed).toBe(true);
    expect(again.reply).toBe(first.reply);
    expect(again.readAloud).toBe(false);
    expect(again.newsLinks).toEqual(first.newsLinks);
    expect(world.ai.freeChatNews).toHaveBeenCalledOnce();
    expect(world.newsCap.reserve).toHaveBeenCalledOnce();
  });

  it("every news-turn event validates against the registry", async () => {
    const world = makeWorld({ newsHeld: 3 });
    await inFreeMode(world);
    await askNews(world, newsAnswer({ kind: "everyday", search_count: 2 }));
    await askNews(world, null);
    await askNews(world, newsAnswer());
    await askNews(world, newsAnswer());
    const calls = world.events.emit.mock.calls.map(
      ([params]) => params as { event_name: string; payload: unknown; idempotencyKey: string },
    );
    const news = calls.filter((c) => c.event_name === "chat.free_chat_news_served");
    // Three held, then an answer (4), a timeout that may have been billed (5, kept), then the cap.
    expect(news.map((c) => (c.payload as { outcome: string }).outcome)).toEqual([
      "answered",
      "unavailable",
      "capped",
      "capped",
    ]);
    expect(news.map((c) => (c.payload as { daily_count: number }).daily_count)).toEqual([
      4, 5, 5, 5,
    ]);
    for (const { event_name: name, payload } of calls) {
      expect(
        EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY].payload.safeParse(payload).success,
        `${name} ${JSON.stringify(payload)}`,
      ).toBe(true);
    }
    expect(new Set(news.map((c) => c.idempotencyKey)).size).toBe(news.length);
  });
});

// ---------------------------------------------------------------------------
// #2172 — no nudge on the casual reply right after a résumé offer
// ---------------------------------------------------------------------------

type World = ReturnType<typeof makeWorld>;

/** Seed the casual counter so the NEXT casual reply is a nudge turn (`count + 1` is a multiple). */
function primeNudge(world: World, count = 2 * FREE_CHAT_NUDGE_EVERY - 1) {
  const saved = world.saved()!;
  world.store.set(SESSION, {
    ...saved,
    profiling: {
      ...saved.profiling!,
      freeChat: { ...saved.profiling!.freeChat!, casualReplies: count },
    },
  });
}

/** Replace the stored `lastTurn` — absent (`undefined`) or a raw stamp the real narrower reads. */
function storeLastTurn(world: World, lastTurn: unknown) {
  const saved = world.saved()!;
  const { lastTurn: _dropped, ...profiling } = saved.profiling!;
  world.store.set(SESSION, {
    ...saved,
    profiling: (lastTurn === undefined
      ? profiling
      : { ...profiling, lastTurn }) as unknown as ProfilingEnvelope,
  });
}

const DECLINE_REPLY = "Koi baat nahi, aaram se sochiye.";

/** The worker declines the offer — read as `casual` since #2176 — and the model answers it. */
async function decline(world: World, text = "nahi") {
  world.classifyAs(verdict("casual"));
  world.replyWith(answer([DECLINE_REPLY], ["Aur batao kuch"]));
  return world.say(text);
}

const nudged = (turn: TurnResult) => turn.reply.endsWith(FREE_CHAT_COPY.CASUAL_NUDGE.latin);

const answeredNudges = (world: World) =>
  world
    .emitted("chat.free_chat_turn_served")
    .filter((e) => e.payload.outcome === "answered")
    .map((e) => e.payload.nudge);

describe("#2172 — the casual reply right after a résumé offer never carries the nudge", () => {
  it.each([
    {
      offer: "JOBS",
      opts: {},
      serve: (world: World) => {
        world.classifyAs(verdict("jobs"));
        return world.say("job chahiye");
      },
    },
    {
      // A casual reply ENDING with the nudge — R38's fourth offer.
      offer: "CASUAL_NUDGE",
      opts: {},
      serve: (world: World) => {
        primeNudge(world, FREE_CHAT_NUDGE_EVERY - 1);
        return casual(world, FREE_CHAT_NUDGE_EVERY);
      },
    },
    {
      offer: "NEWS_CAP",
      opts: { newsHeld: 5 },
      serve: (world: World) => askNews(world, newsAnswer()),
    },
  ] as const)(
    "$offer → 'nahi' (casual) on a DUE counter: the model's line alone, the chip, nudge false",
    async ({ offer, opts, serve }) => {
      const world = makeWorld(opts);
      await inFreeMode(world);
      const offered = await serve(world);
      expect(offered.reply.endsWith(FREE_CHAT_COPY[offer].latin)).toBe(true);

      // The counter WOULD fire on the next casual reply.
      primeNudge(world);
      const turn = await decline(world);

      expect(turn.reply).toBe(DECLINE_REPLY);
      // The résumé chip stays attached as always (R9, §5.1).
      expect(optionKeys(turn)).toEqual(["fcq_a", FREE_CHAT_RESUME_KEY]);
      // The count still moved — only the line was skipped — and the event says so truthfully.
      expect(world.envelope().freeChat!.casualReplies).toBe(2 * FREE_CHAT_NUDGE_EVERY);
      expect(lastTurnServed(world)).toMatchObject({
        category: "casual",
        outcome: "answered",
        nudge: false,
      });
    },
  );

  it("unseeded: casual, casual, JOBS, 'abhi nahi' — the due third is skipped, and NOT re-owed", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    expect(nudged(await casual(world, 1))).toBe(false);
    expect(nudged(await casual(world, 2))).toBe(false);
    world.classifyAs(verdict("jobs"));
    expect((await world.say("job chahiye")).reply).toBe(FREE_CHAT_COPY.JOBS.latin);

    const declined = await decline(world, "abhi nahi");
    expect(declined.reply).toBe(DECLINE_REPLY);
    expect(world.envelope().freeChat!.casualReplies).toBe(3);

    // The next nudge rides the next multiple, as if the counter had been reset at the decline.
    const after: boolean[] = [];
    for (let n = 4; n <= 6; n++) after.push(nudged(await casual(world, n)));
    expect(after).toEqual([false, false, true]);
    expect(answeredNudges(world)).toEqual([false, false, false, false, false, true]);
  });

  it.each([
    { before: "LATER_ACK", serve: async (_world: World) => undefined },
    {
      before: "OFF_LIMITS",
      serve: async (world: World) => {
        world.classifyAs(verdict("off_limits"));
        await world.say("politics pe baat karo");
      },
    },
    {
      // ONLY the reply IMMEDIATELY after: a career answer between the offer and the casual reply.
      before: "a career answer after JOBS",
      serve: async (world: World) => {
        world.classifyAs(verdict("jobs"));
        await world.say("job chahiye");
        world.classifyAs(verdict("career"));
        world.replyWith(answer(["Welder ka kaam har sheher mein milta hai."]));
        await world.say("welder ka kaam kahan milta hai");
      },
    },
  ] as const)("after $before (no offer on screen), a due casual reply is nudged", async (c) => {
    const world = makeWorld();
    await inFreeMode(world);
    await c.serve(world);
    primeNudge(world);
    const turn = await casual(world, 6);
    expect(turn.reply).toBe(`Theek hai, baat 6.\n${FREE_CHAT_COPY.CASUAL_NUDGE.latin}`);
    expect(lastTurnServed(world)).toMatchObject({ nudge: true });
  });

  it("a plain casual run keeps the every-3rd cadence exactly", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const seen: boolean[] = [];
    for (let n = 1; n <= 3 * FREE_CHAT_NUDGE_EVERY; n++) seen.push(nudged(await casual(world, n)));
    const cadence = seen.map((_, i) => (i + 1) % FREE_CHAT_NUDGE_EVERY === 0);
    expect(seen).toEqual(cadence);
    expect(answeredNudges(world)).toEqual(cadence);
    expect(world.envelope().freeChat!.casualReplies).toBe(3 * FREE_CHAT_NUDGE_EVERY);
  });

  it("an envelope with NO lastTurn reads as no offer: the due nudge is served, as before", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    storeLastTurn(world, undefined);
    expect(nudged(await casual(world, 6))).toBe(true);
  });

  it("an OLDEST-shape lastTurn stamp (hash, reply, at only) still names the offer", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    storeLastTurn(world, {
      inboundHash: "stamp-from-an-old-build",
      reply: FREE_CHAT_COPY.JOBS.latin,
      at: T0.toISOString(),
    });
    // Through JSON and the REAL narrower on load (`makeWorld`'s buffer), as production reads it.
    const turn = await decline(world);
    expect(turn.reply).toBe(DECLINE_REPLY);
    expect(lastTurnServed(world)).toMatchObject({ nudge: false });
  });
});

/** A casual reply that ends on its own question — a greeting answered with one (#2242). */
async function casualAsking(world: World, n: number, lines?: string[]) {
  world.classifyAs(verdict("casual"));
  world.replyWith(answer(lines ?? [`Namaste, baat ${n}.`, "Aaj ka kaam kaisa raha?"]));
  return world.say(`namaste ${n}`);
}

describe("#2242 — one question per bubble: a reply that asks holds the nudge, never drops it", () => {
  it("a due reply that asks is served alone, and the next casual reply that asks nothing carries the nudge", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);

    const asking = await casualAsking(world, 6);
    expect(asking.reply).toBe("Namaste, baat 6.\nAaj ka kaam kaisa raha?");
    expect(world.envelope().freeChat!.nudgeOwed).toBe(true);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "answered", nudge: false });

    // Off the multiple (7), but owed: it rides now, and the debt is cleared.
    const next = await casual(world, 7);
    expect(next.reply).toBe(`Theek hai, baat 7.\n${FREE_CHAT_COPY.CASUAL_NUDGE.latin}`);
    expect(world.envelope().freeChat).not.toHaveProperty("nudgeOwed");
    expect(lastTurnServed(world)).toMatchObject({ nudge: true });

    // The cadence is the counter's again: the next one rides the next multiple (9).
    const after: boolean[] = [];
    for (let n = 8; n <= 9; n++) after.push(nudged(await casual(world, n)));
    expect(after).toEqual([false, true]);
  });

  it("stays owed across a career answer and another reply that asks", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    await casualAsking(world, 6);

    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welder ka kaam har sheher mein milta hai."]));
    const career = await world.say("welder ka kaam kahan milta hai");
    expect(nudged(career)).toBe(false);
    expect(world.envelope().freeChat!.nudgeOwed).toBe(true);

    expect(nudged(await casualAsking(world, 7))).toBe(false);
    expect(world.envelope().freeChat!.nudgeOwed).toBe(true);

    expect(nudged(await casual(world, 8))).toBe(true);
    expect(world.envelope().freeChat).not.toHaveProperty("nudgeOwed");
  });

  it("reads a question on ANY line, not only the last", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    const turn = await casualAsking(world, 6, [
      "Aaj ka kaam kaisa raha?",
      "Aaram bhi zaroori hai.",
    ]);
    expect(nudged(turn)).toBe(false);
    expect(world.envelope().freeChat!.nudgeOwed).toBe(true);
  });

  it("an owed nudge meeting a résumé offer is dropped like a due one (#2172), not carried further", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    await casualAsking(world, 6);

    world.classifyAs(verdict("jobs"));
    expect((await world.say("job chahiye")).reply).toBe(FREE_CHAT_COPY.JOBS.latin);
    const declined = await decline(world);
    expect(declined.reply).toBe(DECLINE_REPLY);
    expect(world.envelope().freeChat).not.toHaveProperty("nudgeOwed");

    // Casual reply 8 is not a multiple and owes nothing; 9 is the next multiple.
    expect(nudged(await casual(world, 8))).toBe(false);
    expect(nudged(await casual(world, 9))).toBe(true);
  });

  it("a due reply that asks nothing is nudged exactly as before, and writes no flag", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    primeNudge(world);
    expect(nudged(await casual(world, 6))).toBe(true);
    expect(world.envelope().freeChat).not.toHaveProperty("nudgeOwed");
  });
});

// ---------------------------------------------------------------------------
// ADR-0051 §11 — the reply language (R39–R41)
// ---------------------------------------------------------------------------

/** The input of a reply call — the last one by default. */
const replyInput = (world: ReturnType<typeof makeWorld>, index = -1) =>
  world.ai.freeChatReply.mock.calls.at(index)![0] as { reply_language: unknown; category: string };

/** Free mode, then a career question answered in Hinglish — the reply a bare request re-answers. */
async function careerAnswered(world: ReturnType<typeof makeWorld>) {
  await inFreeMode(world);
  world.classifyAs(verdict("career"));
  world.replyWith(answer(["Aam taur par welder ko 15000 se 20000 milta hai."]));
  return world.say("welder ki salary kitni hoti hai");
}

/** …then "marathi mai jawab do": the Marathi re-answer, and the ask. */
async function askedMarathi(world: ReturnType<typeof makeWorld>) {
  await careerAnswered(world);
  world.replyWith(answer(["Sadharan welder la 15000 te 20000 milta."], ["Aur sanga"]));
  return world.say("marathi mai jawab do");
}

const chipPairs = (turn: TurnResult) => turn.options.map((o) => [o.option_key, o.label_text]);

describe("§11 R41 — an explicit request: the reply in that language, then the ask", () => {
  it("re-answers in the requested language with NO classifier call, the previous reply's category, and the ask's two chips", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    const classified = world.ai.freeChatClassify.mock.calls.length;
    world.replyWith(answer(["Sadharan welder la 15000 te 20000 milta."], ["Aur sanga"]));
    const turn = await world.say("marathi mai jawab do");

    expect(world.ai.freeChatClassify.mock.calls.length).toBe(classified);
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "career" });
    expect(turn.reply).toBe(
      `Sadharan welder la 15000 te 20000 milta.\n${languageAskLine("marathi").latin}`,
    );
    // The ask's chips INSTEAD of the follow-ups and the résumé chip.
    expect(chipPairs(turn)).toEqual([
      [FREE_CHAT_LANG_YES_KEY, "Haan, Marathi mein"],
      [FREE_CHAT_LANG_NO_KEY, "Nahi"],
    ]);
    expect(turn.readAloud).toBe(false);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "marathi" });
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      mode: "free",
      // L6 — the flow decided it, not the distress / abuse lists `lexicon` names.
      decided_by: "flow",
      category: "career",
      confidence_bucket: null,
      outcome: "answered",
      nudge: false,
    });
    // Nothing is KEPT yet — no change, no record.
    expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
    expect(world.chat.mergeFreeChatLanguage).not.toHaveBeenCalled();
  });

  it("after a turn that was no model reply, a bare request makes NO model call and serves the ask alone", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await world.say("Tamil-la sollunga");
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(world.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(turn.reply).toBe(languageAskLine("tamil").latin);
    expect(chipPairs(turn)).toEqual([
      [FREE_CHAT_LANG_YES_KEY, "Haan, Tamil mein"],
      [FREE_CHAT_LANG_NO_KEY, "Nahi"],
    ]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "tamil" });
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "flow",
      category: null,
      outcome: "fixed_line",
    });
  });

  it("the ask follows only an ANSWERED reply — a fallback asks nothing and offers nothing", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    world.replyWith(null);
    const turn = await world.say("marathi mai jawab do");
    expect(turn.reply).toBe(FREE_CHAT_COPY.REPLY_FALLBACK.latin);
    expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });

  it("a request for the language ALREADY KEPT re-answers in it, with no ask", async () => {
    const world = makeWorld({ keptLanguage: "marathi" });
    await inFreeMode(world);
    await casual(world, 1);
    world.replyWith(answer(["Bola, kay madat karu?"], ["Aur sanga"]));
    const turn = await world.say("marathi mein bolo");
    expect(replyInput(world).reply_language).toBe("marathi");
    expect(optionKeys(turn)).toEqual(["fcq_a", FREE_CHAT_RESUME_KEY]);
    expect(turn.reply).not.toContain(languageAskLine("marathi").latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "marathi" });
  });

  it("…and with no answered reply to re-answer, LANG_YES confirms it: no model call, nothing changes", async () => {
    const world = makeWorld({ keptLanguage: "marathi" });
    await inFreeMode(world);
    const turn = await world.say("marathi mein bolo");
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(turn.reply).toBe(languageYesLine("marathi").latin);
    expect(turn.options).toEqual([]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "marathi" });
    expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
  });

  it("the nudge never rides beside the ask, even when it is due", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    await casual(world, 1);
    await casual(world, 2);
    world.replyWith(answer(["Chan aahe."]));
    const turn = await world.say("marathi mein bolo");
    expect(world.envelope().freeChat!.casualReplies).toBe(3);
    expect(turn.reply).toBe(`Chan aahe.\n${languageAskLine("marathi").latin}`);
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload.nudge).toBe(false);
  });

  it("at the GREETING the classifier still decides — a casual request with nothing to re-answer gets the ask alone", async () => {
    const world = makeWorld();
    await world.greet();
    world.classifyAs(verdict("casual"));
    const turn = await world.say("tamil la pesunga");
    expect(world.ai.freeChatClassify).toHaveBeenCalledOnce();
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(turn.reply).toBe(languageAskLine("tamil").latin);
    expect(world.envelope().freeChat).toMatchObject({
      mode: "free",
      trigger: "classifier",
      language: { kept: null, offer: "tamil" },
    });
  });

  it("at the GREETING a CAREER question asked in a request is answered in that language, with the ask", async () => {
    const world = makeWorld();
    await world.greet();
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welder-ku sambalam 15000 to 20000 varum."]));
    const turn = await world.say("tamil la sollunga welder salary evlo");
    expect(replyInput(world)).toMatchObject({ reply_language: "tamil", category: "career" });
    expect(turn.reply.endsWith(languageAskLine("tamil").latin)).toBe(true);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "tamil" });
  });
});

describe("§11 R41 — Haan: the language is kept for the whole chat", () => {
  it("serves LANG_YES, keeps it, records the change and makes it durable — then every reply and news call uses it", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    const classified = world.ai.freeChatClassify.mock.calls.length;

    const yes = await world.say("Haan, Marathi mein");
    expect(yes.reply).toBe(languageYesLine("marathi").latin);
    expect(yes.options).toEqual([]);
    expect(world.ai.freeChatClassify.mock.calls.length).toBe(classified);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "marathi" });
    expect(world.emitted("chat.free_chat_language_changed").map((e) => e.payload)).toEqual([
      { worker_id: WORKER, session_id: SESSION, from: null, to: "marathi", trigger: "accepted" },
    ]);
    expect(world.chat.mergeFreeChatLanguage).toHaveBeenCalledWith(SESSION, WORKER, {
      v: 1,
      language: "marathi",
      set_at: T0.toISOString(),
      session_id: SESSION,
    });
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "chip",
      category: null,
      outcome: "fixed_line",
    });

    // Typed in HINGLISH — sent in Marathi.
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Chan, aaj kay kela?"]));
    await world.say("aaj kya kar rahe ho aap");
    expect(replyInput(world).reply_language).toBe("marathi");
    // Typed in ENGLISH — still Marathi.
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["ITI cha welding course changla aahe."]));
    await world.say("What is the best welding course for me?");
    expect(replyInput(world).reply_language).toBe("marathi");
    // A news question rides the same language.
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("aaj ki taaza khabar kya hai");
    expect(
      (world.ai.freeChatNews.mock.calls.at(-1)![0] as { reply_language: unknown }).reply_language,
    ).toBe("marathi");
  });

  it.each([
    "haan",
    "ha",
    "yes",
    "ho",
    "hoy",
    "aam",
    "avunu",
    "haudu",
    "ok",
    FREE_CHAT_LANG_YES_KEY,
  ])("a typed or keyed %j is the same yes", async (text) => {
    const world = makeWorld();
    await askedMarathi(world);
    expect((await world.say(text)).reply).toBe(languageYesLine("marathi").latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "marathi" });
  });

  it("a NEW session still sends it — read at the next greeting from the durable record", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    await world.say("Haan, Marathi mein");

    world.useSession(NEXT_SESSION);
    await world.greet();
    expect(world.chat.findLatestFreeChatLanguage).toHaveBeenCalledWith(WORKER);
    expect(world.envelope().freeChat).toMatchObject({
      mode: "greeting",
      language: { kept: "marathi" },
    });
    await world.say("Baad mein");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Namaskar, kase aahat?"]));
    await world.say("kaise ho aap");
    expect(replyInput(world).reply_language).toBe("marathi");
  });

  it("the identity intake's greeting holds it too", async () => {
    const world = makeWorld({ withIntake: true, keptLanguage: "tamil" });
    await world.openIntake({ hasName: true, hasState: true, hasCity: false });
    const handoff = await world.say("Pune");
    expect(handoff.reply).toBe(FREE_CHAT_COPY.GREETING.latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "tamil" });
    await world.say("Baad mein");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Vanakkam."]));
    await world.say("kaise ho");
    expect(replyInput(world).reply_language).toBe("tamil");
  });

  it("an unreadable record opens the greeting with none kept — each reply follows the message", async () => {
    const world = makeWorld({ keptLanguage: "throws" });
    await world.greet();
    expect(world.envelope().freeChat).toMatchObject({ mode: "greeting" });
    expect(world.envelope().freeChat!.language).toBeUndefined();
    await world.say("Baad mein");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Kem cho, majama?"]));
    await world.say("tame kem cho");
    expect(replyInput(world).reply_language).toBe("gujarati");
  });
});

describe("§11 R41 — Nahi: each reply follows the message again", () => {
  it("drops a kept language, records the decline and makes it durable", async () => {
    const world = makeWorld({ keptLanguage: "tamil" });
    await inFreeMode(world);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "tamil" });
    // No answered reply yet: the ask alone, no model call.
    expect((await world.say("marathi mein bolo")).reply).toBe(languageAskLine("marathi").latin);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(world.envelope().freeChat!.language).toEqual({ kept: "tamil", offer: "marathi" });

    const no = await world.say("Nahi");
    expect(no.reply).toBe(FREE_CHAT_LANG_NO_LINE.latin);
    expect(no.options).toEqual([]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null });
    expect(world.emitted("chat.free_chat_language_changed").map((e) => e.payload)).toEqual([
      { worker_id: WORKER, session_id: SESSION, from: "tamil", to: null, trigger: "declined" },
    ]);
    expect(world.chat.mergeFreeChatLanguage).toHaveBeenCalledWith(SESSION, WORKER, {
      v: 1,
      language: null,
      set_at: T0.toISOString(),
      session_id: SESSION,
    });

    // Per message again.
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Majama."]));
    await world.say("tame kem cho");
    expect(replyInput(world).reply_language).toBe("gujarati");
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["I am well, thank you."]));
    await world.say("How are you doing today?");
    expect(replyInput(world).reply_language).toBe("english");
  });

  it("with nothing kept, Nahi changes nothing: LANG_NO, no event, no write", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    const no = await world.say("nahi");
    expect(no.reply).toBe(FREE_CHAT_LANG_NO_LINE.latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null });
    expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
    expect(world.chat.mergeFreeChatLanguage).not.toHaveBeenCalled();
  });

  it("a decline is the latest SET value — the next session opens with none kept", async () => {
    const world = makeWorld({ keptLanguage: "tamil" });
    await inFreeMode(world);
    await world.say("marathi mein bolo");
    await world.say(FREE_CHAT_LANG_NO_KEY);
    world.useSession(NEXT_SESSION);
    await world.greet();
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });
});

describe("§11 R41 — only the NEXT message answers the ask", () => {
  it("an unrelated message lets the offer lapse; a later 'haan' is read like any message", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Sab theek hai."]));
    await world.say("aur kya chal raha hai");
    expect(world.envelope().freeChat!.language).toEqual({ kept: null });

    world.classifyAs(verdict("unclear", 0.9));
    const late = await world.say("haan");
    expect(late.reply).toBe(FREE_CHAT_COPY.FREE_CLARIFY.latin);
    expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
  });

  it("every guard keeps its precedence, and the offer lapses behind it", async () => {
    const distress = makeWorld();
    await askedMarathi(distress);
    expect((await distress.say("ab jeene ka mann nahi karta")).reply).toBe(
      FREE_CHAT_COPY.DISTRESS.latin,
    );
    expect(distress.envelope().freeChat!.language).toEqual({ kept: null });

    const abuse = makeWorld();
    await askedMarathi(abuse);
    expect((await abuse.say("chutiya")).reply).toBe(FREE_CHAT_COPY.TRASH_WARN.latin);
    expect(abuse.envelope().freeChat!.language).toEqual({ kept: null });

    const resume = makeWorld();
    await askedMarathi(resume);
    expect((await resume.say(FREE_CHAT_RESUME_LABEL)).reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(resume.envelope().freeChat).toMatchObject({ mode: "resume", language: { kept: null } });
    for (const world of [distress, abuse, resume]) {
      expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
    }
  });

  it("a yes naming ANOTHER language is a new request for it", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    world.replyWith(answer(["Vanakkam."]));
    const turn = await world.say("haan, tamil mein");
    expect(replyInput(world).reply_language).toBe("tamil");
    expect(chipPairs(turn)[0]).toEqual([FREE_CHAT_LANG_YES_KEY, "Haan, Tamil mein"]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "tamil" });
  });
});

describe("§11 R40 — with none kept, every reply call carries the message's own language", () => {
  it.each([
    ["tumhi kase aahat", "marathi"],
    ["मला काम पाहिजे", "marathi"],
    ["How are you doing today?", "english"],
    ["kaise ho aap", "hinglish"],
    ["आप कैसे हैं", "hinglish"],
    ["tame kem cho", "gujarati"],
    ["எனக்கு வேலை வேணும்", "tamil"],
    ["naaku job kavali", "telugu"],
    ["nanage kelsa beku", "kannada"],
    ["ok", "hinglish"],
  ] as const)("%j → reply_language %s", async (text, language) => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Theek hai."]));
    await world.say(text);
    expect(replyInput(world).reply_language).toBe(language);
  });

  it("a live-news call carries it too", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("career"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("enakku inniki news sollunga");
    expect(replyInput(world).reply_language).toBe("tamil");
    expect(
      (world.ai.freeChatNews.mock.calls.at(-1)![0] as { reply_language: unknown }).reply_language,
    ).toBe("tamil");
  });
});

/** A real verdict that also names the message's language (ADR-0051 §11 R42). */
const labelled = (category: Category, language: FreeChatReplyLanguage | null) => ({
  ...verdict(category),
  language,
});

/** The owner's device line (2026-10-14): unlisted Marathi spellings, which the word lists read as Hinglish. */
const DEVICE_LINE = "cam programmer kitee kamai karato?";

/** The input of the last news call. */
const newsInput = (world: ReturnType<typeof makeWorld>) =>
  world.ai.freeChatNews.mock.calls.at(-1)![0] as { reply_language: unknown };

describe("§11 R42 — the classifier names the message's language; the word lists are the backup", () => {
  it("the device line: the classifier's Marathi reaches the reply call", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(labelled("career", "marathi"));
    world.replyWith(answer(["CAM programmer la sadharan 25000 te 40000 milta."]));
    await world.say(DEVICE_LINE);
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "career" });
  });

  it.each([
    ["names no language", labelled("career", null)],
    ["predates the field (no key at all)", verdict("career")],
  ])("a classifier that %s leaves the word lists in force: Hinglish", async (_label, answered) => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(answered);
    world.replyWith(answer(["CAM programmer ko aam taur par 25000 se 40000 milta hai."]));
    await world.say(DEVICE_LINE);
    expect(replyInput(world).reply_language).toBe("hinglish");
  });

  it("an UNAVAILABLE classifier (a mock carrying a label) makes no reply call at all — the clarify line", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs({
      ...labelled("career", "marathi"),
      ai_metadata: { ...REAL_META, real_call: false },
    });
    const turn = await world.say(DEVICE_LINE);
    expect(turn.reply).toBe(FREE_CHAT_COPY.FREE_CLARIFY.latin);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
  });

  it("a regional script still decides by code, whatever the label", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(labelled("casual", "hinglish"));
    world.replyWith(answer(["Vanakkam."]));
    await world.say("எனக்கு வேலை வேணும்");
    expect(replyInput(world).reply_language).toBe("tamil");
  });

  it("a KEPT language still beats the label", async () => {
    const world = makeWorld({ keptLanguage: "tamil" });
    await inFreeMode(world);
    world.classifyAs(labelled("career", "marathi"));
    world.replyWith(answer(["CAM programmer-ku sambalam 25000 to 40000."]));
    await world.say(DEVICE_LINE);
    expect(replyInput(world).reply_language).toBe("tamil");
  });

  it("an EXPLICIT request still beats the label, and still asks", async () => {
    const world = makeWorld();
    await world.greet();
    world.classifyAs(labelled("career", "marathi"));
    world.replyWith(answer(["Welder-ku sambalam 15000 to 20000 varum."]));
    const turn = await world.say("tamil la sollunga welder salary evlo");
    expect(replyInput(world)).toMatchObject({ reply_language: "tamil", category: "career" });
    expect(turn.reply.endsWith(languageAskLine("tamil").latin)).toBe(true);
  });

  it("a news turn follows the same label", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(labelled("career", "marathi"));
    world.replyWith({ status: "refuse", topic: "news", ai_metadata: null });
    await world.say("aajchi navin batmi kaai?");
    expect(replyInput(world).reply_language).toBe("marathi");
    expect(newsInput(world).reply_language).toBe("marathi");
  });

  it("the label rides the memoised verdict: a lost CAS neither re-classifies nor loses it", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.ai.freeChatClassify.mockClear();
    world.classifyAs(labelled("career", "marathi"));
    world.replyWith(answer(["CAM programmer la sadharan 25000 te 40000 milta."]));
    world.buffer.saveWithCas.mockImplementationOnce(async () => false);
    const turn = await world.say(DEVICE_LINE);
    expect(turn.reply).toBe("CAM programmer la sadharan 25000 te 40000 milta.");
    expect(world.ai.freeChatClassify).toHaveBeenCalledOnce();
    expect(world.ai.freeChatReply).toHaveBeenCalledOnce();
    expect(replyInput(world).reply_language).toBe("marathi");
  });
});

describe("§11 — résumé mode and the kill switch are unchanged (R27)", () => {
  it("résumé mode: a language request is classified and deflected as today — no reply, no ask", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("casual"));
    const turn = await world.say("marathi mein bolo");
    expect(turn.reply).toBe(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${FREE_CHAT_COPY.OPENER.latin}`);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(world.envelope().freeChat!.language).toBeUndefined();
    expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
  });

  it("the kill switch: byte-identical to no free chat, no reply call, no language read or write", async () => {
    const off = makeWorld({ killSwitch: true, keptLanguage: "marathi" });
    const absent = makeWorld({ withoutFreeChat: true });
    for (const text of ["marathi mai jawab do", "haan", "tumhi kase aahat", "Nahi"]) {
      expect(await off.say(text)).toEqual(await absent.say(text));
    }
    expect(off.ai.freeChatReply).not.toHaveBeenCalled();
    expect(off.chat.findLatestFreeChatLanguage).not.toHaveBeenCalled();
    expect(off.chat.mergeFreeChatLanguage).not.toHaveBeenCalled();
    expect(off.envelope().freeChat).toBeNull();
  });
});

describe("§11 — the spine", () => {
  it("every event of a request, a yes and a no validates against the registry", async () => {
    const world = makeWorld({ keptLanguage: "tamil" });
    await askedMarathi(world);
    await world.say("Haan, Marathi mein");
    // After LANG_YES (no answered reply): the ask alone — its served event validates too.
    await world.say("gujarati ma bolo");
    await world.say("Nahi");
    const calls = world.events.emit.mock.calls.map(
      ([params]) => params as { event_name: string; payload: unknown; idempotencyKey: string },
    );
    const changed = calls.filter((c) => c.event_name === "chat.free_chat_language_changed");
    expect(changed.map((c) => c.payload)).toEqual([
      expect.objectContaining({ from: "tamil", to: "marathi", trigger: "accepted" }),
      expect.objectContaining({ from: "marathi", to: null, trigger: "declined" }),
    ]);
    for (const { event_name: name, payload } of calls) {
      expect(isEventName(name), name).toBe(true);
      expect(
        EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY].payload.safeParse(payload).success,
        `${name} ${JSON.stringify(payload)}`,
      ).toBe(true);
    }
    expect(new Set(changed.map((c) => c.idempotencyKey)).size).toBe(changed.length);
    // No worker or model words on the spine.
    expect(JSON.stringify(changed)).not.toContain("Marathi mein");
  });
});

// ---------------------------------------------------------------------------
// §11 review fixes — only a BARE request skips the classifier (B2 / H1), and a typed answer is bare
// (M1). The greeting's own reader (#2223) is fixed and tested by #2225, above.
// ---------------------------------------------------------------------------

/** Seed the stored free-chat state — the aside count, a cool-down — as an earlier turn left it. */
function patchFreeChat(world: ReturnType<typeof makeWorld>, patch: Record<string, unknown>) {
  const saved = world.saved()!;
  world.store.set(SESSION, {
    ...saved,
    profiling: {
      ...saved.profiling!,
      freeChat: { ...saved.profiling!.freeChat!, ...patch },
    } as ProfilingEnvelope,
  });
}

/** Nothing about the reply language moved: no offer, nothing kept, no event, no write. */
function expectNoLanguageChange(world: ReturnType<typeof makeWorld>) {
  expect(world.envelope().freeChat!.language ?? { kept: null }).toEqual({ kept: null });
  expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
  expect(world.chat.mergeFreeChatLanguage).not.toHaveBeenCalled();
}

describe("§11 B2 / H1 — a request with anything else in it is CLASSIFIED, and routed by the verdict", () => {
  it("a bare 'marathi mai jawab do' still re-answers with NO classifier call", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    const classified = world.ai.freeChatClassify.mock.calls.length;
    world.replyWith(answer(["Sadharan welder la 15000 te 20000 milta."]));
    const turn = await world.say("marathi mai jawab do");
    expect(world.ai.freeChatClassify.mock.calls.length).toBe(classified);
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "career" });
    expect(turn.reply.endsWith(languageAskLine("marathi").latin)).toBe(true);
  });

  it.each(["english mein resume bana do", "hindi mein resume bana dijiye"])(
    "%j — a résumé ask enters résumé mode (the opener), no re-answer and no ask",
    async (text) => {
      const world = makeWorld();
      await careerAnswered(world);
      const replies = world.ai.freeChatReply.mock.calls.length;
      world.classifyAs(verdict("resume"));
      const turn = await world.say(text);
      expect(turn.reply).toBe(FREE_CHAT_COPY.OPENER.latin);
      expect(world.envelope().freeChat!.mode).toBe("resume");
      expect(world.ai.freeChatReply.mock.calls.length).toBe(replies);
      expect(world.emitted("chat.free_chat_language_changed")).toEqual([]);
    },
  );

  it.each(["mujhe tamil me job dedo", "gujarati mein job batao"])(
    "%j — a jobs ask gets the JOBS line, not a model reply",
    async (text) => {
      const world = makeWorld();
      await careerAnswered(world);
      const replies = world.ai.freeChatReply.mock.calls.length;
      world.classifyAs(verdict("jobs"));
      const turn = await world.say(text);
      expect(turn.reply).toBe(FREE_CHAT_COPY.JOBS.latin);
      expect(optionKeys(turn)).toEqual([FREE_CHAT_RESUME_KEY]);
      expect(world.ai.freeChatReply.mock.calls.length).toBe(replies);
      expect(world.envelope().freeChat!.language).toBeUndefined();
    },
  );

  it.each([
    "reply in english, i want to die",
    "मराठीत सांगा, मला जगायचं नाही",
    "telugu lo cheppandi naaku chavalani undi",
    "english mein bolo, khud ko khatam kar lunga",
  ])("%j — distress riding a request gets the distress line, at any confidence", async (text) => {
    const world = makeWorld();
    await careerAnswered(world);
    const replies = world.ai.freeChatReply.mock.calls.length;
    world.classifyAs(verdict("distress", 0.3));
    const turn = await world.say(text);
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.options).toEqual([]);
    expect(world.ai.freeChatReply.mock.calls.length).toBe(replies);
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "classifier",
      category: "distress",
      outcome: "fixed_line",
    });
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });

  it("abuse riding a request is a counted strike", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    world.classifyAs(verdict("trash"));
    const turn = await world.say("tamil la sollunga, saala kutta");
    expect(turn.reply).toBe(FREE_CHAT_COPY.TRASH_WARN.latin);
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "classifier",
      category: "trash",
      outcome: "strike",
      strike_count: 1,
    });
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });

  it("a question asked in the request is classified, and the CAREER reply comes in Tamil with the ask", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    const classified = world.ai.freeChatClassify.mock.calls.length;
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welder-ku sambalam 15000 to 20000 varum."]));
    const turn = await world.say("can you tell me in tamil what is welder salary");
    expect(world.ai.freeChatClassify.mock.calls.length).toBe(classified + 1);
    expect(replyInput(world)).toMatchObject({ reply_language: "tamil", category: "career" });
    expect(turn.reply).toBe(
      `Welder-ku sambalam 15000 to 20000 varum.\n${languageAskLine("tamil").latin}`,
    );
    expect(chipPairs(turn)).toEqual([
      [FREE_CHAT_LANG_YES_KEY, "Haan, Tamil mein"],
      [FREE_CHAT_LANG_NO_KEY, "Nahi"],
    ]);
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "classifier",
      category: "career",
    });
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "tamil" });
  });

  it("an unclear verdict on a request is today's clarify — no ask", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    world.classifyAs(verdict("unclear", 0.9));
    const turn = await world.say("english mein bolo, hindi nahi aati");
    expect(turn.reply).toBe(FREE_CHAT_COPY.FREE_CLARIFY.latin);
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });
});

describe("§11 M1 — only a BARE typed yes / no answers the ask; anything else lapses it", () => {
  it("'haan marna hai' is no yes: classified, and a distress verdict gets the distress line", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    const classified = world.ai.freeChatClassify.mock.calls.length;
    world.classifyAs(verdict("distress", 0.5));
    const turn = await world.say("haan marna hai");
    expect(world.ai.freeChatClassify.mock.calls.length).toBe(classified + 1);
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expectNoLanguageChange(world);
  });

  it("'accha salary kitni hai' is a question, not a yes: answered in its own language, no LANG_YES", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welder ko 15000 se 20000 milta hai."]));
    const turn = await world.say("accha salary kitni hai");
    expect(turn.reply).not.toBe(languageYesLine("marathi").latin);
    expect(replyInput(world).reply_language).toBe("hinglish");
    expectNoLanguageChange(world);
  });

  it.each(["haan ji", "ji haan", "haan marathi mein"])("%j is still the yes", async (text) => {
    const world = makeWorld();
    await askedMarathi(world);
    expect((await world.say(text)).reply).toBe(languageYesLine("marathi").latin);
  });

  it.each(["nahi ji", "ji nahi"])("%j is the no", async (text) => {
    const world = makeWorld();
    await askedMarathi(world);
    expect((await world.say(text)).reply).toBe(FREE_CHAT_LANG_NO_LINE.latin);
  });
});

describe("§11 L9 — an ask pending behind the aside cap or the cool-down", () => {
  it("the aside cap keeps its precedence: the cap line, the offer lapses, nothing is kept", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    patchFreeChat(world, { asides: FREE_CHAT_ASIDE_CAP });
    const turn = await world.say("Haan, Marathi mein");
    expect(turn.reply).toBe(FREE_CHAT_COPY.ASIDE_CAP.latin);
    expectNoLanguageChange(world);
  });

  it("the cool-down keeps its precedence: the cool-down line, the offer lapses, nothing is kept", async () => {
    const world = makeWorld();
    await askedMarathi(world);
    patchFreeChat(world, { cooldownUntil: new Date(T0.getTime() + 3_600_000).toISOString() });
    const turn = await world.say("haan");
    expect(turn.reply).toBe(FREE_CHAT_COPY.TRASH_COOLDOWN.latin);
    expectNoLanguageChange(world);
  });
});

/** How many reply and classifier calls the world has made so far. */
const calls = (world: ReturnType<typeof makeWorld>) => ({
  reply: world.ai.freeChatReply.mock.calls.length,
  classify: world.ai.freeChatClassify.mock.calls.length,
});

describe("§11 re-review HIGH — a request re-answers ONLY an answered reply; after distress it gets distress", () => {
  it("word-list distress → 'मराठीत सांगा' → the distress line again: no model call, no ask", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    expect((await world.say("मला आत्महत्या करायची आहे")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    const before = calls(world);
    const turn = await world.say("मराठीत सांगा");
    expect(calls(world)).toEqual(before);
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.options).toEqual([]);
    expect(world.envelope().freeChat!.language).toBeUndefined();
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "flow",
      category: "distress",
      outcome: "fixed_line",
    });
  });

  it("classifier distress ('enakku vaazhave venam') → 'tamil la sollunga' → the distress line again", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("distress", 0.4));
    expect((await world.say("enakku vaazhave venam")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    const before = calls(world);
    const turn = await world.say("tamil la sollunga");
    expect(calls(world)).toEqual(before);
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(world.envelope().freeChat!.language).toBeUndefined();
  });

  it("a model's distress refusal counts too, and a NON-bare request after it gets the distress line, unclassified", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("casual"));
    world.replyWith({ status: "refuse", topic: "distress", ai_metadata: null });
    expect((await world.say("sab khatam sa lagta hai")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(lastTurnServed(world)).toMatchObject({ outcome: "refused", refusal_topic: "distress" });
    const before = calls(world);
    const turn = await world.say("english mein bolo, what should i do now");
    expect(calls(world)).toEqual(before);
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
  });

  it("at the GREETING too: distress, then a request, is the distress line again", async () => {
    const world = makeWorld();
    await world.greet();
    expect((await world.say("मला आत्महत्या करायची आहे")).reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    const turn = await world.say("मराठीत सांगा");
    expect(calls(world)).toEqual({ reply: 0, classify: 0 });
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
  });

  it("JOBS → 'marathi mai jawab do' → LANG_ASK alone with its chips: no model call; the offer works", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    world.classifyAs(verdict("jobs"));
    expect((await world.say("mujhe job chahiye")).reply).toBe(FREE_CHAT_COPY.JOBS.latin);
    const before = calls(world);
    const turn = await world.say("marathi mai jawab do");
    expect(calls(world)).toEqual(before);
    expect(turn.reply).toBe(languageAskLine("marathi").latin);
    expect(chipPairs(turn)).toEqual([
      [FREE_CHAT_LANG_YES_KEY, "Haan, Marathi mein"],
      [FREE_CHAT_LANG_NO_KEY, "Nahi"],
    ]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "marathi" });
    expect((await world.say("Haan, Marathi mein")).reply).toBe(languageYesLine("marathi").latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: "marathi" });
  });

  it("a strike → 'english mein bolo' → LANG_ASK alone: no model call", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    expect((await world.say("chutiya")).reply).toBe(FREE_CHAT_COPY.TRASH_WARN.latin);
    const turn = await world.say("english mein bolo");
    expect(calls(world)).toEqual({ reply: 0, classify: 0 });
    expect(turn.reply).toBe(languageAskLine("english").latin);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "english" });
  });

  it("an answered career reply → 'marathi mai jawab do' → the re-answer in Marathi, as before", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    const before = calls(world);
    world.replyWith(answer(["Sadharan welder la 15000 te 20000 milta."]));
    const turn = await world.say("marathi mai jawab do");
    expect(calls(world)).toEqual({ reply: before.reply + 1, classify: before.classify });
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "career" });
    expect(turn.reply.endsWith(languageAskLine("marathi").latin)).toBe(true);
  });

  it("what the previous turn served lasts ONE message: distress, an answered reply, then a request re-answers", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    await world.say("मला आत्महत्या करायची आहे");
    await casual(world, 1);
    world.replyWith(answer(["Bara aahe."]));
    await world.say("marathi mein bolo");
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "casual" });
  });
});

describe("§11 merge-review M1 / L3 — a CLASSIFIED request with nothing to re-answer", () => {
  /** Free mode, then the JOBS line. */
  async function afterJobs(world: ReturnType<typeof makeWorld>) {
    await inFreeMode(world);
    world.classifyAs(verdict("jobs"));
    expect((await world.say("mujhe job chahiye")).reply).toBe(FREE_CHAT_COPY.JOBS.latin);
  }

  it("JOBS → 'bhai marathi mein bolo' (casual) → LANG_ASK alone: NO reply call", async () => {
    const world = makeWorld();
    await afterJobs(world);
    world.classifyAs(verdict("casual"));
    const turn = await world.say("bhai marathi mein bolo");
    expect(world.ai.freeChatClassify).toHaveBeenCalledTimes(2);
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(turn.reply).toBe(languageAskLine("marathi").latin);
    expect(chipPairs(turn)).toEqual([
      [FREE_CHAT_LANG_YES_KEY, "Haan, Marathi mein"],
      [FREE_CHAT_LANG_NO_KEY, "Nahi"],
    ]);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "marathi" });
    expect(world.emitted("chat.free_chat_turn_served").at(-1)!.payload).toMatchObject({
      decided_by: "classifier",
      category: "casual",
      outcome: "fixed_line",
    });
  });

  it("JOBS → 'marathi mein batao welder salary kitni hai' (career) → a career reply in Marathi, then the ask", async () => {
    const world = makeWorld();
    await afterJobs(world);
    world.classifyAs(verdict("career"));
    world.replyWith(answer(["Welder la 15000 te 20000 milta."]));
    const turn = await world.say("marathi mein batao welder salary kitni hai");
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "career" });
    expect(turn.reply).toBe(`Welder la 15000 te 20000 milta.\n${languageAskLine("marathi").latin}`);
    expect(world.envelope().freeChat!.language).toEqual({ kept: null, offer: "marathi" });
  });

  it("after an ANSWERED reply, 'bhai marathi mein bolo' (casual) → the reply, then the ask, as before", async () => {
    const world = makeWorld();
    await careerAnswered(world);
    world.classifyAs(verdict("casual"));
    world.replyWith(answer(["Bola, kay madat karu?"]));
    const turn = await world.say("bhai marathi mein bolo");
    expect(replyInput(world)).toMatchObject({ reply_language: "marathi", category: "casual" });
    expect(turn.reply).toBe(`Bola, kay madat karu?\n${languageAskLine("marathi").latin}`);
  });

  it("L3 — a stored category WITHOUT an answered turn re-answers nothing: the ask alone", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    patchFreeChat(world, { lastReplyCategory: "casual", lastServed: "other" });
    const turn = await world.say("marathi mai jawab do");
    expect(world.ai.freeChatReply).not.toHaveBeenCalled();
    expect(turn.reply).toBe(languageAskLine("marathi").latin);
  });
});
