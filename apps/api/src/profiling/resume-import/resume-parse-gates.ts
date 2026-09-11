/**
 * The SECOND wall for a résumé parse — and an honest account of how much of it there is.
 *
 * `parse-gates.ts` is the Nest half of the interview's double wall: the same six gates the
 * ai-service runs, run again before anything is persisted, because two walls that agree are
 * worth more than one wall that is trusted. On this route that argument is stronger, not
 * weaker: ADR-0041 D5 lets the far wall run under a masking policy the owner can flip, which
 * is exactly when a second opinion earns its keep.
 *
 * ── BUT IT IS NOT THE WHOLE SIX, AND SAYING SO MATTERS ───────────────────────────────────
 *
 * The ai-service fetches and extracts the document ITSELF, so the résumé's lines never reach
 * this process. That is a deliberate privacy property — the text exists in exactly one
 * process and leaves it only as gated values — and it has a direct consequence:
 *
 *   1. PROVENANCE — CANNOT RUN HERE. There is no evidence store to check a quote against.
 *                   Re-checking `evidence.quote` against itself would be a wall that always
 *                   passes, which is worse than no wall: it reads as coverage.
 *   2. ROLE       — CANNOT RUN HERE, same reason.
 *   3. TYPE/RANGE — RUNS. Nothing about it needs the document.
 *   4. AGREEMENT  — NOT APPLICABLE. No interview has happened; there is no answer map.
 *   5. VOCABULARY — RUNS, and it is the cheap one worth repeating: a field id nobody asked
 *                   for should never have been transported at all.
 *   6. PII        — RUNS, AND IT IS THE POINT. This process is the one that WRITES, so the
 *                   last check before persistence belongs here. It is also the gate D5's
 *                   §3.3 singles out: the document may reach the model, but a PAN must never
 *                   reach `worker_attributes`, an event, a log, or the sheet. It runs over
 *                   the field's VALUE and over its cited SPAN — see `applyResumeParseGates`
 *                   for why the span needs its own check on this route and on no other.
 *
 * Do not "fix" 1 and 2 by shipping the lines across. That trade — a real second provenance
 * wall in exchange for the whole résumé's text entering this process, its logs and its error
 * paths — is a bad one, and it would quietly undo the reason the far side fetches its own
 * document.
 */

import type { ParsedField, ResumeEmployment, TargetField } from "@badabhai/ai-contracts";

import {
  checkPii,
  checkTypeRange,
  checkVocabulary,
  type GateId,
  type GateResult,
  type PiiCertifier,
  type Rejection,
} from "../parse-gates";

/**
 * The identifier classes that may never reach a stored value, an event, a log or the sheet.
 *
 * A DELIBERATE NARROWING OF GATE 6, NOT A DISABLING OF IT. The interview's certifier is the
 * full pseudonymization gateway, which also masks employer names, person names and money
 * amounts — and D5 EXPLICITLY authorises employer names into `employer_name_enc`. Worse, the
 * gateway's employer pattern over-fires on ordinary trade vocabulary ("Stainless Steel" and
 * "Diploma Mechanical Engineering" both come back masked), which is why
 * `certified_clean_skill_labels` exists on the far side at all. Certifying résumé values with
 * the full gateway would reject nearly every honest value while the ruling says to keep them.
 *
 * MIRRORS `contains_hard_identifier` in `apps/ai-service/app/pseudonymize.py`. The two are
 * pinned to each other by `packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json`,
 * which BOTH suites read — behaviour rather than source, because the credential-id pattern
 * uses an inline `(?i:...)` group JavaScript has no syntax for, so the regexes cannot be
 * byte-identical even when the behaviour is.
 */
export const HARD_IDENTIFIER_CLASSES = [
  "pan",
  "aadhaar",
  "phone",
  "email",
  "credential_id",
  // Added after the RI-3 security review measured the first draft's claim wrong: the phone
  // pattern is bounded ABOVE at 13 digits, and the residual-digit net that used to cover
  // everything longer is the thing this wall deliberately excludes. A bank account (9-18
  // digits) and an ESIC number (17) walked straight through.
  "long_digit_run",
  // A GSTIN embeds a PAN with no word boundary either side, so PAN_RE misses it.
  "gstin",
] as const;
export type HardIdentifierClass = (typeof HARD_IDENTIFIER_CLASSES)[number];

const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/;

// DIGIT-COUNT based, not character-count based, and mirroring `_PHONE_SEPARATORS` in
// `apps/ai-service/app/pseudonymize.py` CHARACTER FOR CHARACTER.
//
// THE FIRST VERSION CLAIMED TO MIRROR IT AND DID NOT, in both directions: it was missing
// `;` `|` and the whole Unicode set (dash family, bullets, zero-width joiners, the
// Devanagari dandas that Hindi ASR emits), and it ADDED `/` and `\` which the far side does
// not have. So `98765;43210` blocked over there only and `98765/43210` blocked here only —
// and the 25-case fixture that is the stated reason a source-comparison test was not written
// contained no separator but a space, so it verified none of the divergence. The fixture now
// carries those cases; this set is what makes them pass.
//
// `/` AND `\` ARE DELIBERATELY ABSENT rather than added to both. They are absent from the
// gateway's set too (a known R30 residual), and widening the SHARED pattern is a change to
// what the interview masks — not something a résumé PR gets to do. The fixture records
// `98765/43210` as permitted on both sides so the gap is a known, pinned fact rather than a
// difference of opinion between two files.
const PHONE_SEPARATORS =
  "\\s.,\\-()_;|" +
  "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u00ad" + // dash family + soft hyphen
  "\u00b7\u2022" + // separator-ish punctuation
  "\u0964\u0965\u0970"; // Devanagari danda, double danda, abbreviation sign
const PHONE_RE = new RegExp(`(?<!\\d)\\d(?:[${PHONE_SEPARATORS}]*\\d){8,12}(?!\\d)`);
// Fourteen or more. The floor that cannot collide with money: a salary is 7-8 digits and the
// range ceiling is six figures, while a bank account, an ESIC number and a PF number are all
// 14+.
const LONG_DIGIT_RUN_RE = new RegExp(`(?<!\\d)\\d(?:[${PHONE_SEPARATORS}]*\\d){13,}(?!\\d)`);
// `27ABCDE1234F1Z5` — two state digits, a PAN, then three more characters. The PAN sits
// inside a longer alphanumeric run, so PAN_RE's word boundaries never match it.
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/;

// ZERO-WIDTH AND INVISIBLE CHARACTERS ARE REMOVED BEFORE MATCHING, not listed as separators.
//
// They used to sit in the separator class beside the dashes, which ESLint's
// `no-misleading-character-class` correctly rejects — a joined sequence inside a class does
// not mean what it looks like. Stripping first is what the rule wants AND is strictly
// stronger: the class only ever helped the two digit-run patterns, while this helps PAN,
// Aadhaar and email as well. `9876<ZWJ>543210` was never going to be a legitimate value.
//
// The far side strips the same set in `contains_hard_identifier`, so the shared fixture keeps
// pinning ONE behaviour rather than two that happen to agree on the cases written down.
//
// ALTERNATION, NOT A CHARACTER CLASS, and for the rule's own reason rather than to silence
// it: inside a class, `\u200c\u200d` sitting adjacent reads as a joined sequence, which is
// precisely the ambiguity `no-misleading-character-class` exists to flag. Written as
// alternatives there is nothing to misread \u2014 each branch is one code point.
const INVISIBLE_RE = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;
// Cued identifiers the interview's CREDENTIAL_ID_RE does not name. Cue-based rather than
// shape-based because these shapes are ambiguous: a passport number `M1234567` is
// indistinguishable from a part number, and a date of birth from the date range a résumé
// prints on every line of its work history. The digit lookahead is what stops `\baccount\b`
// plus the next word refusing "Account Manager", which is a job a real worker holds.
const RESUME_CUED_ID_RE =
  /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\s*(?:no\.?|number|num|id|#)?\s*[:-]?\s*(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/i;
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Masked on their CUE rather than their shape — a roll or registration number has no shape
// that an ordinary alphanumeric token does not also have. The bounded lookahead mirrors the
// far side's 64-character ceiling, which bounds work per character rather than input size.
const CREDENTIAL_ID_RE =
  /\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:no\.?|number|num|#)?\s*[:-]?\s*(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/i;

/**
 * Which class of hard identifier appears in `text`, or null. Never throws.
 *
 * DELIBERATELY EXCLUDES the residual-digit net AT SEVEN that the full gateway applies. A
 * salary is seven or eight digits and is a legitimate résumé value.
 *
 * The first draft stopped there and said "nothing escapes through that exclusion — only
 * amounts pass". Measured false by the RI-3 security review: `PHONE_RE` is bounded above at
 * 13 digits and anchored on both sides, so a 14+ digit run matched nothing at any offset.
 * `LONG_DIGIT_RUN_RE` is the floor that closes it without touching salaries.
 */
export function containsHardIdentifier(raw: string): HardIdentifierClass | "scanner_error" | null {
  try {
    const text = raw.replace(INVISIBLE_RE, "");
    if (PAN_RE.test(text)) return "pan";
    if (AADHAAR_RE.test(text)) return "aadhaar";
    if (PHONE_RE.test(text)) return "phone";
    if (EMAIL_RE.test(text)) return "email";
    if (CREDENTIAL_ID_RE.test(text) || RESUME_CUED_ID_RE.test(text)) return "credential_id";
    if (GSTIN_RE.test(text)) return "gstin";
    if (LONG_DIGIT_RUN_RE.test(text)) return "long_digit_run";
  } catch {
    // A scanner error must fail CLOSED. Refusing one honest value costs coverage; admitting
    // one identifier costs the worker something they cannot take back.
    return "scanner_error";
  }
  return null;
}

/**
 * Gate 6's certifier for this route. Blocked, never rewritten.
 *
 * TAKES NO POLICY ARGUMENT, mirroring `resume_value_certifier` on the far side and for the
 * same reason: a `PiiCertifier` and a masker have the same shape, so a parameter here would
 * make it a one-character edit to point the wall at whatever the input policy happens to be.
 * There is deliberately no such parameter to fill in. Rewriting is equally refused — gate 6
 * rejects on altered as well as blocked, and returning a rewritten string would record that
 * the worker's résumé said something it did not.
 */
export const resumeValueCertifier: PiiCertifier = (text: string) => ({
  blocked: containsHardIdentifier(text) !== null,
  text,
});

/**
 * Re-gate the scalar fields of a résumé parse before anything is persisted.
 *
 * THREE GATES, NAMED: vocabulary, type/range, and PII over both the value and its cited span.
 * Gate 4 has no answer map to consult (no interview has happened; precedence is ruling D7 and
 * RI-4's staging layer). Gates 1 and 2 have no evidence store and are ABSENT — not faked, not
 * approximated. The module docblock argues why that is the right trade.
 */
export function applyResumeParseGates(
  fields: Record<string, ParsedField | null>,
  targetFields: readonly TargetField[],
): GateResult {
  // RUNS THE THREE GATES DIRECTLY RATHER THAN CALLING `applyParseGates`, and that is the
  // point of this function rather than a shortcut around it.
  //
  // THE FIRST VERSION DID CALL IT, with a transcript built from each field's OWN quote — the
  // exact construction the module docblock above names as the wall that always passes. That
  // was not merely dishonest, it was a live defect: `lineAt` in `parse-gates.ts` resolves a
  // citation with `find(line => line.i === messageIndex)`, FIRST MATCH WINS. Two fields
  // citing the same résumé line produced two entries with the same `i` and different text, so
  // field #2 was checked against field #1's quote, failed `quote_not_in_message`, and was
  // DROPPED — after the far side had accepted it against the real document. A header line
  // yielding `current_city`, `role_label` and `experience_years` together is the ORDINARY
  // case, so the ordinary case lost two of three fields and logged it as "dropped by the
  // second wall", pointing whoever investigated at the ai-service.
  //
  // Passing an empty transcript instead does not work either: `applyParseGates` returns at
  // the first failing gate, so every field would stop at `provenance` and gate 6 — the gate
  // this side exists to run — would never execute. Hence the explicit loop. The gate
  // FUNCTIONS are still the shared ones, so the rules cannot drift; only the composition
  // differs, because only three of the six have an input on this side.
  const accepted: Record<string, ParsedField> = {};
  const rejections: Rejection[] = [];

  for (const [fieldId, field] of Object.entries(fields)) {
    // A null field is the model saying "I looked and found nothing citable" — an honest
    // answer, not a rejection.
    if (field == null) continue;

    const reject = (gate: GateId, reason: Rejection["reason"]) =>
      rejections.push({ fieldId, gate, reason });

    const vocabulary = checkVocabulary(fieldId, targetFields);
    if (vocabulary) {
      reject("vocabulary", vocabulary);
      continue;
    }

    const target = targetFields.find((t) => t.field_id === fieldId);
    const typeRange = checkTypeRange(fieldId, field.value, target);
    if (typeRange) {
      reject("type_range", typeRange);
      continue;
    }

    const valuePii = checkPii(field.value, resumeValueCertifier);
    if (valuePii) {
      reject("pii", valuePii);
      continue;
    }

    // THE CITED SPAN, which `checkPii` is never given on any route because on every OTHER
    // route it cannot carry anything the value cannot — the transcript was pseudonymized
    // before the model saw it. Here, with the far side's raw-text policy on, a quote is a
    // literal substring of an UNMASKED résumé line, and the line most likely to be cited for
    // `current_city` is the header carrying the phone number and the PAN.
    const spanPii = checkPii(field.evidence.quote, resumeValueCertifier);
    if (spanPii) {
      reject("pii", spanPii);
      continue;
    }

    accepted[fieldId] = field;
  }

  return { accepted, rejections, disagreements: [] };
}

/**
 * Employment rows through the checks this side can make: gate 6 on every string, and the
 * year ordering the contract cannot express.
 *
 * A row that fails is DROPPED AND COUNTED, never repaired. Repairing would mean writing an
 * employer name nobody can point at in the document, which is the one thing this whole design
 * exists to make impossible.
 */
export function filterEmployments(entries: ResumeEmployment[]): {
  kept: ResumeEmployment[];
  rejected: number;
} {
  const kept: ResumeEmployment[] = [];
  let rejected = 0;

  for (const entry of entries) {
    // BOTH strings, not just the employer name. `role_title` is as capable of carrying a
    // phone number, and a model handed an unmasked document will occasionally put a whole
    // contact line into whichever field it thought the line was about.
    // THE CITED SPAN IS ONE OF THE STRINGS. It was missing here until the RI-3 security
    // review: an employment row's quote is the résumé line it was read from, and on a real
    // résumé that line carries the employer AND, very often, the contact details printed
    // beside it. Certifying the name while shipping the line it came from is no wall at all.
    const strings = [entry.employer_name, entry.role_title, entry.evidence.quote].filter(
      (value): value is string => typeof value === "string",
    );
    const certified = strings.map((value) => resumeValueCertifier(value));
    if (certified.some((result, index) => result.blocked || result.text !== strings[index])) {
      rejected += 1;
      continue;
    }
    if (
      entry.start_year != null &&
      entry.end_year != null &&
      entry.end_year < entry.start_year
    ) {
      rejected += 1;
      continue;
    }
    if (entry.employer_name == null && entry.role_title == null) {
      rejected += 1;
      continue;
    }
    kept.push(entry);
  }

  return { kept, rejected };
}
