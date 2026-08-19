import { describe, it, expect } from "vitest";
import {
  chatSessionDetailSchema,
  chatSessionListItemSchema,
  chatSessionsPageSchema,
  journeyStepSchema,
  workerJourneySummarySchema,
} from "./journey";

/**
 * Response-shape parity with the three WORKER JOURNEY routes (Phase 6).
 *
 *   GET /admin/workers/:id/journey-summary
 *   GET /admin/workers/:id/chat-sessions
 *   GET /admin/chat-sessions/:id
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * `events.schema.test.ts` records the precedent: a schema shape assumed rather than checked
 * blanked the dashboard, and the transport failing closed made it look like an outage rather
 * than a bug. The journey response is far larger and DISCRIMINATED — seven step variants, each
 * with its own extras — so there are seven separate ways to be wrong, and every one of them
 * costs the whole page.
 *
 * ── WHERE THE FIXTURES COME FROM ────────────────────────────────────────────────────────
 * TRANSCRIBED FROM THE SERVER'S OWN CONTRACT, field by field, out of
 * `apps/api/src/admin/admin-worker-journey.dto.ts` and the service that builds it — including
 * the column types behind the ambiguous fields (`profiling_voice_answer.duration_seconds` is
 * `integer`, so a number; `session_ai_cost_totals.total_cost_inr` is `numeric(16,6)`, so a
 * string; `ai_jobs.cost_inr` is `double precision`, so a number). `Date` fields appear as the
 * ISO strings `JSON.stringify` produces on the wire, which is the conversion this side never
 * gets to see and therefore has to be right about.
 *
 * ── AND WHAT IS NOT IN ANY FIXTURE ──────────────────────────────────────────────────────
 * No message body, no transcript, no answer VALUE. Those columns hold the worker's own words
 * unmasked and the API does not serve them. If one ever appears in a payload this portal
 * receives, that is a backend defect to hand back — not a field to add to a schema here.
 */

// ---------------------------------------------------------------------------
// The 7-step funnel
// ---------------------------------------------------------------------------

const STEPS = [
  {
    key: "login",
    order: 1,
    // ALWAYS `done`: a `workers` row cannot exist without a completed OTP verify.
    status: "done",
    completed: 3,
    total: null,
    first_at: "2026-08-01T06:12:00.000Z",
    last_at: "2026-08-18T11:40:00.000Z",
    otp_verified_count: 3,
    test_login_count: 0,
    last_test_login_at: null,
    worker_created_at: "2026-08-01T06:12:00.000Z",
  },
  {
    key: "profiling",
    order: 2,
    status: "in_progress",
    completed: 12,
    total: 18,
    first_at: "2026-08-01T06:20:00.000Z",
    last_at: "2026-08-18T11:52:00.000Z",
    answered_count: 11,
    declined_count: 1,
    unanswered_count: 0,
    session_count: 2,
    packs: [
      { pack_id: "welder_hi", pack_version: 3, item_count: 11, answer_count: 8 },
      { pack_id: "universal_hi", pack_version: 5, item_count: 7, answer_count: 4 },
    ],
  },
  {
    key: "resume",
    order: 3,
    status: "not_done",
    completed: null,
    total: null,
    first_at: null,
    last_at: null,
    has_resume: false,
    resume_count: 0,
    rendered_count: 0,
  },
  {
    key: "profile_confirmed",
    order: 4,
    status: "in_progress",
    completed: null,
    total: null,
    first_at: "2026-08-18T11:55:00.000Z",
    last_at: "2026-08-18T11:58:00.000Z",
    profile_status: "extracted",
    confirmed_at: null,
    profile_count: 1,
  },
  {
    key: "job_search_apply",
    order: 5,
    status: "not_done",
    completed: 0,
    total: null,
    first_at: null,
    last_at: null,
    search_count: 4,
    first_search_at: "2026-08-18T12:10:00.000Z",
    last_search_at: "2026-08-18T12:31:00.000Z",
    applied_count: 0,
    skipped_count: 6,
  },
  {
    key: "photo",
    order: 6,
    status: "not_done",
    completed: null,
    total: null,
    // `workers` carries no per-column timestamp, so the server sends null rather than
    // `updated_at` — which moves for any reason at all.
    first_at: null,
    last_at: null,
    has_photo: false,
  },
  {
    key: "interview_kit",
    order: 7,
    status: "not_done",
    completed: 0,
    total: null,
    first_at: null,
    last_at: null,
    download_count: 0,
    trade_count: 0,
    attribution_available: true,
  },
];

const REAL_JOURNEY = {
  worker_id: "64660d27-091f-4105-accb-cd72eef62c35",
  generated_at: "2026-08-19T10:31:04.000Z",
  steps: STEPS,
  // The service pushes this one on EVERY response; the others are conditional.
  caveats: ["interview_kit_attribution_since_0079"],
};

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

const REAL_SESSION_ROW = {
  id: "0f0b7a2a-2f3a-4d1e-9a1e-2b7c9d4e5f60",
  worker_id: "64660d27-091f-4105-accb-cd72eef62c35",
  status: "abandoned",
  started_at: "2026-08-18T11:40:00.000Z",
  ended_at: null,
  last_message_at: "2026-08-18T11:52:00.000Z",
  idle_seconds: 82_320,
  pack_id: "welder_hi",
  pack_version: 3,
  message_count: 24,
  answer_count: 8,
  abandoned: true,
};

const REAL_SESSIONS_PAGE = { items: [REAL_SESSION_ROW], nextCursor: null };

const REAL_STUCK_CANDIDATE = {
  question_key: "salary_expected",
  asks: 1,
  ask_ceiling: 2,
  max_asks: 2,
  exhausted: false,
  unservable: false,
  engine_advanced_past: false,
  is_mandatory: true,
  is_core: true,
  pack_id: "universal_hi",
  pack_version: 5,
  display_order: 4,
};

const REAL_SESSION_DETAIL = {
  ...REAL_SESSION_ROW,
  answers: [
    {
      question_key: "years_experience",
      status: "answered",
      source: "chat",
      pack_id: "welder_hi",
      pack_version: 3,
      answered_at: "2026-08-18T11:44:00.000Z",
    },
    {
      question_key: "education",
      status: "declined",
      source: "chip",
      pack_id: "universal_hi",
      pack_version: 5,
      answered_at: "2026-08-18T11:49:00.000Z",
    },
  ],
  voice_answers: [
    {
      id: "2b7c9d4e-5f60-4a1e-9a1e-0f0b7a2a2f3a",
      question_key: "years_experience",
      attempt_no: 1,
      ordinal: 2,
      capture_status: "uploaded",
      transcript_status: "failed",
      transcript_error_code: "stt_call_failed",
      duration_seconds: 7,
      superseded_at: "2026-08-18T11:43:30.000Z",
      superseded_by_id: "3c8daf5f-6071-4b2f-8b2f-1a1c8b3b3040",
      purged_at: null,
      has_clip: true,
      pack_id: "welder_hi",
      pack_version: 3,
      created_at: "2026-08-18T11:43:00.000Z",
    },
    {
      id: "3c8daf5f-6071-4b2f-8b2f-1a1c8b3b3040",
      question_key: "years_experience",
      attempt_no: 2,
      ordinal: 2,
      capture_status: "uploaded",
      transcript_status: "succeeded",
      transcript_error_code: null,
      duration_seconds: 9,
      superseded_at: null,
      superseded_by_id: null,
      purged_at: null,
      has_clip: true,
      pack_id: "welder_hi",
      pack_version: 3,
      created_at: "2026-08-18T11:43:40.000Z",
    },
  ],
  ai_jobs: [
    {
      id: "9d4e5f60-0f0b-4a2a-8f3a-2b7c1e9a1e2b",
      job_type: "profile_extraction",
      status: "succeeded",
      model_name: "gemini-2.0-flash",
      real_call: true,
      input_tokens: 1_820,
      output_tokens: 410,
      total_tokens: 2_230,
      // `ai_jobs.cost_inr` is `double precision` — a NUMBER, unlike every other ₹ here.
      cost_inr: 0.184_2,
      has_error: false,
      created_at: "2026-08-18T11:55:00.000Z",
      updated_at: "2026-08-18T11:55:12.000Z",
    },
  ],
  ai_cost: {
    // `session_ai_cost_totals.total_cost_inr` is `numeric(16,6)` — a STRING.
    total_cost_inr: "0.412300",
    call_count: 9,
    real_call_count: 9,
    first_recorded_at: "2026-08-18T11:41:00.000Z",
    updated_at: "2026-08-18T11:55:12.000Z",
  },
  stuck: {
    outcome: "resolved",
    stuck_question: REAL_STUCK_CANDIDATE,
    candidates: [
      REAL_STUCK_CANDIDATE,
      {
        question_key: "language_spoken",
        asks: 1,
        ask_ceiling: 1,
        max_asks: 1,
        exhausted: true,
        unservable: true,
        engine_advanced_past: true,
        is_mandatory: false,
        is_core: false,
        pack_id: "universal_hi",
        pack_version: 5,
        display_order: 9,
      },
    ],
    asked_count: 14,
    settled_count: 8,
    unresolved_count: 0,
  },
  caveats: [],
};

// ---------------------------------------------------------------------------

describe("journey summary — the 7-step funnel", () => {
  it("parses a captured GET /admin/workers/:id/journey-summary payload", () => {
    const parsed = workerJourneySummarySchema.safeParse(REAL_JOURNEY);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("parses all seven steps, each keeping its OWN extras", () => {
    const parsed = workerJourneySummarySchema.parse(REAL_JOURNEY);
    expect(parsed.steps).toHaveLength(7);
    const profiling = parsed.steps.find((s) => s.key === "profiling");
    // The narrowing is the point of the discriminated union: an intersection schema would
    // have made `packs` optional-ish and rendered "undefined" where a denominator belongs.
    expect(profiling?.key === "profiling" && profiling.packs).toHaveLength(2);
  });

  it("REJECTS a step whose extras were dropped — a count would render as undefined", () => {
    const { packs: _omitted, ...profilingWithoutPacks } = STEPS[1] as Record<string, unknown>;
    const wrong = { ...REAL_JOURNEY, steps: [profilingWithoutPacks] };
    expect(workerJourneySummarySchema.safeParse(wrong).success).toBe(false);
  });

  it("REJECTS a step with no `key` — nothing could discriminate it", () => {
    const { key: _omitted, ...keyless } = STEPS[5] as Record<string, unknown>;
    expect(journeyStepSchema.safeParse(keyless).success).toBe(false);
  });

  it("REJECTS a step `status` outside the three the API can emit", () => {
    // The API DTO argues a fourth value out explicitly: no step emits `not_tracked`, and a
    // case the UI must render but can never see is dead code with a live branch.
    const wrong = { ...(STEPS[5] as Record<string, unknown>), status: "not_tracked" };
    expect(journeyStepSchema.safeParse(wrong).success).toBe(false);
  });

  it("ACCEPTS null `completed`/`total` — a missing denominator is not a zero one", () => {
    const parsed = journeyStepSchema.parse(STEPS[2]);
    expect(parsed.completed).toBeNull();
    expect(parsed.total).toBeNull();
  });

  it("REJECTS a summary missing `caveats` — the honest-absence channel is not optional", () => {
    const { caveats: _omitted, ...without } = REAL_JOURNEY;
    expect(workerJourneySummarySchema.safeParse(without).success).toBe(false);
  });

  it("ACCEPTS a caveat code this build has never heard of", () => {
    const parsed = workerJourneySummarySchema.safeParse({
      ...REAL_JOURNEY,
      caveats: ["some_absence_added_later"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("chat sessions — the keyset-paginated list", () => {
  it("parses a captured GET /admin/workers/:id/chat-sessions payload", () => {
    const parsed = chatSessionsPageSchema.safeParse(REAL_SESSIONS_PAGE);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REJECTS a page missing nextCursor — keyset pagination cannot page without it", () => {
    const { nextCursor: _omitted, ...without } = REAL_SESSIONS_PAGE;
    expect(chatSessionsPageSchema.safeParse(without).success).toBe(false);
  });

  it("ACCEPTS idle_seconds: null — the worker never spoke, which is NOT '0s idle'", () => {
    const parsed = chatSessionListItemSchema.parse({
      ...REAL_SESSION_ROW,
      last_message_at: null,
      idle_seconds: null,
    });
    expect(parsed.idle_seconds).toBeNull();
  });

  it("REJECTS a row missing `abandoned` — the sweep's verdict would vanish", () => {
    const { abandoned: _omitted, ...without } = REAL_SESSION_ROW;
    expect(chatSessionListItemSchema.safeParse(without).success).toBe(false);
  });

  it("REJECTS a row missing `answer_count` — the progress number on the row", () => {
    const { answer_count: _omitted, ...without } = REAL_SESSION_ROW;
    expect(chatSessionListItemSchema.safeParse(without).success).toBe(false);
  });
});

describe("chat session detail — GET /admin/chat-sessions/:id", () => {
  it("parses a captured session detail payload", () => {
    const parsed = chatSessionDetailSchema.safeParse(REAL_SESSION_DETAIL);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("REJECTS a detail missing `stuck` — the headline of the whole screen", () => {
    const { stuck: _omitted, ...without } = REAL_SESSION_DETAIL;
    expect(chatSessionDetailSchema.safeParse(without).success).toBe(false);
  });

  it("REJECTS a `stuck` block missing `outcome` — the field that decides whether to name one", () => {
    const { outcome: _omitted, ...stuck } = REAL_SESSION_DETAIL.stuck;
    expect(
      chatSessionDetailSchema.safeParse({ ...REAL_SESSION_DETAIL, stuck }).success,
    ).toBe(false);
  });

  it("ACCEPTS a null stuck_question — every outcome but `resolved` sends one", () => {
    const parsed = chatSessionDetailSchema.safeParse({
      ...REAL_SESSION_DETAIL,
      stuck: {
        ...REAL_SESSION_DETAIL.stuck,
        outcome: "engine_advanced_past_all",
        stuck_question: null,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("ACCEPTS an outcome string this build has never seen — the presenter owns the branch", () => {
    const parsed = chatSessionDetailSchema.safeParse({
      ...REAL_SESSION_DETAIL,
      stuck: { ...REAL_SESSION_DETAIL.stuck, outcome: "a_later_outcome", stuck_question: null },
    });
    expect(parsed.success).toBe(true);
  });

  it("ACCEPTS a three-valued `unservable` including null", () => {
    for (const unservable of [true, false, null]) {
      const parsed = chatSessionDetailSchema.safeParse({
        ...REAL_SESSION_DETAIL,
        stuck: {
          ...REAL_SESSION_DETAIL.stuck,
          stuck_question: { ...REAL_STUCK_CANDIDATE, unservable },
          candidates: [{ ...REAL_STUCK_CANDIDATE, unservable }],
        },
      });
      expect(parsed.success, `unservable: ${String(unservable)}`).toBe(true);
    }
  });

  it("ACCEPTS ai_cost: null — an unmeasured session is not a free one", () => {
    const parsed = chatSessionDetailSchema.parse({ ...REAL_SESSION_DETAIL, ai_cost: null });
    expect(parsed.ai_cost).toBeNull();
  });

  it("REJECTS a session ai_cost whose total is a number — the column is numeric(16,6)", () => {
    const wrong = {
      ...REAL_SESSION_DETAIL,
      ai_cost: { ...REAL_SESSION_DETAIL.ai_cost, total_cost_inr: 0.4123 },
    };
    expect(chatSessionDetailSchema.safeParse(wrong).success).toBe(false);
  });

  it("keeps `ai_jobs.cost_inr` a NUMBER — that column really is double precision", () => {
    // The mirror-image mistake: "tidying" it into a string would assert an exactness the
    // column does not have. A string here must FAIL.
    const wrong = {
      ...REAL_SESSION_DETAIL,
      ai_jobs: [{ ...REAL_SESSION_DETAIL.ai_jobs[0], cost_inr: "0.1842" }],
    };
    expect(chatSessionDetailSchema.safeParse(wrong).success).toBe(false);
  });

  it("keeps the SUPERSEDED voice attempt — it is the evidence of the repeat", () => {
    const parsed = chatSessionDetailSchema.parse(REAL_SESSION_DETAIL);
    const first = parsed.voice_answers.find((v) => v.attempt_no === 1);
    expect(first?.superseded_at).not.toBeNull();
    expect(first?.superseded_by_id).not.toBeNull();
  });

  it("REJECTS a voice attempt missing `transcript_error_code` — why it failed", () => {
    const { transcript_error_code: _omitted, ...row } = REAL_SESSION_DETAIL.voice_answers[0]!;
    const wrong = { ...REAL_SESSION_DETAIL, voice_answers: [row] };
    expect(chatSessionDetailSchema.safeParse(wrong).success).toBe(false);
  });

  it("STRIPS an answer row's VALUE — this surface serves none, and none can reach a view", () => {
    /*
     * Not a hypothetical schema nicety. `worker_pack_answer.answer_text` is the worker's own
     * words; the API's select lists exclude it and a server-side static guard blocks the
     * column.
     *
     * STRIPPED, not rejected — and deliberately so. `.strict()` here would fail the whole read
     * on ANY additive server field, against this repo's open-set convention, and a blank page
     * is a worse outcome than a parsed one with the value dropped. What the assertion pins is
     * that the key cannot survive the parse into a component's props; a later
     * `.passthrough()` would silently undo that, which is the regression worth catching.
     */
    const regressed = {
      ...REAL_SESSION_DETAIL,
      answers: [{ ...REAL_SESSION_DETAIL.answers[0], answer_text: "मैं वेल्डर हूँ" }],
    };
    const parsed = chatSessionDetailSchema.parse(regressed);
    expect(Object.keys(parsed.answers[0]!)).not.toContain("answer_text");
    // The VALUE, not just the key — nothing the worker said survives anywhere in the parse.
    expect(JSON.stringify(parsed)).not.toContain("मैं वेल्डर हूँ");
  });
});
