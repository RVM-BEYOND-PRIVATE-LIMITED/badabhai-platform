/**
 * ═══ MAY THIS SKILL BE SHOWN, OR STORED? ═══ (ADR-0045 §3.2 — the general road's skills stage)
 *
 * On the general road a worker whose role is outside the 21 is asked for skills by a model, and
 * whatever the model hands back is echoed on the gate as a bullet ("Kya aur koi skill jodni
 * hai?"), persisted in `conversation_state.general_road`, and printed on the `bb_general` sheet.
 * Every one of those surfaces is worker- or employer-facing, and the thing that decided the text
 * was a model. This module is the API's wall in front of all three.
 *
 * ── THE SECOND WALL, NOT THE ONLY ONE ────────────────────────────────────────────────────────
 *
 * The ai-service certified the list once already (`_certified_skills` in
 * `apps/ai-service/app/routers/profiling.py`: the pseudonymization gateway's clean-or-withhold
 * per item, plus a placeholder wall). §3.2 asks for a SECOND, INDEPENDENT one here, for the same
 * reason `parse-gates.ts` re-runs the far side's gates: two walls that agree are worth more than
 * one wall that is trusted, and this process is the one that WRITES. The two walls deliberately
 * look at different things. The far side has the gateway (names, employers); this side has the
 * hard-identifier scanner, the capture-boundary shape checks, a closed generic list, and — the
 * one thing the far side cannot do, because it only ever sees masked text — GROUNDING in the
 * worker's own words.
 *
 * ── REFUSE, NEVER REWRITE ────────────────────────────────────────────────────────────────────
 *
 * A candidate is cleaned (bullets, numbering, whitespace, trailing punctuation — the cosmetic
 * debris a list-writing model leaves) and then either kept verbatim or refused whole. Nothing is
 * truncated to fit a length, nothing has an identifier masked out of the middle of it. A skill
 * the wall had to edit is a skill the worker never said in that form, and the sheet would print
 * it under his name. Refusing costs one bullet; a rewrite costs the claim that every skill on
 * the page is his.
 *
 * ── THE ORDER ────────────────────────────────────────────────────────────────────────────────
 *
 *   0. raw size — BEFORE ANY REGEX      5. PII shape (`looksLikePii`)
 *   1. clean                            6. links and contact routes, minus a closed tech list
 *   2. length                           7. organisation name, and a trailing legal suffix
 *   3. placeholders                     8. generic / the role itself
 *   4. hard identifier, PAN in any      9. grounding (certifySkills only)
 *      case, and the digit budget      10. de-dupe on `skillKey`
 *                                      11. the MAX_SKILLS cap
 *
 * 0-8 are properties of the LABEL alone — {@link certifySkillLabel} runs exactly those, which is
 * what re-certifying a skill gathered on an earlier turn (or the role label) needs. 9-11 need the
 * turn: the worker's message, and what is already held.
 *
 * Walls 3-7 read every form of the label TWICE: as cleaned, and as its SCAN FORM — every Unicode
 * decimal digit folded to ASCII (see {@link scanForm}). The label that is shown and stored is
 * always the cleaned original; the scan form exists only to be read.
 *
 * ── WHERE THIS WALL IS STRICTER THAN THE SHARED SCANNERS, AND WHY IT IS LOCAL ────────────────
 *
 * Several walls here (the scan form, the digit budget, PAN in any case, "@", the path and
 * short-link shapes, the bracket and numbered placeholders, the trailing legal suffix) are
 * stricter than `containsHardIdentifier` and the `@badabhai/validators` heuristics. They live
 * HERE, not in those modules, on purpose: the shared scanners guard résumé values, job text and
 * the interview's masking, where "1200000" is a salary and "Tata Motors Ltd" is an authorised
 * employer (ADR-0041 D5), and widening them is a change to every one of those routes. A SKILL
 * LABEL is a narrower thing — at most six words naming what a worker can do — so the shapes that
 * are ambiguous elsewhere are not ambiguous here, and refusing them costs at most one bullet.
 *
 * ── WHAT IS DELIBERATELY NOT USED ────────────────────────────────────────────────────────────
 *
 * `looksLikeActionContextPii`. It flags 2-4 title-cased words as a human name, which is the exact
 * shape of "React Native", "Night Flying" and "Stainless Steel" — see the comment on
 * `cleanScalar` in `apps/api/src/resume/resume-render-input.ts`. A wall that refuses the honest
 * cases is a wall somebody deletes, and then nothing checks for a PAN either.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────────────────────
 *
 * PURE. No I/O, no logger, no event. The worker's text and the model's labels go in; labels this
 * module vouches for and two COUNTS come out. A caller that wants to observe refusals has
 * `rejected` — a number — and must never reach for the text that was refused.
 */

import { skillIdForPhrase } from "@badabhai/taxonomy";
import { looksLikeOrgName, looksLikePii, looksLikeUrl } from "@badabhai/validators";

import { isUniversalPlaceholderLabel } from "../occupation/family-chip-labels";

import { containsHardIdentifier } from "./resume-import/resume-parse-gates";

/**
 * The RAW ceiling, in UTF-16 units, checked before a single regex runs (wall 0).
 *
 * WHY A SECOND LENGTH LIMIT: {@link MAX_SKILL_CHARS} is measured on the CLEANED label, and
 * cleaning is regex work — `TRAILING_PUNCTUATION_RE` backtracks quadratically on V8 when a long
 * punctuation run does not end the string (measured: ~1.5 s of event-loop block for one
 * 50,000-character candidate). Nothing upstream bounds the input: `LlmTurnOutputSchema.skills`
 * (`packages/ai-contracts/src/oie.ts`) is an array of unbounded strings, so a runaway or
 * prompt-injected model reply decides how long this process blocks. UTF-16 `.length` is O(1),
 * which is the point — the guard must cost nothing whatever it is handed.
 *
 * 256 is a small multiple of the 60-code-point label limit: generous enough that bullets,
 * padding and an astral script never trip it on an honest label, small enough that the quadratic
 * worst case is a few tens of thousands of steps. Over it, the candidate is REFUSED, never
 * truncated — the module's rule, applied before cleaning rather than after.
 */
export const MAX_RAW_SKILL_UNITS = 256;
/** A skill longer than this is a sentence, not a skill — refused, never truncated. */
export const MAX_SKILL_CHARS = 60;
/** Six words holds "Tally ERP 9 with GST billing"; a seventh is a description. */
export const MAX_SKILL_WORDS = 6;
/**
 * The most DIGITS a label may carry, counted over the whole scan form whatever separates them.
 *
 * Ten or more is refused. A phone number is ten, an Aadhaar twelve, a bank account nine to
 * eighteen — and every separator a model or a worker can put between them ("98765*43210",
 * "98765:43210", "98765 aur 43210", "1234/5678/9012") is a separator some shape-based scanner
 * does not list. Counting digits needs no separator list at all. A six-word skill label never
 * needs ten digits: "ISO 9001:2015" carries 8 and passes, "IATF 16949:2016" carries 9 and passes.
 */
export const MAX_SKILL_DIGITS = 9;
/** ADR-0045 §6: the skills stage stops at 30 skills (held + new). */
export const MAX_SKILLS = 30;

export interface SkillCertifyContext {
  /**
   * The worker's OWN text the candidates were drawn from — on the skills stage, the latest
   * message (the contract's `skills` are the skills in that message; `oie.ts`). Raw, in this
   * process only; it never leaves this function in any form.
   */
  readonly workerText: string;
  /** Skills already certified and stored. A candidate matching one is a duplicate, not new. */
  readonly held: readonly string[];
  /** The settled role. A candidate that IS the role is not a skill. */
  readonly roleLabel: string | null;
  /** The settled domain. Same rule as the role. */
  readonly domainLabel: string | null;
}

export interface SkillCertifyResult {
  /** NEW certified skills, cleaned, in input order. Never anything already in `held`. */
  readonly kept: readonly string[];
  /** Candidates refused by a wall. Duplicates and cap overflow are NOT refusals. */
  readonly rejected: number;
  /** The cap was reached AND at least one certified, non-duplicate candidate was left out. */
  readonly capped: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1. CLEANING
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Characters that render as nothing. Stripped rather than treated as separators — the same call
 * `resume-parse-gates.ts` makes for its INVISIBLE_RE, and for a wider set: a label containing an
 * invisible character is either debris or an attempt to split an identifier past a scanner, and
 * stripping serves both. Whitespace controls (`\t`, `\n`) are turned into spaces FIRST, so
 * "MS\nOffice" stays two words rather than fusing into one.
 *
 * THREE CLASSES, BECAUSE THE FIRST ONE WAS NOT ENOUGH:
 *  - `\p{Cf}` `\p{Cc}` — format and control: zero-width space/joiners, word joiner, BOM, soft
 *    hyphen, bidi overrides, tag characters.
 *  - `\p{Default_Ignorable_Code_Point}` — what Unicode itself says a renderer shows as nothing,
 *    WHATEVER its general category. The review that added it measured "Call 98765<X>43210"
 *    rendering as a plain phone number and passing the wall for X = U+FE0F (a variation
 *    selector, Mn), U+034F (combining grapheme joiner, Mn), U+180B (Mongolian variation
 *    selector, Mn), U+17B4 (Mn), and the Hangul fillers U+115F/U+1160/U+3164/U+FFA0 (Lo) — none
 *    of them Cf, so the first version kept every one.
 *  - U+2800, the Braille blank (So). Not Default_Ignorable, but it renders blank in every font a
 *    phone ships, which is all that matters to a scanner being walked past.
 *
 * WHAT IT MUST NOT TOUCH: Devanagari matras, the virama and the nukta are Mn/Mc and NOT
 * Default_Ignorable — "तंदूर" and "वेल्डिंग" come out intact (pinned by a test). The two Indic
 * joiners that ARE in it (ZWJ/ZWNJ, U+200D/U+200C) are Cf and were already stripped; they choose
 * a glyph form, never a letter.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** List-writing debris a model leaves at the head of a label: "- ", "• ", "* ", "> ", "— ". */
const LEADING_BULLETS_RE = /^[\s\-*•·●▪◦‣–—>]+/u;

/** "1. " / "2) " numbering. Requires the space, so "2.5 ton crane" and "3ds Max" are untouched. */
const LEADING_NUMBERING_RE = /^\d+[.)]\s+/u;

/** Sentence punctuation at the tail. "+" and "#" are NOT in it — they are half of "C++"/"C#". */
const TRAILING_PUNCTUATION_RE = /[\s.,;:!?]+$/u;

interface CleanedLabel {
  /** What is shown and stored. */
  readonly label: string;
  /**
   * The same text BEFORE the trailing-punctuation trim. The privacy walls read both — see
   * {@link refusedByPrivacyWalls} for the one case that makes this necessary.
   */
  readonly untrimmed: string;
}

function clean(raw: string): CleanedLabel | null {
  let text = raw.normalize("NFKC").replace(/\s/gu, " ").replace(INVISIBLE_RE, "");

  // REPEATED UNTIL STABLE, because models nest them ("- 1. Welding", "1) • Welding"). Each pass
  // only ever shortens the text, so the loop terminates.
  let previous: string;
  do {
    previous = text;
    text = text.replace(LEADING_BULLETS_RE, "").replace(LEADING_NUMBERING_RE, "");
  } while (text !== previous);

  const untrimmed = text.replace(/\s+/gu, " ").trim();
  const label = untrimmed.replace(TRAILING_PUNCTUATION_RE, "");
  if (label.length === 0) return null;
  return { label, untrimmed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2. LENGTH
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Code points, not UTF-16 units — a Devanagari or astral label is not penalised for encoding. */
function tooLong(label: string): boolean {
  return [...label].length > MAX_SKILL_CHARS || label.split(" ").length > MAX_SKILL_WORDS;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3-7. THE PRIVACY WALLS
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Placeholder shapes. A model that reads MASKED text can copy a gateway token back as a "skill",
 * and the far side's gateway passes it (pseudonymizing a placeholder masks nothing). It is
 * identity the gateway already removed, never a skill.
 *
 *  - The first two are `_SKILLS_PLACEHOLDER` on the ai-service, character for character:
 *    `[PERSON_1]` in any shape a model may reshape it into — unbracketed, lower-cased, spaced.
 *    Written as a SHAPE, not a prefix list, so a prefix the gateway adds later is still caught.
 *    (The bracket rule below subsumes the second; it stays so the mirror stays readable.)
 *  - ANY bracket, brace or angle bracket, anywhere: "[NAME]", "[PERSON1]", "[PERSON-1]",
 *    "[EMPLOYER #1]", "<NAME>", "{{worker_name}}" or half of one. The first version matched
 *    bracketed SHAPES (letters and spaces inside) and a review walked a digit, a hyphen and a
 *    "#" straight past it. An honest skill label has no `[ ] < > { }` at all — "Welding (TIG)"
 *    uses parentheses, which stay legal — so refusing the characters themselves costs nothing
 *    and leaves no shape to enumerate.
 *  - A gateway PREFIX followed by a number, unbracketed and in any case or spacing: "PERSON 1",
 *    "employer-2", "ID #3". The prefixes are the gateway's `token_for` prefixes (PERSON,
 *    EMPLOYER, PHONE, EMAIL, ID, AMOUNT) plus the redaction words a model uses when it masks for
 *    itself (NAME, ADDRESS, AADHAAR, PAN). Read on the scan form, so "PERSON १" is caught too.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?<![A-Za-z0-9])\[?\s*[A-Za-z]+_\d+\s*\]?(?![A-Za-z0-9])/u,
  /\[[A-Za-z]+\s+\d+\]/u,
  /[<>{}[\]]/u,
  /\b(?:person|employer|phone|email|id|name|address|amount|aadhaar|pan)\s*[-#_]?\s*\d+\b/iu,
]);

function isPlaceholder(text: string): boolean {
  return (
    PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)) || isUniversalPlaceholderLabel(text)
  );
}

/**
 * Technology and qualification names that `looksLikeUrl`'s dotted-TLD tier mis-flags (".net",
 * ".com"). CLOSED and exact: exempted only as a whole whitespace-delimited token (or the whole
 * label), case-insensitively — "ASP.NET MVC" passes, "foo.net", "www.asp.net" and
 * "ASP.NET www.example.com" do not, because the exemption removes ONLY the allow-listed token
 * and every other character still faces the URL wall.
 *
 * WHY NOT A LOOSER RULE ("a TLD after a known prefix"): the exemption is a hole in a privacy
 * wall, and a hole should be exactly as large as the names it was cut for. Known gaps, accepted:
 * "Socket.io" (.io) and "C#.NET" are still refused; "B.Com/M.Com" is refused as one token.
 * Adding a name is a one-line, reviewable change here.
 */
const URL_TLD_EXEMPT_TOKENS: ReadonlySet<string> = new Set([
  ".net",
  "asp.net",
  "vb.net",
  "ado.net",
  "b.com",
  "m.com",
]);

/**
 * Token boundaries for the exemption: whitespace, comma, semicolon, parentheses. "/" is
 * deliberately NOT one — splitting on it would let "b.com/anything" through as an exempt token
 * plus a path.
 */
const EXEMPTION_TOKEN_RE = /[^\s,;()]+/gu;

function looksLikeLink(text: string): boolean {
  const remainder = text.replace(EXEMPTION_TOKEN_RE, (token) =>
    URL_TLD_EXEMPT_TOKENS.has(token.toLowerCase().replace(/[.:!?]+$/u, "")) ? " " : token,
  );
  return looksLikeUrl(remainder);
}

/**
 * "@" in any width. An email without a TLD ("ramesh@gmail"), a spaced one ("ramesh @ gmail .
 * com"), a UPI id ("ramesh@okaxis" — a payment identifier tied to a bank account and a legal
 * name) and a social handle ("@ramesh_cook") are all contact routes the shared shape checks miss,
 * because every one of them requires a contiguous ".tld". No honest skill label contains an
 * at-sign, so the character itself is the wall. NFKC already folds the fullwidth and small forms
 * to "@"; they are listed so the wall does not depend on that.
 */
const AT_SIGN_RE = /[@\uFF20\uFE6B]/u;

/**
 * A dotted host immediately followed by a path: "t.me/ramesh", "bit.ly/rameshcv",
 * "linktr.ee/rameshcook", "example.tech/portfolio". TLD-AGNOSTIC on purpose — there are over a
 * thousand TLDs and a closed list is always one short; a host with a path is a link whatever it
 * ends in.
 *
 * KNOWN COST, ACCEPTED: a slash straight after a dotted technology name reads as a path, so
 * "Node.js/Express" and "B.Tech/B.E" are refused (as "B.Com/M.Com" already was, one token to the
 * exemption above). Each costs one bullet; the worker can say them as two skills.
 */
const HOST_WITH_PATH_RE = /[\p{L}\p{N}-]\.\p{L}{2,}\//u;

/**
 * The short-link and portfolio TLDs `looksLikeUrl` does not know (it stops at
 * com|net|org|co.in|co|in|io|biz|info). CLOSED, like the exemption list: each entry is a TLD a
 * worker actually hands out — "t.me", "bit.ly", "linktr.ee", "rameshkitchen.dev", a shop page.
 */
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

/**
 * A WHOLE-TOKEN host ending in one of {@link SHORT_LINK_TLDS}: it must start where a token starts
 * (nothing host-like before it) and the TLD must end where the host ends (nothing host-like after
 * it — a path, a port, a query or the end of the label may follow). That is what keeps it off
 * the technology names: "Node.js", "Vue.js", "B.Tech", "B.Sc", "D.Pharm", "Ph.D" and "ASP.NET"
 * end in no listed TLD, and "ramesh.developer" is not "ramesh.dev".
 */
const SHORT_LINK_HOST_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:${SHORT_LINK_TLDS.join("|")})(?![\p{L}\p{N}-])`,
  "iu",
);

/**
 * An email SPELLED OUT, the way a worker dictates one: "ramesh at gmail dot com", "ramesh (at)
 * gmail (dot) com". `looksLikeUrl`'s own docblock names spelled-out domains as a gap its callers
 * must close; this is the certifier closing it for itself.
 */
const SPELLED_EMAIL_RE = /\bat\b.*\bdot\b[\W_]*(?:com|in|net|org|co)\b/iu;

/** Wall 6's own half: the contact routes `looksLikeUrl` and `looksLikePii` do not see. */
function looksLikeContactRoute(text: string): boolean {
  return (
    AT_SIGN_RE.test(text) ||
    HOST_WITH_PATH_RE.test(text) ||
    SHORT_LINK_HOST_RE.test(text) ||
    SPELLED_EMAIL_RE.test(text)
  );
}

/**
 * A PAN in any case and with light separators: "abcde1234f", "AbCdE1234F", "ABCDE 1234 F",
 * "ABCDE-1234-F", "ABCDE.1234.F", "ABCDE - 1234 - F". The shared `PAN_RE` is upper-case and
 * separator-free — right for a printed résumé, wrong for a label a model copied from a phone
 * keyboard, where lower case is the ORDINARY shape of a PAN, not an adversarial one.
 *
 * Up to THREE separator characters either side of the digits (one wider than the review's
 * sketch), so a spaced hyphen " - " is covered too. The false positive it could cost is a
 * five-letter word, a four-digit number and a lone letter — "Excel 2019 a" — which no skill
 * label is; "Revit 2020 MEP" and "Excel 2016 VBA" pass because the tail is a word, not a letter.
 */
const PAN_ANY_CASE_RE = /(?<![a-z0-9])[a-z]{5}[\W_]{0,3}\d{4}[\W_]{0,3}[a-z](?![a-z0-9])/iu;

const ASCII_DIGIT_RE = /[0-9]/gu;

/** Wall 4's digit budget — see {@link MAX_SKILL_DIGITS}. Reads the SCAN form's ASCII digits. */
function overDigitBudget(text: string): boolean {
  return (text.match(ASCII_DIGIT_RE)?.length ?? 0) > MAX_SKILL_DIGITS;
}

/**
 * Words that end a legal entity's name, matched as the label's LAST WORD, case-insensitively.
 *
 * The shared `looksLikeOrgName` catches a bare "Ltd"/"Limited" only after a Capitalised token,
 * and knows no foreign suffix — so "welding at tata motors ltd", "Sharma LLC" and "Sharma GmbH"
 * passed both walls, and an employer's name would have been stored in plaintext in
 * `general_road` while D5 keeps employer names only in the encrypted `employer_name_enc`.
 *
 * TRAILING POSITION ONLY, and that is what makes it safe here and not in the shared module: in a
 * label of at most six words, a trailing "ltd" is never trade prose, while "Limited slip
 * differential" (the word leads) passes. "Pvt Ltd" and "Private Limited" end in a listed word, so
 * the two-word forms need no entry of their own. One Devanagari twin, because a voice turn skips
 * grounding and "शर्मा प्राइवेट लिमिटेड" would otherwise be the one spelling nothing reads.
 *
 * NOT this wall's concern, and pinned by a test so nobody is surprised: "LLP compliance" and "Pvt
 * Ltd incorporation" are REFUSED — by the shared org wall, which matches `\bllp\b` and
 * `pvt ltd` anywhere. Company-law skills cost a bullet; that is the fail-closed direction.
 */
const LEGAL_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "llc",
  "gmbh",
  "pvt",
  "inc",
  "corp",
  "llp",
  "लिमिटेड",
]);

function endsInLegalSuffix(text: string): boolean {
  const words = normalize(text).split(" ");
  return LEGAL_SUFFIX_WORDS.has(words[words.length - 1] ?? "");
}

// ── THE SCAN FORM ──────────────────────────────────────────────────────────────────────────

/** One decimal digit of any script. Anchored: it tests a single code point. */
const DECIMAL_DIGIT_RE = /^\p{Nd}$/u;
const DECIMAL_DIGITS_RE = /\p{Nd}/gu;

function isDecimalDigit(codePoint: number): boolean {
  return DECIMAL_DIGIT_RE.test(String.fromCodePoint(codePoint));
}

/**
 * The ASCII digit with the same value as `digit` (one `\p{Nd}` code point).
 *
 * Unicode's stability policy encodes every Nd digit in a contiguous run of ten, ascending from
 * zero — so a digit's value is its distance from the start of its run, mod 10. The mod is for the
 * places where runs sit back to back (the mathematical alphanumerics are five runs of ten in one
 * block of fifty). Computed by walking back rather than from a table: at most 49 steps per digit,
 * and no scan of 1.1M code points at module load. The policy itself is pinned by a test against
 * the running engine's Unicode data.
 */
function asciiDigit(digit: string): string {
  const codePoint = digit.codePointAt(0) ?? 0x30;
  if (codePoint >= 0x30 && codePoint <= 0x39) return digit;
  let runStart = codePoint;
  while (runStart > 0 && isDecimalDigit(runStart - 1)) runStart--;
  return String((codePoint - runStart) % 10);
}

/**
 * The form the identifier walls READ: every `\p{Nd}` folded to its ASCII digit.
 *
 * WHY: JavaScript's `\d` is ASCII-only — even under the `u` flag — and NFKC folds fullwidth
 * digits but not the decimal digits of other scripts. So "९८७६५४३२१०" (Devanagari),
 * "٩٨٧٦٥٤٣٢١٠" (Arabic-Indic) and "௯௮௭௬௫௪௩௨௧௦" (Tamil) were NOT DIGITS to `containsHardIdentifier`,
 * `looksLikePii` or anything else here, while the far side's Python `\d` is Unicode and masks
 * them. A voice turn transcribed in Devanagari is also the turn grounding skips — so for exactly
 * that class, the API had no wall at all.
 *
 * READ, NEVER SHOWN: the label returned is the cleaned original ("Class १० maths" stays in the
 * worker's own digits). The walls see both forms — see {@link refusedByPrivacyWalls}.
 */
function scanForm(text: string): string {
  return text.replace(DECIMAL_DIGITS_RE, asciiDigit);
}

/** Walls 3-7, in order. Each reads one form of the label; any hit refuses the candidate. */
const PRIVACY_WALLS: readonly ((text: string) => boolean)[] = Object.freeze([
  isPlaceholder,
  // `"scanner_error"` is non-null, so a scanner that throws fails CLOSED — exactly as the résumé
  // route reads it.
  (text: string) => containsHardIdentifier(text) !== null,
  (text: string) => PAN_ANY_CASE_RE.test(text),
  overDigitBudget,
  looksLikePii,
  looksLikeLink,
  looksLikeContactRoute,
  looksLikeOrgName,
  endsInLegalSuffix,
]);

/**
 * Walls 3-7 over one cleaned form of the label AND its scan form. Any hit refuses.
 *
 * BOTH FORMS, NOT THE SCAN FORM ALONE: folding can only ADD digits a regex sees, but it can also
 * glue a folded digit to an adjacent letter ("५ABCDE1234F" → "5ABCDE1234F", where the PAN's word
 * boundary is gone). Reading both means the fold is never the thing that let an identifier
 * through.
 *
 * FAIL CLOSED ON ANY THROW. Every wall here is a static regex or a pure call and none is expected
 * to throw; if one ever does, the candidate is refused rather than waved past a wall that did not
 * finish.
 */
function refusedByPrivacyWalls(text: string): boolean {
  try {
    const scan = scanForm(text);
    const forms = scan === text ? [text] : [text, scan];
    return forms.some((form) => PRIVACY_WALLS.some((wall) => wall(form)));
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 8. GENERIC WORDS
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Words that answer a question, name the job in general, or name a LEVEL — none of them is a
 * skill. Matched on the WHOLE normalised label only ("operator" is refused, "crane operator" is
 * not). Also the stop set for grounding (a skill token in this set is no evidence).
 *
 * Latin first, as the model writes labels; a handful of Devanagari twins because the gate's
 * Haan/Nahi, echoed back by a model on a voice turn, would otherwise be the one generic word no
 * other wall looks at. CLOSED and authored — a new entry is a reviewed edit, not a heuristic.
 */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  // yes / no / nothing — the gate's own answers, and their spellings
  "haan",
  "haa",
  "ha",
  "han",
  "haan ji",
  "ji",
  "ji haan",
  "yes",
  "nahi",
  "nahin",
  "nhi",
  "nai",
  "no",
  "na",
  "n a",
  "nil",
  "none",
  "nothing",
  "bas",
  "kuch nahi",
  "kuch bhi nahi",
  "koi nahi",
  "pata nahi",
  // everything / the job in general
  "sab",
  "sab kuch",
  "kuch bhi",
  "everything",
  "all",
  "kaam",
  "sab kaam",
  "work",
  "job",
  "naukri",
  "skill",
  "skills",
  "experience",
  "tajurba",
  "anubhav",
  "etc",
  "other",
  "others",
  "kuch aur",
  "koi aur",
  "general",
  "misc",
  "miscellaneous",
  // levels and bare worker nouns — ADR-0045 §3.1: not evidence of anything
  "helper",
  "operator",
  "skilled",
  "unskilled",
  "senior",
  "junior",
  "trainee",
  "fresher",
  "technician",
  "worker",
  "labour",
  "labor",
  "mazdoor",
  "majdoor",
  // Devanagari twins of the commonest of the above
  "हाँ",
  "हां",
  "नहीं",
  "कुछ नहीं",
  "काम",
  "नौकरी",
  "अनुभव",
  "सब",
]);

/**
 * Function words that carry no skill: Hinglish postpositions and pronouns, English articles and
 * prepositions. NOT refused as labels (they never arrive alone); used ONLY to stop them counting
 * as grounding evidence. Without it, "Tile ka kaam" would be grounded by any sentence containing
 * "ka" — which is nearly every Hinglish sentence a worker types — and grounding would be a wall
 * that always passes.
 */
const GROUNDING_STOPWORDS: ReadonlySet<string> = new Set([
  "ka",
  "ki",
  "ke",
  "ko",
  "se",
  "me",
  "mein",
  "main",
  "mai",
  "par",
  "pe",
  "aur",
  "ya",
  "bhi",
  "hai",
  "hain",
  "tha",
  "thi",
  "the",
  "hu",
  "hoon",
  "hun",
  "kar",
  "karta",
  "karti",
  "karte",
  "kiya",
  "wala",
  "wali",
  "wale",
  "liye",
  "ek",
  "mera",
  "meri",
  "mere",
  "hum",
  "ham",
  "ye",
  "yeh",
  "wo",
  "woh",
  "jo",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "an",
  "is",
  "am",
  "are",
  "was",
  "my",
]);

/**
 * NFKC, lowercase, and blank everything but letters, marks and digits — `llm-reply-guard.ts`'s
 * private `normalize`, copied rather than exported from there so neither file's behaviour moves
 * when the other's does. `\p{M}` STAYS IN THE KEEP SET: blanking a Devanagari matra splits one
 * word into two (the bug `duration-months.ts` hit first).
 *
 * ONE ADDITION: invisible characters are stripped BEFORE blanking, so "auto<ZWSP>cad" in a
 * worker's message is "autocad", not "auto cad".
 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s/gu, " ")
    .replace(INVISIBLE_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Is the label generic — or nothing at all?
 *
 * A label with NO LETTER is refused here too: "+++" names nothing, and a bare number ("25000",
 * "737") is a salary, a count or half of a model name, never a skill. "Boeing 737" and "A320"
 * have letters and pass.
 */
function isGeneric(label: string): boolean {
  const normalized = normalize(label);
  if (!/\p{L}/u.test(normalized)) return true;
  return GENERIC_LABELS.has(normalized);
}

/** Steps 0-8 on one candidate: the cleaned label, or null when any wall refuses it. */
function certifyLabelWalls(raw: string): string | null {
  // FIRST, before a single regex: see MAX_RAW_SKILL_UNITS for the quadratic it exists to stop.
  if (raw.length > MAX_RAW_SKILL_UNITS) return null;
  const cleaned = clean(raw);
  if (cleaned === null) return null;
  const { label, untrimmed } = cleaned;
  if (tooLong(label)) return null;

  // BOTH FORMS face the privacy walls. The trailing trim is cosmetic for display, but it is not
  // neutral for the org wall: `looksLikeOrgName` catches "Sharma Co." only by its dot, and the
  // trim would hand it "Sharma Co". Checking the untrimmed form too means the cleaning step can
  // never be the thing that let a name through.
  if (refusedByPrivacyWalls(label)) return null;
  if (untrimmed !== label && refusedByPrivacyWalls(untrimmed)) return null;

  if (isGeneric(label)) return null;
  return label;
}

/**
 * Walls 0-8 for one label, with no context: the cleaned label, or null.
 *
 * FOR RE-CERTIFICATION — a skill gathered on an earlier turn, or the role label before it is
 * echoed. No grounding (there is no message to ground in) and no de-dupe. Also no "is it the
 * role?" check: it has no role to compare against, and it is the function the role itself is
 * certified with. A role label that is only a level word ("Operator") certifies to null, by the
 * same rule that makes a level word no evidence of a lane (ADR-0045 §3.1).
 */
export function certifySkillLabel(label: string): string | null {
  return certifyLabelWalls(label);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 9. GROUNDING
// ─────────────────────────────────────────────────────────────────────────────────────────

interface GroundingIndex {
  /** The normalised message, space-padded so a padded needle only matches whole tokens. */
  readonly padded: string;
  readonly tokens: ReadonlySet<string>;
  /** The tokens eligible for the one-typo match — see {@link fuzzyEligible}. */
  readonly fuzzyTokens: readonly string[];
}

const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{N}/u;

/** A token that counts as evidence at all: two characters or more, and not a stop or generic word. */
function evidential(token: string): boolean {
  return token.length >= 2 && !GENERIC_LABELS.has(token) && !GROUNDING_STOPWORDS.has(token);
}

/**
 * A token eligible for the one-edit typo match: evidential, four characters or more, and NO
 * DIGIT. The digit rule is the one refinement over plain Levenshtein: "exel" → "excel" is a typo,
 * "A321" → "A320" is a different aircraft, and a one-digit edit is how a model hallucinates a
 * neighbouring model number while looking grounded.
 */
function fuzzyEligible(token: string): boolean {
  return token.length >= 4 && evidential(token) && !DIGIT_RE.test(token);
}

/**
 * The worker's message, indexed — or NULL WHEN GROUNDING IS SKIPPED.
 *
 * ══ THE DEVANAGARI TRADE-OFF — READ THIS BEFORE CHANGING IT ══
 *
 * A worker who SPEAKS gets a Devanagari transcript ("मैं ऑटोकैड और फोटोशॉप चलाता हूँ"), and the
 * model returns LATIN labels ("AutoCAD", "Photoshop"). Token overlap between the two scripts is
 * zero, so grounding would refuse every skill every voice worker ever gives — the whole road
 * would produce empty skill lists for the workers least able to type them. So: when the message
 * has letters and NONE of them is Latin, grounding is skipped, and every other wall (0-8, the
 * de-dupe, the cap) still applies. That is why the scan form exists: a voice turn is also the
 * turn whose digits arrive in Devanagari, and walls 3-7 must see them when grounding cannot.
 *
 * WHAT THAT COSTS: on a pure-Devanagari turn a model that INVENTS a plausible skill is not
 * caught here. The far side's certifier still runs, the skill still faces walls 0-8, and it still
 * lands on a gate the worker reads before saying Nahi — but the grounding wall is simply absent
 * for that turn. Transliterating to compare is the real fix, and it is not a regex.
 *
 * THE MIXED-SCRIPT EDGE, KNOWINGLY STRICT: one Latin letter anywhere ("मैं CNC चलाता हूँ")
 * switches grounding back ON, and it then grounds only on the Latin tokens — so "Fanuc", said in
 * Devanagari in that same sentence, is refused. That is the fail-closed direction.
 *
 * AN EMPTY OR LETTERLESS MESSAGE IS NOT SKIPPED. Nothing was said, so nothing is grounded; the
 * skip exists for a script mismatch, not for silence.
 */
function groundingIndex(workerText: string): GroundingIndex | null {
  const text = workerText.normalize("NFKC");
  if (LETTER_RE.test(text) && !LATIN_LETTER_RE.test(text)) return null;

  const normalized = normalize(text);
  const tokens = normalized.length > 0 ? normalized.split(" ") : [];
  return {
    padded: ` ${normalized} `,
    tokens: new Set(tokens),
    fuzzyTokens: tokens.filter(fuzzyEligible),
  };
}

/** Levenshtein distance ≤ 1, by code point, without building the matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (x.length > y.length) i++;
    else if (y.length > x.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

/**
 * Did the worker say this? Any one of:
 *
 *  (a) the whole normalised label is a run of whole tokens in the message ("autocad");
 *  (b) any evidential label token appears as a token in the message ("MS Excel" ← "excel");
 *  (c) any fuzzy-eligible label token is one edit from a fuzzy-eligible message token
 *      ("MS Excel" ← "exel").
 *
 * (b) is generous on purpose — "Pipe fitting" is grounded by "pipe" — because the model's job on
 * this stage is to NAME what the worker described, and a label that shares a real word with the
 * description is a naming, not an invention. What (b) refuses is the label that shares nothing:
 * "Photoshop" from a message about CorelDRAW.
 */
function isGrounded(label: string, index: GroundingIndex): boolean {
  const normalized = normalize(label);
  if (index.padded.includes(` ${normalized} `)) return true;

  const labelTokens = normalized.split(" ");
  if (labelTokens.some((token) => evidential(token) && index.tokens.has(token))) return true;

  return labelTokens
    .filter(fuzzyEligible)
    .some((token) => index.fuzzyTokens.some((heard) => withinOneEdit(token, heard)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 10. IDENTITY
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The de-dupe key: the canonical skill id when the taxonomy knows the phrase ("stick welding"
 * and "Arc welding" are one skill), else `n:` + the label's normalised text.
 *
 * THE FALLBACK KEEPS "+" AND "#", and that is the one place it departs from {@link normalize}.
 * Blanking them would make "C++", "C#" and "C" one key, and the second and third a worker gave
 * would vanish as "duplicates" of the first. Everything else collapses: case, NFKC width,
 * invisible characters, and punctuation — so "node js", "Node.js" and "NODE.JS" are one skill,
 * which is the reading a recruiter would give them. `n:` keeps a phrase from ever colliding with
 * a taxonomy id.
 *
 * The taxonomy lookup runs FIRST and is exact over ratified data (`skill-identity.ts`), so it
 * can merge only phrases a reviewer already said are the same skill.
 */
export function skillKey(label: string): string {
  const id = skillIdForPhrase(label);
  if (id !== null) return id;
  const text = label
    .normalize("NFKC")
    .replace(/\s/gu, " ")
    .replace(INVISIBLE_RE, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}+#]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return `n:${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE WHOLE WALL
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Is the label the role or the domain itself? "Pilot" is what he is, not what he can do. */
function namesTheRole(label: string, excluded: ReadonlySet<string>): boolean {
  return excluded.has(normalize(label));
}

function roleExclusions(ctx: SkillCertifyContext): ReadonlySet<string> {
  const labels = [ctx.roleLabel, ctx.domainLabel]
    .filter((value): value is string => value !== null)
    .map(normalize)
    .filter((value) => value.length > 0);
  return new Set(labels);
}

/**
 * Certify a turn's model-returned skills. See the module docblock for the order.
 *
 * EVERY CANDIDATE RUNS EVERY WALL, EVEN PAST THE CAP. `rejected` therefore counts the same
 * refusals whatever order the model listed things in, and `capped` means exactly "a skill that
 * passed everything was left out for room" — never "something after the 30th was junk".
 */
export function certifySkills(
  candidates: readonly string[],
  ctx: SkillCertifyContext,
): SkillCertifyResult {
  const index = groundingIndex(ctx.workerText);
  const excluded = roleExclusions(ctx);
  const seen = new Set(ctx.held.map(skillKey));

  const kept: string[] = [];
  let rejected = 0;
  let capped = false;

  for (const candidate of candidates) {
    const label = certifyLabelWalls(candidate);
    if (
      label === null ||
      namesTheRole(label, excluded) ||
      (index !== null && !isGrounded(label, index))
    ) {
      rejected++;
      continue;
    }

    const key = skillKey(label);
    if (seen.has(key)) continue;

    if (ctx.held.length + kept.length >= MAX_SKILLS) {
      capped = true;
      continue;
    }
    seen.add(key);
    kept.push(label);
  }

  return { kept, rejected, capped };
}
