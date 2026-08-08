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
  crosswalkFor,
  detectSalaries,
  parseAffirmation,
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
  //
  // A `multi_select` chip is still a LIST OF ONE. Returning the bare value here would make the
  // same question produce a different SHAPE depending on whether the worker tapped the chip or
  // said the words — and since `value_kind` is derived from the shape, that is the difference
  // between a `text` row and a `text_list` row in `worker_attributes` for one attribute.
  const chip = item.options.find(
    (option) => option.label_text.toLowerCase() === text.trim().toLowerCase(),
  );
  if (chip) {
    const value = chip.value ?? chip.label_text;
    return keepIfWellTyped(item, item.answer_type === "multi_select" ? [value] : value);
  }

  const field = item.target_field;
  const normalizer = field ? NORMALIZER_BY_FIELD[field] : undefined;
  if (normalizer) {
    const value = normalizer(text);
    if (value !== null) return value;
    // THE TYPED PARSER FOUND NOTHING — that is not the same as the worker not answering, and
    // returning `undefined` straight from here was throwing away the item's own reviewed chips.
    //
    // Measured, not theorised: `availability` and `relocation` are the only two items in the whole
    // corpus that carry BOTH a typed target field and options, and both live in `qp_universal`, so
    // every interview asks them. `parseRelocationWillingness` returns null for every one of that
    // item's three chip labels; `parseAvailability` reads "Abhi turant" and none of the other
    // three. Short-circuiting meant the reviewed options were never consulted for either.
    //
    // Falls through to the ANSWER TYPE only, never onward to verbatim. That distinction is the
    // whole safety of this branch: a typed field whose parser abstained must not end up holding a
    // whole sentence, because `salary_expected` and `current_city` are matched on by equality and
    // by range. No option matched still means unread.
    const byType = normalizeByAnswerType(item, text);
    return byType === FALL_THROUGH ? undefined : keepIfWellTyped(item, byType);
  }

  // NO FIELD NORMALIZER — try the ANSWER TYPE before falling through to verbatim.
  //
  // This layer exists because the field-keyed table above cannot serve the bulk of the corpus:
  // 236 items are `boolean` and 45 are `multi_select`, spread across 80 distinct target fields
  // that share nothing but their SHAPE. Keying those on the field would mean 80 near-identical
  // entries; keying them on the type is one entry each.
  //
  // It sits BELOW the field table on purpose. Two number fields can need completely different
  // parsers — years and rupees-per-month share a type and share nothing else — so a type-keyed
  // rule must never get to override a field-keyed one.
  const byType = normalizeByAnswerType(item, text);
  if (byType !== FALL_THROUGH) return byType;

  // Free text: the worker's words are the answer. Trimmed, never rewritten.
  //
  // No empty-check, deliberately. `classifyUtterance` already returned `empty` for anything
  // that trims to under two characters, and this line is only reached past that gate — so an
  // `|| undefined` here would be unreachable code pretending to be a safety net.
  return text.trim();
}

/**
 * Refuse an option-derived value that CONTRADICTS the type its target field declares.
 *
 * Applied only to values that came from a chip — never to a normalizer's output (already typed by
 * construction) and never to verbatim text (a free-text field has no declared shape to violate).
 *
 * WHY IT HAS TO EXIST. Option values are authored by a human in a JSONL corpus and land in one of
 * three typed columns, while the field's real type lives in `FIELD_CROSSWALK`. Nothing structurally
 * forces the two to agree, and measured against the shipped corpus they do not: `relocation` is a
 * `boolean` field offering three chips, two carrying `value_bool` and the third carrying the TEXT
 * "conditional". Tapping that third chip put a string into `z.boolean()` and failed the entire
 * extraction job — not the one field, the whole profile.
 *
 * Refusing is the right half of that trade under CLAUDE.md §3. The worker loses one answer and
 * keeps a profile; writing it through loses the profile. It also fails LOUDLY in the corpus rather
 * than silently at Zod: a pack whose chips disagree with their field now shows up as a question
 * that never captures, which is exactly the shape `db:verify:packs` should learn to reject.
 */
function keepIfWellTyped(item: QuestionPackItem, value: unknown): unknown | undefined {
  const entry = item.target_field ? crosswalkFor(item.target_field) : undefined;
  // No declared type — a pack-local attribute, or a field outside the RFS vocabulary. Nothing to
  // contradict, so nothing to refuse.
  if (entry === undefined) return value;
  switch (entry.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "string":
    case "enum":
      return typeof value === "string" ? value : undefined;
    case "string_array":
      // A `multi_select` already wraps; a `single_select` on a list field contributes one item.
      return Array.isArray(value) || typeof value === "string" ? value : undefined;
    default:
      return value;
  }
}

/**
 * Sentinel for "this type has no opinion — keep going".
 *
 * DISTINCT FROM `undefined`, which already means "we could not read an answer here" and leaves the
 * question askable. Collapsing the two would make a `text` item's silence indistinguishable from a
 * `boolean` item's, and one of those should fall through to verbatim while the other must not.
 */
const FALL_THROUGH = Symbol("fall-through");

/**
 * Normalize by `answer_type` — the layer that makes the spoken corpus answerable at all.
 *
 * WHAT IT FIXES. Before this, a `boolean` item stored the sentence "haan bilkul karta hoon" as its
 * value, and a `multi_select` stored a whole sentence unless the worker's words happened to equal
 * one chip label exactly. Both were measured against the shipped corpus, not imagined: all 236
 * boolean items carry ZERO options, so there has never been a chip to match.
 */
function normalizeByAnswerType(
  item: QuestionPackItem,
  text: string,
): unknown | undefined | typeof FALL_THROUGH {
  switch (item.answer_type) {
    case "boolean": {
      // `undefined`, never a guessed `false`. A boolean question answered with "kabhi kabhi" is
      // ambiguous, and recording a `false` the worker did not say puts it in a column the matcher
      // filters on. Leaving it unread costs one re-ask.
      const parsed = parseAffirmation(text);
      return parsed === null ? undefined : parsed.value;
    }
    case "multi_select": {
      const matched = matchOptions(item, text);
      if (matched.length > 0) return matched;
      return closedVocabulary(item) ? undefined : FALL_THROUGH;
    }
    case "single_select": {
      const matched = matchOptions(item, text);
      // Exactly one, or nothing. Two option labels in one utterance is a worker who has not
      // answered a single-choice question, and picking the first would be picking at random.
      if (matched.length === 1) return matched[0];
      return closedVocabulary(item) ? undefined : FALL_THROUGH;
    }
    default:
      return FALL_THROUGH;
  }
}

/**
 * Does this item's destination hold a CLOSED vocabulary?
 *
 * THE DESTINATION DECIDES, and this is the whole reason select items are not treated uniformly.
 *
 * An `attribute` select lands in `worker_attributes.value_text` — a column the matcher filters on
 * by equality. A sentence there is not a worse value, it is an UNMATCHABLE one: nothing will ever
 * query `value_text = 'main workshop mein kaam karta hoon'`. Better to leave the question
 * unanswered and honest.
 *
 * An `rfs` select lands on the profile draft, where `skills` is a free-form list that the skill
 * canonicalization path already owns — 41 of the 45 `multi_select` items are exactly that. There,
 * the worker's own words are strictly more information than nothing, and dropping them would be a
 * coverage regression for the sake of tidiness.
 */
function closedVocabulary(item: QuestionPackItem): boolean {
  return item.target_kind === "attribute";
}

/**
 * Alternatives inside one chip label. Hinglish "ya" and Hindi "या" both mean "or".
 *
 * A LABEL IS WORKER-FACING COPY, NOT A TOKEN, and that is why this exists. The welding pack
 * offers "Loha ya mild steel" — *iron or mild steel* — as ONE option, because a chip has to be
 * readable. A worker who says "mild steel aur stainless steel" names both materials, but matching
 * whole labels finds only the stainless one, because "Loha ya mild steel" is not a substring of
 * anything anyone says. Measured on a real session against the seeded corpus, not imagined.
 */
const LABEL_ALTERNATIVES = /\s+ya\s+|\s+या\s+|\s*\/\s*/;

/** Needles worth searching for, longest first. Short fragments are dropped as noise. */
function needlesFor(labelText: string): string[] {
  const whole = labelText.toLowerCase().trim();
  const parts = whole
    .split(LABEL_ALTERNATIVES)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
  // The whole label first: when a worker DOES say it in full, that is the strongest evidence and
  // it should consume its characters before any fragment of it can.
  return [...new Set([whole, ...parts])].sort((a, b) => b.length - a.length);
}

/**
 * Which of this item's options the worker's words contain.
 *
 * Substring, case-insensitive, against the NEGATION-MASKED text — so "split AC hai, fridge nahi"
 * yields `split_ac` alone. Reusing the negation engine here rather than scanning the raw string is
 * what stops a refused option from being recorded as a claimed one.
 *
 * Longest needle first, ACROSS options, so a label that contains another ("Split AC" vs "AC")
 * claims its characters before the shorter one can. Sorting per-option was not enough once labels
 * decomposed into alternatives: a two-character-longer fragment of option B must not lose to the
 * whole label of option A merely because A was scanned first.
 */
function matchOptions(item: QuestionPackItem, text: string): unknown[] {
  const masked = applyNegation(text).masked.toLowerCase();

  const needles = item.options
    .flatMap((option) => needlesFor(option.label_text).map((needle) => ({ option, needle })))
    .sort((a, b) => b.needle.length - a.needle.length);

  let remaining = masked;
  const hits = new Map<string, { order: number; value: unknown }>();
  for (const { option, needle } of needles) {
    if (hits.has(option.option_key)) continue; // one hit per option, whichever needle landed first
    const at = remaining.indexOf(needle);
    if (at < 0) continue;
    // Consume the matched characters so a shorter contained needle cannot double-count them.
    // Replaced with spaces rather than deleted, to keep every other offset where it was.
    remaining =
      remaining.slice(0, at) + " ".repeat(needle.length) + remaining.slice(at + needle.length);
    hits.set(option.option_key, {
      order: masked.indexOf(needle),
      value: option.value ?? option.label_text,
    });
  }

  // Report in the order the worker SAID them, not in the order we happened to scan.
  return [...hits.values()].sort((a, b) => a.order - b.order).map((hit) => hit.value);
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
      //
      // THIS MUST NOT GROW A `boolean` CASE, and the reason is not obvious. `parseAffirmation`
      // already resolves negation itself and returns `false` for a denied yes — that IS the
      // answer. Returning its span here would hand that same negation to the veto below, which
      // would then discard the value entirely. Every worker who said "nahi" would be recorded as
      // having said nothing.
      return undefined;
  }
}
