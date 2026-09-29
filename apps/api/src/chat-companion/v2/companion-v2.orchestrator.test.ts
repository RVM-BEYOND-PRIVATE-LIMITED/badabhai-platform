import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import type { CompanionEditService } from "./companion-edit.service";
import { CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import {
  V2_CLARIFY,
  V2_EDIT_CARD_INTRO,
  V2_FALTU_COOLDOWN,
  V2_JOBS_DEFERRED,
  V2_PHASE_OFF,
} from "../companion-replies";
import { v2EditCardTurn } from "./companion-v2-compose";

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX = { requestId: "req-1", correlationId: "corr-1" } as never;
const NOW = new Date("2026-09-29T10:00:00.000Z");
const PROFILE = { id: "p1", workerId: WORKER } as never;
const CARD = v2EditCardTurn(V2_EDIT_CARD_INTRO, {
  proposal_id: "22222222-2222-4222-8222-222222222222",
  expires_at: "2026-09-29T10:10:00.000Z",
  rows: [
    {
      row_id: "33333333-3333-4333-8333-333333333333",
      section_label: "Bhasha",
      op: "delete",
      before: "hindi",
      after: null,
    },
  ],
});

function setup(
  opts: {
    pseudo?: unknown;
    classify?: unknown;
    memory?: unknown;
    editEnabled?: boolean;
    newResumeEnabled?: boolean;
    propose?: unknown;
  } = {},
) {
  const ai = {
    // `undefined` means "use the default"; an explicit `null` is the AI service being down.
    pseudonymize: vi.fn(async () =>
      opts.pseudo === undefined ? { pseudonymized_text: "masked text", blocked: false } : opts.pseudo,
    ),
    companionClassify: vi.fn(async () =>
      opts.classify === undefined
        ? { intent: "edit_resume", confidence: 0.9, blocked: false }
        : opts.classify,
    ),
  };
  const memory = {
    read: vi.fn(async () => opts.memory ?? []),
    append: vi.fn(async () => undefined),
  };
  const edits = {
    propose: vi.fn(async () => opts.propose ?? { turn: CARD, outcome: "proposed" }),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: opts.editEnabled ?? true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: opts.newResumeEnabled ?? false,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
  } as unknown as ServerConfig;
  const consents = {
    findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const faltuStore = {
    cooldownUntil: vi.fn(async () => null),
    countStrike: vi.fn(async () => 1),
    startCooldown: vi.fn(async () => null),
  };
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, consents as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
    faltuStore as never,
  );
  return { orchestrator, ai, memory, edits, events, cost, faltuStore, config };
}

const emitted = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls[0]![0] as {
    event_name: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  };

describe("CompanionV2Orchestrator — the turn pipeline (ADR-0046 §2.1)", () => {
  it("edit_resume with the edit flag ON: the card, proposed, classified by the LLM", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "Hindi hata do" }, CTX, NOW);
    expect(turn).toBe(CARD);
    // The handler got the MASKED text, never the raw one.
    expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, "masked text", CTX, NOW);

    const event = emitted(h.events);
    expect(event.event_name).toBe("chat.companion_turn_served_v2");
    expect(event.payload).toMatchObject({
      trigger: "message",
      intent: "fallback",
      intent_source: "llm",
      v2_intent: "edit_resume",
      // 0.9 lands in the top bucket: lt50 < 0.5, 50_70 < 0.7, 70_90 < 0.9, gte90 at/above.
      confidence_bucket: "gte90",
      outcome: "proposed",
      day: "2026-09-29",
      job_chips_count: 0,
    });
    // The payload is exactly what the merged contract accepts.
    const parsed = EVENT_REGISTRY["chat.companion_turn_served_v2"].payload.safeParse(event.payload);
    expect(parsed.success).toBe(true);

    // ADR-0046 O12 — the classify spend is recorded against `companion_classify` before any
    // branch. The fake returns no metadata, so the recorded meta is null; `record` no-ops on
    // null in production, and the call itself is what this pins.
    expect(h.cost.record).toHaveBeenCalledWith(
      null,
      "companion_classify",
      null,
      "corr-1",
      "req-1",
      { workerId: WORKER },
    );
  });

  it("edit_resume with the edit flag OFF: the phase-off line, no edit call at all", async () => {
    const h = setup({ editEnabled: false });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "badlo" }, CTX, NOW);
    expect(turn.reply).toBe(V2_PHASE_OFF.latin);
    expect(h.edits.propose).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({ outcome: "phase_off", v2_intent: "edit_resume" });
  });

  it("jobs_talk gets its own deferred line; career/new_resume/faltu get the phase-off line", async () => {
    const jobs = setup({ classify: { intent: "jobs_talk", confidence: 0.9, blocked: false } });
    expect((await jobs.orchestrator.handleMessage(WORKER, PROFILE, { text: "jobs" }, CTX, NOW)).reply).toBe(
      V2_JOBS_DEFERRED.latin,
    );

    for (const intent of ["career_talk", "new_resume", "faltu"] as const) {
      const h = setup({ classify: { intent, confidence: 0.9, blocked: false } });
      expect((await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW)).reply).toBe(
        V2_PHASE_OFF.latin,
      );
    }
  });

  it("unclear, a null classifier, a blocked classifier and low confidence ALL serve the clarify line", async () => {
    const cases: Array<Record<string, unknown>> = [
      { classify: { intent: "unclear", confidence: 0.9, blocked: false } },
      { classify: null },
      { classify: { intent: "edit_resume", confidence: 0.9, blocked: true } },
      { classify: { intent: "edit_resume", confidence: 0.4, blocked: false } },
    ];
    for (const over of cases) {
      const h = setup(over);
      const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
      expect(turn.reply).toBe(V2_CLARIFY.latin);
      expect(emitted(h.events).payload).toMatchObject({ outcome: "clarify" });
      expect(h.edits.propose).not.toHaveBeenCalled();
    }
    // The low-confidence case still RECORDS what the model said, bucketed.
    const low = setup({ classify: { intent: "edit_resume", confidence: 0.4, blocked: false } });
    await low.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(emitted(low.events).payload).toMatchObject({
      intent_source: "llm",
      v2_intent: "edit_resume",
      confidence_bucket: "lt50",
    });
  });

  it("a BLOCKED message never reaches the classifier and never touches memory", async () => {
    const h = setup({ pseudo: { pseudonymized_text: "", blocked: true } });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "phone" }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({ intent_source: "fallback", v2_intent: null });
  });

  it("an unreachable gateway is the same fail-closed clarify, with no classifier call", async () => {
    const h = setup({ pseudo: null });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
  });

  it("memory: the classifier sees the LAST TWO stored turns; the pair is appended after the turn", async () => {
    const stored = [
      { role: "worker", text: "t1" },
      { role: "bada_bhai", text: "t2" },
      { role: "worker", text: "t3" },
      { role: "bada_bhai", text: "t4" },
    ];
    const h = setup({ memory: stored });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(h.ai.companionClassify).toHaveBeenCalledWith(
      { text: "masked text", recent_turns: [stored[2], stored[3]] },
      CTX,
    );
    expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, {
      role: "worker",
      text: "masked text",
    });
    expect(h.memory.append).toHaveBeenNthCalledWith(2, WORKER, {
      role: "bada_bhai",
      text: CARD.reply.slice(0, 1000),
    });
  });

  it("a submission_id keys the v2 event, so a retried send is one row", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "x", submission_id: "44444444-4444-4444-8444-444444444444" },
      CTX,
      NOW,
    );
    expect(emitted(h.events).idempotencyKey).toBe(
      `chat.companion_turn_served_v2:message:${WORKER}:44444444-4444-4444-8444-444444444444`,
    );
  });

  it("handleCooldown (P2): the guard's turn — line, chips, cooldown_until, and a guard event", async () => {
    const h = setup();
    const turn = await h.orchestrator.handleCooldown(
      WORKER,
      { text: "phir se jobs dikhao" },
      CTX,
      NOW,
      "2026-09-29T10:30:00.000Z",
    );
    expect(turn.reply).toBe(V2_FALTU_COOLDOWN.latin);
    expect(turn.cooldown_until).toBe("2026-09-29T10:30:00.000Z");
    // The cool-down blocks free text, not the worker: the open chips ride along.
    expect(turn.suggested_options.length).toBeGreaterThan(0);
    // Nothing about the message was read, sent or stored.
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({
      intent_source: "guard",
      v2_intent: null,
      outcome: "cooldown",
    });
  });

  it("handleTaskChip (P2): deterministic routing, no classifier, no memory, v1_deterministic", async () => {
    const h = setup({ newResumeEnabled: true });
    const turn = await h.orchestrator.handleTaskChip(
      WORKER,
      PROFILE,
      { text: "Naya resume" },
      "new_resume",
      CTX,
      NOW,
    );
    // The real NewResumeHandler served the redo menu turn — no model was involved anywhere.
    expect(turn.reply).toContain("Naya resume kaise banana chahte hain");
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({
      intent_source: "v1_deterministic",
      v2_intent: "new_resume",
      confidence_bucket: null,
      outcome: "served",
    });
  });

  it("with the FALTU flag off the lexicon is not consulted — abusive text takes the normal path", async () => {
    // Flag off ⇒ P1: the abuse lexicon is a P2 step, and a message it would flag must still go
    // through the gateway and the classifier exactly as it did in Phase 1.
    const h = setup();
    await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "chutiya bhai kya kar raha hai" },
      CTX,
      NOW,
    );
    expect(h.ai.pseudonymize).toHaveBeenCalled();
    expect(h.ai.companionClassify).toHaveBeenCalled();
    expect(h.faltuStore.countStrike).not.toHaveBeenCalled();
  });
});
