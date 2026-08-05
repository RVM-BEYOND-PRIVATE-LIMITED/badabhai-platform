/**
 * Conversational predicates — the detectors the deterministic orchestrator runs on every
 * worker turn to decide whether an answer was given, refused, corrected, or whether the
 * worker is doing something else entirely.
 *
 * Every one of these is battle-tested in `apps/ai-service/app/profiling/signals.py`. Phase 3
 * lifted their DATA into `data/predicates.json` and `data/negation.json`; both languages now
 * read those files, so the TS and Python answers cannot diverge. The rationale for each cue
 * list — in particular the things deliberately left OUT, each excluded on a measurement —
 * lives in the `$comment` keys of those files.
 *
 * Owner: Prakash (Conversation & Profiling).
 */

import { compileNamed, loadLexicon } from "../internal/regex.js";

interface PredicatesFile {
  readonly correctionMarkers: readonly string[];
}

const DONT_KNOW_RE = compileNamed("predicates", "dontKnow");
const HARDSHIP_RE = compileNamed("predicates", "hardship");
const JOB_PROSPECT_RE = compileNamed("predicates", "jobProspect");
const JOB_INTERROGATIVE_RE = compileNamed("predicates", "jobInterrogative");
const ABUSE_RE = compileNamed("predicates", "abuse");
const FIRST_PERSON_CLAIM_RE = compileNamed("predicates", "firstPersonClaim");
const CLAIM_BLOCKERS_RE = compileNamed("predicates", "claimBlockers");

const CORRECTION_MARKERS: readonly string[] =
  loadLexicon<PredicatesFile>("predicates").correctionMarkers;

/**
 * How the orchestrator classifies one inbound worker message.
 *
 * These are mutually exclusive and ordered by precedence, because a single message can satisfy
 * several: "nahi nahi, 7 saal — kaam milega kya?" is a correction AND a question-back.
 * Correction wins, because it carries a value.
 *
 * Note the DOUBLED "nahi nahi". A single "nahi bhai, …" is not a correction marker and must not
 * become one — it opens a large share of worker replies, and treating it as a self-correction
 * would let any passing denial overwrite a value for a topic that is not even on screen.
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
 * Characters that do not make a message meaningful on their own.
 *
 * Includes the Devanagari danda: `।` is a full stop in Hindi, so a worker who sends one has
 * said exactly as much as one who sends ".".
 */
const PUNCTUATION_ONLY_RE = /^[\s.,;:!?'"()[\]{}\-–—।|/\\]*$/;

/** "nahi pata", "pata nahi", "malum nahi" — `signals.is_dont_know`. */
export function isDontKnow(text: string): boolean {
  return DONT_KNOW_RE.test(text || "");
}

/**
 * "nahi, actually…" — `signals.is_correction`. Gates the overwrite rule.
 *
 * Case-folded SUBSTRING matching, not word-boundary matching: "correct kar" must also cover
 * "correct karo" and "correct karna". Preserved verbatim from the Python side, where the same
 * `marker in low` check has shipped since P1-1.
 */
export function isCorrection(text: string): boolean {
  const low = (text || "").toLowerCase();
  return CORRECTION_MARKERS.some((marker) => low.includes(marker));
}

/** "ghar chalana mushkil hai" — `signals.is_hardship`. Fires on hardship, never on achievement. */
export function isHardship(text: string): boolean {
  return HARDSHIP_RE.test(text || "");
}

/** `signals.is_abusive`. The message is still buffered for audit, but flagged out of the parse input. */
export function isAbusive(text: string): boolean {
  return ABUSE_RE.test(text || "");
}

/**
 * "job milegi kya?", "kab tak?" — `signals.asks_about_job_prospects`.
 *
 * BOTH halves must match. The prospect cue alone fires on "abhi job kar raha hu, 1 mahina
 * lagega" — a worker *answering* the availability question — so an interrogative shape is
 * required too. Measured: that conjunct takes corpus false positives to zero without losing a
 * single positive.
 */
export function asksQuestionBack(text: string): boolean {
  const message = text || "";
  return JOB_PROSPECT_RE.test(message) && JOB_INTERROGATIVE_RE.test(message);
}

/**
 * Does the worker claim this of THEMSELVES, rather than describing a workplace?
 * `signals.has_first_person_claim` — the TD98/TD101 guard that stops "humare yahan CNC hai"
 * becoming `trade: CNC operator`.
 */
export function hasFirstPersonClaim(text: string): boolean {
  const message = text || "";
  return FIRST_PERSON_CLAIM_RE.test(message) && !CLAIM_BLOCKERS_RE.test(message);
}

/**
 * Classify one worker message.
 *
 * PURE function of (text, lexicon data). No clock, no randomness, no I/O — the orchestrator's
 * decision function is property-tested on "same answers ⇒ same next question, always", and that
 * only holds if this is deterministic.
 *
 * PRECEDENCE, and why this order:
 *
 *   1. `empty`       — nothing to classify; consumes a turn, not an ask.
 *   2. `abusive`     — must win over everything, because the response is a fixed de-escalation
 *                      line and the message is flagged out of the parse input. An abusive
 *                      message that also carries a value is still handled as abuse.
 *   3. `correction`  — beats `dont_know` and `question_back` because it carries a VALUE, and
 *                      losing a correction leaves the profile holding a number the worker
 *                      explicitly retracted. "nahi nahi, 7 saal — kaam milega kya?" is a
 *                      correction first.
 *   4. `dont_know`   — a complete answer (persona Law 8), so it must be recognised before the
 *                      fallback treats it as off-topic and re-asks. Re-asking after "nahi pata"
 *                      is the specific behaviour Law 8 names as forbidden.
 *   5. `question_back`
 *   6. `hardship`    — last of the specific classes: it neither answers nor blocks, and its
 *                      patterns are the most permissive, so anything more specific wins.
 *   7. `off_topic`   — the bounded-re-ask fallback.
 *
 * `answer` is NOT produced here. Whether a message answers the question ON SCREEN depends on the
 * question, which this function deliberately does not see — that judgement belongs to
 * `answer-capture.ts`, which runs the value normalizers against the asked field. This function
 * reports only what the message is doing *conversationally*.
 */
export function classifyUtterance(text: string): UtteranceSignal {
  const message = text || "";

  if (message.trim().length < 2 || PUNCTUATION_ONLY_RE.test(message)) {
    return { cls: "empty", detector: "empty" };
  }
  if (isAbusive(message)) return { cls: "abusive", detector: "abuse" };
  if (isCorrection(message)) return { cls: "correction", detector: "correction_markers" };
  if (isDontKnow(message)) return { cls: "dont_know", detector: "dont_know" };
  if (asksQuestionBack(message)) return { cls: "question_back", detector: "job_prospect" };
  if (isHardship(message)) return { cls: "hardship", detector: "hardship" };
  return { cls: "off_topic", detector: "none" };
}
