import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JourneyStep, SessionVoiceAnswer } from "../lib/journey";
import { JourneyFunnel } from "./journey-funnel";
import { VoiceAttempts } from "./voice-attempts";

/**
 * What the journey funnel and the voice-attempt table actually RENDER.
 *
 * Two properties that only exist in the markup:
 *
 *  1. ALL SEVEN STEPS RENDER, including `not_done`. The API never omits a step, and hiding the
 *     not-done rows would turn a funnel into a list of achievements — removing exactly the
 *     information this screen exists for, which is where the worker stopped.
 *
 *  2. EVERY VOICE ATTEMPT RENDERS, superseded ones included. A stamped row IS the evidence
 *     that the worker was asked to repeat themselves; dropping it erases the only signal this
 *     table carries for tuning the capture.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const STEPS: JourneyStep[] = [
  {
    key: "login",
    order: 1,
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
    first_at: null,
    last_at: "2026-08-18T11:52:00.000Z",
    answered_count: 11,
    declined_count: 1,
    unanswered_count: 0,
    session_count: 2,
    packs: [{ pack_id: "welder_hi", pack_version: 3, item_count: 11, answer_count: 8 }],
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
    status: "not_done",
    completed: null,
    total: null,
    first_at: null,
    last_at: null,
    profile_status: null,
    confirmed_at: null,
    profile_count: 0,
  },
  {
    key: "job_search_apply",
    order: 5,
    status: "not_done",
    completed: 0,
    total: null,
    first_at: null,
    last_at: null,
    search_count: 0,
    first_search_at: null,
    last_search_at: null,
    applied_count: 0,
    skipped_count: 0,
  },
  {
    key: "photo",
    order: 6,
    status: "not_done",
    completed: null,
    total: null,
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

describe("JourneyFunnel", () => {
  it("renders all seven steps, not-done ones included", () => {
    const out = html(<JourneyFunnel steps={STEPS} />);
    expect(out.match(/funnel__row/g)).toHaveLength(7);
    expect(out).toContain("Résumé generated");
    expect(out).toContain("Interview kit downloaded");
  });

  it("tones `not_done` MUTED — a funnel is not seven failures", () => {
    const out = html(<JourneyFunnel steps={STEPS} />);
    expect(out).toContain("pill--muted");
    expect(out).toContain("not done");
    expect(out).not.toContain("pill--bad");
  });

  it("renders the profiling denominator the server sent", () => {
    const out = html(<JourneyFunnel steps={STEPS} />);
    expect(out).toContain("12 of 18 questions settled");
  });

  it("says so rather than rendering an empty list when no step came back", () => {
    const out = html(<JourneyFunnel steps={[]} />);
    expect(out).toContain("not a worker who");
  });
});

describe("VoiceAttempts", () => {
  const base: SessionVoiceAnswer = {
    id: "a",
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
  };

  it("renders the superseded first attempt AND the retry", () => {
    const out = html(
      <VoiceAttempts
        rows={[
          {
            ...base,
            id: "a",
            transcript_status: "failed",
            transcript_error_code: "stt_call_failed",
            superseded_at: "2026-08-18T11:43:30.000Z",
            superseded_by_id: "b",
          },
          { ...base, id: "b", attempt_no: 2 },
        ]}
      />,
    );
    expect(out).toContain("replaced by a later attempt");
    expect(out).toContain("they were asked to repeat");
    expect(out).toContain("the speech provider call failed");
  });

  it("distinguishes a capture failure from a transcription failure", () => {
    const out = html(
      <VoiceAttempts
        rows={[
          { ...base, id: "a", capture_status: "failed", transcript_status: "pending" },
          {
            ...base,
            id: "b",
            question_key: "education",
            transcript_status: "failed",
            transcript_error_code: "stt_budget_blocked",
          },
        ]}
      />,
    );
    expect(out).toContain("capture failed");
    expect(out).toContain("never reached storage");
    expect(out).toContain("transcription failed");
    expect(out).toContain("speech budget");
  });

  it("an empty list reads as a text-mode interview, not as a silent worker", () => {
    const out = html(<VoiceAttempts rows={[]} />);
    expect(out).toContain("does not mean the worker was silent");
  });

  it("renders no audio handle and no transcript anywhere", () => {
    const out = html(<VoiceAttempts rows={[base]} />);
    for (const forbidden of ["transcript_text", "body_text", "voice_note_id", "<audio"]) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });
});
