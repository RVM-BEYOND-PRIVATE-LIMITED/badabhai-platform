import { describe, it, expect } from "vitest";
import type { JourneyStep, SessionStuck, SessionVoiceAnswer, StuckCandidate } from "./journey";
import {
  describeJourneyCaveat,
  describeStepDetail,
  describeStepProgress,
  describeStuck,
  describeVoiceAttempt,
  stepStatusLabel,
  stepTitle,
  stepTone,
  summariseVoiceAttempts,
  transcriptErrorLabel,
} from "./journey-view";

/**
 * How a worker's journey is allowed to be DESCRIBED.
 *
 * ══ THE ASSERTION THIS FILE EXISTS FOR ═════════════════════════════════════════════════
 * `describeStuck` names a question ONLY when the server said `resolved` AND sent one. Every
 * other outcome — above all `engine_advanced_past_all`, which is the MODAL shape for a session
 * that finished cleanly — must render an explanation and NO question. Naming the top candidate
 * there would accuse a question the worker met on their way to COMPLETING the interview, and it
 * would do it on most sessions, which is exactly the class of confidently-wrong output an
 * operations console must not produce.
 */

const CANDIDATE: StuckCandidate = {
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

const ADVANCED_PAST: StuckCandidate = {
  ...CANDIDATE,
  question_key: "language_spoken",
  engine_advanced_past: true,
  unservable: true,
  exhausted: true,
  asks: 1,
  ask_ceiling: 1,
  max_asks: 1,
  is_mandatory: false,
  is_core: false,
};

function stuck(overrides: Partial<SessionStuck>): SessionStuck {
  return {
    outcome: "resolved",
    stuck_question: CANDIDATE,
    candidates: [CANDIDATE],
    asked_count: 14,
    settled_count: 8,
    unresolved_count: 0,
    ...overrides,
  };
}

describe("describeStuck — a question is NAMED only when the server named one", () => {
  it("names it on `resolved`, with the ask pressure and the servability", () => {
    const view = describeStuck(stuck({}));
    expect(view.question).toEqual(CANDIDATE);
    expect(view.tone).toBe("warn");
    expect(view.headline).toContain("salary_expected");
    // asks vs. ceiling, and whether the engine could have served it again — the two facts
    // that separate "still on screen" from "burned its budget and was abandoned".
    expect(view.body).toContain("1 of a maximum 2");
    expect(view.body).toContain("could still have served it again");
  });

  it("`engine_advanced_past_all` NAMES NOTHING — the interview had already closed", () => {
    /*
     * THE REGRESSION THIS FILE GUARDS. A `close` decision carries `questionKey: null`, which
     * differs from whatever was on screen, so the orchestrator records `unanswered` for it —
     * making this the shape of EVERY cleanly-finished session that left a question unsettled.
     */
    const view = describeStuck(
      stuck({
        outcome: "engine_advanced_past_all",
        stuck_question: null,
        candidates: [ADVANCED_PAST],
      }),
    );
    expect(view.question).toBeNull();
    expect(view.tone).not.toBe("warn");
    expect(view.headline.toLowerCase()).toContain("no question was on screen");
    // Not merely absent from `question` — absent from the words too, so no reader can take
    // the headline as an accusation against a specific key.
    expect(view.headline).not.toContain(ADVANCED_PAST.question_key);
    // The candidates are still worth listing: they are what this worker never settled.
    expect(view.candidatesTitle).not.toBeNull();
  });

  it("`all_settled` names nothing and reads as clean", () => {
    const view = describeStuck(
      stuck({ outcome: "all_settled", stuck_question: null, candidates: [] }),
    );
    expect(view.question).toBeNull();
    expect(view.candidatesTitle).toBeNull();
    expect(view.tone).toBe("muted");
  });

  it("`no_conversation_state` and `no_asks_recorded` name nothing", () => {
    for (const outcome of ["no_conversation_state", "no_asks_recorded"]) {
      const view = describeStuck(
        stuck({ outcome, stuck_question: null, candidates: [] }),
      );
      expect(view.question, outcome).toBeNull();
      expect(view.candidatesTitle, outcome).toBeNull();
    }
  });

  it("an UNKNOWN outcome names nothing — guessing would mean inventing the meaning", () => {
    const view = describeStuck(
      stuck({ outcome: "an_outcome_from_a_later_build", stuck_question: null }),
    );
    expect(view.question).toBeNull();
    expect(view.headline.toLowerCase()).toContain("not recognised");
    expect(view.body).toContain("an_outcome_from_a_later_build");
  });

  it("`resolved` with NO question is reported as a gap, not papered over", () => {
    // The server contradicting itself. Promoting the top candidate here would be this portal
    // inventing the answer the server failed to give.
    const view = describeStuck(stuck({ stuck_question: null }));
    expect(view.question).toBeNull();
    expect(view.headline.toLowerCase()).toContain("no stuck question");
    expect(view.body.toLowerCase()).toContain("gap");
  });

  it("reports how far the engine got, on every outcome", () => {
    for (const outcome of ["resolved", "engine_advanced_past_all", "all_settled", "weird"]) {
      const view = describeStuck(stuck({ outcome, stuck_question: null }));
      expect(view.progress, outcome).toContain("14");
      expect(view.progress, outcome).toContain("8");
    }
  });

  it("describes an UNKNOWN servability as unknown, never as fine", () => {
    const view = describeStuck(
      stuck({ stuck_question: { ...CANDIDATE, unservable: null } }),
    );
    expect(view.body).toContain("unknown");
  });
});

describe("step presentation — every step renders, `not_done` included", () => {
  const photo: JourneyStep = {
    key: "photo",
    order: 6,
    status: "not_done",
    completed: null,
    total: null,
    first_at: null,
    last_at: null,
    has_photo: false,
  };

  it("`not_done` is MUTED, not bad — a funnel is not seven failures", () => {
    expect(stepTone("not_done")).toBe("muted");
    expect(stepTone("in_progress")).toBe("warn");
    expect(stepTone("done")).toBe("ok");
    expect(stepStatusLabel("not_done")).toBe("not done");
  });

  it("titles every one of the seven step keys", () => {
    const keys: JourneyStep["key"][] = [
      "login",
      "profiling",
      "resume",
      "profile_confirmed",
      "job_search_apply",
      "photo",
      "interview_kit",
    ];
    for (const key of keys) expect(stepTitle(key), key).toBeTruthy();
  });

  it("renders a denominator ONLY when the server sent one", () => {
    const withTotal: JourneyStep = {
      key: "profiling",
      order: 2,
      status: "in_progress",
      completed: 12,
      total: 18,
      first_at: null,
      last_at: null,
      answered_count: 11,
      declined_count: 1,
      unanswered_count: 0,
      session_count: 2,
      packs: [],
    };
    expect(describeStepProgress(withTotal)).toBe("12 of 18 questions settled");

    // `total: null` means the denominator could not be established. "12 of 0" is not a
    // progress reading — it is a missing denominator wearing one.
    const withoutTotal = { ...withTotal, total: null };
    const text = describeStepProgress(withoutTotal);
    expect(text).toBe("12 questions settled");
    expect(text).not.toContain(" of ");
  });

  it("keeps a test mint out of the real sign-in count", () => {
    const login: JourneyStep = {
      key: "login",
      order: 1,
      status: "done",
      completed: 0,
      total: null,
      first_at: null,
      last_at: null,
      otp_verified_count: 0,
      test_login_count: 2,
      last_test_login_at: "2026-08-18T11:40:00.000Z",
      worker_created_at: "2026-08-01T06:12:00.000Z",
    };
    expect(describeStepProgress(login)).toBe("0 verified sign-ins");
    expect(describeStepDetail(login).join(" ")).toContain("not real logins");
  });

  it("says a pack version was retired instead of showing a shrunken denominator", () => {
    const profiling: JourneyStep = {
      key: "profiling",
      order: 2,
      status: "in_progress",
      completed: 4,
      total: null,
      first_at: null,
      last_at: null,
      answered_count: 4,
      declined_count: 0,
      unanswered_count: 0,
      session_count: 1,
      packs: [{ pack_id: "welder_hi", pack_version: 2, item_count: 0, answer_count: 4 }],
    };
    expect(describeStepDetail(profiling).join(" ")).toContain("pack version retired");
  });

  /**
   * ⚠ THE PER-PACK CHIP MUST NOT READ AS PROGRESS — it is the one number on this screen that
   * can contradict the headline beside it.
   *
   * `packs[].answer_count` is all-status; `completed` is settled-only. The server's own fixture
   * (6 answered / 2 declined / 1 unanswered against 9 items) therefore renders `8 of 9
   * questions settled` in the headline, and the chip used to render `pack v1: 9 of 9` — "done"
   * next to "not done", from one response, on one row. `unanswered` has no writer today, which
   * is precisely why this is pinned now rather than after one appears.
   */
  it("states per-pack VOLUME and never a fraction that can outrun the headline", () => {
    const profiling: JourneyStep = {
      key: "profiling",
      order: 2,
      status: "in_progress",
      completed: 8,
      total: 9,
      first_at: "2026-04-30T00:00:00.000Z",
      last_at: "2026-05-03T00:00:00.000Z",
      answered_count: 6,
      declined_count: 2,
      unanswered_count: 1,
      session_count: 1,
      packs: [{ pack_id: "qp_welding", pack_version: 1, item_count: 9, answer_count: 9 }],
    };
    expect(describeStepProgress(profiling)).toBe("8 of 9 questions settled");
    const chips = describeStepDetail(profiling).join(" ");
    expect(chips).toContain("pack v1: 9 answer rows against 9 questions");
    // The exact shape that read as a completed progress bar next to "8 of 9".
    expect(chips).not.toContain("9 of 9");
  });

  it("photo and profile steps carry no invented count", () => {
    expect(describeStepProgress(photo)).toBeNull();
    expect(describeStepDetail(photo)).toEqual(["none"]);
  });
});

describe("caveats — the honest-absence channel is never swallowed", () => {
  it("turns each shipped code into a sentence an operator can act on", () => {
    for (const code of [
      "interview_kit_attribution_since_0079",
      "ai_cost_not_recorded",
      "no_conversation_state",
      "pack_version_retired",
      "stuck_items_unresolved",
    ]) {
      const view = describeJourneyCaveat(code);
      expect(view.title, code).toBeTruthy();
      expect(view.body, code).toBeTruthy();
      expect(view.title, code).not.toContain(code);
    }
  });

  it("shows an UNKNOWN code as itself rather than dropping it", () => {
    const view = describeJourneyCaveat("an_absence_added_later");
    expect(view.body).toContain("an_absence_added_later");
  });

  it("says an unrecorded session cost is not ₹0", () => {
    const view = describeJourneyCaveat("ai_cost_not_recorded");
    expect(view.body).toContain("cost nothing");
  });
});

describe("voice attempts — capture failure and transcription failure are different repairs", () => {
  function attempt(overrides: Partial<SessionVoiceAnswer>): SessionVoiceAnswer {
    return {
      id: "2b7c9d4e-5f60-4a1e-9a1e-0f0b7a2a2f3a",
      question_key: "years_experience",
      attempt_no: 1,
      ordinal: 2,
      capture_status: "uploaded",
      transcript_status: "succeeded",
      transcript_error_code: null,
      duration_seconds: 7,
      superseded_at: null,
      superseded_by_id: null,
      purged_at: null,
      has_clip: true,
      pack_id: "welder_hi",
      pack_version: 3,
      created_at: "2026-08-18T11:43:00.000Z",
      ...overrides,
    };
  }

  it("checks CAPTURE before transcription — the clip never reaching storage is its own fault", () => {
    const view = describeVoiceAttempt(
      // A failed capture whose transcript row still reads `succeeded` must NOT report success.
      attempt({ capture_status: "failed", transcript_status: "succeeded" }),
    );
    expect(view.tone).toBe("bad");
    expect(view.label).toBe("capture failed");
    expect(view.why).toContain("never reached storage");
  });

  it("names the transcription failure CODE, never a provider message", () => {
    const view = describeVoiceAttempt(
      attempt({ transcript_status: "failed", transcript_error_code: "stt_budget_blocked" }),
    );
    expect(view.tone).toBe("bad");
    expect(view.why).toContain("speech budget");
  });

  it("says so when a failure carried no code at all", () => {
    const view = describeVoiceAttempt(
      attempt({ transcript_status: "failed", transcript_error_code: null }),
    );
    expect(view.why).toContain("no failure code");
  });

  it("shows an unmapped error code raw", () => {
    expect(transcriptErrorLabel("stt_something_new")).toContain("stt_something_new");
  });

  it("never reads an unrecognised capture/transcript pair as fine", () => {
    const view = describeVoiceAttempt(
      attempt({ capture_status: "quantum", transcript_status: "sideways" }),
    );
    expect(view.tone).not.toBe("ok");
    expect(view.label).toContain("quantum");
  });

  it("counts the repeats over EVERY row, superseded ones included", () => {
    /*
     * A superseded row IS the evidence that the worker had to say it twice. Excluding those
     * rows would zero out the only measurement this summary exists to make.
     */
    const summary = summariseVoiceAttempts([
      attempt({
        id: "a",
        attempt_no: 1,
        transcript_status: "failed",
        transcript_error_code: "stt_call_failed",
        superseded_at: "2026-08-18T11:43:30.000Z",
        superseded_by_id: "b",
      }),
      attempt({ id: "b", attempt_no: 2 }),
      attempt({ id: "c", question_key: "education", capture_status: "failed" }),
    ]);
    expect(summary.totalAttempts).toBe(3);
    expect(summary.questionsRetried).toBe(1);
    expect(summary.extraAttempts).toBe(1);
    expect(summary.captureFailures).toBe(1);
    expect(summary.transcriptFailures).toBe(1);
  });

  it("reports no repeats when every question was recorded once", () => {
    const summary = summariseVoiceAttempts([attempt({ id: "a" })]);
    expect(summary.questionsRetried).toBe(0);
    expect(summary.extraAttempts).toBe(0);
  });
});
