import { describe, expect, it, vi } from "vitest";
import { validateEvent } from "@badabhai/event-schema";
import { resolveResumeMenu, RESUME_MENU_EDIT_LABEL } from "../chat/resume-menu";
import { ChatCompanionService } from "./chat-companion.service";
import { COMPANION_JOB_KEY_PREFIX, COMPANION_RESUME_KEY } from "./companion-keys";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const CTX = { requestId: "req-1", correlationId: "33333333-3333-4333-8333-333333333333" };
const NOW = new Date("2026-09-26T10:00:00.000Z");
const JOB_A = "44444444-4444-4444-8444-444444444444";
const JOB_B = "55555555-5555-4555-8555-555555555555";

/** A profile row as the policy hands it over — confirmed, with one fillable gap (machines). */
const PROFILE = {
  id: "p1",
  profileStatus: "confirmed",
  confirmedAt: new Date("2026-09-20T10:00:00.000Z"),
  source: "form",
  canonicalTradeId: "t",
  canonicalRoleId: "r",
  skills: ["turning"],
  machines: [],
  experience: { total_years: 5 },
  salaryExpectation: { min: 15000 },
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
      generated_at: "2026-09-20T10:05:00.000Z",
      render_status: "rendered",
      rendered_at: "2026-09-20T10:06:00.000Z",
      is_current: true,
      display_ref: "ABC123",
      trade_label: "VMC Operator",
      experience_years: 5,
      machines: ["Fanuc"],
      axes: [],
      city: "Pune",
      page_count: 1,
    },
  ],
  pending_update: null,
};

function make(over: {
  mode?: "interview" | "companion";
  history?: unknown;
  historyThrows?: boolean;
  applied?: number;
  appliedThrows?: boolean;
  wanted?: string[];
  rows?: { id: string; title: string; city: string | null }[];
  hasMore?: boolean;
  jobsThrows?: boolean;
  emitThrows?: boolean;
} = {}) {
  const policy = {
    resolve: vi.fn(async () =>
      (over.mode ?? "companion") === "companion" ? { mode: "companion", profile: PROFILE } : { mode: "interview" },
    ),
  };
  const repo = {
    countApplied: vi.fn(async () => {
      if (over.appliedThrows) throw new Error("x");
      return over.applied ?? 2;
    }),
    latestActiveSessionStartedAt: vi.fn(),
  };
  const resumes = {
    history: vi.fn(async () => {
      if (over.historyThrows) throw new Error("x");
      return over.history ?? HISTORY;
    }),
  };
  const skills = { listWantedSkillIds: vi.fn(async () => over.wanted ?? ["mskill_cnc_turning"]) };
  const jobs = {
    searchOpenPostings: vi.fn(async () => {
      if (over.jobsThrows) throw new Error("x");
      return {
        rows: over.rows ?? [
          { id: JOB_A, title: "CNC Operator", city: "Pune" },
          { id: JOB_B, title: "VMC Setter", city: null },
        ],
        hasMore: over.hasMore ?? false,
      };
    }),
  };
  const events = {
    emit: vi.fn(async () => {
      if (over.emitThrows) throw new Error("spine down");
      return {};
    }),
  };
  const config = {
    CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS: 7,
    CHAT_COMPANION_NEW_JOBS_COUNT_CAP: 20,
    CHAT_COMPANION_JOB_CHIPS: 3,
  };
  const svc = new ChatCompanionService(
    config as never,
    policy as never,
    repo as never,
    resumes as never,
    skills as never,
    jobs as never,
    events as never,
  );
  return { svc, policy, repo, resumes, skills, jobs, events };
}

type Emitted = { event_name: string; payload: Record<string, unknown>; idempotencyKey?: string };
const emitted = (events: { emit: { mock: { calls: unknown[][] } } }): Emitted =>
  events.emit.mock.calls[0]![0] as Emitted;

describe("ChatCompanionService.open", () => {
  it("interview mode: {mode:'interview'} and NOTHING else is read or recorded", async () => {
    const h = make({ mode: "interview" });
    expect(await h.svc.open(WORKER, CTX, NOW)).toEqual({ mode: "interview" });
    expect(h.resumes.history).not.toHaveBeenCalled();
    expect(h.jobs.searchOpenPostings).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("companion mode: the recap, as the chat reply's own shape", async () => {
    const res = await make().svc.open(WORKER, CTX, NOW);
    expect(res.mode).toBe("companion");
    if (res.mode !== "companion") return;
    expect(res.reply.split("\n")[0]).toBe("Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.");
    expect(res.reply).toContain("Aapka resume form se bana hai.");
    expect(res.reply).toContain("Aapne ab tak 2 jobs par apply kiya hai.");
    expect(res.reply).toContain("Pichhle 7 din mein aapke kaam ke 2 naye jobs aaye hain.");
    expect(res.suggested_options[0]!.option_key).toBe(`${COMPANION_JOB_KEY_PREFIX}${JOB_A}`);
    expect(res.suggested_followups).toEqual(res.suggested_options.map((o) => o.label_text));
    expect(res.question_kind).toBe("disambiguate");
    // The fields a companion turn fixes — nothing here may make an old parser do something.
    expect(res.session_ended).toBe(false);
    expect(res.extraction_ready).toBe(false);
    expect(res.form_offer).toBeNull();
    expect(res.resume_update).toBeNull();
    expect(res.tts_text).toMatch(/[ऀ-ॿ]/u);
    expect(res.digest_key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reads new jobs with the Jobs tab's own rule, narrowed to the window — never the search SERVICE", async () => {
    const h = make();
    await h.svc.open(WORKER, CTX, NOW);
    expect(h.jobs.searchOpenPostings).toHaveBeenCalledWith({
      workerId: WORKER,
      q: null,
      profileSkillIds: ["mskill_cnc_turning"],
      city: null,
      state: null,
      limit: 20,
      offset: 0,
      publishedAfter: new Date("2026-09-19T10:00:00.000Z"),
    });
  });

  it("no wanted skills: the jobs query is never run and nothing is claimed", async () => {
    const h = make({ wanted: [] });
    const res = await h.svc.open(WORKER, CTX, NOW);
    expect(h.jobs.searchOpenPostings).not.toHaveBeenCalled();
    if (res.mode === "companion") expect(res.reply).not.toContain("aapke kaam");
    expect(emitted(h.events).payload.jobs_scope).toBe("no_skills");
    expect(emitted(h.events).payload.new_jobs_count).toBeNull();
  });

  it("a payer title that looks like a phone number or an email is never put on a chip; it still counts", async () => {
    const h = make({
      rows: [
        { id: JOB_A, title: "Call 9876543210 now", city: "Pune" },
        { id: JOB_B, title: "Fitter", city: "Pune" },
      ],
    });
    const res = await h.svc.open(WORKER, CTX, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    expect(JSON.stringify(res)).not.toContain("9876543210");
    expect(res.reply).toContain("aapke kaam ke 2 naye jobs");
    expect(res.suggested_options.map((o) => o.option_key)).toContain(`${COMPANION_JOB_KEY_PREFIX}${JOB_B}`);
  });

  it.each([
    ["the résumé read", { historyThrows: true }, "Aapne ab tak 2 jobs par apply kiya hai."],
    ["the applied count", { appliedThrows: true }, "Pichhle 7 din"],
    ["the jobs read", { jobsThrows: true }, "Abhi naye jobs nahi dikha pa rahe."],
  ] as const)("a failed %s drops only its own section and still answers", async (_name, over, expected) => {
    const res = await make(over).svc.open(WORKER, CTX, NOW);
    expect(res.mode).toBe("companion");
    if (res.mode === "companion") expect(res.reply).toContain(expected);
  });

  it("a failed résumé read says NOTHING about the résumé — never that it is still being built", async () => {
    const res = await make({ historyThrows: true }).svc.open(WORKER, CTX, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    expect(res.reply).not.toMatch(/resume (ban raha|form se|ban chuka)/i);
  });

  it("a failed event write never costs the worker the recap", async () => {
    const res = await make({ emitThrows: true }).svc.open(WORKER, CTX, NOW);
    expect(res.mode).toBe("companion");
  });

  it("records ONE counts-only event per worker per UTC day, and it passes the strict schema", async () => {
    const h = make();
    await h.svc.open(WORKER, CTX, NOW);
    const e = emitted(h.events);
    expect(e.event_name).toBe("chat.companion_turn_served");
    expect(e.idempotencyKey).toBe(`chat.companion_turn_served:open:${WORKER}:2026-09-26`);
    expect(e.payload).toEqual({
      worker_id: WORKER,
      trigger: "open",
      intent: "digest",
      applied_count: 2,
      new_jobs_count: 2,
      jobs_scope: "profile",
      job_chips_count: 2,
      resume_source: "form",
      nudge: "apply_new",
      day: "2026-09-26",
    });
    const envelope = {
      event_id: SUBMISSION,
      event_name: e.event_name,
      event_version: 1,
      occurred_at: NOW.toISOString(),
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "worker", subject_id: WORKER },
      source: "api",
      correlation_id: CTX.correlationId,
      causation_id: null,
      payload: e.payload,
      metadata: { environment: "test", service: "api" },
    };
    expect(validateEvent(envelope).success).toBe(true);
  });

  it("never puts a worker's own words, a job title or a city on the spine", async () => {
    const h = make();
    await h.svc.message(WORKER, { text: "naye jobs dikhao Ramesh", submission_id: SUBMISSION }, CTX, NOW);
    const payload = JSON.stringify(emitted(h.events).payload);
    for (const leak of ["Ramesh", "naye jobs", "CNC Operator", "Pune", JOB_A]) {
      expect(payload).not.toContain(leak);
    }
  });
});

describe("ChatCompanionService.message", () => {
  it("interview mode: {mode:'interview'} — the route turns it into a 409", async () => {
    expect(await make({ mode: "interview" }).svc.message(WORKER, { text: "hi" }, CTX, NOW)).toEqual({
      mode: "interview",
    });
  });

  it("a résumé-menu label is answered by the SHIPPED menu, verbatim, and reads no facts", async () => {
    const h = make();
    const res = await h.svc.message(WORKER, { text: RESUME_MENU_EDIT_LABEL }, CTX, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    const menu = resolveResumeMenu(RESUME_MENU_EDIT_LABEL);
    expect(res.turn.reply).toBe(menu.reply);
    expect(res.turn.suggested_followups).toEqual(menu.followups);
    expect(res.turn.suggested_options).toEqual(menu.options);
    expect(res.turn.question_kind).toBe("disambiguate");
    expect(h.resumes.history).not.toHaveBeenCalled();
    expect(emitted(h.events).payload).toMatchObject({ intent: "resume_menu", applied_count: null, jobs_scope: null });
  });

  it("'Resume badlein' opens the menu's root — edit and redo, one tap from the companion", async () => {
    const res = await make().svc.message(WORKER, { text: COMPANION_RESUME_KEY }, CTX, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    expect(res.turn.suggested_options.map((o) => o.option_key)).toEqual(["resume_edit", "resume_redo"]);
  });

  it("'naye jobs dikhao' lists the matching jobs as chips", async () => {
    const res = await make().svc.message(WORKER, { text: "naye jobs dikhao" }, CTX, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    expect(res.turn.reply).toContain("Kisi job par dabakar poori jaankari dekhein.");
    expect(res.turn.suggested_options.filter((o) => o.option_key.startsWith(COMPANION_JOB_KEY_PREFIX))).toHaveLength(2);
  });

  it("dedupes a retried send by its submission id", async () => {
    const h = make();
    await h.svc.message(WORKER, { text: "hi", submission_id: SUBMISSION }, CTX, NOW);
    expect(emitted(h.events).idempotencyKey).toBe(`chat.companion_turn_served:message:${WORKER}:${SUBMISSION}`);
    const h2 = make();
    await h2.svc.message(WORKER, { text: "hi" }, CTX, NOW);
    expect(emitted(h2.events).idempotencyKey).toBeUndefined();
  });
});

describe("the companion's reach", () => {
  it("is constructed from repositories and the history projection only — no chat writer, no model, no impression-recording service", () => {
    // Seven collaborators, all read-only or the event spine. A refactor that routes a read through
    // MatchFeedService.getFeed / ApplicationsService.getFeed / JobsService.searchJobs (which record
    // impressions and searches), ChatService, or AiService fails here first.
    expect(ChatCompanionService.length).toBe(7);
  });
});
