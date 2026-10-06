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
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const freeChat = new FreeChatService(ai as never, cost as never, events as never, chat as never);

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
  );

  const freeChatInput = () =>
    opts.withoutFreeChat
      ? {}
      : {
          freeChat: {
            enabled: opts.killSwitch !== true,
            sessionLocked: opts.sessionLocked === true,
            locked: async () => opts.workerLocked === true,
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
    advance,
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
    // The session was still stamped résumé mode — invisibly — for the lock.
    expect(off.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "kill_switch" });
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

  it("treats ANY message on a greeting or free session as the greeting's Haan", async () => {
    const world = makeWorld();
    await world.greet();
    const off = makeWorld({ killSwitch: true });
    off.store.set(SESSION, world.saved()!);
    const turn = await off.say("aaj mausam kaisa hai");
    expect(turn.reply).toBe(FREE_CHAT_COPY.OPENER.latin);
    expect(off.envelope().freeChat).toMatchObject({ mode: "resume", trigger: "kill_switch" });
    expect(off.ai.freeChatClassify).not.toHaveBeenCalled();
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

  it("trash the lexicon missed takes today's de-escalation path and counts toward the cap", async () => {
    const world = makeWorld();
    await inResumeMode(world);
    world.classifyAs(verdict("trash"));
    const turn = await world.say("tu pagal hai kya");
    expect(turn.reply).toBe(DE_ESCALATION_REPLY_TEXT);
    expect(world.envelope().abusiveTurns).toBe(1);
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
  it("openResumeConfirm opens nothing beneath a greeting (ADR-0051 (e))", async () => {
    const world = makeWorld({ identity: LINE });
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
