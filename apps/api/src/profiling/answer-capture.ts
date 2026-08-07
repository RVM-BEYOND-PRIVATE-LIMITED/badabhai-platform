/**
 * Answer capture. PURE: `(text, askedItem, state) -> Capture`.
 *
 * Runs on EVERY turn, at capture time — not at parse time. That timing is the whole reason the
 * system can fail closed: because `value_normalized` is already populated when the interview ends,
 * a profile can be projected from the answer map alone when the parse call is down, blocked, or
 * fails its provenance gates.
 *
 * Every detector here comes from `@badabhai/profiling-lexicon`, which is the same data
 * `signals.py` reads. A cue list that changes on one side turns the other side's suite red, so the
 * orchestrator and the extraction path cannot drift into disagreeing about what a worker said.
 */

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import {
  applyNegation,
  canonicalCity,
  classifyUtterance,
  detectSalaries,
  parseAvailability,
  parseExperienceYears,
  parseRelocationWillingness,
  type UtteranceClass,
} from "@badabhai/profiling-lexicon";

import type { AnswerMap, CapturedValue } from "./answer-map";

/** What one worker turn produced. */
export interface Capture {
  /** The utterance class, from the shared predicate lexicon. */
  readonly turnClass: UtteranceClass;
  /** Values to write. Empty for every non-answer class. */
  readonly values: readonly CapturedValue[];
  /**
   * The message is buffered either way — the AUDIT stays honest — but this flags it so the model
   * never sees it. Abuse is recorded and excluded, not silently dropped.
   */
  readonly excludeFromParse: boolean;
  /** The worker explicitly declined ("nahi pata"): a COMPLETE answer, never re-asked. */
  readonly declined: boolean;
  /** An explicit correction ("nahi, 5 saal nahi 7 saal"), which overrides the commit rule. */
  readonly correcting: boolean;
}

/**
 * THE OVERWRITE RULE. May this detected value be written?
 *
 * 1. **The question being asked always commits** — it is the deliberate answer to the question on
 *    screen, including the bounded re-ask where a second, better answer must replace the first.
 * 2. **An explicit correction commits**, whatever question is on screen — the worker is overriding
 *    on purpose.
 * 3. **Otherwise: first write wins.** A cross-question signal picked up in passing may FILL an
 *    empty slot (free information) but may never overwrite one the worker already established.
 *    Without this, mentioning a city while answering the salary question would rewrite an
 *    established location.
 */
export function mayCommit(
  answers: AnswerMap,
  questionKey: string,
  askedQuestionKey: string | null,
  correcting: boolean,
): boolean {
  if (questionKey === askedQuestionKey || correcting) return true;
  return answers[questionKey] === undefined;
}

/**
 * Field id → the lexicon normalizer that types it.
 *
 * Keyed on the RFS `target_field`, not on `answer_type`, because two number fields can need
 * completely different parsers — years and rupees-per-month share a type and share nothing else.
 *
 * THE KEYS ARE RFS IDS AND NOTHING ELSE (`RFS_FIELD_IDS` in `@badabhai/db`), asserted by a test.
 * A key spelled as the WorkerProfileDraft column instead — `willing_to_relocate` rather than
 * `relocation_willingness` — matches no pack question, so the field silently falls through to the
 * verbatim path and stores a whole sentence where a boolean belongs. `notice_period_days` is the
 * deliberate exception: it is an `attribute` target, never an `rfs` one.
 * A field with no entry falls through to the verbatim path, which is correct for free text and for
 * chip answers whose label IS the value.
 */
const NORMALIZER_BY_FIELD: Readonly<Record<string, (text: string) => unknown>> = {
  current_city: (text) => canonicalCity(text)?.value ?? null,
  experience_years: (text) => parseExperienceYears(text)?.value ?? null,
  salary_expected: (text) => detectSalaries(text).expected?.value ?? null,
  salary_current: (text) => detectSalaries(text).current?.value ?? null,
  availability: (text) => parseAvailability(text)?.value.availability ?? null,
  notice_period_days: (text) => parseAvailability(text)?.value.noticeDays ?? null,
  relocation_willingness: (text) => parseRelocationWillingness(text)?.value ?? null,
};

/**
 * Does this target field have a TYPED normalizer?
 *
 * The gate on cross-question capture, and it is load-bearing rather than an optimization. A
 * free-text question's "normalizer" is the identity — the worker's whole message IS the answer —
 * so running the cross-question path over free-text items would fill every one of them with the
 * entire message the moment a worker said anything at all. Only fields with a real parser can
 * claim a value they were not asked for.
 */
export function hasFieldNormalizer(field: string | null): boolean {
  return field !== null && field in NORMALIZER_BY_FIELD;
}

/**
 * The field ids this file can type. Exported so a test can assert they are REAL vocabulary ids
 * rather than plausible-looking ones — the defect that shipped was a key nothing could ever match.
 */
export const NORMALIZED_FIELDS: readonly string[] = Object.keys(NORMALIZER_BY_FIELD);

/**
 * Was the detected value negated?
 *
 * Checked against the span the normalizer reported, not against the whole message: "Pune nahi
 * jaunga" mentions Pune and refuses it, and a whole-message check would either lose the city
 * everywhere it appears or keep it everywhere it is refused.
 */
function isVetoed(text: string, span: { start: number; end: number } | undefined): boolean {
  if (!span) return false;
  return applyNegation(text).spans.some(([s, e]) => s < span.end && span.start < e);
}

/**
 * Normalize the worker's text for one pack item.
 *
 * Returns `undefined` when nothing usable was found, which is DISTINCT from a captured `null`: the
 * former means "we could not read an answer here", the latter means "we read one and it is empty".
 * Only the former leaves the question askable again.
 */
function normalizeFor(item: QuestionPackItem, text: string): unknown | undefined {
  // A chip answer is the worker's answer of record VERBATIM. The label is reviewed static data, so
  // there is nothing to normalize and nothing to second-guess.
  const chip = item.options.find(
    (option) => option.label_text.toLowerCase() === text.trim().toLowerCase(),
  );
  if (chip) return chip.value ?? chip.label_text;

  const field = item.target_field;
  const normalizer = field ? NORMALIZER_BY_FIELD[field] : undefined;
  if (!normalizer) {
    // Free text: the worker's words are the answer. Trimmed, never rewritten.
    //
    // No empty-check, deliberately. `classifyUtterance` already returned `empty` for anything
    // that trims to under two characters, and this line is only reached past that gate — so an
    // `|| undefined` here would be unreachable code pretending to be a safety net.
    return text.trim();
  }

  const value = normalizer(text);
  return value === null ? undefined : value;
}

/**
 * Capture one worker turn against the question on screen.
 *
 * IT DOES NOT TAKE THE ANSWER MAP. Capture only ever writes the question ON SCREEN, which rule 1
 * of the overwrite rule says always commits — so a map argument here would be decoration. The
 * cross-question rule lives in {@link mayCommit}, which the ORCHESTRATOR calls with the map when it
 * folds a value detected in passing.
 *
 * PRECEDENCE IS THE SHARED LEXICON'S, not this file's: `classifyUtterance` already decides that a
 * correction beats a question-back, and that an abusive turn beats everything. Re-deciding it here
 * would be a second precedence table free to disagree with the one the extraction path uses.
 */
export function captureAnswer(text: string, askedItem: QuestionPackItem | null): Capture {
  const signal = classifyUtterance(text);
  const turnClass = signal.cls;

  if (turnClass === "abusive") {
    return { turnClass, values: [], excludeFromParse: true, declined: false, correcting: false };
  }
  if (turnClass === "empty" || turnClass === "hardship" || turnClass === "question_back") {
    // None of these is an answer, and none of them is the worker's fault. They consume a TURN and
    // are handled by the orchestrator (acknowledge, clarify, or simply wait) — never an ASK.
    return { turnClass, values: [], excludeFromParse: false, declined: false, correcting: false };
  }
  if (turnClass === "dont_know") {
    return { turnClass, values: [], excludeFromParse: false, declined: true, correcting: false };
  }

  const correcting = turnClass === "correction";
  if (!askedItem) {
    return { turnClass, values: [], excludeFromParse: false, declined: false, correcting };
  }

  const normalized = normalizeFor(askedItem, text);
  if (normalized === undefined) {
    return { turnClass, values: [], excludeFromParse: false, declined: false, correcting };
  }

  // The negation veto is checked LAST, so a value that was found and then refused is reported as
  // "no answer here" rather than as a wrong answer. "abhi kaam nahi mil raha" must never become
  // availability: immediate.
  const span = spanFor(askedItem, text);
  if (isVetoed(text, span)) {
    return { turnClass, values: [], excludeFromParse: false, declined: false, correcting };
  }

  // NOTE there is no `mayCommit` call here, and that is deliberate. This function only ever
  // captures for the question ON SCREEN, which rule 1 says always commits — so a guard here would
  // be unreachable code pretending to be a safety net. `mayCommit` is exported for the
  // ORCHESTRATOR's cross-question path, where a value detected in passing must not overwrite one
  // the worker already established.
  return {
    turnClass,
    values: [
      {
        questionKey: askedItem.question_key,
        targetField: askedItem.target_field,
        valueRaw: text.trim(),
        valueNormalized: normalized,
        // Evidence is attached by the orchestrator, which is the only thing that knows the
        // message's index in the transcript. A pure function has no transcript.
        evidence: null,
      },
    ],
    excludeFromParse: false,
    declined: false,
    correcting,
  };
}

/** The span the field's normalizer reported, for the negation veto. */
function spanFor(item: QuestionPackItem, text: string): { start: number; end: number } | undefined {
  switch (item.target_field) {
    case "current_city":
      return canonicalCity(text)?.span;
    case "experience_years":
      return parseExperienceYears(text)?.span;
    case "salary_expected":
      return detectSalaries(text).expected?.span;
    case "salary_current":
      return detectSalaries(text).current?.span;
    case "availability":
    case "notice_period_days":
      return parseAvailability(text)?.span;
    case "relocation_willingness":
      return parseRelocationWillingness(text)?.span;
    default:
      // Free text and chips have no sub-span to veto: the whole message IS the answer, and
      // vetoing it wholesale would delete answers containing an unrelated negation.
      return undefined;
  }
}
