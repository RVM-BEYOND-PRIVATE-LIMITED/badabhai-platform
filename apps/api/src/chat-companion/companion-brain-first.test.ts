import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_EDIT_REPLY,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_KEY,
  RESUME_SECTIONS,
} from "../chat/resume-menu";
import { FreeChatModelCalls } from "../profiling/free-chat/free-chat-model-calls";
import { FREE_CHAT_COPY } from "../profiling/free-chat/free-chat.copy";
import { ChatCompanionService } from "./chat-companion.service";
import { CompanionTurnSchema, type CompanionTurn } from "./chat-companion.dto";
import {
  COMPANION_JOBS_TAB_KEY,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_JOBS_TAB_LABEL,
} from "./companion-keys";
import { V2_EDIT_CARD_INTRO, V3_GREETING } from "./companion-replies";
import { CompanionResumeStatus } from "./companion-resume-status";
import {
  COMPANION_TASK_CAREER_LABEL,
  COMPANION_TASK_EDIT_RESUME_LABEL,
} from "./companion-task-keys";
import { COMPANION_RESUME_DOWNLOAD_KEY, RESUME_MENU_FORM_CREATE_KEY } from "./companion-v3-keys";
import { CompanionBrain } from "./v2/companion-brain";
import type { CompanionEditService } from "./v2/companion-edit.service";
import { CompanionV2Orchestrator } from "./v2/companion-v2.orchestrator";
import { v2EditCardTurn } from "./v2/companion-v2-compose";
import { CareerTalkHandler } from "./v2/handlers/career-talk.handler";
import { EditResumeHandler } from "./v2/handlers/edit-resume.handler";
import { FaltuHandler } from "./v2/handlers/faltu.handler";
import {
  JobsDeferredHandler,
  PhaseOffHandler,
  UnclearHandler,
} from "./v2/handlers/fixed-line.handlers";
import { NewResumeHandler } from "./v2/handlers/new-resume.handler";
import { CompanionHandlerRegistry } from "./v2/handlers/registry";

/**
 * ADR-0055, ROUND 2 (owner rulings 2026-10-15, "brain first") — the Bada Bhai chat's routing END TO
 * END: the REAL service, orchestrator, brain, free-chat model calls, résumé status and handlers;
 * only the AI client, the stores, the repositories and the spine are faked.
 *
 *   R1 — while the brain is on, WP6's route precedence runs: an edit phrasing goes straight to the
 *        edit handler, and a WEAK v1 alias (résumé word, menu alias, greeting) reaches the brain;
 *   R2 — a TYPED jobs-word message is classified FIRST; jobs / unclear / below the floor / an
 *        unavailable classifier is today's v1 jobs answer and event, everything else the brain's;
 *   R3 — greetings reach the brain;
 *   R4 — the reply (never the classifier) gets the profiling chat's rolling summary.
 *
 * Every example also runs under the KILL SWITCH (`CHAT_FREE_CHAT_DISABLED`), which must be today's
 * flow: v1's answer for a v1 hit, the v2 classifier for a miss, and no free-chat call at all.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const CTX = { requestId: "req-1", correlationId: "33333333-3333-4333-8333-333333333333" };
const NOW = new Date("2026-10-15T10:00:00.000Z");
const JOB = "44444444-4444-4444-8444-444444444444";

const PROFILE = {
  id: "p1",
  profileStatus: "confirmed",
  confirmedAt: new Date("2026-10-01T10:00:00.000Z"),
  source: "form",
  canonicalTradeId: null,
  canonicalRoleId: null,
  skills: ["welding"],
  machines: [],
  experience: { total_years: 5 },
  salaryExpectation: { currency: "INR" },
  locationPreference: { preferred_cities: ["Pune"] },
  availability: { status: "immediate" },
  rawProfile: null,
};

const HISTORY = {
  items: [
    {
      resume_id: "r1",
      profile_id: "p1",
      source: "form",
      trigger: "profile_confirmed",
      generated_at: "2026-10-01T10:05:00.000Z",
      render_status: "rendered",
      rendered_at: "2026-10-01T10:06:00.000Z",
      is_current: true,
      display_ref: "ABC123",
      trade_label: "Welder",
      experience_years: 5,
      machines: [],
      axes: [],
      city: "Pune",
      page_count: 1,
    },
  ],
  pending_update: null,
};

const CARD = v2EditCardTurn(V2_EDIT_CARD_INTRO, {
  proposal_id: "55555555-5555-4555-8555-555555555555",
  expires_at: "2026-10-15T10:10:00.000Z",
  rows: [
    {
      row_id: "66666666-6666-4666-8666-666666666666",
      section_label: "Bhasha",
      op: "add",
      before: null,
      after: "marathi",
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

type Verdict =
  | { category: string; confidence?: number; resume_action?: string | null }
  | "unavailable";

const output = (verdict: Verdict) =>
  verdict === "unavailable"
    ? {
        category: "career",
        confidence: 0.9,
        blocked: false,
        ai_metadata: { ...META, real_call: false },
      }
    : {
        category: verdict.category,
        confidence: verdict.confidence ?? 0.92,
        blocked: false,
        ai_metadata: META,
        language: null,
        resume_action: verdict.resume_action ?? null,
      };

const REPLY_LINE = "Welding ka kaam Tata Steel Ltd jaisi jagah bhi milta hai.";

function setup(opts: { killSwitch?: boolean; verdict?: Verdict; summary?: string | null } = {}) {
  const config = {
    CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS: 7,
    CHAT_COMPANION_NEW_JOBS_COUNT_CAP: 20,
    CHAT_COMPANION_JOB_CHIPS: 3,
    RESUME_UPDATE_PENDING_TIMEOUT_SECONDS: 1_200,
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
    CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED: false,
    CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: 0.6,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
    AI_RAW_PII_ENABLED: true,
    CHAT_FREE_CHAT_DISABLED: opts.killSwitch ?? false,
  } as unknown as ServerConfig;
  const ai = {
    pseudonymize: vi.fn(async (text: string) => ({ pseudonymized_text: text, blocked: false })),
    companionClassify: vi.fn(async () => ({
      intent: "edit_resume",
      confidence: 0.9,
      blocked: false,
    })),
    companionCareer: vi.fn(async () => null),
    freeChatClassify: vi.fn(async (..._args: unknown[]) =>
      output(opts.verdict ?? { category: "casual" }),
    ),
    freeChatReply: vi.fn(async (..._args: unknown[]) => ({
      status: "answer",
      lines: [REPLY_LINE],
      followup_chips: [],
      ai_metadata: META,
    })),
    freeChatNews: vi.fn(async () => null),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const memory = { read: vi.fn(async () => []), append: vi.fn(async () => undefined) };
  const faltuStore = {
    cooldownUntil: vi.fn(async () => null),
    countStrike: vi.fn(async () => 1),
    startCooldown: vi.fn(async () => null),
  };
  const replayed = new Map<string, CompanionTurn>();
  const pending = {
    set: vi.fn(async () => undefined),
    take: vi.fn(async () => null),
    clear: vi.fn(async () => undefined),
  };
  const edits = { propose: vi.fn(async () => ({ turn: CARD, outcome: "proposed" })) };
  const resumes = { history: vi.fn(async () => HISTORY) };
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
  const summaries = {
    latestText: vi.fn(async (_workerId: string) => opts.summary ?? null),
  };
  const brain = new CompanionBrain(
    config,
    new FreeChatModelCalls(
      ai as never,
      cost as never,
      {
        reserve: vi.fn(async () => ({ ok: true, count: 1 })),
        release: vi.fn(async () => undefined),
      } as never,
    ),
    registry,
    new CompanionResumeStatus(config, resumes as never),
    { sourcesFor: () => ({ knownName: async () => null, ownName: async () => null }) } as never,
    summaries as never,
  );
  const orchestrator = new CompanionV2Orchestrator(
    config,
    ai as never,
    memory as never,
    registry,
    events as never,
    cost as never,
    faltuStore as never,
    // An in-memory stand-in for the Redis replay cache, keyed as the store keys it.
    {
      read: vi.fn(async (w: string, s: string) => replayed.get(`${w}:${s}`) ?? null),
      remember: vi.fn(async (w: string, s: string, turn: CompanionTurn) => {
        replayed.set(`${w}:${s}`, turn);
      }),
      claim: vi.fn(async () => "claimed"),
      release: vi.fn(async () => undefined),
    } as never,
    pending as never,
    brain,
  );
  const svc = new ChatCompanionService(
    config,
    { resolve: vi.fn(async () => ({ mode: "companion", profile: PROFILE })) } as never,
    { countApplied: vi.fn(async () => 0) } as never,
    resumes as never,
    { listWantedSkillIds: vi.fn(async () => ["mskill_welding"]) } as never,
    {
      searchOpenPostings: vi.fn(async () => ({
        rows: [{ id: JOB, title: "Welder", city: "Pune" }],
        hasMore: false,
      })),
    } as never,
    events as never,
    { confirm: vi.fn(), cancel: vi.fn(), propose: vi.fn() } as never,
    orchestrator,
  );
  const send = async (text: string): Promise<CompanionTurn> => {
    const result = await svc.message(WORKER, { text, submission_id: SUBMISSION }, CTX, NOW);
    if (result.mode !== "companion") throw new Error("expected companion");
    expect(CompanionTurnSchema.safeParse(result.turn).success).toBe(true);
    return result.turn;
  };
  const eventNames = () =>
    events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
  const v1Intent = () =>
    events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: { intent: string } })
      .find((e) => e.event_name === "chat.companion_turn_served")!.payload.intent;
  const v4 = () =>
    events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "chat.companion_turn_served_v4")!;
  return { svc, ai, events, edits, pending, summaries, send, eventNames, v1Intent, v4 };
}

const keys = (turn: CompanionTurn) => turn.suggested_options.map((o) => o.option_key);

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("R1 — résumé words and menu aliases reach the brain (or the edit handler)", () => {
  it("'skills mein Marathi jod do' → the edit card, straight from the edit pattern (no classifier)", async () => {
    const h = setup();
    expect((await h.send("skills mein Marathi jod do")).edit_proposal).toEqual(CARD.edit_proposal);
    expect(h.edits.propose).toHaveBeenCalledTimes(1);
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(h.v4().payload).toMatchObject({
      intent_source: "v1_deterministic",
      v2_intent: "edit_resume",
    });
  });

  it("a RESENT edit phrasing (same submission_id): one edit parse, one card, the same turn replayed", async () => {
    const h = setup();
    const first = await h.send("skills mein Marathi jod do");
    const second = await h.send("skills mein Marathi jod do");
    expect(h.edits.propose).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.edit_proposal?.proposal_id).toBe(CARD.edit_proposal!.proposal_id);
    // The replayed turn records nothing again: one v4 event for the one turn served.
    expect(h.eventNames()).toEqual(["chat.companion_turn_served_v4"]);
  });

  it("'resume mein welding add karo' → the brain's résumé/edit → the edit card", async () => {
    const h = setup({ verdict: { category: "resume", resume_action: "edit" } });
    expect((await h.send("resume mein welding add karo")).edit_proposal).toEqual(
      CARD.edit_proposal,
    );
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    expect(h.eventNames()).not.toContain("chat.companion_turn_served");
  });

  it("'resume ka pdf bhejo' → the brain's résumé/download → the download chip", async () => {
    const h = setup({ verdict: { category: "resume", resume_action: "download" } });
    const turn = await h.send("resume ka pdf bhejo");
    expect(keys(turn)).toEqual([COMPANION_RESUME_DOWNLOAD_KEY]);
    expect(h.v4().payload).toMatchObject({ v2_intent: "download_resume", free_category: "resume" });
  });

  it("'naya resume banana hai' → the brain's résumé/new → the redo menu WITH the form road", async () => {
    const h = setup({ verdict: { category: "resume", resume_action: "new" } });
    const turn = await h.send("naya resume banana hai");
    expect(keys(turn)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_FORM_CREATE_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
  });

  it("the menu's EXACT chips and the named intents keep their zero-model v1 answers", async () => {
    for (const [text, intent] of [
      [RESUME_MENU_REDO_LABEL, "resume_menu"],
      ["ab tak kya hua", "digest"],
      ["apply kiya?", "applied"],
      ["naukri milegi?", "guarantee"],
      [COMPANION_NEW_JOBS_LABEL, "jobs"],
      [COMPANION_JOBS_TAB_LABEL, "jobs"],
    ] as const) {
      const h = setup();
      await h.send(text);
      expect(h.v1Intent(), text).toBe(intent);
      expect(h.ai.freeChatClassify, text).not.toHaveBeenCalled();
      expect(h.ai.companionClassify, text).not.toHaveBeenCalled();
    }
  });

  it("a task-chip tap leaves the EDIT task pending; career talk is the brain's own (no pending)", async () => {
    const edit = setup();
    await edit.send(COMPANION_TASK_EDIT_RESUME_LABEL);
    expect(edit.pending.set).toHaveBeenCalledWith(WORKER, "edit_resume");
    const career = setup();
    await career.send(COMPANION_TASK_CAREER_LABEL);
    expect(career.pending.set).not.toHaveBeenCalled();
    expect(career.pending.clear).toHaveBeenCalledWith(WORKER);
  });
});

describe("R2 — a typed jobs-word message is classified first", () => {
  it("'job nahi mili, marna hai' → distress (even at low confidence) → the helpline", async () => {
    const h = setup({ verdict: { category: "distress", confidence: 0.3 } });
    const turn = await h.send("job nahi mili, marna hai");
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.suggested_options).toEqual([]);
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    expect(h.eventNames()).toEqual(["chat.companion_turn_served_v4"]);
    expect(h.v4().payload).toMatchObject({ v2_intent: "distress", free_category: "distress" });
  });

  it("'Tata mein welder ki job milti hai?' → career → the model's reply, never read aloud", async () => {
    const h = setup({ verdict: { category: "career" } });
    const turn = await h.send("Tata mein welder ki job milti hai?");
    expect(turn.reply).toBe(REPLY_LINE);
    expect(turn.read_aloud).toBe(false);
    expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    const parsed = EVENT_REGISTRY["chat.companion_turn_served_v4"].payload.safeParse(
      h.v4().payload,
    );
    expect(parsed.success).toBe(true);
  });

  it.each<[string, Verdict]>([
    ["jobs", { category: "jobs" }],
    ["unclear", { category: "unclear" }],
    ["below the floor", { category: "career", confidence: 0.4 }],
    ["trash below the floor", { category: "trash", confidence: 0.4 }],
    ["an unavailable classifier", "unavailable"],
  ])(
    "'job chahiye' classified %s → TODAY's v1 jobs answer and event, byte for byte",
    async (_why, verdict) => {
      const brain = setup({ verdict });
      const turn = await brain.send("job chahiye");
      const today = setup({ killSwitch: true });
      expect(turn).toEqual(await today.send("job chahiye"));
      expect(keys(turn)).toContain(`companion_job:${JOB}`);
      expect(keys(turn)).toContain(COMPANION_JOBS_TAB_KEY);
      // ONE classify, and the deferred turn records v1's own event only.
      expect(brain.ai.freeChatClassify).toHaveBeenCalledTimes(1);
      expect(brain.eventNames()).toEqual(["chat.companion_turn_served"]);
      expect(brain.v1Intent()).toBe("jobs");
    },
  );

  it("the jobs CHIPS are exact taps: never classified", async () => {
    const h = setup({ verdict: { category: "career" } });
    await h.send(COMPANION_NEW_JOBS_LABEL);
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
  });
});

describe("R3 as amended (#2287) — a BARE greeting gets the fixed line; status gets the recap", () => {
  it.each([
    "hello",
    "Namaste ji",
    "hi bada bhai",
    "good morning sir",
    "🙏 namaste",
    "ram ram",
    "नमस्ते जी",
  ])("%j → V3_GREETING with the clarify line's chips, and NO model call", async (text) => {
    const h = setup({ verdict: { category: "casual" } });
    const turn = await h.send(text);
    expect(turn.reply).toBe(V3_GREETING.latin);
    expect(turn.tts_text).toBe(V3_GREETING.dev);
    // The very chips the clarify line carries.
    const clarify = await setup({ verdict: "unavailable" }).send("kuch to gadbad hai");
    expect(turn.suggested_options).toEqual(clarify.suggested_options);
    expect(turn.suggested_options.length).toBeGreaterThan(0);
    // Zero model calls: no gateway, no classifier, no reply.
    expect(h.ai.pseudonymize).not.toHaveBeenCalled();
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(h.ai.freeChatReply).not.toHaveBeenCalled();
    expect(h.ai.companionClassify).not.toHaveBeenCalled();
    // Recorded as a deterministic route on the v4 event, which parses.
    expect(h.eventNames()).toEqual(["chat.companion_turn_served_v4"]);
    expect(h.v4().payload).toMatchObject({
      intent_source: "v1_deterministic",
      v2_intent: "casual",
      outcome: "served",
      free_category: null,
      confidence_bucket: null,
    });
    const parsed = EVENT_REGISTRY["chat.companion_turn_served_v4"].payload.safeParse(
      h.v4().payload,
    );
    expect(parsed.success).toBe(true);
  });

  it.each(["hello, welder ki salary kitni hai", "namaste bada bhai kaise ho aap"])(
    "%j — a greeting WITH content still reaches the brain",
    async (text) => {
      const h = setup({ verdict: { category: "career" } });
      const turn = await h.send(text);
      expect(turn.reply).toBe(REPLY_LINE);
      expect(h.ai.freeChatClassify).toHaveBeenCalledTimes(1);
    },
  );

  it("'status' → v1's recap again, with no model call", async () => {
    const h = setup({ verdict: { category: "casual" } });
    await h.send("status");
    expect(h.v1Intent()).toBe("digest");
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it("a bare greeting leaves a pending task intent for the next message", async () => {
    const h = setup();
    await h.send("hello");
    expect(h.pending.take).not.toHaveBeenCalled();
  });

  it("REPLAY-SAFE BY DETERMINISM: a resent greeting is the same turn, on one event key", async () => {
    const h = setup();
    const first = await h.send("namaste");
    const second = await h.send("namaste");
    expect(second).toEqual(first);
    const keys = h.events.emit.mock.calls.map(
      (c) => (c[0] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      `chat.companion_turn_served_v4:message:${WORKER}:${SUBMISSION}`,
      `chat.companion_turn_served_v4:message:${WORKER}:${SUBMISSION}`,
    ]);
  });
});

describe("R4 — the reply gets the rolling summary; the classifier never does", () => {
  it("passes the stored summary to the reply only", async () => {
    const h = setup({
      verdict: { category: "career" },
      summary: "- Welder, 5 saal, Pune mein kaam chahta hai",
    });
    await h.send("welder ki salary kitni hai");
    expect(h.summaries.latestText).toHaveBeenCalledWith(WORKER);
    expect(h.ai.freeChatReply.mock.calls[0]![0]).toMatchObject({
      summary: "- Welder, 5 saal, Pune mein kaam chahta hai",
    });
    expect("summary" in (h.ai.freeChatClassify.mock.calls[0]![0] as object)).toBe(false);
  });

  it("no summary (or an unreadable one) is a reply with summary null", async () => {
    const h = setup({ verdict: { category: "casual" }, summary: null });
    await h.send("kaise ho");
    expect(h.ai.freeChatReply.mock.calls[0]![0]).toMatchObject({ summary: null });
  });

  it("a fixed-line answer never reads it", async () => {
    const h = setup({ verdict: { category: "off_limits" } });
    await h.send("politics pe baat karo");
    expect(h.summaries.latestText).not.toHaveBeenCalled();
  });
});

describe("#2295 — a GENERIC edit request gets the edit section menu, with no model call", () => {
  it.each([
    "resume edit karein",
    "mera resume update karna hai",
    "resume badalna hai",
    "edit my resume",
  ])(
    "%j → the edit section menu on v1's resume_menu event: no classifier, no edit parse",
    async (text) => {
      const h = setup();
      const turn = await h.send(text);
      expect(turn.reply).toBe(RESUME_MENU_EDIT_REPLY);
      expect(keys(turn)).toEqual(RESUME_SECTIONS.map((section) => section.key));
      expect(h.edits.propose).not.toHaveBeenCalled();
      expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
      expect(h.ai.companionClassify).not.toHaveBeenCalled();
      expect(h.eventNames()).toEqual(["chat.companion_turn_served"]);
      expect(h.v1Intent()).toBe("resume_menu");
    },
  );

  it("consumes no pending intent and clears a stale one, as the menu's edit chip would", async () => {
    const h = setup();
    await h.send("resume edit karein");
    expect(h.pending.take).not.toHaveBeenCalled();
    expect(h.pending.clear).toHaveBeenCalledWith(WORKER);
  });

  it("a CONCRETE change beside the generic ask still goes straight to the edit handler", async () => {
    const h = setup();
    const turn = await h.send("resume mein salary 25000 kar do");
    expect(turn.edit_proposal).toEqual(CARD.edit_proposal);
    expect(h.edits.propose).toHaveBeenCalledTimes(1);
  });
});

describe("the KILL SWITCH — every example is today's flow", () => {
  it.each([
    ["resume edit karein", "resume_menu"],
    ["resume badalna hai", "resume_menu"],
    ["resume mein welding add karo", "digest"],
    ["resume ka pdf bhejo", "digest"],
    ["naya resume banana hai", "resume_menu"],
    ["job nahi mili, marna hai", "jobs"],
    ["Tata mein welder ki job milti hai?", "jobs"],
    ["job chahiye", "jobs"],
    ["hello", "digest"],
    ["namaste", "digest"],
    ["status", "digest"],
  ] as const)("%j → v1's %s answer, with no free-chat call", async (text, intent) => {
    const h = setup({ killSwitch: true });
    const turn = await h.send(text);
    expect(h.v1Intent()).toBe(intent);
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    expect(h.pending.take).not.toHaveBeenCalled();
    if (intent === "resume_menu") expect(keys(turn)).not.toContain(RESUME_MENU_FORM_CREATE_KEY);
  });

  it("an edit phrasing v1 misses goes to TODAY's v2 classifier, not straight to the edit handler", async () => {
    const h = setup({ killSwitch: true });
    expect((await h.send("skills mein Marathi jod do")).edit_proposal).toEqual(CARD.edit_proposal);
    expect(h.ai.companionClassify).toHaveBeenCalledTimes(1);
    expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
  });

  it.each(["hello", "Namaste ji", "good morning sir", "🙏 namaste"])(
    "%j never gets the fixed greeting line — no free-chat call either",
    async (text) => {
      const h = setup({ killSwitch: true });
      const turn = await h.send(text);
      expect(turn.reply).not.toBe(V3_GREETING.latin);
      expect(h.ai.freeChatClassify).not.toHaveBeenCalled();
    },
  );

  it("a career task-chip tap still sets no pending intent (the flag is off)", async () => {
    const h = setup({ killSwitch: true });
    await h.send(COMPANION_TASK_CAREER_LABEL);
    expect(h.pending.set).not.toHaveBeenCalled();
  });
});
