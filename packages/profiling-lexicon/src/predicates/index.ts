/**
 * Conversational predicates — the detectors the deterministic orchestrator runs on every
 * worker turn to decide whether an answer was given, refused, corrected, or whether the
 * worker is doing something else entirely.
 *
 * Every one of these already exists and is battle-tested in
 * `apps/ai-service/app/profiling/signals.py`. Phase 3 lifts their DATA into `data/` and
 * implements these readers against it, so the TS and Python answers cannot diverge.
 *
 * Owner: Prakash (Conversation & Profiling).
 */

/**
 * How the orchestrator classifies one inbound worker message.
 *
 * These are mutually exclusive and ordered by precedence in the orchestrator, because a
 * single message can satisfy several: "nahi bhai, 7 saal — kaam milega kya?" is a
 * correction AND a question-back. Correction wins, because it carries a value.
 */
export type UtteranceClass =
  /** A usable answer to the question on screen. */
  | "answer"
  /** "nahi pata" — a COMPLETE answer. Never re-asked, never blocks completion (persona Law 8). */
  | "dont_know"
  /** "nahi, 5 saal nahi 7 saal" — overrides an established value, whatever is on screen. */
  | "correction"
  /** "ghar chalana mushkil hai" — acknowledge, do not push a question this turn, do not count an ask. */
  | "hardship"
  /** "job milegi kya?" — serve the question's `why_text`, then RE-SERVE. Never counts as an ask. */
  | "question_back"
  /** Abusive. Serve a fixed de-escalation line; at 3 → close with `abuse_cap`. */
  | "abusive"
  /** Under 2 characters or punctuation-only. Consumes a TURN, not an ASK. */
  | "empty"
  /** Nothing detected. Bounded re-ask, then record `unanswered` and advance. */
  | "off_topic";

/** The result of classifying one message. */
export interface UtteranceSignal {
  readonly cls: UtteranceClass;
  /**
   * Which detector fired, for observability. Never carries worker text — this reaches logs,
   * and §2 of the privacy contract says a worker's words never do.
   */
  readonly detector: string;
}

/**
 * Classify one worker message.
 *
 * MUST be a pure function of (text, lexicon data). No clock, no randomness, no I/O — the
 * orchestrator's decision function is property-tested on the invariant "same answers ⇒ same
 * next question, always", and that only holds if this is deterministic.
 */
export declare function classifyUtterance(text: string): UtteranceSignal;

/** "nahi pata", "pata nahi", "malum nahi" — `signals.is_dont_know`. */
export declare function isDontKnow(text: string): boolean;

/** "nahi, actually…" — `signals.is_correction`. Gates the overwrite rule. */
export declare function isCorrection(text: string): boolean;

/** "ghar chalana mushkil hai" — `signals.is_hardship`. */
export declare function isHardship(text: string): boolean;

/** `signals.is_abusive`. The message is still buffered for audit, but flagged out of the parse input. */
export declare function isAbusive(text: string): boolean;

/** "job milegi kya?", "kab tak?" — `signals.asks_about_job_prospects` plus a generic question check. */
export declare function asksQuestionBack(text: string): boolean;

/**
 * Does the worker claim this of THEMSELVES, rather than describing a workplace?
 * `signals.has_first_person_claim` — the TD101 guard that stops "humare yahan CNC hai"
 * becoming `trade: CNC operator`.
 */
export declare function hasFirstPersonClaim(text: string): boolean;
