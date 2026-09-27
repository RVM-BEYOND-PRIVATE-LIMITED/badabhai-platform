/**
 * ═══ MAY THIS BRIEF BE PRINTED? ═══ (ADR-0045 R6 — the general form's last question)
 *
 * "Apne kaam ke baare mein 1-2 line batayein." Whatever the worker types here is printed UNDER
 * THE HEADLINE of the `bb_general` sheet, on the worker's copy AND ON THE EMPLOYER'S COPY — the
 * one surface on the road where a stranger reads the worker's own words verbatim. No model reads
 * it, polishes it or rewrites it (R6); this module is the only thing between the keyboard and
 * that page.
 *
 * ── REFUSE, NEVER REWRITE ────────────────────────────────────────────────────────────────────
 *
 * The text is NORMALISED (NFKC, invisible characters stripped, whitespace collapsed) and then
 * either kept or refused whole. Nothing is masked out of the middle of it and nothing is
 * truncated to fit: a brief the wall had to edit is a sentence the worker never wrote, and the
 * sheet would print it under his name as his own. Refusing costs him one retype, with a closed
 * reason the app turns into a line he can act on ("number mat likhiye", "link mat likhiye").
 *
 * ── WHAT IS REFUSED, AND WHY EACH IS HERE ────────────────────────────────────────────────────
 *
 *   empty         nothing printable is left, or no LETTER at all ("....", "12345") — a line with
 *                 no word in it says nothing about the worker's work and still prints.
 *   too_long      over {@link GENERAL_FORM_BRIEF_MAX_CHARS} code points after collapsing, or a
 *                 raw input over {@link BRIEF_RAW_MAX_UNITS} before a single regex runs.
 *   emoji         pictographs, flags, skin tones, keycaps. The sheet's fonts carry none of them;
 *                 each would print as a box on the employer's copy.
 *   brackets      `[ ] { } < >` — the gateway's placeholder shapes (`[PERSON_1]`), template debris
 *                 and markup. An honest one-line brief has no use for them; parentheses stay legal.
 *   identifier    a hard identifier (`containsHardIdentifier`: PAN, Aadhaar, phone, email,
 *                 credential ids, GSTIN, long digit runs), a PAN in lower case, a phone- or
 *                 email-shaped run (`looksLikePii`), or TEN OR MORE digits in total.
 *   name          the worker's OWN stored name — the whole name or any token of 3+ characters,
 *                 matched exactly as `redactKnownName` matches it — or a self-introduction cue
 *                 ("mera naam", "my name is", "मेरा नाम"). The employer copy prints only the
 *                 name's initials (`resume-disclosure.service.ts`); a brief that repeated it
 *                 would un-mask the worker on the one surface built to hide him. No gazetteer
 *                 (the R32 lesson): only the name we hold is looked for.
 *   contact      an "@" in any width (a UPI id, a handle, an email with no TLD) or an email spelled
 *                 out ("ramesh at gmail dot com").
 *   link          a URL (`looksLikeUrl`), a host followed by a path ("t.me/ramesh"), or a
 *                 short-link host ("bit.ly", "linktr.ee").
 *   organisation  a legal-entity name — `looksLikeOrgName`, plus a bare "Ltd"/"LLC"/"GmbH"/"LLP"
 *                 anywhere and a Capitalised "Limited" after a word.
 *   unscreenable  a wall THREW. Fail closed: a wall that did not finish is not a wall that passed.
 *
 * ── THE ORGANISATION WALL IS A DECISION, NOT A DEFAULT ──────────────────────────────────────
 *
 * A worker's brief could honestly say "Tata Motors Ltd mein 5 saal kaam kiya". It is refused
 * anyway, for two reasons that do not depend on the worker meaning any harm: (1) the brief prints
 * on the EMPLOYER copy, and (2) ADR-0041 D5 keeps employer names only in the ENCRYPTED
 * `worker_employment.employer_name_enc` — a brief is a plaintext `worker_attributes` row, so an
 * employer name accepted here would be the one plaintext copy on the platform. The Work History
 * page is where an employer belongs, and it is one screen earlier in the same form.
 *
 * KNOWN GAP, ACCEPTED: a bare brand with no legal suffix ("Tata Motors mein") passes — the shared
 * heuristic cannot tell a brand from trade prose, and neither can this module. That is the same
 * line `looksLikeOrgName` draws for job text.
 *
 * ── KNOWN COSTS, PINNED BY TESTS SO NOBODY IS SURPRISED ─────────────────────────────────────
 *
 *  - "2015-2023 tak" is REFUSED: `looksLikePii` strips "-" and sees an eight-digit phone-shaped
 *    run. "2015 se 2023 tak" passes. The worker rewords; the fail-closed direction.
 *  - Ten digits across the whole brief are refused whatever separates them (the skill
 *    certifier's digit budget): "10 saal, 2014 se, 15000 salary" is eleven. A phone number is
 *    ten, and every separator list is one separator short; counting needs no list.
 *  - "B.Tech/Diploma" reads as a host with a path and is refused (the certifier's cost too).
 *  - A name token that is also a word is refused for THAT worker: a worker surnamed Das cannot
 *    write "das saal" (he writes "10 saal"). The same collision `redactKnownName` accepts.
 *  - A name typed in another script than the one it is stored in ("रमेश" for a stored "Ramesh")
 *    is not matched unless a self-introduction cue comes with it. Transliteration is a
 *    gazetteer by another name, and that direction is closed (R32).
 *
 * ── WHY SOME WALLS ARE COPIED FROM `skill-certifier.ts` RATHER THAN IMPORTED ────────────────
 *
 * The scan form, the digit budget, the any-case PAN, the "@" and the link shapes live in the
 * skill certifier as module-private helpers, deliberately stricter than the shared scanners
 * (its header explains why they are not in `@badabhai/validators`). They are duplicated here —
 * minimally, with the same names — rather than exported from there, so that tightening a SKILL
 * wall (six words at most) can never silently loosen or tighten a BRIEF wall (160 characters of
 * prose), and vice versa. Where the brief's rule differs (the PAN separators, the link
 * exemptions) the difference is stated at the rule.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────────────────────
 *
 * PURE. No I/O, no logger, no event. The text goes in; the text or a closed reason comes out. A
 * caller that wants to observe a refusal has the REASON and must never reach for the text.
 */

import { looksLikeOrgName, looksLikePii, looksLikeUrl } from "@badabhai/validators";
import { GENERAL_FORM_BRIEF_MAX_CHARS, GENERAL_FORM_BRIEF_MIN_CHARS } from "@badabhai/types";

import { knownNamePattern } from "../../common/redact-known-name";
import { containsHardIdentifier } from "../resume-import/resume-parse-gates";

/**
 * The RAW ceiling, in UTF-16 units, checked before any normalisation or regex runs — `.length` is
 * O(1), and the walls below include backtracking patterns whose cost grows with the input. 600 is
 * the trade form's text bound: generous enough that a pasted brief full of padding reaches the
 * collapse step and is measured there.
 */
export const BRIEF_RAW_MAX_UNITS = 600;

/**
 * The DTO's bound on the same field — a request-size cap ONLY, deliberately above
 * {@link BRIEF_RAW_MAX_UNITS} and with no minimum, so an empty or over-long brief reaches
 * {@link screenBrief} and is answered with its closed reason (`brief_empty`, `brief_too_long`)
 * rather than the validation pipe's code-less 400.
 */
export const BRIEF_WIRE_MAX_UNITS = 4000;

/**
 * The most digits a brief may carry, counted over the whole SCAN FORM whatever separates them.
 * Ten or more is refused — see the module header's known costs.
 */
export const BRIEF_MAX_DIGITS = 9;

/** Every reason a brief is refused. CLOSED: a new wall is a new member and a new client line. */
export const BRIEF_REFUSAL_REASONS = [
  "empty",
  "too_long",
  "emoji",
  "brackets",
  "identifier",
  "contact",
  "link",
  "name",
  "organisation",
  "unscreenable",
] as const;
export type BriefRefusalReason = (typeof BRIEF_REFUSAL_REASONS)[number];

export type BriefScreenResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: BriefRefusalReason };

// ─────────────────────────────────────────────────────────────────────────────────────────
// NORMALISATION
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Characters that render as nothing — the skill certifier's INVISIBLE_RE, verbatim, for its
 * reasons: format and control characters, everything Unicode calls default-ignorable whatever
 * its category (variation selectors, the combining grapheme joiner, the Hangul fillers), and the
 * Braille blank. Stripped rather than kept, because an invisible character inside a brief is
 * either debris or an attempt to split an identifier past a scanner.
 *
 * DEVANAGARI SURVIVES IT: matras, the virama, the nukta and the chandrabindu are Mn/Mc and not
 * default-ignorable. The two Indic joiners that ARE in it (ZWJ/ZWNJ) choose a glyph form, never
 * a letter. Pinned by a test.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}⠀]/gu;

/**
 * NFKC, every whitespace character to a space FIRST (so "welding\nfitting" stays two words
 * rather than fusing when `\n` — a control character — is stripped), invisibles out, runs of
 * spaces collapsed, ends trimmed. What comes out is what is measured, screened, stored and
 * printed; there is no second form of the brief anywhere.
 */
function collapse(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\s/gu, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/ {2,}/gu, " ")
    .trim();
}

/** Code points, not UTF-16 units — the certifier's measure, so an astral letter costs one. */
function codePointLength(text: string): number {
  return [...text].length;
}

const LETTER_RE = /\p{L}/u;

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE WALLS
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pictographs (`Extended_Pictographic`), flag halves (`Regional_Indicator` — a flag is NOT
 * pictographic), skin-tone modifiers, and the combining keycap U+20E3 (what "1️⃣" leaves once
 * its variation selector has been stripped as invisible).
 */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}⃣]/u;

/** The certifier's bracket wall: any bracket, brace or angle bracket, anywhere. */
const BRACKETS_RE = /[<>{}[\]]/u;

// ── identifiers ──

/** One decimal digit of any script. Anchored: it tests a single code point. */
const DECIMAL_DIGIT_RE = /^\p{Nd}$/u;
const DECIMAL_DIGITS_RE = /\p{Nd}/gu;
const ASCII_DIGIT_RE = /[0-9]/gu;

function isDecimalDigit(codePoint: number): boolean {
  return DECIMAL_DIGIT_RE.test(String.fromCodePoint(codePoint));
}

/**
 * The ASCII digit with the same value as one `\p{Nd}` code point — the certifier's `asciiDigit`.
 * Unicode encodes every decimal digit in a contiguous ascending run of ten, so the value is the
 * distance from the start of the run, mod 10 (runs sit back to back in the math alphanumerics).
 */
function asciiDigit(digit: string): string {
  const codePoint = digit.codePointAt(0) ?? 0x30;
  if (codePoint >= 0x30 && codePoint <= 0x39) return digit;
  let runStart = codePoint;
  while (runStart > 0 && isDecimalDigit(runStart - 1)) runStart--;
  return String((codePoint - runStart) % 10);
}

/**
 * The form the identifier walls READ: every `\p{Nd}` folded to ASCII. JavaScript's `\d` is ASCII
 * only (even under `u`), and NFKC does not fold Devanagari or Tamil digits — so "९८७६५४३२१०" is
 * no phone number to any shared scanner. READ, NEVER SHOWN: the brief stored is the worker's own
 * digits.
 */
function scanForm(text: string): string {
  return text.replace(DECIMAL_DIGITS_RE, asciiDigit);
}

function overDigitBudget(text: string): boolean {
  return (text.match(ASCII_DIGIT_RE)?.length ?? 0) > BRIEF_MAX_DIGITS;
}

/**
 * A PAN in lower or mixed case, joined or with ONE hyphen or dot: "abcde1234f", "Abcde-1234-F".
 *
 * NARROWER THAN THE CERTIFIER'S, AND THAT IS THE BRIEF'S DIFFERENCE. The certifier allows up to
 * three separators of any kind either side of the digits, which is safe for a six-word skill and
 * not for prose: "since 2019 a good welder" is five letters, a space, four digits, a space and a
 * one-letter word. Spaces are therefore not separators in the any-case form. The spaced UPPER
 * case form ("ABCDE 1234 F") has its own rule below — upper-case prose in that exact shape does
 * not occur.
 */
const PAN_ANY_CASE_RE = /(?<![a-z0-9])[a-z]{5}[-.]?\d{4}[-.]?[a-z](?![a-z0-9])/iu;
const PAN_SPACED_UPPER_RE =
  /(?<![A-Za-z0-9])[A-Z]{5}[\W_]{1,3}\d{4}[\W_]{0,3}[A-Z](?![A-Za-z0-9])/u;

function looksLikeIdentifier(text: string): boolean {
  // `"scanner_error"` is non-null, so a scanner that fails reads as a refusal.
  return (
    containsHardIdentifier(text) !== null ||
    PAN_ANY_CASE_RE.test(text) ||
    PAN_SPACED_UPPER_RE.test(text) ||
    overDigitBudget(text) ||
    looksLikePii(text)
  );
}

// ── contact routes ──

/** "@" in any width. NFKC already folds the fullwidth and small forms; listed so this does not depend on it. */
const AT_SIGN_RE = /[@＠﹫]/u;

/** An email dictated rather than typed: "ramesh at gmail dot com", "ramesh (at) gmail (dot) in". */
const SPELLED_EMAIL_RE = /\bat\b.*\bdot\b[\W_]*(?:com|in|net|org|co)\b/iu;

function looksLikeContactRoute(text: string): boolean {
  return AT_SIGN_RE.test(text) || SPELLED_EMAIL_RE.test(text);
}

// ── links ──

/**
 * Qualification and technology names `looksLikeUrl`'s dotted-TLD tier mis-flags — the
 * certifier's exemption list. On a brief the ones that matter are the degrees: "B.Com pass" is
 * an honest thing for a worker to write about himself, and ".com" is exactly what the URL wall
 * looks for. Exempted only as a WHOLE token, so "b.com/anything" and "shop.b.com" still face the
 * wall.
 */
const URL_TLD_EXEMPT_TOKENS: ReadonlySet<string> = new Set([
  ".net",
  "asp.net",
  "vb.net",
  "ado.net",
  "b.com",
  "m.com",
]);
const EXEMPTION_TOKEN_RE = /[^\s,;()]+/gu;

/** A dotted host immediately followed by a path — TLD-agnostic ("t.me/x", "example.tech/cv"). */
const HOST_WITH_PATH_RE = /[\p{L}\p{N}-]\.\p{L}{2,}\//u;

/** The short-link and portfolio TLDs `looksLikeUrl` does not know — the certifier's closed list. */
const SHORT_LINK_TLDS: readonly string[] = Object.freeze([
  "me",
  "ly",
  "ee",
  "dev",
  "app",
  "xyz",
  "site",
  "shop",
  "store",
  "online",
  "link",
  "page",
]);
const SHORT_LINK_HOST_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:${SHORT_LINK_TLDS.join("|")})(?![\p{L}\p{N}-])`,
  "iu",
);

function looksLikeLink(text: string): boolean {
  const remainder = text.replace(EXEMPTION_TOKEN_RE, (token) =>
    URL_TLD_EXEMPT_TOKENS.has(token.toLowerCase().replace(/[.:!?]+$/u, "")) ? " " : token,
  );
  return (
    looksLikeUrl(remainder) || HOST_WITH_PATH_RE.test(text) || SHORT_LINK_HOST_RE.test(remainder)
  );
}

// ── organisations ──

/**
 * A legal-entity suffix ANYWHERE in the brief, as a whole word, in any case.
 *
 * The shared `looksLikeOrgName` catches a bare "Ltd" only in TRAILING position after a
 * Capitalised word, which is right for a job title and wrong for prose: "Tata Motors Ltd mein 5
 * saal" has the suffix mid-sentence. These four words have no trade-prose meaning, so position
 * does not matter. "Pvt" alone is deliberately absent ("pvt company me kaam kiya" is how a
 * worker says "a private company", naming nobody); "Pvt Ltd" is caught by the shared wall.
 */
const LEGAL_SUFFIX_ANYWHERE_RE = /(?<![\p{L}\p{N}])(?:ltd|llc|gmbh|llp)(?![\p{L}\p{N}])/iu;

/**
 * "Limited" as an entity suffix mid-sentence: CAPITALISED and after another word ("Motors
 * Limited mein"). Lower-case "limited" is prose — "experience limited hai" — and passes.
 */
const CAPITALISED_LIMITED_RE = /[\p{L}\p{N}.&'-]\s+(?:Limited|LIMITED)(?![\p{L}\p{N}])/u;

/** The Devanagari spelling, which no Latin rule reads. */
const DEVANAGARI_LIMITED_RE = /लिमिटेड/u;

function looksLikeOrganisation(text: string): boolean {
  return (
    looksLikeOrgName(text) ||
    LEGAL_SUFFIX_ANYWHERE_RE.test(text) ||
    CAPITALISED_LIMITED_RE.test(text) ||
    DEVANAGARI_LIMITED_RE.test(text)
  );
}

// ── the worker's own name ──

/**
 * A self-introduction, whoever's name follows it: "mera naam …", "my name is …", "… naam hai",
 * "मेरा नाम …", "… नाम है", and a brief that OPENS with "Myself …" (the Indian-English
 * introduction — anchored to the start so "taught myself Excel" is prose). It closes part of the
 * gap the known-name match cannot: a name typed in another script than the one it is stored in.
 */
const NAME_CUE_RE =
  /(?<![\p{L}\p{N}])(?:mera\s+naa?m|my\s+name|naa?m\s+hai)(?![\p{L}\p{N}])|^myself(?![\p{L}\p{N}])|मेरा\s+नाम|नाम\s+है/iu;

function looksLikeOwnName(text: string, knownName: RegExp | null): boolean {
  return NAME_CUE_RE.test(text) || (knownName !== null && text.search(knownName) !== -1);
}

/**
 * The content walls, IN ORDER — the first hit names the reason. Identifiers lead: when a brief
 * is refused for two things, the one that would have put a number on an employer's copy is the
 * one the worker should hear about. The name wall follows contact and link: a handle or a link
 * that happens to contain his name ("ramesh@okaxis") is refused as the route it is, which is the
 * more specific thing to retype.
 */
const WALLS: readonly {
  readonly reason: BriefRefusalReason;
  readonly test: (text: string, knownName: RegExp | null) => boolean;
}[] = Object.freeze([
  { reason: "identifier", test: looksLikeIdentifier },
  { reason: "contact", test: looksLikeContactRoute },
  { reason: "link", test: looksLikeLink },
  { reason: "name", test: looksLikeOwnName },
  { reason: "organisation", test: looksLikeOrganisation },
]);

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SCREEN
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Screen one brief. Returns the normalised text to store and print, or a closed reason.
 *
 * The walls read the collapsed text AND its scan form: folding can only add digits a regex sees,
 * but it can also glue a folded digit to a neighbouring letter and move a word boundary, so
 * reading both means the fold is never what let an identifier through.
 *
 * `knownName` is the worker's own DECRYPTED name, or `null` when none is stored. REQUIRED, not
 * optional, so no caller can screen a brief without having decided about the name; a caller that
 * could not decrypt it must refuse (`unscreenable`) rather than pass `null`.
 */
export function screenBrief(raw: string, knownName: string | null): BriefScreenResult {
  if (raw.length > BRIEF_RAW_MAX_UNITS) return { ok: false, reason: "too_long" };
  try {
    const namePattern = knownNamePattern(knownName?.normalize("NFKC"));
    const text = collapse(raw);
    const length = codePointLength(text);
    if (length < GENERAL_FORM_BRIEF_MIN_CHARS) return { ok: false, reason: "empty" };
    if (length > GENERAL_FORM_BRIEF_MAX_CHARS) return { ok: false, reason: "too_long" };
    if (EMOJI_RE.test(text)) return { ok: false, reason: "emoji" };
    if (BRACKETS_RE.test(text)) return { ok: false, reason: "brackets" };

    const scan = scanForm(text);
    const forms = scan === text ? [text] : [text, scan];
    for (const wall of WALLS) {
      if (forms.some((form) => wall.test(form, namePattern))) {
        return { ok: false, reason: wall.reason };
      }
    }
    // LAST, so a letterless phone number is reported as the identifier it is, not as "empty".
    if (!LETTER_RE.test(text)) return { ok: false, reason: "empty" };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "unscreenable" };
  }
}

/**
 * The length the `profile.general_form_answered` event records for an accepted brief — the SAME
 * measure {@link screenBrief} bounds, so the event's 1..160 range can never reject a brief this
 * module accepted.
 */
export function briefLength(screenedText: string): number {
  return codePointLength(screenedText);
}
