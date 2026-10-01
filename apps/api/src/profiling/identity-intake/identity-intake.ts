/**
 * THE IDENTITY INTAKE (ADR-0048, #1858) — the worker's first name, surname, state and city, asked
 * as the onboarding chat's first turns instead of on the app's `/name` screen. PURE: no I/O, no
 * clock, no key. The orchestrator wires it; `IdentityIntakeService` does the crypto and the writes.
 *
 * ── WHY A DEDICATED MACHINE AND NOT FOUR PACK QUESTIONS ─────────────────────────────────────────
 *
 * A name that went through the ordinary message path would be read by everything that reads a
 * worker's words for meaning before the engine chooses a question: capture and cross-question fill
 * would try it against the pack, `identify` would spend one of its two attempts treating "Ramesh"
 * as a trade phrase (and could queue it to the growth corpus), and the LLM-led interview would send
 * it to the provider as the first line of history. So the intake answers its own turns and returns
 * before any of that runs, and its lines are flagged out of every meaning-reader (`intake: true`).
 *
 * ── THE RULINGS THIS MODULE ENCODES (owner, 2026-09-30) ─────────────────────────────────────────
 *
 *   D1  Not mandatory. A step is asked at most {@link MAX_INTAKE_ASKS_PER_STEP} times; a second
 *       non-answer settles it as skipped. The worker's record keeps its gap, so his next NEW
 *       session asks again — the interview never traps him on a question he will not answer.
 *       A non-answer is a lexicon class or a reply carrying a word from the closed D1 lists below;
 *       a refusal is never written as the value it refused.
 *   D2  The first name is held SEALED between the two name steps (the service seals it; this
 *       module only says "hold this") and `full_name` is written once. A skipped surname writes
 *       the first name alone.
 *   D3  First name, then surname. A first answer of two or more words — after the closed cue list
 *       below is stripped — is the full name, and the surname step is not asked. Every name value
 *       passes `SetMyNameSchema.shape.full_name`, imported rather than copied.
 *   D5  State, then city, both free text: the app shows its pickers for the question keys, and an
 *       unrecognised value is accepted verbatim, exactly as `WorkersService.setLocation` does.
 */

import { canonicalCity, canonicalState, classifyUtterance } from "@badabhai/profiling-lexicon";
import type { IdentityIntakeOutcome, IdentityIntakeStep } from "@badabhai/event-schema";

import { titleCaseName } from "../../resume/resume-text-case";
import { SetMyNameSchema } from "../../workers/workers.dto";
import type { IdentityIntakeState } from "../conversation-state";
import { DE_ESCALATION_REPLY_TEXT } from "../next-question";
import { INTAKE_COPY } from "./identity-intake.copy";

export { IDENTITY_INTAKE_REPLIES, INTAKE_COPY, INTAKE_HANDOFF_TEXT } from "./identity-intake.copy";
export type { IdentityIntakeState } from "../conversation-state";

export type IntakeStep = IdentityIntakeStep;

/**
 * The wire `question_key` per step — `asked_question_id` on `POST /chat/message` and
 * `opening_question_key` on `POST /chat/session`. The app keys its State and City pickers off the
 * last two. `^[a-z_]+$`, like every pack key, so the event filters and the flush accept them; and
 * prefixed `worker_` so none can ever collide with a pack's own `current_city`.
 */
export const INTAKE_QUESTION_KEYS = {
  first_name: "worker_first_name",
  last_name: "worker_last_name",
  state: "worker_state",
  city: "worker_city",
} as const satisfies Record<IntakeStep, string>;

/** How every intake question is answered: typed (or picked in the app and sent as text). */
export const INTAKE_ANSWER_TYPE = "text" as const;

/** D1 — asks per step before a non-answer settles it as skipped. */
export const MAX_INTAKE_ASKS_PER_STEP = 2;

/**
 * D3 — the CLOSED list of cue words stripped from a name answer, matched whole-word and
 * case-insensitively. It holds the sentence a worker says a name inside, in Hinglish AND
 * Devanagari: "main Ramesh hoon", "Ramesh hu", "I'm Ramesh", "mera surname Kumar hai" and
 * "मेरा नाम रमेश है" are the commonest answers to "what is your name", and each must read as the
 * name, not be re-asked twice and skipped. Every entry is a word that can never be part of the name
 * it surrounds; widening the list is a deliberate decision, not a tuning knob. Ordered longest
 * first when compiled (see `CUE_RE`), so "my name is" is removed before a shorter cue could split
 * it.
 *
 * KNOWN LIMIT, ACCEPTED: a trade said in the same sentence survives the strip — "main welder hoon"
 * reads as the first name "Welder". A trade-word check cannot be added: Indian surnames are often
 * trade words (Mistry, Lohar, Darzi, Sonar), and refusing them would refuse real names.
 */
export const NAME_CUE_PHRASES = [
  "my surname is",
  "my name is",
  "mera surname",
  "mera naam",
  "my name",
  "i am",
  "i'm",
  "i’m",
  "im",
  "surname",
  "naam",
  "hai",
  "hoon",
  "hun",
  "hu",
  "ji",
  "main",
  "mai",
  "मेरा नाम",
  "नाम",
  "है",
  "हूँ",
  "हूं",
  "मैं",
  "जी",
];

/**
 * D1 — the CLOSED word lists that make a reply a NON-ANSWER, whatever `SetMyNameSchema` would make
 * of it. That schema bounds a value's shape (length, digits, control characters) and accepts any
 * words at all, so without these "nahi batana" was written as the worker's full name, "surname
 * nahi" as his surname and "nahi" as his state — and, once written, the record has no gap, so D9
 * never asks again and the words print on his résumé. The lexicon's `dont_know` class covers only
 * "pata nahi"; everything else a worker says instead of his name lands here.
 *
 * WHOLE WORDS, AND EVERY ENTRY IS A WORD NO NAME OR PLACE IS MADE OF — "Noronha" holds "no",
 * "Hina" holds "hi", "Okhla" holds "ok", and all three are answers. Deliberately ABSENT: "nai"
 * ("Nai Dilli" is a city), "sahi" (a surname) and "ho" (the Ho people's name), though the lexicon
 * reads the first two as a no and a yes. A reply that carries one of these is re-asked, NEVER
 * trimmed down to what is left: stripping is the cue list's job, and that list is closed (D3).
 * Widening any of the three is an owner decision, exactly as widening the cue list is.
 */
export const INTAKE_REFUSAL_WORDS = [
  "nahi",
  "nahin",
  "nahee",
  "nhi",
  "no",
  "nope",
  "not",
  "never",
  "skip",
  "baad",
  "later",
  "dont",
  "don't",
  "wont",
  "won't",
  "नहीं",
  "नही",
  "बाद",
] as const;

/** D1 — a question back in the worker's own words: served the step's why, then the question. */
export const INTAKE_WHY_WORDS = [
  "kyu",
  "kyun",
  "kyon",
  "kyoon",
  "kyo",
  "why",
  "kya",
  "kaun",
  "what",
  "who",
  "क्यों",
  "क्यूँ",
  "क्यूं",
  "क्या",
  "कौन",
] as const;

/**
 * D1 — an acknowledgement or a greeting, or a stray sentence word the cue list does not strip
 * ("my Ramesh", "mera Ramesh"): the reply is re-asked. The words a name is SAID inside are the cue
 * list's job (D3) and are stripped there, so they are not repeated here.
 */
export const INTAKE_FILLER_WORDS = [
  "haan",
  "haa",
  "han",
  "yes",
  "ok",
  "okay",
  "hi",
  "hello",
  "hlo",
  "hey",
  "my",
  "mera",
  "meri",
  "aap",
  "name",
  "हाँ",
  "हां",
  "मेरा",
] as const;

/** Which of the worker's three identity facts are already on his record. */
export interface IdentityGaps {
  readonly hasName: boolean;
  readonly hasState: boolean;
  readonly hasCity: boolean;
}

/** The worker row's three identity columns, read as presence only — never the values. */
export function identityGapsOf(worker: {
  readonly fullName: string | null;
  readonly currentState: string | null;
  readonly currentCity: string | null;
}): IdentityGaps {
  const present = (value: string | null): boolean =>
    typeof value === "string" && value.trim().length > 0;
  return {
    hasName: present(worker.fullName),
    hasState: present(worker.currentState),
    hasCity: present(worker.currentCity),
  };
}

/**
 * Only what is missing, in the order the steps are asked: name first (first name then surname),
 * then state before city (master spec rule 3). Empty for a worker with no gap — D9: he is never
 * asked.
 */
export function planIntake(gaps: IdentityGaps): IntakeStep[] {
  return [
    ...(gaps.hasName ? [] : (["first_name", "last_name"] as const)),
    ...(gaps.hasState ? [] : (["state"] as const)),
    ...(gaps.hasCity ? [] : (["city"] as const)),
  ];
}

/** A pending intake on its first step, which counts as asked once. Null for an empty plan. */
export function openIntake(steps: readonly IntakeStep[]): IdentityIntakeState | null {
  const [first, ...rest] = steps;
  if (first === undefined) return null;
  return {
    state: "pending",
    step: first,
    remaining: rest,
    asks: { [first]: 1 },
    firstNameEnc: null,
    heldState: null,
  };
}

/**
 * The line a pending step is RE-SERVED in on a reopen: the retry once it has been asked twice.
 * Never the clarify or the de-escalation — those answer a reply, and a reopen answers nothing.
 */
export function reservedIntakeLine(intake: IdentityIntakeState, step: IntakeStep): IntakeLine {
  return (intake.asks[step] ?? 1) >= MAX_INTAKE_ASKS_PER_STEP ? "retry" : "prompt";
}

/** The words for one line of one step. The de-escalation is the engine's own fixed line. */
export function intakeLineText(step: IntakeStep, line: IntakeLine): string {
  if (line === "de_escalate") return DE_ESCALATION_REPLY_TEXT;
  return INTAKE_COPY[step][line];
}

// ---------------------------------------------------------------------------
// Reading one answer
// ---------------------------------------------------------------------------

/** Why a reply did not answer the step on screen. Decides only which line re-asks it. */
export type IntakeNonAnswer = "empty" | "abusive" | "declined" | "question_back" | "unreadable";

export type IntakeReading =
  /** A usable value. `fullName` is true only for a first-name answer of two or more words (D3). */
  | { readonly kind: "answer"; readonly value: string; readonly fullName: boolean }
  | { readonly kind: "non_answer"; readonly why: IntakeNonAnswer };

/**
 * What counts as PART OF A WORD: letters, digits AND combining marks. The marks are not optional —
 * a Devanagari vowel sign (ा ी ै …) is `\p{M}`, not `\p{L}`, so a class of letters and digits alone
 * cut "सीता" to "सीत" and "शर्मा" to "शर्म", and wrote the stump to the résumé.
 */
const WORD_CHAR = String.raw`\p{L}\p{M}\p{N}`;

/** Longest first, so a multi-word cue is removed whole before a shorter one could split it. */
const CUE_ALTERNATION = [...NAME_CUE_PHRASES]
  .sort((a, b) => b.length - a.length)
  .map((cue) => cue.replace(/ /g, " +"))
  .join("|");

const CUE_RE = new RegExp(`(?<![${WORD_CHAR}])(?:${CUE_ALTERNATION})(?![${WORD_CHAR}])`, "giu");

/** Punctuation a name token may be wrapped in ("Ramesh," / "(Kumar)"), stripped at its edges only. */
const EDGE_PUNCTUATION = new RegExp(`^[^${WORD_CHAR}]+|[^${WORD_CHAR}]+$`, "gu");

/**
 * The words of a reply: each token trimmed of edge punctuation, and only tokens that still carry a
 * letter kept — so "Ramesh ." is one word and never "Ramesh" + ".". Internal punctuation stays
 * ("D'Souza", "Ram-Prasad"): it is part of the name.
 */
function wordsOf(text: string): string[] {
  return text
    .split(/[ \t\r\n]+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ""))
    .filter((token) => /\p{L}/u.test(token));
}

/** The name words in a reply: {@link wordsOf} with the closed cue words removed first (D3). */
export function nameWords(text: string): string[] {
  return wordsOf(text.replace(CUE_RE, " "));
}

/** A word as the D1 lists hold it: composed, lower-cased, with a typographic apostrophe folded. */
function foldWord(word: string): string {
  return word.normalize("NFC").toLowerCase().replace(/’/g, "'");
}

const WHY_WORDS: ReadonlySet<string> = new Set(INTAKE_WHY_WORDS);
const REFUSAL_WORDS: ReadonlySet<string> = new Set(INTAKE_REFUSAL_WORDS);
const FILLER_WORDS: ReadonlySet<string> = new Set(INTAKE_FILLER_WORDS);

/**
 * Why these words are not the value asked for, or null when none of them is a D1 word. A question
 * wins over a refusal — "nahi batana, kyu chahiye?" is owed the why — and a refusal over filler.
 */
function nonAnswerIn(words: readonly string[]): IntakeNonAnswer | null {
  const folded = words.map(foldWord);
  if (folded.some((word) => WHY_WORDS.has(word))) return "question_back";
  if (folded.some((word) => REFUSAL_WORDS.has(word))) return "declined";
  if (folded.some((word) => FILLER_WORDS.has(word))) return "unreadable";
  return null;
}

/**
 * One reply, read against the step on screen. The conversational class comes from the SAME
 * lexicon the interview uses (`classifyUtterance`), so "pata nahi" is a decline here exactly as it
 * is on a pack question; the words are then checked against the D1 lists, and only then is the
 * value held to the `/name` endpoint's own validators.
 */
export function readIntakeAnswer(step: IntakeStep, text: string): IntakeReading {
  const cls = classifyUtterance(text).cls;
  if (cls === "empty") return { kind: "non_answer", why: "empty" };
  if (cls === "abusive") return { kind: "non_answer", why: "abusive" };
  if (cls === "dont_know") return { kind: "non_answer", why: "declined" };
  if (cls === "question_back") return { kind: "non_answer", why: "question_back" };
  if (cls === "hardship") return { kind: "non_answer", why: "unreadable" };
  return step === "first_name" || step === "last_name"
    ? readName(step, text)
    : readPlace(step, text);
}

function readName(step: "first_name" | "last_name", text: string): IntakeReading {
  const words = nameWords(text);
  if (words.length === 0) return { kind: "non_answer", why: "unreadable" };
  const why = nonAnswerIn(words);
  if (why !== null) return { kind: "non_answer", why };
  // The app title-cased every name `/name` sent (`titleCaseName`, name_cubit.dart); this is the
  // API's twin of that function, so a chat-captured name prints on the résumé as a `/name` one did.
  const parsed = SetMyNameSchema.shape.full_name.safeParse(titleCaseName(words.join(" ")));
  if (!parsed.success) return { kind: "non_answer", why: "unreadable" };
  return {
    kind: "answer",
    value: parsed.data,
    fullName: step === "first_name" && words.length >= 2,
  };
}

function readPlace(step: "state" | "city", text: string): IntakeReading {
  const why = nonAnswerIn(wordsOf(text));
  if (why !== null) return { kind: "non_answer", why };
  // VERBATIM (D5): trimmed and bounded by the `/name` endpoint's own rule, never resolved here —
  // `setLocation` canonicalises what the gazetteer knows and stores the rest exactly as typed.
  const parsed = SetMyNameSchema.shape[step].safeParse(text);
  if (!parsed.success || parsed.data === undefined)
    return { kind: "non_answer", why: "unreadable" };
  return { kind: "answer", value: parsed.data, fullName: false };
}

// ---------------------------------------------------------------------------
// Advancing the machine
// ---------------------------------------------------------------------------

/** One step settled on this turn — exactly what `profile.identity_intake_answered` carries. */
export interface IntakeSettlement {
  readonly step: IntakeStep;
  readonly outcome: IdentityIntakeOutcome;
  /** The gazetteer verdict on an answered state or city; null otherwise. */
  readonly recognized: boolean | null;
}

/**
 * The name, once its steps are done — or null when there is nothing to write.
 *
 * `full`: the first answer already was the full name. `held`: the sealed first name plus this
 * turn's surname (or none, when the surname was skipped) — the service unseals and composes.
 */
export type IntakeNameWrite =
  | { readonly kind: "full"; readonly value: string }
  | { readonly kind: "held"; readonly surname: string | null };

/** What the turn puts on screen next. */
export type IntakeReply =
  /** A step question: its first ask, its retry, the why-then-question, or the de-escalation line. */
  | { readonly kind: "ask"; readonly step: IntakeStep; readonly line: IntakeLine }
  /** The intake is over; the orchestrator serves the next opening (D6). */
  | { readonly kind: "handoff" };

export type IntakeLine = "prompt" | "retry" | "clarify" | "de_escalate";

export interface IntakeTransition {
  readonly next: IdentityIntakeState;
  readonly reply: IntakeReply;
  readonly settled: readonly IntakeSettlement[];
  /** A first name to seal into `next.firstNameEnc`. This module holds no key, so it cannot. */
  readonly holdFirstName: string | null;
  readonly name: IntakeNameWrite | null;
  /** The location to write once, when the last planned location step settles. */
  readonly location: { readonly state?: string; readonly city?: string } | null;
}

/** The line that re-asks a step after a non-answer. */
function reaskLine(why: IntakeNonAnswer): IntakeLine {
  if (why === "abusive") return "de_escalate";
  if (why === "question_back") return "clarify";
  return "retry";
}

/**
 * Advance a PENDING intake by one reply. Pure: the same state and reading always produce the same
 * transition, which is what lets the orchestrator re-run it on a lost CAS.
 */
export function advanceIntake(
  intake: IdentityIntakeState,
  reading: IntakeReading,
): IntakeTransition {
  const step = intake.step;
  if (intake.state !== "pending" || step === null) {
    throw new Error("advanceIntake called on an intake that is not pending");
  }
  const asked = intake.asks[step] ?? 1;

  if (reading.kind === "non_answer" && asked < MAX_INTAKE_ASKS_PER_STEP) {
    return {
      next: { ...intake, asks: { ...intake.asks, [step]: asked + 1 } },
      reply: { kind: "ask", step, line: reaskLine(reading.why) },
      settled: [],
      holdFirstName: null,
      name: null,
      location: null,
    };
  }

  const value = reading.kind === "answer" ? reading.value : null;
  const settlement: IntakeSettlement = {
    step,
    outcome: value === null ? "skipped" : "answered",
    recognized: recognitionOf(step, value),
  };

  let remaining = [...intake.remaining];
  let heldState = intake.heldState;
  let holdFirstName: string | null = null;
  let name: IntakeNameWrite | null = null;
  let location: { state?: string; city?: string } | null = null;

  switch (step) {
    case "first_name": {
      const surnameAhead = remaining.includes("last_name");
      if (value === null || (reading.kind === "answer" && reading.fullName) || !surnameAhead) {
        // A skipped first name asks no surname (there is nothing to attach it to); a two-word first
        // answer IS the full name (D3). Either way the surname step leaves the plan unasked.
        remaining = remaining.filter((next) => next !== "last_name");
        if (value !== null) name = { kind: "full", value };
      } else {
        holdFirstName = value;
      }
      break;
    }
    case "last_name":
      name = { kind: "held", surname: value };
      break;
    case "state":
      heldState = value;
      if (!remaining.includes("city")) {
        location = locationOf(heldState, null);
        heldState = null;
      }
      break;
    case "city":
      location = locationOf(heldState, value);
      heldState = null;
      break;
  }

  const [nextStep, ...rest] = remaining;
  const asks = nextStep === undefined ? intake.asks : { ...intake.asks, [nextStep]: 1 };
  const next: IdentityIntakeState =
    nextStep === undefined
      ? { state: "settled", step: null, remaining: [], asks, firstNameEnc: null, heldState: null }
      : {
          state: "pending",
          step: nextStep,
          remaining: rest,
          asks,
          // The sealed first name survives only while the surname is still to come; the service
          // replaces this null with the new seal when `holdFirstName` is set.
          firstNameEnc: nextStep === "last_name" ? intake.firstNameEnc : null,
          heldState,
        };

  return {
    next,
    reply:
      nextStep === undefined
        ? { kind: "handoff" }
        : { kind: "ask", step: nextStep, line: "prompt" },
    settled: [settlement],
    holdFirstName,
    name,
    location,
  };
}

function locationOf(
  state: string | null,
  city: string | null,
): { state?: string; city?: string } | null {
  if (state === null && city === null) return null;
  return { ...(state === null ? {} : { state }), ...(city === null ? {} : { city }) };
}

/** The gazetteer verdict for the event: did the state or city resolve to a canonical value? */
function recognitionOf(step: IntakeStep, value: string | null): boolean | null {
  if (value === null) return null;
  if (step === "state") return canonicalState(value) !== null;
  if (step === "city") return canonicalCity(value) !== null;
  return null;
}

/**
 * The full name to record from the sealed first name and the surname step (D2).
 *
 * NULL WHEN THE FIRST NAME CANNOT BE READ BACK — a surname is never written as a whole name. And
 * when the two together break the `/name` bound (80 characters), the first name alone is written
 * rather than a truncated one: a name cut mid-word on a résumé is worse than a shorter true one.
 *
 * A SURNAME ANSWER THAT OPENS WITH THE FIRST NAME is the worker giving his whole name again ("Aapka
 * surname kya hai?" → "Ramesh Kumar"), so that leading word is dropped rather than written twice.
 * The held first name is always ONE word (a longer first answer was the full name, D3), so the
 * comparison is one word against one word.
 */
export function composeFullName(firstName: string | null, surname: string | null): string | null {
  if (firstName === null) return null;
  const rest = surname === null ? null : withoutLeadingWord(surname, firstName);
  const joined = rest === null ? firstName : `${firstName} ${rest}`;
  const parsed = SetMyNameSchema.shape.full_name.safeParse(joined);
  if (parsed.success) return parsed.data;
  const alone = SetMyNameSchema.shape.full_name.safeParse(firstName);
  return alone.success ? alone.data : null;
}

/** `text` without a leading `word` (case-insensitive, whole word); null when nothing is left. */
function withoutLeadingWord(text: string, word: string): string | null {
  const [lead, ...rest] = text.trim().split(/[ \t\r\n]+/);
  if (lead === undefined || foldWord(lead) !== foldWord(word)) return text;
  return rest.length === 0 ? null : rest.join(" ");
}
