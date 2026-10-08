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
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
} from "./free-chat.copy";
import { FREE_CHAT_ASIDE_CAP, FREE_CHAT_COOLDOWN_MS } from "./free-chat.state";
import { FreeChatService } from "./free-chat.service";
import { FreeChatSummaryService } from "./free-chat-summary.service";

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
}

function makeWorld(opts: WorldOpts = {}) {
  const store = new Map<string, TranscriptBuffer>();
  let casToLose = opts.loseCas ?? 0;
  let now = T0;

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
    loadUniversal: vi.fn(async () => UNIVERSAL_PACK),
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
            ...(opts.summary === undefined ? {} : { summary: summaryThunk }),
          },
        };

  const say = (text: string, extra: { armGeneralRoad?: boolean } = {}): Promise<TurnResult> =>
    orchestrator.takeTurn({
      sessionId: SESSION,
      workerId: WORKER,
      text,
      now,
      // A distinct id per physical send, so a repeated word is a new turn — never a replay.
      submissionId: randomUUID(),
      voiceNoteId: null,
      ...(extra.armGeneralRoad === true ? { armGeneralRoad: true } : {}),
      ...freeChatInput(),
      knownName: async () => null,
      ctx: CTX as never,
    });
  const greet = () =>
    orchestrator.openFreeChatGreeting({
      sessionId: SESSION,
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
  const saved = () => store.get(SESSION);
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

describe("résumé mode — the skip list asks no model", () => {
  async function onQuestion(world: ReturnType<typeof makeWorld>, upTo: "years" | "tools") {
    await inResumeMode(world);
    world.classifyAs(verdict("resume"), verdict("resume"));
    await world.say("main welder hoon");
    const next = await world.say("welder");
    expect(next.questionKey).toBe(YEARS.question_key);
    if (upTo === "tools") await world.say("5 saal");
    world.ai.freeChatClassify.mockClear();
  }

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
      freeChat: { enabled: true, sessionLocked: false, locked: async () => false, foldedLines: 6 },
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
    expect(world.newsCount.held).toBe(0);
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: 0 }),
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
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null }),
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

  it("a FAILED call (null): NEWS_UNAVAILABLE, the slot handed back", async () => {
    const world = makeWorld();
    await inFreeMode(world);
    const turn = await askNews(world, null);
    expect(turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(world.newsCount.held).toBe(0);
    expect(newsServed(world)).toEqual([
      expect.objectContaining({ outcome: "unavailable", search_count: null, daily_count: 0 }),
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
      expect.objectContaining({ outcome: "no_results", search_count: 2, source_count: 0 }),
    ]);
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
    expect(world.newsCount.held).toBe(0);
  });

  it("REJECTED lines (G1, persona): NEWS_UNAVAILABLE, the turn a fallback, the slot back", async () => {
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
    expect(world.newsCount.held).toBe(0);
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
      freeChat: { enabled: true, sessionLocked: false, locked: async () => false },
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
    expect(news.map((c) => (c.payload as { outcome: string }).outcome)).toEqual([
      "answered",
      "unavailable",
      "answered",
      "capped",
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
