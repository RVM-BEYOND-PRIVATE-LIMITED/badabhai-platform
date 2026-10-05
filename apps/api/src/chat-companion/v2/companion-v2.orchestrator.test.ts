import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { CompanionClassifyInputSchema, CompanionRecentTurnSchema } from "@badabhai/ai-contracts";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import type { CompanionV2EditOp } from "@badabhai/types";
import { resolveCompanionText } from "../companion-intents";
import { COMPANION_TASK_NEW_RESUME_LABEL } from "../companion-task-keys";
import type { CompanionEditService } from "./companion-edit.service";
import { resolveCompanionTaskChip } from "./companion-task-chips";
import { catalogueEntry, normaliseValue, opAllowed } from "./edit-catalogue";
import { CLASSIFY_TEXT_MAX, CompanionV2Orchestrator } from "./companion-v2.orchestrator";
import { NewResumeHandler } from "./handlers/new-resume.handler";
import { FaltuHandler } from "./handlers/faltu.handler";
import { CareerTalkHandler } from "./handlers/career-talk.handler";
import { EditResumeHandler } from "./handlers/edit-resume.handler";
import { JobsDeferredHandler, PhaseOffHandler, UnclearHandler } from "./handlers/fixed-line.handlers";
import { CompanionHandlerRegistry } from "./handlers/registry";
import {
  V2_CAREER_ASK,
  V2_CLARIFY,
  V2_EDIT_ASK,
  V2_EDIT_CARD_INTRO,
  V2_FALTU_COOLDOWN,
  V2_JOBS_DEFERRED,
  V2_PHASE_OFF,
} from "../companion-replies";
import { taskChips, v2EditCardTurn } from "./companion-v2-compose";

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
    careerEnabled?: boolean;
    faltuEnabled?: boolean;
    propose?: unknown;
    /** `AI_RAW_PII_ENABLED` (ADR-0047). Omitted = the key is absent, which must read as OFF. */
    rawPii?: boolean;
  } = {},
) {
  const ai = {
    // `undefined` means "use the default"; an explicit `null` is the AI service being down.
    pseudonymize: vi.fn(async (_text: string) =>
      opts.pseudo === undefined ? { pseudonymized_text: "masked text", blocked: false } : opts.pseudo,
    ),
    companionClassify: vi.fn(async (_input: unknown, _ctx: unknown) =>
      opts.classify === undefined
        ? { intent: "edit_resume", confidence: 0.9, blocked: false }
        : opts.classify,
    ),
    companionCareer: vi.fn(async () => null),
  };
  const memory = {
    read: vi.fn(async () => opts.memory ?? []),
    append: vi.fn(async (_workerId: string, _turn: unknown) => undefined),
  };
  const edits = {
    propose: vi.fn(async () => opts.propose ?? { turn: CARD, outcome: "proposed" }),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: opts.editEnabled ?? true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: opts.newResumeEnabled ?? false,
    CHAT_COMPANION_V2_CAREER_ENABLED: opts.careerEnabled ?? false,
    CHAT_COMPANION_V2_FALTU_ENABLED: opts.faltuEnabled ?? false,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
    ...(opts.rawPii === undefined ? {} : { AI_RAW_PII_ENABLED: opts.rawPii }),
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
  // An in-memory stand-in for the Redis replay cache, keyed exactly as the store keys it.
  const replayed = new Map<string, unknown>();
  const replays = {
    read: vi.fn(async (w: string, s: string) => replayed.get(`${w}:${s}`) ?? null),
    remember: vi.fn(async (w: string, s: string, turn: unknown) => {
      replayed.set(`${w}:${s}`, turn);
    }),
  };
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, consents as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(
      config,
      ai as never,
      cost as never,
      events as never,
      { isKnownEmployer: vi.fn(async () => false) } as never,
    ),
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
    replays as never,
  );
  return { orchestrator, ai, memory, edits, events, cost, faltuStore, replays, config };
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

  it("career_talk: the flag gates the ONE model-written answer (P3)", async () => {
    const career = { intent: "career_talk", confidence: 0.9, blocked: false };
    const off = setup({ classify: career });
    expect((await off.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW)).reply).toBe(
      V2_PHASE_OFF.latin,
    );
    expect(off.ai.companionCareer).not.toHaveBeenCalled();

    const on = setup({ classify: career, careerEnabled: true });
    // The harness's `companionCareer` answers null (unreachable) — the point here is that the
    // model was reached at all, and the worker still got the fail-closed line.
    const turn = await on.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(on.ai.companionCareer).toHaveBeenCalled();
    expect(turn.reply).not.toBe(V2_PHASE_OFF.latin);
    // The handler emits `chat.companion_career_answered` FIRST, so find the turn event by name.
    const turnEvent = on.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_turn_served_v2")!;
    expect(turnEvent.payload).toMatchObject({ v2_intent: "career_talk", outcome: "fallback" });
  });
});

describe("a TAPPED task chip names a task — no model ever reads its label", () => {
  const chipEvent = (h: ReturnType<typeof setup>) =>
    h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_turn_served_v2")!;

  it("'Resume badlo' serves the fixed ask line: no edit-parse call, no snapshot, no memory", async () => {
    const h = setup({ newResumeEnabled: true, careerEnabled: true });
    const turn = await h.orchestrator.handleTaskChip(
      WORKER,
      PROFILE,
      { text: "Resume badlo" },
      "edit_resume",
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(V2_EDIT_ASK.latin);
    expect(turn.tts_text).toBe(V2_EDIT_ASK.dev);
    // The open task chips ride along, as on every fixed v2 line.
    expect(turn.suggested_options).toEqual(taskChips(h.config));
    expect(h.edits.propose).not.toHaveBeenCalled();
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
    expect(chipEvent(h).payload).toMatchObject({
      intent_source: "v1_deterministic",
      v2_intent: "edit_resume",
      confidence_bucket: null,
      outcome: "served",
    });
  });

  it("'Career ki baat' serves the fixed ask line: the career model is never sent the label", async () => {
    const h = setup({ careerEnabled: true });
    const turn = await h.orchestrator.handleTaskChip(
      WORKER,
      PROFILE,
      { text: "Career ki baat" },
      "career_talk",
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(V2_CAREER_ASK.latin);
    expect(turn.tts_text).toBe(V2_CAREER_ASK.dev);
    expect(h.ai.companionCareer).not.toHaveBeenCalled();
    expect(h.cost.record).not.toHaveBeenCalled();
    expect(chipEvent(h).payload).toMatchObject({ v2_intent: "career_talk", outcome: "served" });
    // No `chat.companion_career_answered`: nothing was answered.
    expect(
      h.events.emit.mock.calls.some(
        (c) => (c[0] as { event_name: string }).event_name === "chat.companion_career_answered",
      ),
    ).toBe(false);
  });

  it("the handler gets the chip's SERVER-AUTHORED label, never the bytes the app posted", async () => {
    const handle = vi.spyOn(NewResumeHandler.prototype, "handle");
    try {
      const h = setup({ newResumeEnabled: true });
      // Matched after normalization — but these bytes are the app's, not the chip's.
      await h.orchestrator.handleTaskChip(
        WORKER,
        PROFILE,
        { text: "  NAYA   RESUME." },
        "new_resume",
        CTX,
        NOW,
      );
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle.mock.calls[0]![0].text).toBe(COMPANION_TASK_NEW_RESUME_LABEL);
    } finally {
      handle.mockRestore();
    }
  });

  it("every example the ask lines quote is a v1 MISS and not a chip — typing one reaches the router", () => {
    const examples = [V2_EDIT_ASK, V2_CAREER_ASK].flatMap((pair) =>
      [...pair.latin.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
    );
    expect(examples).toHaveLength(3);
    const allOpen = {
      CHAT_COMPANION_V2_EDIT_ENABLED: true,
      CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
      CHAT_COMPANION_V2_CAREER_ENABLED: true,
    };
    for (const example of examples) {
      expect(resolveCompanionText(example), example).toEqual({ kind: "intent", intent: "fallback" });
      expect(resolveCompanionTaskChip(example, allOpen), example).toBeNull();
    }
  });

  it("every example V2_EDIT_ASK quotes is a change the edit catalogue can make — never a promise it cannot keep", () => {
    // Keyed by the example's text: a copy change that swaps an example fails here until the new
    // one is mapped to a catalogue field, an allowed op and a value the field normalises.
    const writable: Record<string, { section: string; field: string; op: CompanionV2EditOp; value: string }> = {
      "Marathi bhasha jod do": { section: "languages", field: "language", op: "add", value: "marathi" },
      "night shift kar do": { section: "preferences", field: "shift", op: "edit", value: "night" },
    };
    const examples = [...V2_EDIT_ASK.latin.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(examples.sort()).toEqual(Object.keys(writable).sort());
    for (const example of examples) {
      const { section, field, op, value } = writable[example]!;
      const entry = catalogueEntry(section, field);
      expect(entry, example).toBeDefined();
      expect(opAllowed(entry!, op), example).toBe(true);
      expect(normaliseValue(entry!.section, field, value), example).toBe(value);
    }
  });
});

describe("the classify bound (contracts §2.1) — a long message is classified, not refused", () => {
  it("CLASSIFY_TEXT_MAX is the contract's own bound", () => {
    const input = (n: number) => ({ text: "a".repeat(n), recent_turns: [] });
    expect(CompanionClassifyInputSchema.safeParse(input(CLASSIFY_TEXT_MAX)).success).toBe(true);
    expect(CompanionClassifyInputSchema.safeParse(input(CLASSIFY_TEXT_MAX + 1)).success).toBe(false);
  });

  it("a 4000-char message: the classifier and memory get its first 1000, the handler all of it", async () => {
    const long = "welding ".repeat(500); // 4000 chars — the API's own message bound
    expect(long.length).toBe(4000);
    const h = setup({ pseudo: { pseudonymized_text: long, blocked: false } });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: long }, CTX, NOW);

    const sent = h.ai.companionClassify.mock.calls[0]![0] as { text: string; recent_turns: unknown[] };
    expect(sent.text).toBe(long.slice(0, CLASSIFY_TEXT_MAX));
    // The payload the API sends now satisfies the contract it is sent under.
    expect(CompanionClassifyInputSchema.safeParse(sent).success).toBe(true);
    // Classified, so the worker gets the card — not the clarify line a 422 used to become.
    expect(turn).toBe(CARD);
    // The edit handler still reads the WHOLE masked message (its contract takes 4000).
    expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, long, CTX, NOW);
    // Memory keeps what the store will read back (it drops any turn over 1000).
    const stored = h.memory.append.mock.calls[0]![1] as { role: string; text: string };
    expect(stored).toEqual({ role: "worker", text: long.slice(0, CLASSIFY_TEXT_MAX) });
    expect(CompanionRecentTurnSchema.safeParse(stored).success).toBe(true);
  });

  it("the cut never splits a surrogate pair", async () => {
    // 999 chars, then an emoji whose two UTF-16 halves straddle the 1000 bound.
    const text = `${"a".repeat(CLASSIFY_TEXT_MAX - 1)}\u{1F527} tail`;
    const h = setup({ pseudo: { pseudonymized_text: text, blocked: false } });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text }, CTX, NOW);
    const sent = (h.ai.companionClassify.mock.calls[0]![0] as { text: string }).text;
    expect(sent).toBe("a".repeat(CLASSIFY_TEXT_MAX - 1));
  });
});

describe("a RETRIED submission (same submission_id) is answered once", () => {
  const SID = "55555555-5555-4555-8555-555555555555";

  it("the retry replays the served turn: one classify, one handler run, one memory pair, one event", async () => {
    const h = setup();
    const dto = { text: "Hindi hata do", submission_id: SID };
    const first = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
    const retry = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);

    expect(retry).toEqual(first);
    expect(h.ai.pseudonymize).toHaveBeenCalledTimes(1);
    expect(h.ai.companionClassify).toHaveBeenCalledTimes(1);
    expect(h.cost.record).toHaveBeenCalledTimes(1);
    expect(h.edits.propose).toHaveBeenCalledTimes(1);
    expect(h.memory.append).toHaveBeenCalledTimes(2); // ONE pair: worker + bada_bhai
    expect(h.events.emit).toHaveBeenCalledTimes(1);
    expect(h.replays.remember).toHaveBeenCalledWith(WORKER, SID, first);
  });

  it("a retried abusive message is ONE strike, not two", async () => {
    const h = setup({ faltuEnabled: true });
    const abusive = { text: "chutiya bhai kya kar raha hai", submission_id: SID };
    const first = await h.orchestrator.handleMessage(WORKER, PROFILE, abusive, CTX, NOW);
    const retry = await h.orchestrator.handleMessage(WORKER, PROFILE, abusive, CTX, NOW);

    expect(retry).toEqual(first);
    expect(h.faltuStore.countStrike).toHaveBeenCalledTimes(1);
    const strikes = h.events.emit.mock.calls.filter(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_faltu_strike",
    );
    expect(strikes).toHaveLength(1);
  });

  it("a DIFFERENT submission is a new message, processed in full", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x", submission_id: SID }, CTX, NOW);
    await h.orchestrator.handleMessage(
      WORKER,
      PROFILE,
      { text: "x", submission_id: "66666666-6666-4666-8666-666666666666" },
      CTX,
      NOW,
    );
    expect(h.ai.companionClassify).toHaveBeenCalledTimes(2);
  });

  it("a FAIL-CLOSED turn is not kept: the gateway was down, the retry reaches the classifier", async () => {
    // The first attempt fails closed because the AI path was unreachable; by the retry it is back.
    const h = setup({ pseudo: null });
    const dto = { text: "Hindi hata do", submission_id: SID };
    const first = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
    expect(first.reply).toBe(V2_CLARIFY.latin);
    expect(h.replays.remember).not.toHaveBeenCalled();

    h.ai.pseudonymize.mockResolvedValue({ pseudonymized_text: "masked text", blocked: false });
    const retry = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
    expect(h.ai.companionClassify).toHaveBeenCalledTimes(1);
    expect(retry).toBe(CARD);
    // The recovered turn IS kept for any further retry.
    expect(h.replays.remember).toHaveBeenCalledWith(WORKER, SID, CARD);
  });

  it("a FAIL-CLOSED turn is not kept: the classifier failed, the retry classifies again", async () => {
    for (const failed of [null, { blocked: true, ai_metadata: null }]) {
      const h = setup({ classify: failed });
      const dto = { text: "Hindi hata do", submission_id: SID };
      const first = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
      expect(first.reply).toBe(V2_CLARIFY.latin);
      expect(h.replays.remember).not.toHaveBeenCalled();

      h.ai.companionClassify.mockResolvedValue({
        intent: "edit_resume",
        confidence: 0.9,
        blocked: false,
      });
      const retry = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
      expect(h.ai.companionClassify).toHaveBeenCalledTimes(2);
      expect(retry).toBe(CARD);
    }
  });

  it("a below-floor `unclear` is NOT fail-closed: the classifier answered, so the turn is kept", async () => {
    const h = setup({ classify: { intent: "edit_resume", confidence: 0.3, blocked: false } });
    const dto = { text: "Hindi hata do", submission_id: SID };
    const first = await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
    expect(h.replays.remember).toHaveBeenCalledWith(WORKER, SID, first);
    await h.orchestrator.handleMessage(WORKER, PROFILE, dto, CTX, NOW);
    expect(h.ai.companionClassify).toHaveBeenCalledTimes(1);
  });

  it("without a submission_id (an older client) there is nothing to key on — no replay read or write", async () => {
    const h = setup();
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: "x" }, CTX, NOW);
    expect(h.replays.read).not.toHaveBeenCalled();
    expect(h.replays.remember).not.toHaveBeenCalled();
  });
});

describe("CompanionV2Orchestrator — AI_RAW_PII_ENABLED (owner decision 2026-09-30, ADR-0047)", () => {
  const RAW = "Tata Motors mein welder tha";

  it("ON: no gateway hop — the classifier, the handler and memory get the worker's own words", async () => {
    const h = setup({ rawPii: true });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(turn).toBe(CARD);
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).toHaveBeenCalledWith({ text: RAW, recent_turns: [] }, CTX);
    expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, RAW, CTX, NOW);
    expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, { role: "worker", text: RAW });
    expect(emitted(h.events).payload).toMatchObject({ intent_source: "llm", outcome: "proposed" });
  });

  it("ON: a gateway that would refuse or is down cannot short-circuit — it is never asked", async () => {
    for (const pseudo of [null, { pseudonymized_text: "", blocked: true }]) {
      const h = setup({ rawPii: true, pseudo });
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
      expect(h.ai.pseudonymize).not.toHaveBeenCalled();
      expect(h.ai.companionClassify).toHaveBeenCalledOnce();
    }
  });

  it("ON: an unreachable classifier still fails closed to the clarify line", async () => {
    const h = setup({ rawPii: true, classify: null });
    const turn = await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(h.edits.propose).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({
      intent_source: "fallback",
      outcome: "clarify",
    });
  });

  it("OFF, explicitly: the gateway runs and only its output travels — the default path exactly", async () => {
    for (const h of [setup({ rawPii: false }), setup()]) {
      await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
      expect(h.ai.pseudonymize).toHaveBeenCalledWith(RAW, CTX);
      expect(h.ai.companionClassify).toHaveBeenCalledWith(
        { text: "masked text", recent_turns: [] },
        CTX,
      );
      expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, "masked text", CTX, NOW);
      expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, {
        role: "worker",
        text: "masked text",
      });
    }
    const blocked = setup({ rawPii: false, pseudo: { pseudonymized_text: "", blocked: true } });
    const turn = await blocked.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(turn.reply).toBe(V2_CLARIFY.latin);
    expect(blocked.ai.companionClassify).not.toHaveBeenCalled();
  });

  it("ON: the classify bound still holds — the classifier and memory get the first 1000 raw chars, the handler all", async () => {
    const long = `${RAW} `.repeat(200).slice(0, 4000);
    expect(long.length).toBe(4000);
    const h = setup({ rawPii: true });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: long }, CTX, NOW);
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    const sent = h.ai.companionClassify.mock.calls[0]![0] as { text: string };
    expect(sent.text).toBe(long.slice(0, CLASSIFY_TEXT_MAX));
    expect(h.edits.propose).toHaveBeenCalledWith(WORKER, PROFILE, long, CTX, NOW);
    expect(h.memory.append).toHaveBeenNthCalledWith(1, WORKER, {
      role: "worker",
      text: long.slice(0, CLASSIFY_TEXT_MAX),
    });
  });

  it("ON: a message the classifier calls faltu is still never stored", async () => {
    const h = setup({ rawPii: true, classify: { intent: "faltu", confidence: 0.9, blocked: false } });
    await h.orchestrator.handleMessage(WORKER, PROFILE, { text: RAW }, CTX, NOW);
    expect(h.ai.companionClassify).toHaveBeenCalledWith({ text: RAW, recent_turns: [] }, CTX);
    expect(h.memory.append).not.toHaveBeenCalled();
  });
});
