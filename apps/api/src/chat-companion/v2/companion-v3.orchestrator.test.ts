import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { FreeChatModelCalls } from "../../profiling/free-chat/free-chat-model-calls";
import { FREE_CHAT_COPY } from "../../profiling/free-chat/free-chat.copy";
import { V2_CLARIFY, V2_EDIT_CARD_INTRO } from "../companion-replies";
import { CompanionBrain } from "./companion-brain";
import type { CompanionEditService } from "./companion-edit.service";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { v2EditCardTurn } from "./companion-v2-compose";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import {
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./handlers/fixed-line.handlers";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { CompanionHandlerRegistry } from "./handlers/registry";

/**
 * ADR-0055 (#2275) — the ORCHESTRATOR on the free-chat brain, end to end through the REAL brain,
 * the REAL `FreeChatModelCalls` and the real handlers; only `AiService` (both classifiers, the
 * reply), the stores and the spine are faked. Pins: the brain replaces ONLY the classify + handler
 * steps; the turn event is `chat.companion_turn_served_v4` on BOTH paths, and it parses; the kill
 * switch (`CHAT_FREE_CHAT_DISABLED`) is today's v2 path; the distress word-list route.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-10-14T10:00:00.000Z");
const PROFILE = { id: "p1", canonicalTradeId: null, experience: { total_years: 2 } } as never;
const CARD = v2EditCardTurn(V2_EDIT_CARD_INTRO, {
  proposal_id: "33333333-3333-4333-8333-333333333333",
  expires_at: "2026-10-14T10:10:00.000Z",
  rows: [
    {
      row_id: "44444444-4444-4444-8444-444444444444",
      section_label: "Bhasha",
      op: "delete",
      before: "hindi",
      after: null,
    },
  ],
});

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_free_classify",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
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

const classified = (category: string, resume_action: string | null = null, confidence = 0.92) => ({
  category,
  confidence,
  blocked: false,
  ai_metadata: META,
  language: null,
  resume_action,
});

function setup(opts: { killSwitch?: boolean; freeClassify?: unknown; reply?: unknown } = {}) {
  const config = {
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: false,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
    ...(opts.killSwitch === undefined ? {} : { CHAT_FREE_CHAT_DISABLED: opts.killSwitch }),
  } as unknown as ServerConfig;
  const ai = {
    pseudonymize: vi.fn(async () => ({ pseudonymized_text: "masked text", blocked: false })),
    companionClassify: vi.fn(async () => ({
      intent: "edit_resume",
      confidence: 0.9,
      blocked: false,
    })),
    companionCareer: vi.fn(async () => null),
    freeChatClassify: vi.fn(
      async (..._args: unknown[]) => opts.freeClassify ?? classified("career"),
    ),
    freeChatReply: vi.fn(async () =>
      opts.reply === undefined
        ? {
            status: "answer",
            lines: ["Welding ka certificate ITI se milta hai."],
            followup_chips: [],
            ai_metadata: META,
          }
        : opts.reply,
    ),
    freeChatNews: vi.fn(async () => null),
  };
  const memory = {
    read: vi.fn(async () => [{ role: "worker", text: "namaste" }]),
    append: vi.fn(async (_w: string, _t: unknown) => undefined),
  };
  const edits = { propose: vi.fn(async () => ({ turn: CARD, outcome: "proposed" })) };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const faltuStore = {
    cooldownUntil: vi.fn(async () => null),
    countStrike: vi.fn(async () => 1),
    startCooldown: vi.fn(async () => null),
  };
  const replays = {
    read: vi.fn(async () => null),
    remember: vi.fn(async () => undefined),
    claim: vi.fn(async () => "claimed"),
    release: vi.fn(async () => undefined),
  };
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, {
      findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
    } as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(
      config,
      ai as never,
      cost as never,
      events as never,
      {
        isKnownEmployer: vi.fn(async () => false),
      } as never,
    ),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const calls = new FreeChatModelCalls(
    ai as never,
    cost as never,
    {
      reserve: vi.fn(async () => ({ ok: true, count: 1 })),
      release: vi.fn(async () => undefined),
    } as never,
  );
  const brain = new CompanionBrain(
    config,
    calls,
    registry,
    { downloadOf: vi.fn(async () => "ready") } as never,
    // ADR-0055 — no name on file: nothing to redact.
    { sourcesFor: () => ({ knownName: async () => null, ownName: async () => null }) } as never,
    // ADR-0055 R4 — no rolling summary on file.
    { latestText: vi.fn(async () => null) } as never,
  );
  const route = vi.spyOn(brain, "route");
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
    faltuStore as never,
    replays as never,
    { set: vi.fn(), take: vi.fn(async () => null), clear: vi.fn() } as never,
    brain,
  );
  return { orchestrator, ai, memory, edits, events, cost, replays, route };
}

type Emitted = { event_name: string; payload: Record<string, unknown>; idempotencyKey?: string };
const turnEvent = (events: { emit: { mock: { calls: unknown[][] } } }): Emitted =>
  events.emit.mock.calls
    .map((c) => c[0] as Emitted)
    .find((e) => e.event_name.startsWith("chat.companion_turn_served"))!;
const parses = (e: Emitted) =>
  EVENT_REGISTRY["chat.companion_turn_served_v4"].payload.safeParse(e.payload).success;

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("kill switch OFF (production's default) — the v1 miss runs the free-chat brain", () => {
  it("one free-chat classify on the gateway text — and NO companion classify", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "welding ka certificate kahan milega", submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe("Welding ka certificate ITI se milta hai.");
    expect(turn.read_aloud).toBe(false);
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    expect(h.ai.freeChatClassify.mock.calls[0]![0]).toMatchObject({
      text: "masked text",
      mode: "free",
      surface: "companion",
    });
    // The free chat's spend, with no session on the companion.
    expect(h.cost.record).toHaveBeenCalledWith(
      META,
      "profiling_free_classify",
      null,
      "corr-1",
      "req-1",
      {
        workerId: WORKER,
        sessionId: null,
      },
    );
  });

  it("the v4 event carries the brain's facts, parses, and is keyed on the submission", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "x", submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    const event = turnEvent(h.events);
    expect(event.event_name).toBe("chat.companion_turn_served_v4");
    expect(event.payload).toMatchObject({
      intent: "fallback",
      intent_source: "llm",
      v2_intent: "career_talk",
      confidence_bucket: "gte90",
      outcome: "answered",
      free_category: "career",
      resume_action: null,
      refusal_topic: null,
      reply_language: "hinglish",
      news_outcome: null,
      news_source_count: 0,
    });
    expect(parses(event)).toBe(true);
    expect(event.idempotencyKey).toBe(
      `chat.companion_turn_served_v4:message:${WORKER}:${SUBMISSION}`,
    );
    // Never the worker's words, never the model's.
    expect(JSON.stringify(event.payload)).not.toMatch(/certificate|masked/);
  });

  it("memory gets the pair — except a message the classifier called trash", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(h.memory.append).toHaveBeenCalledWith(WORKER, { role: "worker", text: "masked text" });

    const trash = setup({ freeClassify: classified("trash") });
    await trash.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(trash.memory.append).not.toHaveBeenCalled();
    expect(turnEvent(trash.events).payload).toMatchObject({
      v2_intent: "faltu",
      free_category: "trash",
    });
  });

  it("a résumé edit reaches the EXISTING edit handler; its event records the action", async () => {
    const h = setup({ freeClassify: classified("resume", "edit") });
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "hindi hata do" },
      CTX,
      NOW,
    );
    expect(turn).toBe(CARD);
    expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, "masked text", CTX, NOW);
    const event = turnEvent(h.events);
    expect(event.payload).toMatchObject({
      v2_intent: "edit_resume",
      outcome: "proposed",
      free_category: "resume",
      resume_action: "edit",
    });
    expect(parses(event)).toBe(true);
  });

  it("an unavailable classifier is a fail-closed clarify, and that turn is never kept for a retry", async () => {
    const h = setup({
      freeClassify: { ...classified("career"), ai_metadata: { ...META, real_call: false } },
    });
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "x", submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(turnEvent(h.events).payload).toMatchObject({
      intent_source: "fallback",
      v2_intent: null,
    });
    expect(h.replays.remember).not.toHaveBeenCalled();
  });

  it("a brain that THROWS fails closed to the clarify line — never a 500, never kept", async () => {
    const h = setup();
    h.route.mockRejectedValueOnce(new TypeError("boom"));
    const turn = await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "x", submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(turnEvent(h.events).payload).toMatchObject({
      intent_source: "fallback",
      outcome: "clarify",
    });
    expect(h.replays.remember).not.toHaveBeenCalled();
  });

  it("the gateway still runs first: a blocked message reaches no classifier at all", async () => {
    const h = setup();
    h.ai.pseudonymize.mockResolvedValueOnce({ pseudonymized_text: "", blocked: true });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });
});

describe("kill switch ON (`CHAT_FREE_CHAT_DISABLED`) — today's v2 path, byte for byte", () => {
  it("the companion classifier and the registry answer; the brain is never reached", async () => {
    const off = setup({ killSwitch: true });
    const turn = await off.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "hindi hata do" },
      CTX,
      NOW,
    );
    expect(turn).toBe(CARD);
    expect(off.ai.companionClassify).toHaveBeenCalledTimes(1);
    expect(off.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(off.route).not.toHaveBeenCalled();
    expect(off.cost.record).toHaveBeenCalledWith(
      null,
      "companion_classify",
      null,
      "corr-1",
      "req-1",
      {
        workerId: WORKER,
      },
    );
  });

  it("emits v4 with every brain field null — the v3 facts, unchanged", async () => {
    const off = setup({ killSwitch: true });
    await off.orchestrator.handleMessage(WORKER, PROFILE, { text: "hindi hata do" }, CTX, NOW);
    const event = turnEvent(off.events);
    expect(event.event_name).toBe("chat.companion_turn_served_v4");
    expect(event.payload).toMatchObject({
      intent_source: "llm",
      v2_intent: "edit_resume",
      confidence_bucket: "gte90",
      outcome: "proposed",
      free_category: null,
      resume_action: null,
      refusal_topic: null,
      reply_language: null,
      news_outcome: null,
      news_source_count: 0,
    });
    expect(parses(event)).toBe(true);
  });
});

describe("handleDistress — the word list's route (the service calls it before v1)", () => {
  it("the helpline alone, a lexicon v4 event, and nothing stored or sent", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleDistress(
      WORKER,
      { text: "marna chahta hoon" },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.suggested_options).toEqual([]);
    const event = turnEvent(h.events);
    expect(event.payload).toMatchObject({
      intent_source: "lexicon",
      v2_intent: "distress",
      outcome: "served",
      free_category: null,
    });
    expect(parses(event)).toBe(true);
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
  });
});
