import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { FreeChatResumeAction } from "@badabhai/types";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_EDIT_KEY,
  RESUME_MENU_REDO_KEY,
  RESUME_MENU_ROOT_REPLY,
  RESUME_MENU_UPLOAD_KEY,
} from "../../chat/resume-menu";
import type { FreeChatNewsResolution } from "../../profiling/free-chat/free-chat-news";
import { FREE_CHAT_COPY } from "../../profiling/free-chat/free-chat.copy";
import { CompanionTurnSchema } from "../chat-companion.dto";
import type { CompanionResumeDownload } from "../companion-facts";
import { COMPANION_JOBS_TAB_KEY, COMPANION_JOBS_TAB_LABEL } from "../companion-keys";
import {
  RESUME_RENDER_FAILED,
  V2_CLARIFY,
  V2_EDIT_CARD_INTRO,
  V2_FALTU_REDIRECT,
  V3_DOWNLOAD_PENDING,
  V3_DOWNLOAD_READY,
  V3_JOBS,
  V3_NEWS_CAP,
} from "../companion-replies";
import {
  COMPANION_RESUME_DOWNLOAD_KEY,
  COMPANION_RESUME_DOWNLOAD_LABEL,
  RESUME_MENU_FORM_CREATE_KEY,
} from "../companion-v3-keys";
import { CompanionBrain, type BrainInput, type BrainTurn } from "./companion-brain";
import type { CompanionEditService } from "./companion-edit.service";
import { taskChips, v2EditCardTurn } from "./companion-v2-compose";
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
 * THE BADA BHAI CHAT'S FREE-CHAT BRAIN (ADR-0055, #2275) — every dispatch branch, through the REAL
 * handler registry and handlers (only the model calls, the strike store, consent and the résumé
 * read are faked). The model is never asked anything but a category: every answer below is code.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-14T10:00:00.000Z");
const CTX = { correlationId: "corr-1", requestId: "req-1" };
const PROFILE = {
  id: "p1",
  confirmedAt: new Date("2026-10-01T10:00:00.000Z"),
  canonicalTradeId: null,
  experience: { total_years: 5 },
} as never;
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
  task_type: "profiling_free_reply",
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

const verdict = (category: string, confidence = 0.9, language: string | null = null) => ({
  kind: "verdict" as const,
  category,
  confidence,
  language,
});

const answer = (lines: string[], followup_chips: string[] = []) => ({
  status: "answer",
  lines,
  followup_chips,
  ai_metadata: META,
});

interface Setup {
  verdict?: unknown;
  resumeAction?: FreeChatResumeAction | null;
  reply?: unknown;
  news?: FreeChatNewsResolution;
  download?: CompanionResumeDownload;
}

function setup(opts: Setup = {}) {
  const config = {
    CHAT_COMPANION_V2_ENABLED: true,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
    CHAT_COMPANION_V2_FALTU_STRIKES: 3,
    CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES: 30,
  } as unknown as ServerConfig;
  const calls = {
    classifyWithAction: vi.fn(async (..._args: unknown[]) => ({
      verdict: opts.verdict ?? verdict("career"),
      resumeAction: opts.resumeAction ?? null,
    })),
    reply: vi.fn(async (..._args: unknown[]) =>
      opts.reply === undefined ? answer(["Theek hai."]) : opts.reply,
    ),
    requestNews: vi.fn(async (..._args: unknown[]) => opts.news),
  };
  const edits = { propose: vi.fn(async () => ({ turn: CARD, outcome: "proposed" })) };
  const faltuStore = { countStrike: vi.fn(async () => 1), startCooldown: vi.fn(async () => null) };
  const events = { emit: vi.fn(async () => undefined) };
  // The v2 career handler must NEVER be reached on the brain: its model client throws if it is.
  const careerAi = {
    companionCareer: vi.fn(async () => {
      throw new Error("the v2 career handler was reached on the brain");
    }),
  };
  const employers = { isKnownEmployer: vi.fn(async () => true) };
  const registry = new CompanionHandlerRegistry(
    config,
    new EditResumeHandler(edits as unknown as CompanionEditService),
    new NewResumeHandler(config, {
      findLatestByWorker: vi.fn(async () => ({ revokedAt: null, purposes: ["resume_generation"] })),
    } as never),
    new FaltuHandler(config, faltuStore as never, events as never),
    new CareerTalkHandler(
      config,
      careerAi as never,
      { record: vi.fn() } as never,
      events as never,
      employers as never,
    ),
    new JobsDeferredHandler(config),
    new PhaseOffHandler(config),
    new UnclearHandler(config),
  );
  const resumes = { downloadOf: vi.fn(async () => opts.download ?? "ready") };
  // ADR-0055 — the worker's own name, for redaction: the two views of one read.
  const knownName = vi.fn(async () => "Ramesh Yadav");
  const ownName = vi.fn(async () => "Ramesh Yadav");
  const names = { sourcesFor: vi.fn(() => ({ knownName, ownName })) };
  const brain = new CompanionBrain(
    config,
    calls as never,
    registry,
    resumes as never,
    names as never,
  );
  return {
    brain,
    calls,
    edits,
    faltuStore,
    events,
    careerAi,
    employers,
    resumes,
    config,
    names,
    knownName,
    ownName,
  };
}

const input = (text: string, over: Partial<BrainInput> = {}): BrainInput => ({
  workerId: WORKER,
  profile: PROFILE,
  rawText: text,
  promptText: text,
  recentTurns: [
    { role: "worker", text: "namaste" },
    { role: "bada_bhai", text: "Namaste ji" },
  ],
  ctx: CTX,
  now: NOW,
  submissionId: SUBMISSION,
  ...over,
});

const keys = (out: BrainTurn) => out.turn.suggested_options.map((o) => o.option_key);

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("the classifier call — ONE, on the companion surface, with no session", () => {
  it("classifies the gateway text in free mode with the memory as context", async () => {
    const h = setup();
    await h.brain.route(input("welder kaise banun", { promptText: "welder kaise banun (masked)" }));
    expect(h.calls.classifyWithAction).toHaveBeenCalledTimes(1);
    const [req, ctx] = h.calls.classifyWithAction.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown> & { knownName: () => Promise<string | null> },
    ];
    expect(req).toEqual({
      text: "welder kaise banun (masked)",
      mode: "free",
      pendingQuestion: null,
      messages: [
        { role: "worker", text: "namaste" },
        { role: "assistant", text: "Namaste ji" },
      ],
    });
    expect(ctx).toMatchObject({
      workerId: WORKER,
      sessionId: null,
      correlationId: "corr-1",
      requestId: "req-1",
      surface: "companion",
    });
    // ADR-0055: the worker's own name, read once per turn for REDACTION — the knownName view.
    expect(h.names.sourcesFor).toHaveBeenCalledWith(WORKER);
    expect(ctx.knownName).toBe(h.knownName);
  });
});

describe("distress, unclear and the floor", () => {
  it("DISTRESS at ANY confidence (R10): the helpline alone, no chips, read aloud", async () => {
    const h = setup({ verdict: verdict("distress", 0.3) });
    const out = await h.brain.route(input("sab khatam lagta hai"));
    expect(out.turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(out.turn.tts_text).toBe(FREE_CHAT_COPY.DISTRESS.dev);
    expect(out.turn.suggested_options).toEqual([]);
    expect(out).toMatchObject({
      v2Intent: "distress",
      outcome: "served",
      intentSource: "llm",
      confidenceBucket: "lt50",
    });
    expect(out.facts.freeCategory).toBe("distress");
    expect(h.calls.reply).not.toHaveBeenCalled();
  });

  it("a distress message is NEVER remembered — the classifier's verdict, or a distress refusal", async () => {
    const verdicted = await setup({ verdict: verdict("distress", 0.95) }).brain.route(input("x"));
    expect(verdicted.remember).toBe(false);
    const refused = await setup({
      reply: { status: "refuse", topic: "distress", ai_metadata: META },
    }).brain.route(input("x"));
    expect(refused.remember).toBe(false);
    // Any other refusal keeps the pair, as v2 does.
    const legal = await setup({
      reply: { status: "refuse", topic: "legal_medical_financial", ai_metadata: META },
    }).brain.route(input("x"));
    expect(legal.remember).toBe(true);
  });

  it("a TRASH verdict below the floor clarifies — and is still never remembered", async () => {
    const h = setup({ verdict: verdict("trash", 0.4) });
    const out = await h.brain.route(input("bakwas"));
    expect(out.turn.reply).toBe(V2_CLARIFY.latin);
    expect(out).toMatchObject({ outcome: "clarify", v2Intent: "faltu", remember: false });
    // Below the floor no strike is counted: the clarify handler answered, not the faltu one.
    expect(h.faltuStore.countStrike).not.toHaveBeenCalled();
    // Other categories below the floor keep the pair (v2's rule for a clarify).
    expect(
      (await setup({ verdict: verdict("career", 0.4) }).brain.route(input("x"))).remember,
    ).toBe(true);
  });

  it("an UNAVAILABLE classifier is the existing clarify handler, recorded as fail-closed", async () => {
    const h = setup({ verdict: { kind: "unavailable" } });
    const out = await h.brain.route(input("x"));
    expect(out.turn.reply).toBe(V2_CLARIFY.latin);
    expect(out.turn.suggested_options).toEqual(taskChips(h.config));
    expect(out).toMatchObject({
      intentSource: "fallback",
      v2Intent: null,
      confidenceBucket: null,
      outcome: "clarify",
    });
    expect(out.facts).toEqual({
      freeCategory: null,
      resumeAction: null,
      refusalTopic: null,
      replyLanguage: null,
      newsOutcome: null,
      newsSourceCount: 0,
    });
  });

  it("`unclear`, and any category below the 0.6 floor, clarify — the classifier's say still recorded", async () => {
    const unclear = await setup({ verdict: verdict("unclear") }).brain.route(input("x"));
    expect(unclear).toMatchObject({ outcome: "clarify", v2Intent: "unclear" });

    const h = setup({ verdict: verdict("career", 0.55) });
    const low = await h.brain.route(input("x"));
    expect(low.turn.reply).toBe(V2_CLARIFY.latin);
    expect(low).toMatchObject({
      outcome: "clarify",
      v2Intent: "career_talk",
      confidenceBucket: "50_70",
    });
    expect(low.facts.freeCategory).toBe("career");
    expect(h.calls.reply).not.toHaveBeenCalled();
  });
});

describe("the fixed-line categories", () => {
  it("jobs: V3_JOBS and the app-routed 'Sabhi jobs dekhein' chip", async () => {
    const out = await setup({ verdict: verdict("jobs") }).brain.route(
      input("kahin hiring hai kya"),
    );
    expect(out.turn.reply).toBe(V3_JOBS.latin);
    expect(out.turn.tts_text).toBe(V3_JOBS.dev);
    expect(out.turn.suggested_options).toEqual([
      {
        option_key: COMPANION_JOBS_TAB_KEY,
        label_text: COMPANION_JOBS_TAB_LABEL,
        is_none_of_above: false,
      },
    ]);
    expect(out.turn.suggested_followups).toEqual(["Sabhi jobs dekhein"]);
    expect(out).toMatchObject({ v2Intent: "jobs_talk", outcome: "served" });
  });

  it("off_limits: the free chat's OFF_LIMITS line with the open task chips", async () => {
    const h = setup({ verdict: verdict("off_limits") });
    const out = await h.brain.route(input("politics pe baat karo"));
    expect(out.turn.reply).toBe(FREE_CHAT_COPY.OFF_LIMITS.latin);
    expect(out.turn.suggested_options).toEqual(taskChips(h.config));
    expect(out).toMatchObject({ v2Intent: "off_limits", outcome: "served" });
  });

  it("trash: the EXISTING faltu handler (a strike), and the message is never remembered", async () => {
    const h = setup({ verdict: verdict("trash") });
    const out = await h.brain.route(input("bakwas"));
    expect(out.turn.reply).toBe(V2_FALTU_REDIRECT.latin);
    expect(h.faltuStore.countStrike).toHaveBeenCalledWith(WORKER, "2026-10-14");
    expect(out).toMatchObject({ v2Intent: "faltu", remember: false });
  });
});

describe("career / casual — the free chat's reply and gate", () => {
  it("serves the model's lines (₹ ranges and company names ALLOWED), never read aloud", async () => {
    const lines = [
      "Welder ki salary aam taur par 15000 se 20000 hoti hai.",
      "Tata Steel Ltd mein bhi welder lagte hain.",
    ];
    const h = setup({ reply: answer(lines, ["Kaunsa certificate chahiye"]) });
    const out = await h.brain.route(input("welder ki salary kitni hoti hai"));
    expect(out.turn.reply).toBe(lines.join("\n"));
    expect(out.turn.read_aloud).toBe(false);
    expect("tts_text" in out.turn).toBe(false);
    expect(out.turn.suggested_followups).toEqual(["Kaunsa certificate chahiye"]);
    expect(out).toMatchObject({ v2Intent: "career_talk", outcome: "answered", remember: true });
    // NO employer backstop on this path: the career handler's index is never consulted, and the
    // v2 career model is never called.
    expect(h.employers.isKnownEmployer).not.toHaveBeenCalled();
    expect(h.careerAi.companionCareer).not.toHaveBeenCalled();
  });

  it("asks the reply on the companion surface with the profile's closed context and no summary", async () => {
    const h = setup({ verdict: verdict("casual") });
    await h.brain.route(input("kaise ho", { promptText: "kaise ho (masked)" }));
    const [req, ctx] = h.calls.reply.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(req).toMatchObject({
      category: "casual",
      text: "kaise ho (masked)",
      workerContext: { trade_label: null, experience_bucket: "3-7" },
      summary: null,
      replyLanguage: "hinglish",
    });
    expect(ctx).toMatchObject({ sessionId: null, surface: "companion" });
  });

  it("the reply language: an explicit request for THIS reply, else the message's own", async () => {
    const asked = setup({ verdict: verdict("casual") });
    await asked.brain.route(input("marathi mein jawab do, aaj kya karun"));
    expect(asked.calls.reply.mock.calls[0]![0]).toMatchObject({ replyLanguage: "marathi" });

    const labelled = setup({ verdict: verdict("career", 0.9, "tamil") });
    const out = await labelled.brain.route(input("vela kidaikkuma"));
    expect(labelled.calls.reply.mock.calls[0]![0]).toMatchObject({ replyLanguage: "tamil" });
    expect(out.facts.replyLanguage).toBe("tamil");
  });

  it("a FAILED reply (null) and a REJECTED one both serve REPLY_FALLBACK with the task chips", async () => {
    for (const reply of [
      null,
      answer(["Call kariye 9876543210 par."]),
      answer(["Yeh kaam kariye!"]),
    ]) {
      const h = setup({ reply });
      const out = await h.brain.route(input("x"));
      expect(out.turn.reply).toBe(FREE_CHAT_COPY.REPLY_FALLBACK.latin);
      expect(out.turn.suggested_options).toEqual(taskChips(h.config));
      expect(out.outcome).toBe("fallback");
    }
  });

  it("a REFUSAL serves its topic's reviewed line; the helpline carries no chip", async () => {
    const legal = await setup({
      reply: { status: "refuse", topic: "legal_medical_financial", ai_metadata: META },
    }).brain.route(input("loan kaise milega"));
    expect(legal.turn.reply).toBe(FREE_CHAT_COPY.LEGAL_MED_FIN.latin);
    expect(legal).toMatchObject({ outcome: "refused" });
    expect(legal.facts.refusalTopic).toBe("legal_medical_financial");
    expect(legal.turn.suggested_options.length).toBeGreaterThan(0);

    const distress = await setup({
      reply: { status: "refuse", topic: "distress", ai_metadata: META },
    }).brain.route(input("x"));
    expect(distress.turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(distress.turn.suggested_options).toEqual([]);
  });
});

describe("live news (ADR-0054) — the reply's `news` refusal hands over", () => {
  const NEWS_REFUSAL = { status: "refuse", topic: "news", ai_metadata: META };
  const LINKS = [
    {
      title: "New factory in Pune",
      url: "https://www.thehindu.com/news/pune/factory",
      site: "thehindu.com",
    },
  ];

  it("ANSWERED: the gate's lines with their tiles as `news_links`, never read aloud", async () => {
    const h = setup({
      reply: NEWS_REFUSAL,
      news: {
        outcome: "answered",
        kind: "work",
        lines: ["Pune mein ek nayi factory khul rahi hai."],
        links: LINKS,
        searchCount: 1,
        dailyCount: 1,
      },
    });
    const out = await h.brain.route(input("pune mein koi factory khul rahi hai?"));
    expect(out.turn.reply).toBe("Pune mein ek nayi factory khul rahi hai.");
    expect(out.turn.news_links).toEqual(LINKS);
    expect(out.turn.read_aloud).toBe(false);
    expect(out).toMatchObject({ outcome: "answered" });
    expect(out.facts).toMatchObject({
      newsOutcome: "answered",
      newsSourceCount: 1,
      refusalTopic: null,
    });
    // Deduped on the worker and the submission (no session), at the turn's clock.
    const [, ctx, now, submission] = h.calls.requestNews.mock.calls[0]! as unknown as [
      unknown,
      { sessionId: string | null },
      Date,
      string,
    ];
    expect(ctx.sessionId).toBeNull();
    expect(now).toBe(NOW);
    expect(submission).toBe(SUBMISSION);
    expect(CompanionTurnSchema.safeParse(out.turn).success).toBe(true);
  });

  it("CAPPED: the companion's own V3_NEWS_CAP — never the profiling line that offers a résumé", async () => {
    const out = await setup({
      reply: NEWS_REFUSAL,
      news: {
        outcome: "capped",
        line: FREE_CHAT_COPY.NEWS_CAP,
        refusalTopic: null,
        searchCount: null,
        rejection: null,
        dailyCount: 5,
      },
    }).brain.route(input("aaj ki khabar"));
    expect(out.turn.reply).toBe(V3_NEWS_CAP.latin);
    expect(out.turn.reply).not.toBe(FREE_CHAT_COPY.NEWS_CAP.latin);
    expect(out).toMatchObject({ outcome: "served" });
    expect(out.facts).toMatchObject({ newsOutcome: "capped", newsSourceCount: 0 });
    expect("news_links" in out.turn).toBe(false);
  });

  it("every other ending serves its reviewed line; a news refusal records its topic", async () => {
    const unavailable = await setup({
      reply: NEWS_REFUSAL,
      news: {
        outcome: "unavailable",
        line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
        refusalTopic: null,
        searchCount: null,
        rejection: null,
        dailyCount: null,
      },
    }).brain.route(input("aaj ki khabar"));
    expect(unavailable.turn.reply).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE.latin);
    expect(unavailable).toMatchObject({ outcome: "served" });

    const refused = await setup({
      reply: NEWS_REFUSAL,
      news: {
        outcome: "refused",
        line: FREE_CHAT_COPY.OFF_LIMITS,
        refusalTopic: "off_limits",
        searchCount: null,
        rejection: null,
        dailyCount: 1,
      },
    }).brain.route(input("election news"));
    expect(refused.turn.reply).toBe(FREE_CHAT_COPY.OFF_LIMITS.latin);
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused.facts).toMatchObject({ refusalTopic: "off_limits", newsOutcome: "refused" });
  });
});

describe("resume — the classifier's action decides, the existing flows answer", () => {
  it("edit → the EXISTING edit handler: the card, from the gateway text", async () => {
    const h = setup({ verdict: verdict("resume"), resumeAction: "edit" });
    const out = await h.brain.route(
      input("hindi hata do", { promptText: "hindi hata do (masked)" }),
    );
    expect(out.turn).toBe(CARD);
    expect(h.edits.propose).toHaveBeenCalledWith(
      WORKER,
      PROFILE,
      "hindi hata do (masked)",
      CTX,
      NOW,
    );
    expect(out).toMatchObject({ v2Intent: "edit_resume", outcome: "proposed" });
    expect(out.facts).toMatchObject({ freeCategory: "resume", resumeAction: "edit" });
  });

  it("new → the EXISTING new-résumé handler: the redo menu, with the form road on the brain", async () => {
    const out = await setup({ verdict: verdict("resume"), resumeAction: "new" }).brain.route(
      input("naya resume chahiye"),
    );
    expect(keys(out)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_FORM_CREATE_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    expect(out.turn.suggested_followups).toEqual([
      "Resume upload karein",
      "Form se resume banayein",
      "Chat se resume banayein",
    ]);
    expect(out).toMatchObject({ v2Intent: "new_resume", outcome: "served" });
  });

  it("download, READY: V3_DOWNLOAD_READY and the download chip", async () => {
    const out = await setup({ verdict: verdict("resume"), resumeAction: "download" }).brain.route(
      input("resume ka pdf bhejo"),
    );
    expect(out.turn.reply).toBe(V3_DOWNLOAD_READY.latin);
    expect(out.turn.tts_text).toBe(V3_DOWNLOAD_READY.dev);
    expect(out.turn.suggested_options).toEqual([
      {
        option_key: COMPANION_RESUME_DOWNLOAD_KEY,
        label_text: COMPANION_RESUME_DOWNLOAD_LABEL,
        is_none_of_above: false,
      },
    ]);
    expect(out).toMatchObject({ v2Intent: "download_resume", outcome: "served" });
  });

  it("download, BUILDING: the pending line and no chip; UNAVAILABLE: the honest line and no chip", async () => {
    const building = await setup({
      verdict: verdict("resume"),
      resumeAction: "download",
      download: "building",
    }).brain.route(input("pdf chahiye"));
    expect(building.turn.reply).toBe(V3_DOWNLOAD_PENDING.latin);
    expect(building.turn.suggested_options).toEqual([]);

    const unavailable = await setup({
      verdict: verdict("resume"),
      resumeAction: "download",
      download: "unavailable",
    }).brain.route(input("pdf chahiye"));
    expect(unavailable.turn.reply).toBe(RESUME_RENDER_FAILED.latin);
    expect(unavailable.turn.suggested_options).toEqual([]);
  });

  it("no action → the résumé root menu, plus the download chip only when a PDF is ready", async () => {
    const ready = await setup({ verdict: verdict("resume") }).brain.route(
      input("resume ke baare mein"),
    );
    expect(ready.turn.reply).toBe(RESUME_MENU_ROOT_REPLY);
    expect(keys(ready)).toEqual([
      RESUME_MENU_EDIT_KEY,
      RESUME_MENU_REDO_KEY,
      COMPANION_RESUME_DOWNLOAD_KEY,
    ]);
    expect(ready).toMatchObject({ v2Intent: "resume_menu", outcome: "served" });
    expect(ready.facts.resumeAction).toBeNull();

    const building = await setup({ verdict: verdict("resume"), download: "building" }).brain.route(
      input("resume ke baare mein"),
    );
    expect(keys(building)).toEqual([RESUME_MENU_EDIT_KEY, RESUME_MENU_REDO_KEY]);
  });
});

describe("every turn the brain serves passes the strict outbound schema", () => {
  const cases: Array<[string, Setup]> = [
    ["distress", { verdict: verdict("distress") }],
    ["jobs", { verdict: verdict("jobs") }],
    ["off_limits", { verdict: verdict("off_limits") }],
    ["career", { verdict: verdict("career") }],
    ["fallback", { reply: null }],
    ["download", { verdict: verdict("resume"), resumeAction: "download" }],
    ["menu", { verdict: verdict("resume") }],
    ["new", { verdict: verdict("resume"), resumeAction: "new" }],
    ["unclear", { verdict: { kind: "unavailable" } }],
  ];
  it.each(cases)("%s", async (_name, opts) => {
    const out = await setup(opts).brain.route(input("x"));
    expect(CompanionTurnSchema.safeParse(out.turn).success).toBe(true);
  });
});
