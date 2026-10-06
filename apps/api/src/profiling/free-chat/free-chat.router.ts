/**
 * THE FREE CHAT'S ROUTING RULES (ADR-0051 §3.2) — PURE: text and facts in, a handler out.
 *
 * AI NEVER DECIDES. The classifier contributes one closed category and a confidence; every rule
 * that turns that into a handler — the precedence, the 0.6 floor, what an unavailable classifier
 * means in each mode, which categories get reviewed copy — lives here, deterministically, and is
 * unit-tabled in `free-chat.router.test.ts`. The orchestrator gathers the facts (what is on screen,
 * the lexicon class, the pending offers) and executes the answer; it never re-decides.
 *
 * TWO MODES, TWO TABLES. Free mode (and a greeting the worker typed past) answers every message
 * itself. Résumé mode is today's interview: most messages skip the classifier entirely, and an
 * unavailable classifier passes the message to the interview — an AI outage never degrades it.
 */

import { hasFirstPersonClaim, isAbusive, type UtteranceClass } from "@badabhai/profiling-lexicon";
import type {
  CompanionV2ConfidenceBucket,
  FreeChatCategory,
  FreeChatReplyCategory,
} from "@badabhai/types";
import type { QuestionPackOption } from "@badabhai/ai-contracts";

import {
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_LATER_LABEL,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
  FREE_CHAT_START_LABEL,
} from "./free-chat.copy";
import { coolingDown, FREE_CHAT_ASIDE_CAP, type FreeChatState } from "./free-chat.state";

/**
 * Below this, a classifier verdict is not acted on (ADR-0051 §3.2): free mode clarifies, résumé
 * mode clarifies and re-asks. A named constant because the labelled-set baseline (R20) is what
 * will move it, and it must move in one place.
 */
export const FREE_CHAT_MIN_CONFIDENCE = 0.6;

/**
 * The classifier's answer as the router reads it. `unavailable` is every way it can fail to give a
 * REAL verdict — null, blocked, a mock (`real_call !== true`), a failed call, a timeout — folded
 * into one value by `FreeChatService`, so no branch here can mistake a mock for a decision.
 */
export type FreeChatVerdict =
  | { readonly kind: "unavailable" }
  | { readonly kind: "verdict"; readonly category: FreeChatCategory; readonly confidence: number };

export const UNAVAILABLE_VERDICT: FreeChatVerdict = { kind: "unavailable" };

// ---------------------------------------------------------------------------
// Reading the worker's words deterministically
// ---------------------------------------------------------------------------

/** Lowercase, accents off, punctuation to spaces, whitespace collapsed — a chip/label fold. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Was this exact chip sent — its key (a client that posts keys) or its label (one that posts labels)? */
function isChip(text: string, key: string, label: string): boolean {
  return text.trim().toLowerCase() === key || fold(text) === fold(label);
}

/** The typed yes-variants the greeting reads (ADR-0051 §5.1). */
const START_WORDS: ReadonlySet<string> = new Set(["haan", "ha", "yes", "shuru", "ok"]);
/** The typed later-variants the greeting reads (ADR-0051 §5.1), as whole phrases. */
const LATER_PHRASES: readonly string[] = ["baad mein", "baad me", "later", "abhi nahi"];
/** A negation anywhere turns a "haan …" into something the greeting must not read as a yes. */
const NEGATIONS: ReadonlySet<string> = new Set(["nahi", "nahin", "nhi", "na", "no", "mat"]);
/** A typed variant is a short reply; anything longer is a message, and is classified. */
const VARIANT_MAX_WORDS = 3;

/**
 * The greeting's Haan / Baad mein, read deterministically: the chip's key or label, or a SHORT
 * typed variant. Null for anything else — which free mode then classifies (a greeting the worker
 * typed past is answered as free chat).
 */
export function readGreetingChoice(text: string): "start" | "later" | null {
  if (isChip(text, FREE_CHAT_START_KEY, FREE_CHAT_START_LABEL)) return "start";
  if (isChip(text, FREE_CHAT_LATER_KEY, FREE_CHAT_LATER_LABEL)) return "later";
  const folded = fold(text);
  const words = folded.length === 0 ? [] : folded.split(" ");
  if (words.length === 0 || words.length > VARIANT_MAX_WORDS + 1) return null;
  if (LATER_PHRASES.some((phrase) => ` ${folded} `.includes(` ${phrase} `))) return "later";
  if (words.length > VARIANT_MAX_WORDS) return null;
  if (START_WORDS.has(words[0]!) && !words.some((word) => NEGATIONS.has(word))) return "start";
  return null;
}

/** The "Resume banayein" chip — its key or its label. Works in free mode and during a cool-down. */
export function isResumeChip(text: string): boolean {
  return isChip(text, FREE_CHAT_RESUME_KEY, FREE_CHAT_RESUME_LABEL);
}

/** Does the message match one of the options the worker was shown — its key or its label? */
export function matchesOfferedOption(
  text: string,
  options: readonly Pick<QuestionPackOption, "option_key" | "label_text">[],
): boolean {
  const key = text.trim().toLowerCase();
  const folded = fold(text);
  if (folded.length === 0) return false;
  return options.some((option) => option.option_key === key || fold(option.label_text) === folded);
}

/**
 * THE DISTRESS LIST (ADR-0051 §5.2) — closed, reviewed like the copy, and matched as WHOLE PHRASES,
 * case- and diacritic-insensitively. The model never writes the reply to a distress message (R10),
 * and this list is checked before the abuse lexicon and the classifier in both modes.
 */
export const DISTRESS_PHRASES: readonly string[] = [
  "suicide",
  "khudkushi",
  "khud khushi",
  "aatmahatya",
  "atmahatya",
  "jeene ka mann nahi",
  "jine ka man nahi",
  "marna chahta",
  "marna chahti",
  "mar jaana chahta",
  "mar jana chahta",
  "mar jaana chahti",
  "mar jana chahti",
  "zindagi khatam karna",
  "jaan de dunga",
  "jaan de dungi",
  "kill myself",
  "end my life",
  "आत्महत्या",
  "खुदकुशी",
  "ख़ुदकुशी",
  "मरना चाहता",
  "मरना चाहती",
  "जीने का मन नहीं",
];

/**
 * The distress fold: NFKD, Latin combining accents and the Devanagari nukta dropped (so "ख़" and
 * "ख" are one letter, and "khúdkushi" is "khudkushi"), lowercased, every non-letter a separator.
 * Devanagari vowel signs are KEPT — they are letters of the word, not accents, and dropping them
 * would make "मारना" ("to hit") read as "मरना" ("to die").
 */
function foldDistress(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-़ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

const FOLDED_DISTRESS: readonly string[] = DISTRESS_PHRASES.map(foldDistress);

/** Does the message carry a phrase from the distress list, as a whole phrase? */
export function matchesDistress(text: string): boolean {
  const haystack = ` ${foldDistress(text)} `;
  return FOLDED_DISTRESS.some((phrase) => haystack.includes(` ${phrase} `));
}

/** The contracts §4 buckets the event carries — the companion's, unchanged. */
export function confidenceBucketOf(confidence: number): CompanionV2ConfidenceBucket {
  if (confidence < 0.5) return "lt50";
  if (confidence < 0.7) return "50_70";
  if (confidence < 0.9) return "70_90";
  return "gte90";
}

// ---------------------------------------------------------------------------
// FREE MODE (and a greeting the worker typed past)
// ---------------------------------------------------------------------------

/** What free mode does BEFORE any model call — the first rule that applies wins. */
export type FreeModePre =
  /** Haan, or "Resume banayein": enter résumé mode and serve the opening. */
  | { readonly kind: "start" }
  /** Baad mein: free mode, with the later line. */
  | { readonly kind: "later" }
  | { readonly kind: "distress" }
  | { readonly kind: "cooldown" }
  | { readonly kind: "aside_cap" }
  /** The abuse lexicon: a counted trash strike. */
  | { readonly kind: "strike" }
  | { readonly kind: "classify" };

/**
 * Free mode's deterministic rules (ADR-0051 §3.2, rules 1-4, and the §3.6 cap).
 *
 * THE ORDER, and where it departs from the §3.2 table: DISTRESS IS FIRST, before every chip and the
 * cool-down — a worker who writes "haan, suicide" at the greeting, or a distress phrase while
 * blocked from typing, is given the helpline, never the opener or the cool-down line. No chip's key
 * or label can match a distress phrase, so nothing a chip means is lost. Then the chips (they
 * "still work" during a cool-down, R13), the cool-down (no model call), the per-session cap, and the
 * abuse lexicon.
 */
export function preClassifyFree(input: {
  readonly mode: "greeting" | "free";
  readonly text: string;
  readonly state: FreeChatState;
  readonly now: Date;
}): FreeModePre {
  if (matchesDistress(input.text)) return { kind: "distress" };
  if (input.mode === "greeting") {
    const choice = readGreetingChoice(input.text);
    if (choice !== null) return { kind: choice };
  }
  if (isResumeChip(input.text)) return { kind: "start" };
  if (coolingDown(input.state, input.now)) return { kind: "cooldown" };
  if (input.state.asides >= FREE_CHAT_ASIDE_CAP) return { kind: "aside_cap" };
  if (isAbusive(input.text)) return { kind: "strike" };
  return { kind: "classify" };
}

/** What free mode does with the classifier's answer (ADR-0051 §3.2, rules 5-12). */
export type FreeModeAction =
  /** Unavailable, `unclear`, or below the floor: the clarify line and the chip. */
  | { readonly kind: "clarify" }
  /**
   * `resume`: enter résumé mode. `firstTurn` when the message already describes the work (a
   * first-person claim) — it then passes to the interview as its first answer; a bare intent gets
   * the opener.
   */
  | { readonly kind: "start"; readonly firstTurn: boolean }
  | { readonly kind: "reply"; readonly category: FreeChatReplyCategory }
  | { readonly kind: "fixed"; readonly line: "JOBS" | "OFF_LIMITS" | "DISTRESS" }
  | { readonly kind: "strike" };

export function postClassifyFree(verdict: FreeChatVerdict, text: string): FreeModeAction {
  if (verdict.kind === "unavailable") return { kind: "clarify" };
  if (verdict.confidence < FREE_CHAT_MIN_CONFIDENCE) return { kind: "clarify" };
  switch (verdict.category) {
    case "resume":
      return { kind: "start", firstTurn: hasFirstPersonClaim(text) };
    case "career":
    case "casual":
      return { kind: "reply", category: verdict.category };
    case "jobs":
      return { kind: "fixed", line: "JOBS" };
    case "off_limits":
      return { kind: "fixed", line: "OFF_LIMITS" };
    case "distress":
      return { kind: "fixed", line: "DISTRESS" };
    case "trash":
      return { kind: "strike" };
    case "unclear":
      return { kind: "clarify" };
  }
}

// ---------------------------------------------------------------------------
// RÉSUMÉ MODE (the lock — today's interview)
// ---------------------------------------------------------------------------

/**
 * What the orchestrator knows about the turn that decides whether the classifier runs at all.
 * Every field is a fact about what is on screen or what the lexicon read — never a guess.
 */
export interface ResumeSkipFacts {
  /** Past `MAX_ENGINE_TURNS`: the interview is closing. */
  readonly capped: boolean;
  /** A résumé update, résumé identity, batch-confirm or trade-form offer awaits its answer. */
  readonly pendingOffer: boolean;
  /** The experience gate or the general road's skills gate is open. */
  readonly gateOpen: boolean;
  /** The message is one of the options on screen (a tap, or its label typed). */
  readonly offeredOption: boolean;
  /** The shared lexicon's class for the message. */
  readonly lexiconClass: UtteranceClass;
  /** A typed (number, yes/no, field-normalised, or option-matching) answer to the question on screen. */
  readonly typedAnswer: boolean;
  /** Whether there is a question to re-serve after a deflection — nothing on screen means no aside. */
  readonly hasPendingQuestion: boolean;
  /** The session already served its quota of asides. */
  readonly asideCapReached: boolean;
}

/** The lexicon classes today's interview already owns (de-escalation, silence, "pata nahi"). */
const LEXICON_OWNED: ReadonlySet<UtteranceClass> = new Set(["abusive", "empty", "dont_know"]);

export type ResumeModePre =
  | { readonly kind: "distress" }
  | { readonly kind: "pass" }
  | { readonly kind: "classify" };

/**
 * Résumé mode's deterministic rules: distress first (in both modes), then the skip list — every
 * case today's interview already reads deterministically goes straight to it, with no model call.
 */
export function preClassifyResume(text: string, facts: ResumeSkipFacts): ResumeModePre {
  if (matchesDistress(text)) return { kind: "distress" };
  const skip =
    facts.capped ||
    facts.pendingOffer ||
    facts.gateOpen ||
    facts.offeredOption ||
    LEXICON_OWNED.has(facts.lexiconClass) ||
    facts.typedAnswer ||
    !facts.hasPendingQuestion ||
    facts.asideCapReached;
  return skip ? { kind: "pass" } : { kind: "classify" };
}

export type ResumeModeAction =
  /** Today's interview, unchanged. */
  | { readonly kind: "pass" }
  /**
   * The classifier called it trash and the abuse LEXICON did not: today's de-escalation line + the
   * pending question again, as an aside that is NOT counted toward `MAX_ABUSIVE_TURNS` — a model
   * verdict alone never ends profiling (CLAUDE.md §3). At most twice per pending question; the
   * orchestrator passes a third to the interview (`FreeChatState.deescalated`). Abuse the lexicon
   * DID flag never reaches the classifier: the skip list hands it to today's counted path.
   */
  | { readonly kind: "de_escalate" }
  /**
   * "Pehle resume…" + the pending question again; no turn or ask spent — AT MOST TWICE per pending
   * question: the orchestrator passes a third off-topic answer for the same question to the
   * interview (the stuck-loop guard, `FreeChatState.deflected`).
   */
  | { readonly kind: "deflect" }
  /**
   * "Samajh nahi aaya…" + the pending question again — AT MOST ONCE per pending question: the
   * orchestrator passes a second unsure answer for the same question to the interview (the cap
   * lives with the state it reads, `FreeChatState.clarifiedFor`).
   */
  | { readonly kind: "clarify" }
  | { readonly kind: "distress" };

/** What résumé mode does with the classifier's answer (ADR-0051 §3.2, the résumé table). */
export function postClassifyResume(verdict: FreeChatVerdict): ResumeModeAction {
  // AN OUTAGE NEVER DEGRADES THE INTERVIEW: unavailable is today's interview, not a clarify.
  if (verdict.kind === "unavailable") return { kind: "pass" };
  if (verdict.confidence < FREE_CHAT_MIN_CONFIDENCE) return { kind: "clarify" };
  switch (verdict.category) {
    case "resume":
      return { kind: "pass" };
    case "trash":
      return { kind: "de_escalate" };
    case "distress":
      return { kind: "distress" };
    case "unclear":
      return { kind: "clarify" };
    case "career":
    case "casual":
    case "jobs":
    case "off_limits":
      return { kind: "deflect" };
  }
}
