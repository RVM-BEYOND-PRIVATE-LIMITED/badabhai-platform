import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type {
  LlmTurnInput,
  LlmTurnOutput,
  QuestionPack,
  QuestionPackItem,
} from "@badabhai/ai-contracts";
import { EVENT_REGISTRY } from "@badabhai/event-schema";

import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import { emptyAnswerMap, recordAnswer } from "./answer-map";
import {
  answersOf,
  emptyGeneralRoad,
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  withAnswers,
  type GeneralRoadState,
  type ProfilingEnvelope,
} from "./conversation-state";
import type { LlmTurnResult } from "./llm-turn.service";
import { MAX_ENGINE_TURNS } from "./next-question";
import {
  llmChipOptions,
  ProfilingOrchestrator,
  type TurnInput,
  type TurnResult,
} from "./orchestrator.service";
import type { ResumeUpdateOfferPolicy } from "./resume-update-offer";
import {
  GENERAL_FORM_OFFER,
  GENERAL_FORM_OFFER_NO_SKILLS,
  SKILLS_GATE_OPTIONS,
  skillsGatePrompt,
} from "./skills-gate";
import { SkillsTurnService } from "./skills-turn.service";
import { FORM_OFFER_OPTIONS, offerPrompt } from "./trade-form-offer";

/**
 * ═══ THE GENERAL ROAD (ADR-0045), END TO END THROUGH THE ORCHESTRATOR ═══
 *
 * `skills-turn.service.test.ts` asserts ONE skills turn as a decision, against a stubbed model.
 * This file asserts what the ORCHESTRATOR does with it — the stamp, the lane, the handover, the
 * events — with a REAL `SkillsTurnService` wired in exactly where Nest puts it (the trailing
 * constructor argument) and only the ai-service, the cost ledger and the trace store faked. The
 * Phase A service stays a stub, as it is in `trade-form-handover.test.ts`: what it returns is its
 * own contract, and the lane is decided on what it returns.
 *
 * WHAT IS ACTUALLY AT RISK HERE, and what these tests are shaped around:
 *
 *   1. AN UNARMED SESSION MUST BE TODAY'S INTERVIEW BYTE FOR BYTE — same reply, same envelope,
 *      same events, no extra model call. Every worker in the country goes through the branches
 *      this change added, and almost none of them are on the general road. So the unarmed cases
 *      are asserted against a world built WITHOUT the service at all, not against expectations
 *      written by hand: a hand-written expectation can only say what its author remembered.
 *   2. THE 21 STAY ON TODAY'S PATH, including the five polymer roles that have no form yet —
 *      armed or not, their turn is the one they got before the lane existed.
 *   3. THE SKILLS LANE OWNS EVERY TURN IT IS ON. Identify must not read a skills answer as a trade
 *      statement, Phase A must not be consulted again, and the close is the general-form card —
 *      never the trade card, never the résumé-update offer.
 *   4. WHAT THE CHAT HEARD ABOUT YEARS IS FORGOTTEN (R5). Total experience on this road comes only
 *      from the general form's work history.
 *   5. THE EVENTS CARRY COUNTS AND CLOSED SETS, never a skill, a label or a worker's words — and
 *      each one validates against the registry it will be checked against in production.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-09-26T10:00:00.000Z");
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req_gr" };

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
const CITY = item({
  question_key: "current_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
});
const YEARS = item({
  question_key: "experience_years",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Is kaam mein aapko kitne saal ho gaye?",
});
/**
 * THE SAME FACT UNDER ANOTHER KEY — which is why the lane forgets `experience_years` by TARGET
 * FIELD as well as by key. A pack is free to own total experience under any question key.
 */
const TENURE = item({
  question_key: "kaam_ka_tajurba",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Kitne saal ka tajurba hai?",
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 2,
  family_id: "fam_universal",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [TRADE, CITY, YEARS, TENURE],
};

/**
 * A pack that carries a `skills` question — the one shape through which a settled draft would
 * put skills in the answer map, and so the one that can prove the handover does not (R7).
 */
const TECH_SKILLS = item({
  question_key: "tech_skills",
  target_kind: "rfs",
  target_field: "skills",
  answer_type: "multi_select",
  prompt_text: "Aap kaunsi technology use karte hain?",
  options: [
    {
      option_key: "react",
      label_text: "React",
      value: "react",
      implies_skill_id: null,
      is_none_of_above: false,
    },
    {
      option_key: "angular",
      label_text: "Angular",
      value: "angular",
      implies_skill_id: null,
      is_none_of_above: false,
    },
  ],
});
const PACK_WITH_SKILLS: QuestionPack = {
  ...UNIVERSAL_PACK,
  items: [...UNIVERSAL_PACK.items, TECH_SKILLS],
};

// ── The worker and what the model makes of them ──────────────────────────────────────────

const DOMAIN = "Information Technology";
const ROLE = "Software developer";
/** The role answer. It names two skills — the reason the lane harvests it on the same turn. */
const ROLE_MSG = "main software developer hoon, React aur Node pe kaam karta hoon";
const PHASE_A_REPLY = "Aur kya kaam karte hain?";

/** What Phase A hands back on the turn the role is known (the `trade-form-handover` shape). */
function led(
  domainLabel: string | null,
  roleLabel: string | null,
  opts: {
    readonly kind?: "ask" | "done";
    readonly skills?: readonly string[];
    readonly experiences?: ProfilingEnvelope["llmDraft"]["experiences"];
    readonly patch?: Partial<ProfilingEnvelope>;
  } = {},
): LlmTurnResult {
  const kind = opts.kind ?? "ask";
  const patch: Partial<ProfilingEnvelope> = {
    llmStage: kind === "done" ? "done" : "role",
    llmLedTurns: 1,
    llmAsks: 1,
    llmDraft: {
      domain_label: domainLabel,
      role_label: roleLabel,
      skills: [...(opts.skills ?? [])],
      experiences: [...(opts.experiences ?? [])],
    },
    ...opts.patch,
  };
  return kind === "done"
    ? { kind: "done", patch }
    : { kind: "ask", reply: PHASE_A_REPLY, chips: [], inputMode: "text", patch };
}

const SW_LED = led(DOMAIN, ROLE);

/** One skills-stage reply from the ai-service, as `AiService.llmTurn` hands it back. */
function skillsModel(over: Partial<LlmTurnOutput> = {}): LlmTurnOutput {
  return {
    reply_text: "Kaunsa database use karte hain?",
    stage: "skills",
    input_mode: "text",
    suggested_answers: [],
    domain_label: null,
    role_label: null,
    skills: [],
    experience_entry: null,
    phase_a_done: false,
    blocked: false,
    blocked_reason: null,
    is_mock: false,
    ai_metadata: null,
    ...over,
  };
}

/** The entering turn: two skills named in the role answer, and the stage's first question. */
const ENTER_ASK = skillsModel({
  skills: ["React", "Node.js"],
  reply_text: "Kaunsa database use karte hain?",
  suggested_answers: ["PostgreSQL", "MongoDB"],
});
const TO_GATE_MSG = "PostgreSQL aur Git bhi aata hai";
/** The model says the stage is done — advisory, but the gate follows. */
const TO_GATE = skillsModel({
  skills: ["PostgreSQL", "Git"],
  phase_a_done: true,
  reply_text: "Theek hai, samajh gaya.",
});
const GATE_SKILLS = ["React", "Node.js", "PostgreSQL", "Git"] as const;

/** A session already on the skills lane — the state `enterSkillsLane` writes. */
const ON_SKILLS_LANE: Partial<ProfilingEnvelope> = {
  phase: "llm_interview",
  llmStage: "skills",
  llmLedTurns: 1,
  llmAsks: 1,
  llmDraft: { domain_label: DOMAIN, role_label: ROLE, skills: [], experiences: [] },
  generalRoad: {
    ...emptyGeneralRoad(),
    armed: true,
    lane: "skills",
    laneReason: "outside_declared_roles",
    roleLabel: ROLE,
    domainLabel: DOMAIN,
    skills: ["React"],
    skillsAsks: 1,
  },
};

const ARMED_UNDECIDED: GeneralRoadState = { ...emptyGeneralRoad(), armed: true };

// ── The world ─────────────────────────────────────────────────────────────────────────────

interface WorldOpts {
  /** What Phase A returns — every call, unless a test queues a different one. */
  readonly led?: LlmTurnResult | null;
  /** The skills model's replies, IN ORDER. A call past the end fails the test loudly. */
  readonly model?: ReadonlyArray<LlmTurnOutput | null>;
  readonly flags?: { readonly road?: boolean; readonly llm?: boolean };
  /**
   * `fresh` — a buffer with no envelope yet, the state of a brand-new chat session (the stamp's
   * one chance). `existing` — an envelope written before this turn (never re-stamped). An object
   * is folded over an existing envelope.
   */
  readonly seed?: "fresh" | "existing" | Partial<ProfilingEnvelope>;
  readonly turnCount?: number;
  /** False builds TODAY'S orchestrator: no `SkillsTurnService` at all. */
  readonly withSkills?: boolean;
  /** The résumé-update policy's answer (ADR-0043). */
  readonly eligible?: boolean;
  readonly pack?: QuestionPack;
}

function makeWorld(opts: WorldOpts = {}) {
  const store = new Map<string, TranscriptBuffer>();
  const seed = opts.seed ?? "fresh";
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: opts.turnCount ?? 0,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    ...(seed === "fresh"
      ? {}
      : {
          profiling: {
            ...emptyProfilingEnvelope(),
            rev: 1,
            ...(seed === "existing" ? {} : seed),
          },
        }),
  } as TranscriptBuffer);

  const buffer = {
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      // Through the REAL narrower, exactly as `ChatTranscriptBuffer.load` does — so a
      // general-road field the lane writes but the narrower drops fails HERE, as a lane that
      // silently resets every turn.
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
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
    loadUniversal: vi.fn(async () => opts.pack ?? UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => null),
    resolveForOccupation: vi.fn(async () => null),
  };
  const identify = {
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    // The real `leads()` rule minus the flag: the stage is what switches Phase A off.
    leads: (envelope: ProfilingEnvelope) => envelope.llmStage !== "done",
    take: vi.fn(
      async (): Promise<LlmTurnResult | null> => ("led" in opts ? (opts.led ?? null) : SW_LED),
    ),
  };

  // ── THE REAL SKILLS STAGE, with only its I/O faked ──
  const queue = [...(opts.model ?? [])];
  const ai = {
    llmTurn: vi.fn(async (_input: LlmTurnInput, _ctx?: unknown) => {
      if (queue.length === 0) {
        throw new Error("the skills model was called more often than this test scripted");
      }
      return queue.shift() ?? null;
    }),
  };
  const config = {
    CHAT_GENERAL_ROAD_ENABLED: opts.flags?.road ?? true,
    CHAT_LLM_INTERVIEW_ENABLED: opts.flags?.llm ?? true,
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const traces = fakeAiTraceRecorder();
  const skills = new SkillsTurnService(
    ai as never,
    config as never,
    cost as never,
    traces.recorder,
  );
  const policy = { eligible: vi.fn(async (_workerId: string) => opts.eligible ?? false) };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
    // ADR-0041 RI-5. No pending résumé offer: the interview is the one a worker without one gets.
    {
      pendingForChat: async () => null,
      forImport: async () => new Map(),
      identityForChat: async () => null,
    } as never,
    // #1504 item 5 (city-seed). No worker record to seed from.
    { findCurrentCity: async () => null } as never,
    // RI-AUTOFILL — never reached here.
    undefined,
    policy as unknown as ResumeUpdateOfferPolicy,
    opts.withSkills === false ? undefined : skills,
  );
  return { orchestrator, store, events, llm, ai, identify, policy, cost };
}

type World = ReturnType<typeof makeWorld>;

/** A CHAT turn — `ChatService.postMessage` is the one caller that passes `armGeneralRoad`. */
const fromChat = (text: string, at: Date = T0): TurnInput => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId: null,
  voiceNoteId: null,
  armGeneralRoad: true,
  ctx: CTX as never,
});

/** A VOICE-FORM turn — `ProfilingSessionService` never passes `armGeneralRoad`. */
const fromVoice = (text: string, at: Date = T0): TurnInput => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

const later = (ms: number) => new Date(T0.getTime() + ms);

const saved = (world: World) => world.store.get(SESSION)?.profiling;

/** The envelope minus the latency histogram, which is wall-clock and differs run to run. */
function comparable(envelope: ProfilingEnvelope | undefined) {
  if (!envelope) return envelope;
  const { turnLatency: _latency, ...rest } = envelope;
  return rest;
}

type EmittedEvent = {
  event_name: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
};
const allEvents = (world: World): EmittedEvent[] =>
  world.events.emit.mock.calls.map(([params]) => params as EmittedEvent);
const emitted = (world: World, name: string): EmittedEvent[] =>
  allEvents(world).filter((e) => e.event_name === name);

const LANE = "profile.profiling_lane_decided";
const GATE_ANSWERED = "profile.skills_gate_answered";
const GENERAL_FORM = "profile.general_form_mode_entered";
const GENERAL_ROAD_EVENTS: readonly string[] = [LANE, GATE_ANSWERED, GENERAL_FORM];
const generalRoadEvents = (world: World) =>
  allEvents(world).filter((e) => GENERAL_ROAD_EVENTS.includes(e.event_name));

/** Run the same inputs through a world and hand back every result. */
async function run(world: World, inputs: readonly TurnInput[]): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  for (const input of inputs) results.push(await world.orchestrator.takeTurn(input));
  return results;
}

/** Enter the lane and reach the gate — the two turns most tests below start from. */
async function toTheGate(world: World): Promise<TurnResult> {
  await world.orchestrator.takeTurn(fromChat(ROLE_MSG));
  return world.orchestrator.takeTurn(fromChat(TO_GATE_MSG));
}

describe("the general road through the orchestrator (ADR-0045)", () => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  // ═══ 1. UNARMED IS TODAY ═══════════════════════════════════════════════════════════════
  describe("an UNARMED session is today's interview, byte for byte", () => {
    it("an envelope that already existed is never armed — an outside role gets today's turn", async () => {
      const armedWorld = makeWorld({ seed: "existing" });
      const today = makeWorld({ seed: "existing", withSkills: false });

      const [result] = await run(armedWorld, [fromChat(ROLE_MSG)]);
      const [expected] = await run(today, [fromChat(ROLE_MSG)]);

      // THE SAME TURN — reply, chips, envelope and events — as an orchestrator with no general
      // road in it at all. Not asserted field by field: equality with the real thing is the claim.
      expect(result).toEqual(expected);
      expect(result!.reply).toBe(PHASE_A_REPLY);
      expect(comparable(saved(armedWorld))).toEqual(comparable(saved(today)));
      expect(allEvents(armedWorld)).toEqual(allEvents(today));
      expect(saved(armedWorld)?.generalRoad).toEqual(emptyGeneralRoad());
      expect(generalRoadEvents(armedWorld)).toHaveLength(0);
      // NO EXTRA MODEL CALL — the skills stage never ran.
      expect(armedWorld.ai.llmTurn).not.toHaveBeenCalled();
      expect(armedWorld.cost.record).not.toHaveBeenCalled();
    });

    it("a FRESH voice-form session (no armGeneralRoad) is never armed", async () => {
      const armedWorld = makeWorld({ seed: "fresh" });
      const today = makeWorld({ seed: "fresh", withSkills: false });

      const [result] = await run(armedWorld, [fromVoice(ROLE_MSG)]);
      const [expected] = await run(today, [fromVoice(ROLE_MSG)]);

      expect(result).toEqual(expected);
      expect(comparable(saved(armedWorld))).toEqual(comparable(saved(today)));
      expect(allEvents(armedWorld)).toEqual(allEvents(today));
      expect(saved(armedWorld)?.generalRoad).toEqual(emptyGeneralRoad());
      expect(armedWorld.ai.llmTurn).not.toHaveBeenCalled();
    });

    it("stays today's interview on the turns after the role, too", async () => {
      // One turn of equality proves the branch point; the next proves nothing leaked into the
      // envelope that a later branch reads (the cross-fill exclusion, the skills branch).
      const armedWorld = makeWorld({ seed: "existing" });
      const today = makeWorld({ seed: "existing", withSkills: false });
      const inputs = [fromChat(ROLE_MSG), fromChat(TO_GATE_MSG), fromChat("Nahi")];

      expect(await run(armedWorld, inputs)).toEqual(await run(today, inputs));
      expect(comparable(saved(armedWorld))).toEqual(comparable(saved(today)));
      expect(allEvents(armedWorld)).toEqual(allEvents(today));
      expect(armedWorld.ai.llmTurn).not.toHaveBeenCalled();
    });
  });

  // ═══ 2. THE STAMP ═════════════════════════════════════════════════════════════════════
  describe("the stamp — once, on the envelope's first turn, from the chat only", () => {
    // An unknown role, so the lane stays undecided and the stamp is the only thing asserted.
    const UNKNOWN = led(null, null);

    it("arms a fresh CHAT session when both flags are on", async () => {
      const world = makeWorld({ seed: "fresh", led: UNKNOWN });
      await world.orchestrator.takeTurn(fromChat("namaste"));
      expect(saved(world)?.generalRoad).toEqual(ARMED_UNDECIDED);
    });

    it("never arms a fresh VOICE session — absence is today's interview", async () => {
      const world = makeWorld({ seed: "fresh", led: UNKNOWN });
      await world.orchestrator.takeTurn(fromVoice("namaste"));
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());
    });

    it.each([
      ["the general-road flag is off", { road: false, llm: true }],
      ["the LLM interview flag is off", { road: true, llm: false }],
      ["both flags are off", { road: false, llm: false }],
    ])("never arms when %s", async (_why, flags) => {
      const world = makeWorld({ seed: "fresh", led: UNKNOWN, flags });
      await world.orchestrator.takeTurn(fromChat("namaste"));
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());
      expect(generalRoadEvents(world)).toHaveLength(0);
    });

    it("never re-stamps an envelope that already exists", async () => {
      const world = makeWorld({ seed: "existing", led: UNKNOWN });
      await world.orchestrator.takeTurn(fromChat("namaste"));
      await world.orchestrator.takeTurn(fromChat("main kaam dhundh raha hoon"));
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());
    });

    it("never UN-arms either: a flag flipped off mid-interview does not switch engines", async () => {
      const world = makeWorld({
        seed: { generalRoad: ARMED_UNDECIDED },
        led: UNKNOWN,
        flags: { road: false, llm: false },
      });
      await world.orchestrator.takeTurn(fromChat("namaste"));
      expect(saved(world)?.generalRoad).toEqual(ARMED_UNDECIDED);
    });

    it("openTurn never arms — and the chat turn after it finds an envelope that exists", async () => {
      const world = makeWorld({ seed: "fresh", led: UNKNOWN });
      await world.orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: T0,
        ctx: CTX as never,
      });
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());

      await world.orchestrator.takeTurn(fromChat("namaste"));
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());
    });

    it("a construction without the SkillsTurnService never arms, even from the chat", async () => {
      const world = makeWorld({ seed: "fresh", led: UNKNOWN, withSkills: false });
      await world.orchestrator.takeTurn(fromChat("namaste"));
      expect(saved(world)?.generalRoad).toEqual(emptyGeneralRoad());
    });
  });

  // ═══ 3. AN OUTSIDE ROLE ENTERS THE SKILLS STAGE ON THE SAME TURN ═════════════════════════
  describe("an outside role enters the skills stage on the turn it is named", () => {
    /**
     * An ARMED session that had already captured years (by key AND under a pack's own key), whose
     * led turn names an outside role, carries a job in its draft and opens the experience gate —
     * everything the lane must forget, on the one turn it enters.
     */
    function enteringWorld() {
      let answers = recordAnswer(
        emptyAnswerMap(),
        {
          questionKey: "experience_years",
          targetField: "experience_years",
          valueRaw: "5 saal",
          valueNormalized: 5,
          evidence: null,
        },
        1,
      );
      answers = recordAnswer(
        answers,
        {
          questionKey: "kaam_ka_tajurba",
          targetField: "experience_years",
          valueRaw: "5",
          valueNormalized: 5,
          evidence: null,
        },
        1,
      );
      const seeded = withAnswers(
        { ...emptyProfilingEnvelope(), rev: 1, generalRoad: ARMED_UNDECIDED },
        answers,
      );
      return makeWorld({
        seed: seeded,
        turnCount: 1,
        led: led(DOMAIN, ROLE, {
          // Phase A's own skills: one grounded in the worker's words, one invented.
          skills: ["React", "Kubernetes"],
          experiences: [
            {
              role_label: ROLE,
              duration_text: "5 saal",
              duration_months: 60,
              work_done: "web apps",
            },
          ],
          patch: { llmStage: "experience", llmGateOpen: true },
        }),
        model: [skillsModel({ ...ENTER_ASK, skills: ["React", "Node.js", "Photoshop"] })],
      });
    }

    it("serves the skills stage's first question, harvested from the role answer", async () => {
      const world = enteringWorld();
      const result = await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      expect(result.kind).toBe("ask");
      expect(result.reply).toBe(ENTER_ASK.reply_text);
      expect(result.questionKey).toBeNull();
      // THE MODEL'S CHIPS, AS CERTIFIED LABELS, through the one chip builder every model turn uses.
      expect(result.options).toEqual(llmChipOptions(["PostgreSQL", "MongoDB"], false));
      expect(result.answerType).toBe("single_select");
      expect(result.inputMode).toBe("text");
      expect(result.gateKind ?? null).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.checkpointDue).toBe(false);
      expect(result.formOffer ?? null).toBeNull();
      expect(result.generalFormOffer ?? null).toBeNull();

      // Phase A once, the skills model once — on the SAME turn.
      expect(world.llm.take).toHaveBeenCalledTimes(1);
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(1);
    });

    it("stores only CERTIFIED skills, and counts the refusals", async () => {
      const world = enteringWorld();
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      expect(saved(world)?.generalRoad).toEqual({
        armed: true,
        lane: "skills",
        laneReason: "outside_declared_roles",
        roleLabel: ROLE,
        domainLabel: DOMAIN,
        // "React" from Phase A (grounded), "Node.js" from the stage; React's second copy is a
        // duplicate, not a refusal.
        skills: ["React", "Node.js"],
        skillsAsks: 1,
        staleTurns: 0,
        gateOpen: false,
        gateRounds: 0,
        // "Kubernetes" (Phase A) and "Photoshop" (the stage) — neither was said.
        rejectedCount: 2,
        outcome: null,
        handedOver: false,
      });
    });

    it("FORGETS the years it heard, clears the draft's jobs and closes the experience gate", async () => {
      const world = enteringWorld();
      // The precondition, so the assertion below is a change and not a default.
      const before = answersOf(saved(world)!);
      expect(Object.keys(before).sort()).toEqual(["experience_years", "kaam_ka_tajurba"]);

      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));
      const after = saved(world)!;

      const answers = answersOf(after);
      expect(answers.experience_years).toBeUndefined();
      expect(answers.kaam_ka_tajurba).toBeUndefined();
      expect(after.llmDraft.experiences).toEqual([]);
      // The led patch opened it on this very turn; the lane closes it.
      expect(after.llmGateOpen).toBe(false);
      expect(after.llmStage).toBe("skills");
      expect(after.phase).toBe("llm_interview");
      expect(after.servedQuestionKey).toBeNull();
      expect(after.formKind).toBeNull();
    });

    it("records the lane ONCE, with ids, closed sets and counts only", async () => {
      const world = enteringWorld();
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      const lane = emitted(world, LANE);
      expect(lane).toHaveLength(1);
      expect(lane[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        lane: "skills",
        reason: "outside_declared_roles",
        llm_led_turns: 1,
        asks: 1,
      });
      expect(lane[0]!.idempotencyKey).toBe(`${LANE}:${SESSION}`);
      expect(emitted(world, GATE_ANSWERED)).toHaveLength(0);
      expect(emitted(world, GENERAL_FORM)).toHaveLength(0);
    });

    it("sends the skills model the role answer and the CERTIFIED draft — no jobs — and ledgers it", async () => {
      const world = enteringWorld();
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      const [request, reqCtx] = world.ai.llmTurn.mock.calls[0]!;
      expect(request).toMatchObject({
        worker_ref: WORKER,
        stage: "skills",
        interview_mode: "skills_only",
        message_text: ROLE_MSG,
        experience_count: 0,
        force_close: false,
        draft: {
          domain_label: DOMAIN,
          role_label: ROLE,
          // Only what survived the wall — never Phase A's invented "Kubernetes".
          skills: ["React"],
          experiences: [],
        },
      });
      expect(reqCtx).toEqual({ correlationId: CTX.correlationId, requestId: CTX.requestId });
      // THE SECOND CALL ON THIS TURN IS PAID FOR, and attributed to this session like Phase A's.
      expect(world.cost.record).toHaveBeenCalledWith(
        null,
        "profiling_chat_turn",
        null,
        CTX.correlationId,
        CTX.requestId,
        { workerId: WORKER, sessionId: SESSION },
      );
    });

    it("never reads the entering turn's words as a stop — they answered Phase A, not the stage", async () => {
      // Phase A asked a yes/no and the worker said "nahi"; the model fills the role on THAT turn.
      // "nahi" is the stage's own stop word, and reading it as one would hand a worker who was
      // never asked about skills straight to the form.
      const world = makeWorld({ led: led(null, null), model: [ENTER_ASK] });
      await world.orchestrator.takeTurn(fromChat("main hisaab kitaab dekhta hoon"));
      world.llm.take.mockResolvedValueOnce(led("Accounts", "Accountant"));
      const result = await world.orchestrator.takeTurn(fromChat("nahi"));

      expect(world.ai.llmTurn).toHaveBeenCalledTimes(1);
      expect(world.ai.llmTurn.mock.calls[0]![0]).toMatchObject({ message_text: "nahi" });
      expect(result.kind).toBe("ask");
      expect(result.reply).toBe(ENTER_ASK.reply_text);
      expect(saved(world)?.generalRoad).toMatchObject({ lane: "skills", handedOver: false });
      expect(emitted(world, GENERAL_FORM)).toHaveLength(0);
    });

    it("works from a brand-new chat session: stamp, lane and first skills question in one turn", async () => {
      const world = makeWorld({ seed: "fresh", model: [ENTER_ASK] });
      const result = await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      expect(result.reply).toBe(ENTER_ASK.reply_text);
      expect(saved(world)?.generalRoad.lane).toBe("skills");
      expect(saved(world)?.generalRoad.skills).toEqual(["React", "Node.js"]);
      expect(emitted(world, LANE)).toHaveLength(1);
    });
  });

  // ═══ 4. THE 21 STAY ON TODAY'S PATH ════════════════════════════════════════════════════
  describe("one of the 21 — or no role yet — stays on today's path", () => {
    /** The same turn through an armed world and through today's orchestrator. */
    async function againstToday(turn: LlmTurnResult | null, text: string) {
      const armed = makeWorld({ seed: "fresh", led: turn });
      const today = makeWorld({ seed: "fresh", led: turn, withSkills: false });
      const [result] = await run(armed, [fromChat(text)]);
      const [expected] = await run(today, [fromChat(text)]);
      return { armed, today, result: result!, expected: expected! };
    }

    /** Every event the armed world emitted, minus the lane decision, is today's list. */
    function sameEventsBesidesTheLane(armed: World, today: World) {
      expect(allEvents(armed).filter((e) => e.event_name !== LANE)).toEqual(allEvents(today));
    }

    it("a CNC turner is offered the trade form exactly as today, on a classic `form_offered` lane", async () => {
      const { armed, today, result, expected } = await againstToday(
        led("CNC Machining", "CNC Turner"),
        "main cnc turner hoon",
      );

      expect(result).toEqual(expected);
      expect(result.reply).toBe(offerPrompt("cnc_turner"));
      expect(result.options).toEqual([...FORM_OFFER_OPTIONS]);
      const lane = emitted(armed, LANE);
      expect(lane).toHaveLength(1);
      expect(lane[0]!.payload).toMatchObject({ lane: "classic", reason: "form_offered" });
      sameEventsBesidesTheLane(armed, today);
      expect(saved(armed)?.generalRoad).toEqual({
        ...ARMED_UNDECIDED,
        lane: "classic",
        laneReason: "form_offered",
      });
      expect(armed.ai.llmTurn).not.toHaveBeenCalled();
    });

    it("a formless polymer role keeps today's Phase A ask, on a classic `declared_role` lane", async () => {
      const { armed, today, result, expected } = await againstToday(
        led("Plastics", "Injection moulding operator"),
        "injection moulding machine chalata hoon",
      );

      expect(result).toEqual(expected);
      expect(result.reply).toBe(PHASE_A_REPLY);
      expect(emitted(armed, LANE).map((e) => e.payload)).toEqual([
        expect.objectContaining({ lane: "classic", reason: "declared_role" }),
      ]);
      sameEventsBesidesTheLane(armed, today);
      expect(armed.ai.llmTurn).not.toHaveBeenCalled();
    });

    it("an unknown role on an ask decides nothing yet", async () => {
      const { armed, today, result, expected } = await againstToday(led(null, null), "namaste");

      expect(result).toEqual(expected);
      expect(saved(armed)?.generalRoad).toEqual(ARMED_UNDECIDED);
      expect(generalRoadEvents(armed)).toHaveLength(0);
      expect(allEvents(armed)).toEqual(allEvents(today));
    });

    it("Phase A ending without a role is a classic `role_unresolved` lane and today's engine turn", async () => {
      const { armed, today, result, expected } = await againstToday(
        led(null, null, { kind: "done" }),
        "pata nahi",
      );

      expect(result).toEqual(expected);
      expect(emitted(armed, LANE).map((e) => e.payload)).toEqual([
        expect.objectContaining({ lane: "classic", reason: "role_unresolved" }),
      ]);
      sameEventsBesidesTheLane(armed, today);
    });

    it("the lane is decided ONCE: a later outside-looking draft never moves a classic session", async () => {
      const world = makeWorld({
        seed: "fresh",
        led: led("Plastics", "Injection moulding operator"),
      });
      await world.orchestrator.takeTurn(fromChat("injection moulding machine chalata hoon"));
      world.llm.take.mockResolvedValueOnce(SW_LED);
      const result = await world.orchestrator.takeTurn(fromChat("ab software bhi seekh raha hoon"));

      expect(result.reply).toBe(PHASE_A_REPLY);
      expect(emitted(world, LANE)).toHaveLength(1);
      expect(saved(world)?.generalRoad.lane).toBe("classic");
      expect(world.ai.llmTurn).not.toHaveBeenCalled();
    });
  });

  // ═══ 5. THE MODEL GOING AWAY ═══════════════════════════════════════════════════════════
  describe("Phase A unavailable", () => {
    it("is a classic `model_unavailable` lane and today's fallback turn", async () => {
      const armed = makeWorld({ seed: "fresh", led: null });
      const today = makeWorld({ seed: "fresh", led: null, withSkills: false });
      const [result] = await run(armed, [fromChat(ROLE_MSG)]);
      const [expected] = await run(today, [fromChat(ROLE_MSG)]);

      expect(result).toEqual(expected);
      expect(saved(armed)?.llmFallback).toBe(true);
      expect(emitted(armed, LANE).map((e) => e.payload)).toEqual([
        expect.objectContaining({ lane: "classic", reason: "model_unavailable" }),
      ]);
      expect(allEvents(armed).filter((e) => e.event_name !== LANE)).toEqual(allEvents(today));
      expect(armed.ai.llmTurn).not.toHaveBeenCalled();
    });
  });

  // ═══ 6. THE SKILLS STAGE, THE GATE AND THE HANDOVER ═════════════════════════════════════
  describe("the skills stage", () => {
    it("ends at the gate: certified bullets, two chips, the keyboard locked, a checkpoint", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      const gate = await toTheGate(world);

      expect(gate.kind).toBe("ask");
      expect(gate.reply).toBe(skillsGatePrompt(GATE_SKILLS));
      for (const skill of GATE_SKILLS) expect(gate.reply).toContain(`• ${skill}`);
      expect(gate.options).toEqual([...SKILLS_GATE_OPTIONS]);
      expect(gate.answerType).toBe("single_select");
      expect(gate.inputMode).toBe("options_only");
      expect(gate.gateKind).toBe("skills");
      expect(gate.checkpointDue).toBe(true);
      expect(gate.questionKey).toBeNull();
      expect(gate.complete).toBe(false);

      const road = saved(world)!.generalRoad;
      expect(road.gateOpen).toBe(true);
      expect(road.gateRounds).toBe(1);
      expect(road.skills).toEqual([...GATE_SKILLS]);
      expect(road.skillsAsks).toBe(2);
    });

    it("Nahi hands over to the GENERAL form — the card, not the trade card, and Phase A off", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("Nahi"));

      expect(result.kind).toBe("close");
      expect(result.complete).toBe(true);
      expect(result.completionReason).toBe("general_form_handoff");
      expect(result.generalFormOffer).toEqual(GENERAL_FORM_OFFER);
      expect(result.reply).toBe(GENERAL_FORM_OFFER.reply);
      expect(result.formOffer ?? null).toBeNull();
      expect(result.gateKind ?? null).toBeNull();
      expect(result.options).toEqual([]);
      expect(result.questionKey).toBeNull();
      // THE GATE'S ANSWER NEEDS NO MODEL.
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);

      const after = saved(world)!;
      // `formKind` STAYS NULL: it routes a returning worker to a TRADE form.
      expect(after.formKind).toBeNull();
      expect(after.llmStage).toBe("done");
      expect(after.llmGateOpen).toBe(false);
      expect(after.phase).toBe("close");
      expect(after.generalRoad).toMatchObject({
        lane: "skills",
        gateOpen: false,
        handedOver: true,
        outcome: "confirmed",
        skills: [...GATE_SKILLS],
      });
      // SETTLES THE TRADE ONLY — the role, and never skills or years.
      const answers = answersOf(after);
      expect(answers.primary_trade?.status).toBe("answered");
      expect(answers.primary_trade?.value_raw).toBe(ROLE);
      expect(answers.experience_years).toBeUndefined();
      expect(answers.kaam_ka_tajurba).toBeUndefined();
    });

    it("the handover settles NO skills into the answer map, even ones a skills question would match (R7)", async () => {
      // Phase A's draft names "React", and this pack carries a `skills` multi-select with React
      // among its options — exactly what the classic settlement turns into an answer. On this
      // road skills live only, certified, on the general-road stamp.
      const world = makeWorld({
        pack: PACK_WITH_SKILLS,
        led: led(DOMAIN, ROLE, { skills: ["React"] }),
        model: [ENTER_ASK, TO_GATE],
      });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("Nahi"));

      expect(result.completionReason).toBe("general_form_handoff");
      const answers = answersOf(saved(world)!);
      expect(answers.tech_skills).toBeUndefined();
      expect(answers.primary_trade?.status).toBe("answered");
      expect(saved(world)?.generalRoad.skills).toEqual([...GATE_SKILLS]);
    });

    it("records the gate answer once for its round, and the handover once, with counts", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      await toTheGate(world);
      await world.orchestrator.takeTurn(fromChat("Nahi"));

      const answered = emitted(world, GATE_ANSWERED);
      expect(answered).toHaveLength(1);
      expect(answered[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        round: 1,
        reply: "done",
        skills_count: 4,
      });
      expect(answered[0]!.idempotencyKey).toBe(`${GATE_ANSWERED}:${SESSION}:1`);

      const handover = emitted(world, GENERAL_FORM);
      expect(handover).toHaveLength(1);
      expect(handover[0]!.payload).toEqual({
        worker_id: WORKER,
        session_id: SESSION,
        outcome: "confirmed",
        skills_count: 4,
        skills_asks: 2,
        gate_rounds: 1,
        llm_led_turns: 1,
        rejected_count: 0,
      });
      expect(handover[0]!.idempotencyKey).toBe(`${GENERAL_FORM}:${SESSION}`);
      // Neither of the trade road's events.
      expect(emitted(world, "profile.form_mode_entered")).toHaveLength(0);
      expect(emitted(world, "profile.form_offered")).toHaveLength(0);
      expect(emitted(world, LANE)).toHaveLength(1);
    });

    it("Haan goes back to the stage and asks the model again — not counted as stale", async () => {
      const world = makeWorld({
        model: [
          ENTER_ASK,
          TO_GATE,
          skillsModel({ reply_text: "Kaunsa cloud platform use karte hain?" }),
        ],
      });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("Haan"));

      expect(world.ai.llmTurn).toHaveBeenCalledTimes(3);
      expect(result.kind).toBe("ask");
      expect(result.reply).toBe("Kaunsa cloud platform use karte hain?");
      expect(result.inputMode).toBe("text");
      expect(result.gateKind ?? null).toBeNull();
      expect(result.options).toEqual([]);
      expect(result.answerType).toBe("text");
      expect(result.complete).toBe(false);

      const road = saved(world)!.generalRoad;
      expect(road.gateOpen).toBe(false);
      expect(road.gateRounds).toBe(1);
      expect(road.staleTurns).toBe(0);
      expect(road.handedOver).toBe(false);
      expect(emitted(world, GATE_ANSWERED).map((e) => e.payload)).toEqual([
        expect.objectContaining({ round: 1, reply: "add" }),
      ]);
      expect(emitted(world, GENERAL_FORM)).toHaveLength(0);
    });

    it("a skill TYPED at the gate is read by the model and recorded as `typed`", async () => {
      const world = makeWorld({
        model: [
          ENTER_ASK,
          TO_GATE,
          skillsModel({ skills: ["Docker"], reply_text: "Kaunsa CI tool use karte hain?" }),
        ],
      });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("Docker bhi aata hai"));

      expect(world.ai.llmTurn).toHaveBeenCalledTimes(3);
      expect(result.reply).toBe("Kaunsa CI tool use karte hain?");
      expect(saved(world)?.generalRoad.skills).toEqual([...GATE_SKILLS, "Docker"]);
      expect(emitted(world, GATE_ANSWERED).map((e) => e.payload)).toEqual([
        expect.objectContaining({ round: 1, reply: "typed", skills_count: 5 }),
      ]);
    });

    it("an unreadable gate reply that names no skill is `unclear` and hands over", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE, skillsModel({ skills: [] })] });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("abhi naukri chahiye"));

      expect(result.completionReason).toBe("general_form_handoff");
      expect(emitted(world, GATE_ANSWERED).map((e) => e.payload)).toEqual([
        expect.objectContaining({ round: 1, reply: "unclear" }),
      ]);
      expect(emitted(world, GENERAL_FORM).map((e) => e.payload)).toEqual([
        expect.objectContaining({ outcome: "confirmed" }),
      ]);
    });

    it("'bas' mid-stage goes straight to the gate with no model call", async () => {
      const world = makeWorld({ model: [ENTER_ASK] });
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));
      const result = await world.orchestrator.takeTurn(fromChat("bas"));

      expect(world.ai.llmTurn).toHaveBeenCalledTimes(1);
      expect(result.reply).toBe(skillsGatePrompt(["React", "Node.js"]));
      expect(result.inputMode).toBe("options_only");
      expect(result.gateKind).toBe("skills");
      expect(result.options).toEqual([...SKILLS_GATE_OPTIONS]);
      // Reaching the gate is not an answer to it.
      expect(emitted(world, GATE_ANSWERED)).toHaveLength(0);
    });

    it("zero skills and 'bas' skip the gate and hand over as `no_skills`", async () => {
      const world = makeWorld({ model: [skillsModel({ skills: [] })] });
      const first = await world.orchestrator.takeTurn(fromChat("main pilot banna chahta hoon"));
      // Stale once — the stage still asks.
      expect(first.kind).toBe("ask");

      const result = await world.orchestrator.takeTurn(fromChat("bas"));
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("close");
      expect(result.completionReason).toBe("general_form_handoff");
      // NOTHING WAS NOTED, so the card must not say "Skills note ho gayi" (review 2b).
      expect(result.generalFormOffer).toEqual(GENERAL_FORM_OFFER_NO_SKILLS);
      expect(result.reply).toBe(GENERAL_FORM_OFFER_NO_SKILLS.reply);
      expect(saved(world)?.generalRoad).toMatchObject({
        outcome: "no_skills",
        handedOver: true,
        gateRounds: 0,
        skills: [],
      });
      expect(emitted(world, GATE_ANSWERED)).toHaveLength(0);
      expect(emitted(world, GENERAL_FORM).map((e) => e.payload)).toEqual([
        expect.objectContaining({ outcome: "no_skills", skills_count: 0, gate_rounds: 0 }),
      ]);
    });

    it("the session's turn cap hands over as `turn_cap`, without a model call", async () => {
      const world = makeWorld({ seed: ON_SKILLS_LANE, turnCount: MAX_ENGINE_TURNS });
      const result = await world.orchestrator.takeTurn(fromChat("Docker bhi aata hai"));

      expect(world.ai.llmTurn).not.toHaveBeenCalled();
      expect(result.kind).toBe("close");
      expect(result.completionReason).toBe("general_form_handoff");
      expect(result.generalFormOffer).toEqual(GENERAL_FORM_OFFER);
      expect(saved(world)?.generalRoad).toMatchObject({ outcome: "turn_cap", handedOver: true });
      expect(emitted(world, GENERAL_FORM).map((e) => e.payload)).toEqual([
        expect.objectContaining({ outcome: "turn_cap", skills_count: 1 }),
      ]);
    });

    it("years said mid-stage are never cross-filled into the answer map (R5)", async () => {
      // The draft's jobs are empty on this lane, which makes `isOpenerReplyTurn` read true again —
      // so without the lane's own exclusion "5 saal" would be captured as total experience.
      const world = makeWorld({
        seed: ON_SKILLS_LANE,
        model: [skillsModel({ skills: ["Docker"], reply_text: "Kaunsa CI tool use karte hain?" })],
      });
      await world.orchestrator.takeTurn(fromChat("5 saal se Docker pe kaam kar raha hoon"));

      const answers = answersOf(saved(world)!);
      expect(answers.experience_years).toBeUndefined();
      expect(answers.kaam_ka_tajurba).toBeUndefined();
      expect(saved(world)?.generalRoad.skills).toEqual(["React", "Docker"]);
    });

    it("a skills model that goes away with skills in hand ends at the gate, not in an error", async () => {
      const world = makeWorld({ model: [ENTER_ASK, null] });
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));
      const result = await world.orchestrator.takeTurn(fromChat("aur Docker bhi"));

      expect(result.unavailable).toBe(false);
      expect(result.gateKind).toBe("skills");
      expect(result.reply).toBe(skillsGatePrompt(["React", "Node.js"]));
      // Ledgered anyway — a call that failed may still have been paid for.
      expect(world.cost.record).toHaveBeenCalledTimes(2);
    });
  });

  // ═══ 7. THE LANE OWNS THE TURN ══════════════════════════════════════════════════════════
  describe("the skills lane owns every turn it is on", () => {
    it("never calls identify or Phase A once the lane is entered", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      await toTheGate(world);
      await world.orchestrator.takeTurn(fromChat("Nahi"));

      // The entering turn is the last one either sees: a skills answer is not a trade statement.
      expect(world.identify.identify).toHaveBeenCalledTimes(1);
      expect(world.llm.take).toHaveBeenCalledTimes(1);
    });

    it("never serves the résumé-update offer on the handover, even to an eligible worker", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE], eligible: true });
      await toTheGate(world);
      const result = await world.orchestrator.takeTurn(fromChat("Nahi"));

      expect(result.generalFormOffer).toEqual(GENERAL_FORM_OFFER);
      expect(result.completionReason).toBe("general_form_handoff");
      expect(saved(world)?.resumeUpdateOffer).toBeNull();
      expect(world.policy.eligible).not.toHaveBeenCalled();
    });
  });

  // ═══ 8. THE GATE SURVIVES A RETRY AND A REOPEN ════════════════════════════════════════
  describe("the gate on a retry and a reopen", () => {
    it("a replay of the gate turn keeps its chips, its locked keyboard and its kind", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      const gate = await toTheGate(world);
      const again = await world.orchestrator.takeTurn(fromChat(TO_GATE_MSG, later(1)));

      expect(again.replayed).toBe(true);
      expect(again.reply).toBe(gate.reply);
      expect(again.options).toEqual([...SKILLS_GATE_OPTIONS]);
      expect(again.inputMode).toBe("options_only");
      expect(again.gateKind).toBe("skills");
      // A replay is not a turn: no model call, and the gate is still what is on screen.
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);
      expect(saved(world)?.generalRoad.gateOpen).toBe(true);
      expect(saved(world)?.generalRoad.gateRounds).toBe(1);

      // And the worker's real answer after it still hands over.
      const done = await world.orchestrator.takeTurn(fromChat("Nahi", later(2)));
      expect(done.completionReason).toBe("general_form_handoff");
    });

    it("a replay of the handover keeps the general-form card — the button is the only way out", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      await toTheGate(world);
      await world.orchestrator.takeTurn(fromChat("Nahi"));
      const again = await world.orchestrator.takeTurn(fromChat("Nahi", later(1)));

      expect(again.replayed).toBe(true);
      expect(again.generalFormOffer).toEqual(GENERAL_FORM_OFFER);
      expect(emitted(world, GENERAL_FORM)).toHaveLength(1);
    });

    it("openTurn at the gate re-serves it locked, with its kind, and writes nothing", async () => {
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      const gate = await toTheGate(world);
      const rev = saved(world)?.rev;

      const reopened = await world.orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: later(60_000),
        ctx: CTX as never,
      });

      expect(reopened.replayed).toBe(true);
      expect(reopened.reply).toBe(gate.reply);
      expect(reopened.options).toEqual([...SKILLS_GATE_OPTIONS]);
      expect(reopened.inputMode).toBe("options_only");
      expect(reopened.gateKind).toBe("skills");
      expect(saved(world)?.rev).toBe(rev);
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);
    });

    it("openTurn after a hardship line over the gate never locks the keyboard with nothing to tap", async () => {
      // The hardship acknowledgement REPLACES the gate on screen — no chips — while the gate stays
      // open behind it (the worker's next words are still its answer). A reopen that derived the
      // lock from `gateOpen` alone served that chipless line as `options_only` + `gate_kind`: a
      // locked composer with nothing to press. What is on screen is what `lastTurn` cached.
      const world = makeWorld({ model: [ENTER_ASK, TO_GATE] });
      await toTheGate(world);
      const ack = await world.orchestrator.takeTurn(fromChat("ghar chalana mushkil hai"));
      expect(ack.options).toEqual([]);
      expect(saved(world)?.generalRoad.gateOpen).toBe(true);

      const reopened = await world.orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: later(60_000),
        ctx: CTX as never,
      });

      expect(reopened.reply).toBe(ack.reply);
      expect(reopened.options).toEqual([]);
      expect(reopened.inputMode).toBe("text");
      expect(reopened.gateKind ?? null).toBeNull();
      // And the gate still reads the next answer — a Nahi still hands over.
      const done = await world.orchestrator.takeTurn(fromChat("Nahi", later(61_000)));
      expect(done.completionReason).toBe("general_form_handoff");
      expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);
    });

    it("openTurn mid-stage re-serves the model's question with the keyboard open", async () => {
      const world = makeWorld({ model: [ENTER_ASK] });
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));

      const reopened = await world.orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: later(60_000),
        ctx: CTX as never,
      });

      expect(reopened.reply).toBe(ENTER_ASK.reply_text);
      expect(reopened.inputMode).toBe("text");
      expect(reopened.gateKind ?? null).toBeNull();
    });

    it("openTurn re-serves the skills question even when Phase A itself asked nothing", async () => {
      // The model named the role on a CLOSING turn (`done`, zero asks): `llmAsks` is 0, and only
      // the lane says a model-led question is on screen. Without it a reopen would fall through to
      // the pack and serve an authored question the skills stage never asked.
      const world = makeWorld({
        led: led(DOMAIN, ROLE, { kind: "done", patch: { llmAsks: 0 } }),
        model: [ENTER_ASK],
      });
      await world.orchestrator.takeTurn(fromChat(ROLE_MSG));
      expect(saved(world)?.llmAsks).toBe(0);
      expect(saved(world)?.generalRoad.lane).toBe("skills");

      const reopened = await world.orchestrator.openTurn({
        sessionId: SESSION,
        workerId: WORKER,
        now: later(60_000),
        ctx: CTX as never,
      });

      expect(reopened.reply).toBe(ENTER_ASK.reply_text);
      expect(reopened.questionKey).toBeNull();
      expect(reopened.replayed).toBe(true);
    });
  });

  // ═══ 9. PRIVACY ═══════════════════════════════════════════════════════════════════════
  describe("the events", () => {
    /** Two rounds of the gate, a typed skill, then the chip key — every event this road emits. */
    async function fullRoad() {
      const world = makeWorld({
        model: [
          skillsModel({ ...ENTER_ASK, skills: ["React", "Node.js", "Photoshop"] }),
          TO_GATE,
          skillsModel({ reply_text: "Kaunsa cloud platform use karte hain?" }),
          skillsModel({ skills: ["Docker"], phase_a_done: true }),
        ],
      });
      const texts = [ROLE_MSG, TO_GATE_MSG, "Haan", "Docker bhi aata hai", "skills_gate_done"];
      const results = await run(
        world,
        texts.map((text) => fromChat(text)),
      );
      return { world, texts, results };
    }

    it("the whole road emits each general-road event the number of times it should", async () => {
      const { world, results } = await fullRoad();

      expect(results.at(-1)?.completionReason).toBe("general_form_handoff");
      expect(emitted(world, LANE)).toHaveLength(1);
      expect(emitted(world, GATE_ANSWERED).map((e) => e.payload)).toEqual([
        expect.objectContaining({ round: 1, reply: "add" }),
        expect.objectContaining({ round: 2, reply: "done", skills_count: 5 }),
      ]);
      expect(emitted(world, GENERAL_FORM).map((e) => e.payload)).toEqual([
        expect.objectContaining({ outcome: "confirmed", gate_rounds: 2, rejected_count: 1 }),
      ]);
    });

    it("never carry a skill, a label or anything the worker typed", async () => {
      const { world, texts } = await fullRoad();
      const forbidden = [
        "React",
        "Node",
        "PostgreSQL",
        "Docker",
        "Photoshop",
        "Git",
        ROLE,
        DOMAIN,
        "Software",
        "developer",
        ...texts,
      ];

      const events = allEvents(world);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const json = JSON.stringify(event.payload);
        for (const word of forbidden) expect(json).not.toContain(word);
      }
    });

    it("validate against the registered payload schemas", async () => {
      const { world } = await fullRoad();
      const events = generalRoadEvents(world);
      expect(events.map((e) => e.event_name).sort()).toEqual(
        [GATE_ANSWERED, GATE_ANSWERED, GENERAL_FORM, LANE].sort(),
      );
      for (const event of events) {
        const schema = EVENT_REGISTRY[event.event_name as keyof typeof EVENT_REGISTRY].payload;
        expect(schema.safeParse(event.payload).success).toBe(true);
      }
    });
  });
});
