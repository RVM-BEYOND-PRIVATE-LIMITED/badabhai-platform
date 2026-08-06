/**
 * Availability, notice period and relocation willingness — a faithful port of
 * `signals._has_immediate_cue`, `_has_notice_cue`, `_notice_period_days`, `_self_state_blocked`
 * and `_has_relocate_cue`, against the same `data/availability.json` the Python side reads.
 *
 * BOTH FAMILIES EXIST BECAUSE THEY WERE FABRICATING (#424 follow-up and #437, each a measured
 * post-merge finding). The cues used to be bare substrings, and "abhi" merely means "right now" —
 * the question bank's own questions open with it, so the natural answer to our own question
 * invented an availability the worker never stated. Both fields are live: availability is a reach
 * scoring signal and both render on the worker's resume.
 *
 * THE RULE: a cue must be a GENUINE statement, matched with boundaries AND adjacency — a place
 * next to a going verb, a time adverb next to a join intent.
 *
 * FAIL DIRECTION IS TOWARD "unknown". `availability` is a MUST_ASK topic, so an undetected one is
 * simply asked. A FABRICATED one is never corrected.
 */

import { compileIn, compileList, loadLexicon } from "../internal/regex.js";
import { applyNegation, precededByNegator } from "./negation.js";
import type { Availability, NormalizedValue } from "./types.js";

interface AvailabilityFile {
  readonly selfStateWindowBefore: number;
  readonly selfStateWindowAfter: number;
  readonly preNegatorLookback: number;
  readonly askedNoticeBlockWindow: number;
  readonly wordNumbers: Readonly<Record<string, number>>;
  readonly unitDays: readonly (readonly [string, number])[];
}

const AVAILABILITY = loadLexicon<AvailabilityFile>("availability");

const ANYWHERE = compileList("availability", "anywhereCues");
const RELOCATE = compileList("availability", "relocateCues");
const IMMEDIATE_STRONG = compileList("availability", "immediateStrong");
const IMMEDIATE_SELF_STATE = compileList("availability", "immediateSelfState");
const IMMEDIATE_NEGATION_BEARING = compileList("availability", "immediateNegationBearing");
const SELF_STATE_BEFORE = compileList("availability", "selfStateBefore");
const SELF_STATE_AFTER = compileList("availability", "selfStateAfter");
const NOTICE = compileList("availability", "noticeCues");
const ASKED_NOTICE_SPAN = compileIn("availability", "askedNoticeSpan");
const ASKED_NOTICE_BLOCKERS = compileList("availability", "askedNoticeBlockers");
const ASKED_IMMEDIATE = compileList("availability", "askedImmediate");

/** `[start, end)` of a matched cue. */
type Span = readonly [number, number];

/** Walk every match of `pattern` in `text`, with offsets. Mirrors Python's `finditer`. */
function* eachMatch(pattern: RegExp, text: string): Generator<Span> {
  const global = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const m of text.matchAll(global)) yield [m.index, m.index + m[0].length] as const;
}

/**
 * True when a SELF-STATE cue is not about the worker being free NOW.
 * `signals._self_state_blocked`.
 *
 * Windowed rather than whole-message, so a later unrelated clause cannot suppress a real answer.
 */
export function selfStateBlocked(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - AVAILABILITY.selfStateWindowBefore), start);
  const after = text.slice(end, end + AVAILABILITY.selfStateWindowAfter);
  return (
    SELF_STATE_BEFORE.some((p) => p.test(before)) || SELF_STATE_AFTER.some((p) => p.test(after))
  );
}

/**
 * True when the cue at `[start, end)` sits inside a NEGATED span. `signals._negation_vetoed`.
 *
 * Availability is matched against the RAW text and the masked text is used as a VETO rather than
 * as the input — deliberately. Masking blanks a backward window from the negator, which would
 * delete the "kaam" out of "kaam nahi kar raha", a phrase whose negator is what makes it mean
 * *available*. Masking preserves LENGTH, so a plain slice comparison is exact.
 */
function negationVetoed(masked: string, raw: string, start: number, end: number): boolean {
  return masked.slice(start, end) !== raw.slice(start, end);
}

/** Both halves of the veto: inside a negated span, or a negator directly in front. */
function availabilityNegated(masked: string, raw: string, start: number, end: number): boolean {
  return (
    negationVetoed(masked, raw, start, end) ||
    precededByNegator(raw, start, AVAILABILITY.preNegatorLookback)
  );
}

/**
 * The span of the first surviving "can start now" cue, or null.
 *
 * Strong cues fire on their own; self-state cues must also survive {@link selfStateBlocked}. Both
 * are vetoed when the phrase is NEGATED. Negation-bearing cues are matched separately and are
 * never vetoed, because their negator IS the signal.
 */
export function firstImmediateCue(text: string, masked?: string): Span | null {
  const vetoed = (start: number, end: number): boolean =>
    masked !== undefined && availabilityNegated(masked, text, start, end);

  for (const pattern of IMMEDIATE_STRONG) {
    for (const [start, end] of eachMatch(pattern, text)) {
      if (!vetoed(start, end)) return [start, end] as const;
    }
  }
  for (const pattern of IMMEDIATE_SELF_STATE) {
    for (const [start, end] of eachMatch(pattern, text)) {
      if (!selfStateBlocked(text, start, end) && !vetoed(start, end)) return [start, end] as const;
    }
  }
  for (const pattern of IMMEDIATE_NEGATION_BEARING) {
    for (const [start, end] of eachMatch(pattern, text)) {
      if (!selfStateBlocked(text, start, end)) return [start, end] as const;
    }
  }
  return null;
}

/** The span of the first surviving notice-period cue, or null. */
export function firstNoticeCue(text: string, masked?: string): Span | null {
  for (const pattern of NOTICE) {
    for (const [start, end] of eachMatch(pattern, text)) {
      if (masked === undefined || !availabilityNegated(masked, text, start, end)) {
        return [start, end] as const;
      }
    }
  }
  return null;
}

/** True when a bare duration in an availability-context message is not a notice. */
function askedNoticeBlocked(text: string, start: number, end: number): boolean {
  const window =
    text.slice(Math.max(0, start - AVAILABILITY.askedNoticeBlockWindow), start) +
    " " +
    text.slice(end, end + AVAILABILITY.askedNoticeBlockWindow);
  return ASKED_NOTICE_BLOCKERS.some((p) => p.test(window));
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

function toAscii(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const index = DEVANAGARI_DIGITS.indexOf(ch);
    out += index >= 0 ? String(index) : ch;
  }
  return out;
}

/** `"15 din"` → 15, `"do mahine"` → 60, `"ek hafta"` → 7. `signals._notice_days`. */
function noticeDays(num: string, unit: string): number | null {
  const lowNum = num.toLowerCase();
  const lowUnit = unit.toLowerCase();
  let value = AVAILABILITY.wordNumbers[lowNum];
  if (value === undefined) {
    // Devanagari digits reach here because the matcher accepts them (Python's `\d` did), so a
    // quantity that MATCHED must not then fail to convert and be silently dropped.
    const parsed = Number.parseInt(toAscii(lowNum), 10);
    if (!Number.isInteger(parsed)) return null;
    value = parsed;
  }
  for (const [stem, days] of AVAILABILITY.unitDays) {
    if (lowUnit.startsWith(stem)) return value * days;
  }
  return null;
}

/** The matched duration plus its span, or null. */
function firstNoticeDuration(text: string, masked?: string): { days: number; span: Span } | null {
  const global = new RegExp(ASKED_NOTICE_SPAN.source, `${ASKED_NOTICE_SPAN.flags}g`);
  for (const m of text.matchAll(global)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (askedNoticeBlocked(text, start, end)) continue;
    if (masked !== undefined && availabilityNegated(masked, text, start, end)) continue;
    const days = noticeDays(m[1] ?? "", m[2] ?? "");
    if (days !== null) return { days, span: [start, end] as const };
  }
  return null;
}

/**
 * The notice duration IN DAYS, or null. `signals._notice_period_days`.
 *
 * Reads the same spans through the same blocker and negation vetoes as the `notice_period` status
 * it accompanies, so the number can never disagree with the status. Prefers NULL on any
 * ambiguity: a fabricated "15 days" on a worker's resume is worse than a blank, and this field is
 * payer-visible.
 */
export function noticePeriodDays(text: string, masked?: string): number | null {
  return firstNoticeDuration(text, masked)?.days ?? null;
}

/** A bare duration that really does read as "this long until I can join". */
export function askedNoticeDuration(text: string, masked?: string): boolean {
  return firstNoticeDuration(text, masked) !== null;
}

/**
 * True when the whole message reads as "whenever you say".
 *
 * CONTEXT-GATED: only meaningful when the availability question is the one on screen. Bare "abhi"
 * stays barred from the context-free path because our own questions open with it.
 */
export function asksImmediateInContext(text: string): boolean {
  return ASKED_IMMEDIATE.some((p) => p.test(text));
}

/** True when the message carries a generality-of-place idiom ("kahin bhi"). */
export function hasAnywhereCue(text: string): boolean {
  return ANYWHERE.some((p) => p.test(text || ""));
}

/** The span of the first surviving relocation cue, or null. */
export function firstRelocateCue(text: string, masked?: string): Span | null {
  for (const pattern of RELOCATE) {
    for (const [start, end] of eachMatch(pattern, text)) {
      if (masked === undefined || !negationVetoed(masked, text, start, end)) {
        return [start, end] as const;
      }
    }
  }
  return null;
}

/**
 * Availability plus notice period, or null when the message states neither.
 *
 * IMMEDIATE WINS over a notice period when both fire: "abhi join kar sakta hu, 15 din me" is a
 * worker saying they can start now. The Python composes the same precedence in
 * `detect_answered_topics`.
 *
 * Never returns `"not_looking"` or `"unknown"` — those are the orchestrator's to record from a
 * declined or unasked question, not something to infer from free text.
 */
export function parseAvailability(
  text: string,
): NormalizedValue<{ availability: Availability; noticeDays: number | null }> | null {
  const message = text || "";
  const { masked } = applyNegation(message);

  const immediate = firstImmediateCue(message, masked);
  if (immediate) {
    return {
      value: { availability: "immediate", noticeDays: null },
      span: { start: immediate[0], end: immediate[1] },
      // The veto already ran inside the cue search, so a surviving cue is never negated. Reported
      // as false rather than recomputed, so the two can never disagree.
      negationVetoed: false,
    };
  }

  const notice = firstNoticeCue(message, masked);
  if (notice) {
    return {
      value: { availability: "notice_period", noticeDays: noticePeriodDays(message, masked) },
      span: { start: notice[0], end: notice[1] },
      negationVetoed: false,
    };
  }
  return null;
}

/**
 * Willingness to relocate, or null. `signals._has_relocate_cue`, negation-guarded.
 *
 * Only ever returns `true`: a message with no cue returns null, because "did not say" is not
 * "said no". Recording `false` from silence is the fabrication this detector was rewritten to
 * stop, in the opposite direction.
 */
export function parseRelocationWillingness(text: string): NormalizedValue<boolean> | null {
  const message = text || "";
  const { masked } = applyNegation(message);
  const cue = firstRelocateCue(message, masked);
  if (!cue) return null;
  return {
    value: true,
    span: { start: cue[0], end: cue[1] },
    negationVetoed: false,
  };
}
