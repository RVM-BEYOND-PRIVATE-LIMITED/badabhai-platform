import type {
  JourneyStep,
  JourneyStepKey,
  JourneyStepStatus,
  SessionStuck,
  SessionVoiceAnswer,
  StuckCandidate,
} from "./journey";
import type { Tone } from "../components/status-pill";

/**
 * How a worker's journey is ALLOWED to be described. Pure, so every rule below is testable in
 * the node environment this app's vitest runs in, and separate from the pages so it is obvious
 * that nothing is invented: every sentence is a statement about a field the API actually sends.
 *
 * ══ THE ONE RULE THIS MODULE EXISTS FOR ═════════════════════════════════════════════════
 * `stuck.outcome` distinguishes a REAL stall from a session where the interview had already
 * closed. `engine_advanced_past_all` is the MODAL shape for a completed interview — a `close`
 * decision carries `questionKey: null`, so the orchestrator records "advanced past" for whatever
 * was on screen, and every unsettled question ends up flagged that way. Naming one of them as
 * "where the worker got stuck" would accuse a question the worker met on their way to FINISHING,
 * and it would do it on most sessions. {@link describeStuck} therefore names a question only
 * when the server says `resolved` AND sends one; every other outcome, including one this build
 * has never heard of, renders an explanation and no question.
 */

// ---------------------------------------------------------------------------
// The 7-step funnel
// ---------------------------------------------------------------------------

const STEP_TITLES: Record<JourneyStepKey, string> = {
  login: "Signed in",
  profiling: "AI profiling interview",
  resume: "Résumé generated",
  profile_confirmed: "Profile confirmed",
  job_search_apply: "Searched and applied",
  photo: "Photo uploaded",
  interview_kit: "Interview kit downloaded",
};

/** What the step actually measures — the thing an operator needs to read the count correctly. */
const STEP_BLURBS: Record<JourneyStepKey, string> = {
  login: "A worker record cannot exist without a completed OTP verify, so this step is always done — what matters is when, and how often.",
  profiling: "Questions settled against both packs the interview runs — this worker's own trade pack, taken from the versions their answers stamp, plus the universal tail every worker is asked. The same total the worker's own progress bar showed them.",
  resume: "Résumé rows for this worker. The PDF render is a second, independently failing leg.",
  profile_confirmed: "The worker has seen their extracted profile and confirmed it. Extracting or extracted is progress, not completion.",
  job_search_apply: "Applying is the step. Searching and skipping are real engagement, but they are the step before.",
  photo: "Whether a profile photo has been uploaded. The portal never fetches the photo itself.",
  interview_kit: "Kit downloads attributed to this worker. The download route is anonymous by design, so attribution only exists from migration 0079 forward.",
};

export function stepTitle(key: JourneyStepKey): string {
  return STEP_TITLES[key];
}

export function stepBlurb(key: JourneyStepKey): string {
  return STEP_BLURBS[key];
}

export function stepStatusLabel(status: JourneyStepStatus): string {
  if (status === "done") return "done";
  if (status === "in_progress") return "in progress";
  return "not done";
}

/**
 * The funnel's own tone scale. `not_done` is MUTED, not bad: most workers have simply not got
 * there yet, and a column of red would read as seven failures rather than as a funnel.
 */
export function stepTone(status: JourneyStepStatus): Tone {
  if (status === "done") return "ok";
  if (status === "in_progress") return "warn";
  return "muted";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The headline count for a step, or null where a count is not meaningful for it.
 *
 * The denominator is rendered ONLY when the server sent one: `total` is null when it could not
 * be established, and "12 of 0" is not a progress reading, it is a missing denominator wearing
 * one.
 */
export function describeStepProgress(step: JourneyStep): string | null {
  switch (step.key) {
    case "login":
      return plural(step.otp_verified_count, "verified sign-in", "verified sign-ins");
    case "profiling": {
      const done = step.completed ?? 0;
      return step.total === null
        ? `${plural(done, "question settled", "questions settled")}`
        : `${done} of ${step.total} questions settled`;
    }
    case "resume":
      return step.resume_count === 0
        ? null
        : plural(step.resume_count, "résumé", "résumés");
    case "profile_confirmed":
      return null;
    case "job_search_apply":
      return plural(step.applied_count, "application", "applications");
    case "photo":
      return null;
    case "interview_kit":
      return plural(step.download_count, "download", "downloads");
  }
}

/**
 * The step's own extras, as short factual chips. Each one is a field the API sends; none is
 * derived from another screen or assumed.
 */
export function describeStepDetail(step: JourneyStep): string[] {
  switch (step.key) {
    case "login": {
      const chips = [];
      // NEVER summed into the real count: `worker.test_login` is a distinct event precisely so
      // a staging mint can never masquerade as a worker actually signing in.
      if (step.test_login_count > 0) {
        chips.push(`${plural(step.test_login_count, "test mint", "test mints")} (not real logins)`);
      }
      return chips;
    }
    case "profiling": {
      const chips = [
        plural(step.answered_count, "answered", "answered"),
        plural(step.declined_count, "declined", "declined"),
        plural(step.session_count, "session", "sessions"),
      ];
      // Expected to be zero on every current row — the interview flush never writes one. Shown
      // when it is not, so it stops being zero VISIBLY.
      if (step.unanswered_count > 0) {
        chips.push(`${step.unanswered_count} left unanswered`);
      }
      /**
       * ⚠ VOLUME, NOT PROGRESS — and it is worded that way because `x of y` here CONTRADICTS
       * the headline.
       *
       * `packs[].answer_count` is ALL-STATUS (see `AdminJourneyPackProgress`), while the
       * step's `completed` counts only the SETTLED ones. The two are the same number today
       * and stop being it the moment an `unanswered` row exists. Measured against the API's
       * own fixture — one pack, `item_count` 9, `answer_count` 9, statuses 6/2/1:
       *
       *     headline  "8 of 9 questions settled"   pill: in progress
       *     chip      "pack v1: 9 of 9"            ← reads as finished, on the same row
       *
       * With a single pack — the common case — the chip IS the headline re-derived by summing,
       * which is exactly what the DTO says must not be done. So the denominator is dropped and
       * the numerator is named for what it counts. Progress is read off the headline, which is
       * the only place that knows which rows settled.
       */
      for (const pack of step.packs) {
        chips.push(
          pack.item_count === 0
            ? `pack v${pack.pack_version}: ${plural(pack.answer_count, "answer row", "answer rows")}, pack version retired`
            : `pack v${pack.pack_version}: ${plural(pack.answer_count, "answer row", "answer rows")} against ${plural(pack.item_count, "question", "questions")}`,
        );
      }
      return chips;
    }
    case "resume":
      return step.resume_count === 0
        ? []
        : [`${step.rendered_count} of ${step.resume_count} rendered as PDF`];
    case "profile_confirmed": {
      const chips = [step.profile_status ?? "never profiled"];
      if (step.profile_count > 1) {
        chips.push(`${step.profile_count} profile rows (re-interviewed)`);
      }
      return chips;
    }
    case "job_search_apply":
      return [
        plural(step.search_count, "search", "searches"),
        plural(step.skipped_count, "skip", "skips"),
      ];
    case "photo":
      return [step.has_photo ? "uploaded" : "none"];
    case "interview_kit":
      return step.download_count === 0
        ? []
        : [plural(step.trade_count, "trade", "trades")];
  }
}

// ---------------------------------------------------------------------------
// Caveats — the honest-absence channel
// ---------------------------------------------------------------------------

export interface CaveatView {
  title: string;
  body: string;
}

/**
 * A caveat code as a sentence a reader can act on.
 *
 * An unrecognised code renders as ITSELF rather than being dropped. This channel exists so a
 * missing measurement never reads as a confident zero; swallowing a code because this build
 * predates it would reintroduce exactly that failure.
 */
export function describeJourneyCaveat(code: string): CaveatView {
  switch (code) {
    case "interview_kit_attribution_since_0079":
      return {
        title: "Interview-kit downloads are only attributable since migration 0079",
        body: "The download route is anonymous by design, so earlier downloads carry no worker id and cannot be backfilled. A zero on step 7 means “no attributed download since then”, never “this worker never took a kit”.",
      };
    case "ai_cost_not_recorded":
      return {
        title: "This session's AI spend was never recorded",
        body: "Per-session cost totals accrue only from migration 0077 forward, with no backfill. This session has no row — which is not the same fact as “it cost nothing”, so no ₹ figure is shown.",
      };
    case "no_conversation_state":
      return {
        title: "This session saved no interview state",
        body: "A v1 model-driven interview, or one that never reached the deterministic engine. Without `ask_counts` there is nothing to derive a stuck question from.",
      };
    case "pack_version_retired":
      return {
        // WIDENED, because the server widened what it fires on. The code now covers three
        // ways the corpus can stop accounting for a worker's answers — a whole pack version
        // with no items left, a single question dropped by a re-seed, and a re-interview that
        // settles one question under two packs. Naming only the first would tell an operator
        // something specific and, two thirds of the time, false.
        title: "The question packs no longer account for all of this worker's answers",
        body: "A pack version they answered under has lost its questions, or a question was retired from under them, or they were re-interviewed and one question settled under two packs. Either way the profiling total no longer describes the answers counted against it, so read the progress figure as approximate — the answered and declined counts beside it are exact.",
      };
    case "stuck_items_unresolved":
      return {
        title: "The stuck ranking was partly blind",
        body: "One or more served questions resolved to no pack item in any version this read could load, so their ask ceiling, mandatory flag and position were unknown and the ranking could not judge them on those legs.",
      };
    default:
      return {
        title: "The server attached a caveat this portal does not recognise",
        body: `Code: ${code}. It is shown rather than dropped — an unknown caveat still means some measurement below is incomplete.`,
      };
  }
}

// ---------------------------------------------------------------------------
// The stuck question
// ---------------------------------------------------------------------------

export interface StuckView {
  /** `warn` only when a real stall was named. Nothing else on this panel is a problem. */
  tone: "warn" | "info" | "muted";
  headline: string;
  body: string;
  /**
   * The named question. NON-NULL only when the server reported `resolved` AND sent one — the
   * single most important property in this file.
   */
  question: StuckCandidate | null;
  /** Heading for the ranked candidate list, or null when there is nothing worth listing. */
  candidatesTitle: string | null;
  /** How far the engine got in this session. */
  progress: string;
}

/** How servable the engine judged the named question — the second leg of the ranking. */
function servability(candidate: StuckCandidate): string {
  if (candidate.unservable === false) return "the engine could still have served it again";
  if (candidate.unservable === true) return "the engine could never have served it again";
  return "whether the engine could serve it again is unknown — its pack item could not be resolved";
}

export function describeStuck(stuck: SessionStuck): StuckView {
  const progress = `The engine served ${plural(stuck.asked_count, "question", "questions")} in this session; ${stuck.settled_count} settled.`;

  switch (stuck.outcome) {
    case "resolved": {
      const question = stuck.stuck_question;
      if (!question) {
        // The server contradicting itself. Reported as a gap rather than papered over with the
        // top candidate — picking one here would be this portal inventing the answer.
        return {
          tone: "muted",
          headline: "No stuck question was named",
          body: "The server reported a resolved stuck question but sent none. Treat this as a gap in the read, not as a clean finish.",
          question: null,
          candidatesTitle: "Questions this session never settled",
          progress,
        };
      }
      return {
        tone: "warn",
        headline: `Stuck on ${question.question_key}`,
        body: `This is the question the engine was still serving when the session ended. It was asked ${question.asks} of a maximum ${question.ask_ceiling} time${question.ask_ceiling === 1 ? "" : "s"}, and ${servability(question)}. Nothing recorded the engine moving past it, which is what separates a stall from a question the interview simply left behind.`,
        question,
        candidatesTitle: "Every question this session left unsettled, ranked",
        progress,
      };
    }
    case "engine_advanced_past_all":
      return {
        tone: "info",
        headline: "No question was on screen",
        body: "The interview had already closed. The engine had moved past every question this session left unsettled, so none of them is where the worker stopped — closing advances past whatever was showing. The questions below are still worth reading: they are the ones this worker never settled.",
        question: null,
        candidatesTitle: "Questions this session never settled",
        progress,
      };
    case "all_settled":
      return {
        tone: "muted",
        headline: "Every question asked was settled",
        body: "The worker answered or declined every question the engine served in this session. There is no stuck question.",
        question: null,
        candidatesTitle: null,
        progress,
      };
    case "no_asks_recorded":
      return {
        tone: "muted",
        headline: "The engine never served a question",
        body: "This session has interview state but no record of a question being asked — so there is nothing here to be stuck on.",
        question: null,
        candidatesTitle: null,
        progress,
      };
    case "no_conversation_state":
      return {
        tone: "muted",
        headline: "No interview state was saved",
        body: "A v1 model-driven interview, or one that never reached the deterministic engine. No stuck question can be derived from anything.",
        question: null,
        candidatesTitle: null,
        progress,
      };
    default:
      return {
        tone: "muted",
        headline: "The stuck outcome is not recognised",
        body: `The server reported “${stuck.outcome}”, which this portal has not been taught. No question is named, because naming one would mean guessing what that outcome meant.`,
        question: null,
        candidatesTitle: stuck.candidates.length > 0 ? "Questions this session never settled" : null,
        progress,
      };
  }
}

// ---------------------------------------------------------------------------
// Voice attempts — where a worker had to repeat themselves
// ---------------------------------------------------------------------------

export interface VoiceAttemptView {
  tone: Tone;
  label: string;
  /** Why it failed, when it failed. Null on a clean attempt. */
  why: string | null;
}

/** The closed-set transcription failure codes the profiling pipeline writes. */
export function transcriptErrorLabel(code: string): string {
  switch (code) {
    case "stt_budget_blocked":
      return "the speech budget was exhausted, so the gateway refused the call";
    case "stt_call_failed":
      return "the speech provider call failed";
    case "stt_service_unreachable":
      return "the speech service was unreachable";
    case "stt_failed":
      return "transcription failed";
    default:
      return `transcription failed with ${code}`;
  }
}

/**
 * What happened to ONE recorded attempt.
 *
 * CAPTURE IS CHECKED BEFORE TRANSCRIPTION, because they fail independently and for different
 * reasons: "the clip never reached storage" and "the clip became no text" are different repairs,
 * and collapsing them is how a worker's answer disappears while the row still reads fine.
 */
export function describeVoiceAttempt(row: SessionVoiceAnswer): VoiceAttemptView {
  if (row.capture_status === "failed") {
    return { tone: "bad", label: "capture failed", why: "the clip never reached storage" };
  }
  if (row.capture_status === "abandoned") {
    return { tone: "warn", label: "recording abandoned", why: "the worker stopped mid-recording" };
  }
  if (row.transcript_status === "failed") {
    return {
      tone: "bad",
      label: "transcription failed",
      why: row.transcript_error_code
        ? transcriptErrorLabel(row.transcript_error_code)
        : "no failure code was recorded",
    };
  }
  if (row.transcript_status === "succeeded") {
    return { tone: "ok", label: "transcribed", why: null };
  }
  if (row.transcript_status === "pending" || row.transcript_status === "queued") {
    return { tone: "warn", label: row.transcript_status, why: "still waiting on transcription" };
  }
  if (row.transcript_status === "skipped") {
    return { tone: "muted", label: "transcription skipped", why: null };
  }
  // An unrecognised pair is shown as itself — never as "fine".
  return {
    tone: "warn",
    label: `${row.capture_status} / ${row.transcript_status}`,
    why: "a capture or transcript state this portal has not been taught",
  };
}

export interface VoiceRetrySummary {
  /** Distinct questions the worker had to record more than once. */
  questionsRetried: number;
  /** Attempts beyond the first, summed across those questions. */
  extraAttempts: number;
  captureFailures: number;
  transcriptFailures: number;
  totalAttempts: number;
}

/**
 * How much repeating this session cost the worker.
 *
 * Counted over EVERY attempt row including superseded ones — a superseded row IS the evidence
 * that the worker had to say it twice, so excluding them would zero out the only measurement
 * this summary exists to make.
 */
export function summariseVoiceAttempts(rows: readonly SessionVoiceAnswer[]): VoiceRetrySummary {
  const attemptsByQuestion = new Map<string, number>();
  let captureFailures = 0;
  let transcriptFailures = 0;

  for (const row of rows) {
    attemptsByQuestion.set(row.question_key, (attemptsByQuestion.get(row.question_key) ?? 0) + 1);
    if (row.capture_status === "failed") captureFailures += 1;
    if (row.transcript_status === "failed") transcriptFailures += 1;
  }

  let questionsRetried = 0;
  let extraAttempts = 0;
  for (const count of attemptsByQuestion.values()) {
    if (count > 1) {
      questionsRetried += 1;
      extraAttempts += count - 1;
    }
  }

  return {
    questionsRetried,
    extraAttempts,
    captureFailures,
    transcriptFailures,
    totalAttempts: rows.length,
  };
}
