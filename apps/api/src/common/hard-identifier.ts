/**
 * Shared hard-identifier detector (#2562 review).
 *
 * ONE definition for every surface that must refuse a hard identifier in free text: resume
 * values, the interview, the payer-login DTO and the admin worker-account reason DTO. It used
 * to live under profiling/resume-import; it is general-purpose policy, not a resume gate.
 *
 * MIRRORS `contains_hard_identifier` in `apps/ai-service/app/pseudonymize.py`, pinned by
 * `packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json`, which both suites read.
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

// A CONTROL CHARACTER FAILS CLOSED (issue #2064, risks-register R59; the far side's #1984).
//
// PARITY: mirrors `_NON_LAYOUT_CONTROL_CHAR_RE`, `_LAYOUT_WHITESPACE_RE` and
// `CONTROL_CHARACTER_REFUSAL` in `apps/ai-service/app/pseudonymize.py`. No pattern in this file
// sees through a Unicode `Cc` character, so one inside an identifier split it past every rule:
// "call 9876<NUL>543210" read as no phone and "anil<NUL>@example.com" as no email. The value is
// WITHHELD, not cleaned — deleting the character would certify a value that differs from the one
// stored, and a C1 such as NEL (U+0085) renders as a line break, so the matched text is not what
// a reader sees. No honest value carries one.
//
// `\p{Cc}` IS EXACTLY THE FAR SIDE'S `[\x00-\x1f\x7f-\x9f]` — a closed, stable category of 65
// code points, pinned over all of Unicode by `resume-parse-gates.control-chars.test.ts`. TAB, LF
// and CR are carved out: a free-text value (a quoted résumé line, a multi-line answer) carries
// them legitimately, so they are read as a plain space, which every pattern here already treats
// as a separator — they can split nothing a typed space could not. Same carve-out as the
// companion walls (R57). The rewrite to a space is a no-op for every pattern TODAY (JS `\s`
// already matches all three, and no mutation of it fails a test); it is kept so a future pattern
// that lists a literal space rather than `\s` reads them as the far side does.
//
// NOT `\p{Cf}`. ZWJ / ZWNJ shape Devanagari conjuncts; they stay in `INVISIBLE_RE` above and are
// stripped, as on the far side. Withholding Cf is a separate owner decision.
const NON_LAYOUT_CONTROL_CHAR_RE = /(?![\t\n\r])\p{Cc}/u;
const LAYOUT_WHITESPACE_RE = /[\t\n\r]/g;

/**
 * What {@link containsHardIdentifier} returns for a value carrying a non-layout control character.
 * NOT one of {@link HARD_IDENTIFIER_CLASSES} (the shared fixture pins that set): like
 * `"scanner_error"`, a fail-closed refusal of its own, and non-null, so every caller withholds.
 */
export const CONTROL_CHARACTER_REFUSAL = "control_character";

// Cued identifiers the interview's CREDENTIAL_ID_RE does not name. Cue-based rather than
// shape-based because these shapes are ambiguous: a passport number `M1234567` is
// indistinguishable from a part number, and a date of birth from the date range a résumé
// prints on every line of its work history. The digit lookahead is what stops `\baccount\b`
// plus the next word refusing "Account Manager", which is a job a real worker holds.
//
// THE CONNECTOR AFTER THE CUE IS LINEAR, in both patterns (issue #1933, risks-register R54).
// It was `\s*(?:no\.?|number|num|#)?\s*[:-]?\s*`: three whitespace quantifiers with only
// optional tokens between them, so a cue followed by a whitespace run that then failed the digit
// lookahead tried every split of the run, O(k^3) in V8 as in Python: 31 ms at 400 spaces, 244 ms
// at 800, 1.96 s at 1,600 (2026-10-03). Each quantifier is now folded into the optional token it
// follows, the far side's exact text: the same spans on every input, and 0.1 ms on a run of
// 20,000. Both are exported for `resume-parse-gates.linear.test.ts`, which compares them span for
// span with the connector written main's unfolded way; `containsHardIdentifier` stays the only
// production reader.
//
// A DOT AFTER THE CUE AND A ":-" SEPARATOR ARE READ, in both patterns (issue #1950, risks-register
// R56), and "regn" is a credential cue. "Reg.No.:- 123456", "Regn. No. MH2019CN4471" and
// "Passport.No: K1234567" were admitted: no connector token started with "." and the separator
// was one character. Three additive tokens, the far side's exact text: `\.?` straight after the
// cue word, "regn", and `-?` after the separator. None is whitespace, so the rules stay linear;
// the language only grows, so nothing that was refused is admitted.
//
// A TWO-WORD LABEL IS READ, in both patterns (issue #2091, risks-register R56). The connector read
// one number word, so "Voter ID No: XYZ9876543", "IFSC code HDFC0004321" and (the credential rule
// had no "id" word) "Registration ID 123456" were admitted. In front of the number word it now
// reads up to two label words, in a fixed order: "id", then "card" or "code" ("ID No", "Card No",
// "ID Card No", "Code"), the far side's exact text. Each word keeps its own trailing `\s*`, so the
// rules stay linear; the "id" word moved from the number-word slot, so a lone "ID" reads as before.
export const RESUME_CUED_ID_RE =
  /\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|a\/c|account|dob|date\s+of\s+birth)\b\.?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,24}\d)[A-Za-z0-9][A-Za-z0-9/-]{4,}/i;
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Masked on their CUE rather than their shape — a roll or registration number has no shape
// that an ordinary alphanumeric token does not also have. The bounded lookahead mirrors the
// far side's 64-character ceiling, which bounds work per character rather than input size.
export const CREDENTIAL_ID_RE =
  /\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:id\s*)?(?:(?:card|code)\s*)?(?:(?:no\.?|number|num|#)\s*)?(?:[:-]-?\s*)?(?=[A-Za-z0-9/-]{0,64}\d)[A-Za-z0-9][A-Za-z0-9/-]{5,}/i;

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
 *
 * A CONTROL CHARACTER FAILS CLOSED FIRST (#2064, R59), exactly as `contains_hard_identifier` does
 * on the far side: any `Cc` other than TAB / LF / CR returns {@link CONTROL_CHARACTER_REFUSAL};
 * those three are read as a space, so "98765\t43210" is still a phone. `Cf` is untouched.
 */
export function containsHardIdentifier(
  raw: string,
): HardIdentifierClass | typeof CONTROL_CHARACTER_REFUSAL | "scanner_error" | null {
  try {
    if (NON_LAYOUT_CONTROL_CHAR_RE.test(raw)) return CONTROL_CHARACTER_REFUSAL;
    const text = raw.replace(LAYOUT_WHITESPACE_RE, " ").replace(INVISIBLE_RE, "");
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

