import { z } from "zod";
import {
  LANGUAGE_CODES,
  MAX_VOICE_NOTE_SECONDS,
  CONSENT_PURPOSES,
  type VacancyBand,
} from "@badabhai/types";

/**
 * @badabhai/validators — reusable Zod schemas shared by API DTOs, AI contracts,
 * and tests. Keep these small and composable.
 *
 * BROWSER FLOOR, FOR THE WHOLE FILE: payer-web bundles this module, untranspiled,
 * into its client form schemas, for Next's default browser target (Chrome 64,
 * Firefox 67, Safari 12). A regex lookbehind, a \p{..} property escape, a named
 * group or an s / d / v flag ANYWHERE here — even in a function payer-web never
 * calls — is a parse-time SyntaxError for the whole chunk on those browsers.
 * `browser-floor.test.ts` fails on any of them.
 */

/**
 * E.164 phone number, e.g. "+919876543210".
 * Leading "+", first digit 1-9, total 8-15 digits.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, "Must be a valid E.164 phone number (e.g. +919876543210)");

export function isE164Phone(value: string): boolean {
  return e164PhoneSchema.safeParse(value).success;
}

/** Lowercased, trimmed email — shared by every login/admin-invite surface. */
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

const DIGITS_ONLY = /^\d+$/;

/**
 * A numeric one-time-code string, digits only.
 *
 * Pass a fixed length (`otpDigitsSchema(6)`, e.g. a TOTP code) or a `{ min, max }`
 * range (`otpDigitsSchema({ min: 4, max: 8 })`, e.g. a provider-flexible OTP) —
 * both payer-web's login OTP and admin-web's email code use the 4-8 range;
 * admin-web's MFA step is the fixed-6 TOTP shape.
 *
 * Checks digit-shape with the one fixed, hardcoded regex above and the length
 * bound separately, rather than building a length-parameterized `RegExp` at
 * call time -- a dynamic `new RegExp(...)` pattern is exactly the shape
 * semgrep's ReDoS rule (detect-non-literal-regexp) blocks on, even though
 * every call site here passes a hardcoded literal.
 */
export function otpDigitsSchema(spec: number | { min: number; max: number }) {
  const [min, max] = typeof spec === "number" ? [spec, spec] : [spec.min, spec.max];
  return z.string().trim().refine((v) => DIGITS_ONLY.test(v) && v.length >= min && v.length <= max, {
    message:
      min === max ? `Must be exactly ${min} digits` : `Must be ${min}-${max} digits`,
  });
}

/** RFC 4122 UUID. */
export const uuidSchema = z.string().uuid();

/** Supported language code (see @badabhai/types LANGUAGE_CODES). */
export const languageCodeSchema = z.enum(LANGUAGE_CODES);

/**
 * Voice note duration in seconds. Must be > 0 and <= 120 (Phase 1 hard limit).
 */
export const voiceDurationSecondsSchema = z
  .number()
  .positive("Duration must be greater than 0")
  .max(MAX_VOICE_NOTE_SECONDS, `Duration must be at most ${MAX_VOICE_NOTE_SECONDS} seconds`);

export function isValidVoiceDuration(seconds: number): boolean {
  return voiceDurationSecondsSchema.safeParse(seconds).success;
}

/** Non-empty (after trim) message string. */
export const nonEmptyMessageSchema = z
  .string()
  .trim()
  .min(1, "Message must not be empty");

/** Default maximum length for free-text fields. */
export const DEFAULT_SAFE_TEXT_MAX = 5000;

/** Safe bounded free text. Defaults to a 5000-char cap. */
export function safeTextSchema(maxLength: number = DEFAULT_SAFE_TEXT_MAX) {
  return z.string().trim().min(1).max(maxLength);
}

/** Consent purposes — must be a non-empty subset of the known purposes. */
export const consentPurposesSchema = z
  .array(z.enum(CONSENT_PURPOSES))
  .min(1, "At least one consent purpose is required")
  .refine((arr) => new Set(arr).size === arr.length, "Consent purposes must be unique");

// ---------------------------------------------------------------------------
// Worker-conversation Storage prefix (ADR-0003, Withdrawn — erasure leg only)
// ---------------------------------------------------------------------------

/**
 * Per-worker prefix in the `worker-conversations` Storage bucket, for DPDP
 * ERASURE ONLY.
 *
 *   <worker_id>/
 *
 * ⚠ THIS IS NOT A WRITE CONTRACT ANY MORE. ADR-0003 planned an archival tier that
 * mirrored each finished interview into this bucket as JSON; it was withdrawn on
 * 2026-08-14 without ever being built (the bucket was never provisioned and nothing
 * ever wrote `chat_sessions.conversation_storage_path`). `chat_messages` is the
 * complete durable transcript, so a bucket copy would only have doubled the raw-PII
 * surface — which was the whole of risk R10. Its sibling `conversationObjectKey`
 * was deleted with the retirement; do not reintroduce a key builder here without a
 * NEW ADR.
 *
 * WHY THIS SURVIVED THE RETIREMENT. It backs a live erasure leg — the
 * `conversation_prefix` sweep in `AccountDeletionService` — and deleting an erasure
 * leg to tidy up a retired feature is a security regression, not a cleanup. The
 * sweep is defence in depth: against a bucket that does not exist the Storage `list`
 * 404s and the sweep records `nothing_to_delete`, so it costs one call and would
 * still catch an object if the tier were ever revived or provisioned by hand.
 *
 * Throws if `workerId` is not a UUID (fail closed — a non-opaque id must never
 * become a storage path).
 */
export function conversationWorkerPrefix(workerId: string): string {
  return `${uuidSchema.parse(workerId)}/`;
}

// ---------------------------------------------------------------------------
// Best-effort PII shape detection (capture-boundary guard)
// ---------------------------------------------------------------------------

// An email shape: a character, "@", then a domain with a dot inside it. The local part
// is ONE character on purpose (#1924). `[^\s@]+@` was quadratic: on a long run with no
// "@" it re-scanned the run from every start position, ~190 ms at 20k characters and
// ~4.8 s at 100k, and Zod still runs a refine after `.max()` fails. Matching only the
// character before the "@" changes no verdict, because any local part ends in one.
// Each "@" now starts at most one domain scan, and those scans never overlap (a domain
// stops at the next "@"), so the work is linear. Only ever used with `.test()`.
const EMAIL_LIKE = /[^\s@]@[^\s@]+\.[^\s@]+/;
// Separators commonly used inside phone numbers; stripped before counting digits
// so spaced/punctuated forms ("98765 43210", "+91-98765-43210") are still caught.
const PHONE_SEPARATORS = /[\s().+-]/g;
const PHONE_DIGIT_RUN = /\d{7,}/;
// Human-name-like free text: 2-4 title-cased words without digits or punctuation.
const HUMAN_NAME_LIKE = /^(?:[A-Z][a-z]+|[A-Z]\.)+(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)+){1,3}$/;
// Address-like phrases: street/sector/house keywords with a number or another
// address keyword, which is enough to reject obvious home-address free text.
const ADDRESS_LIKE = /\b(?:house|flat|apartment|street|road|lane|colony|sector|area|nagar|ward|block)\b/i;

/**
 * Best-effort heuristic: true if a string looks like an OBVIOUS phone number or
 * email address. Used broadly at free-text capture boundaries — job/posting
 * titles, descriptions, benefits, campaign tags — to fail closed on raw PII
 * before it reaches the events table or a worker-visible surface.
 *
 * NOT a PII classifier: it only catches email-shaped strings and long digit runs
 * (after stripping common phone separators). It deliberately does NOT flag
 * name/address-shaped text here — most of this function's callers validate
 * legitimate short title-case free text ("New Title", "Night Shift Operator",
 * "Updated Role Title"), which is INDISTINGUISHABLE from a human name by
 * capitalization shape alone. Callers must still keep free text out of fields
 * that flow into events/logs. See `looksLikeActionContextPii` for the narrower
 * boundary (the actions-context bag) where a stricter name/address check is safe.
 */
export function looksLikePii(s: string): boolean {
  const value = s.trim();
  if (!value) return false;
  if (EMAIL_LIKE.test(value)) return true;
  return PHONE_DIGIT_RUN.test(value.replace(PHONE_SEPARATORS, ""));
}

/**
 * TD11 — the actions-context bag's stricter guard: everything `looksLikePii`
 * catches, PLUS obvious human-name-shaped (2-4 title-cased words) and
 * address-shaped free text. Safe ONLY at this boundary because `context` values
 * are short non-PII SIGNALS ("started", "step_2"), not narrative content —
 * unlike job titles/descriptions, a title-cased 2-4 word `context` value has no
 * legitimate reason to exist, so the false-positive risk that rules this check
 * out of the general `looksLikePii` is acceptable here.
 */
export function looksLikeActionContextPii(s: string): boolean {
  const value = s.trim();
  if (!value) return false;
  if (looksLikePii(value)) return true;
  if (HUMAN_NAME_LIKE.test(value)) return true;
  return Boolean(ADDRESS_LIKE.test(value) && (/\d/.test(value) || /\b(?:street|road|lane|sector|colony|area|nagar|ward|block)\b/i.test(value)));
}

// ---------------------------------------------------------------------------
// Best-effort ORG-NAME shape detection (worker-visible job free text, ADR-0024)
// ---------------------------------------------------------------------------

// Strong legal-entity markers — safe to match ANYWHERE, case-insensitively (each
// is a suffix shape that essentially never occurs in legitimate trade text):
// Pvt Ltd / Pvt. Ltd., Private Limited, LLP, Inc, Corp/Corporation. The "Co"
// forms are ORG_CO_FORM below — they need a compound guard these do not.
const ORG_SUFFIX_STRONG = new RegExp(
  [
    String.raw`\bpvt\.?\s+ltd\b`, // Pvt Ltd / Pvt. Ltd.
    String.raw`\bprivate\s+limited\b`, // Private Limited
    String.raw`\bllp\b`, // LLP
    String.raw`\binc\b`, // Inc / Inc.
    String.raw`\bcorp(?:oration)?\b`, // Corp / Corp. / Corporation
  ].join("|"),
  "i",
);

// "& Co" / "and Co" anywhere, and "Co." — where the DOT is REQUIRED so a bare
// "co" and words that merely start with "co" ("control") stay legal. Neither
// form fires when the "co" opens a COMPOUND (#1914). The "& Co" / "and Co" form
// takes the guard the ai-service puts on its capitals CO form (`_CAPS_CO_COMPOUND`,
// #1875):
//  - a dash straight after "co" always makes one — "and co-ordinate", "& co-workers",
//    "co–operative" — across the whole dash family (ASCII hyphen, U+2010–U+2015,
//    minus sign, small and fullwidth hyphen-minus), not only ASCII;
//  - across a space only the CLOSED list does — "and co ordinate", "and co
//    operation", "& co op society", "co worker", "co curricular", "and co 2
//    welding", "co 2 gas". Closed on purpose: "Sharma & Co operations manager",
//    "Sharma & Co 2 saal" and "Sharma & Co 2 welder chahiye" are still firms —
//    "2 weld" stops at "weld"/"welding", so a count of welders is not a compound.
// After a DOT — either form — only "ordinat" makes a compound ("co.ordinator",
// "co. ordinate"). This is NARROWER than the ai-service on purpose. No compound
// is spelled "co.-", so "Sharma Co.-Pune" is a firm, and a dot before "op" /
// "operative" / "worker" is how the co-operative employers write their names:
// "Cosmos Co.op. Bank", "Shanti Co. Operative Housing Society". The measured
// corpus held no "co." compound but "co.ordinator", so the wider list would have
// lost those firms and gained nothing.
// Horizontal whitespace only (never \r or \n) between "co" and the listed word —
// note `[^\S\r\n]` still admits VT, FF, U+2028 and U+2029, no wider than a plain
// space already is: "Sharma & Co",
// a line break, then "Operation head" is a firm. The price, stated: a firm glued
// to a dash ("Sharma & Co-Pune", "Sharma & Co—Pune", a trailing "Sharma & Co-"),
// or followed across a space by a listed word ("Sharma & Co workers chahiye",
// "Sharma & Co Operative Store", "Sharma & Co op"), reads as a compound and slips
// this tier.
const ORG_CO_FORM =
  /(?:&|\band)\s+co\b(?![-\u2010-\u2015\u2212\uFE63\uFF0D]|[^\S\r\n]*(?:ordinat|operat(?:ion|ive|e)\b|op\b|worker|curricular|2[^\S\r\n]*(?:weld(?:ing)?|gas)\b)|\.[^\S\r\n]*ordinat)|\bco\.(?![^\S\r\n]*ordinat)/i;

// Bare "Ltd"/"Limited" WITHOUT a pvt/private prefix. The two words are not equally
// ambiguous — "Ltd" is almost always a firm's suffix, "limited" is an ordinary word
// ("limited experience ok") — so they get different tiers (#1927). "Almost": trade prose
// does write "ltd" for "limited" ("Seats ltd hain", "ltd seats"), and that "ltd" is clean
// only before a noun ORG_LTD_NOT_A_NAME lists; anywhere else it is read as a suffix.
//  - ORG_TRAILING_LTD: either word after a Capitalized-ish token, at the end of the
//    string or before punctuation ("Tata Steel Ltd", "Bharat Forge Limited.", "Tata
//    Steel Ltd, Pune"); the suffix's own dot counts as that punctuation ("Godrej Ltd.
//    ke liye"). The suffix is spelled with per-letter classes because the
//    Capitalized-token test forbids the `i` flag (it would case-fold [A-Z] too).
//  - ORG_LTD_AFTER_NAME: "Ltd" in ANY position and ANY case once a name character sits
//    before it on the same line — a closing quote, bracket or markdown mark counts as
//    one: ) ] } > ' " ’ ” “ » › * ` — ("Tata Steel Ltd mein apply kariye", "welding at
//    tata motors ltd", "Ashok Leyland Ltd/Hosur", '"Tata Steel" Ltd mein', "**Tata
//    Steel** Ltd"). Skipped only before a word ORG_LTD_NOT_A_NAME lists — the entity
//    TYPE ("a reputed Ltd company") or a noun "ltd" means "limited" for ("Ltd seats",
//    "ltd vacancies", "ltd experience") — so "Tata Steel Ltd company mein" and "Tata
//    Steel Ltd jobs" slip this tier, while "Seats ltd hain" is flagged. Its second
//    branch is "Ltd"/"Limited" glued to a "pvt" by up to three non-letters, which the
//    strong tier's "pvt ltd" needs a space for ("Sharma Pvt.Ltd", "PvtLtd", "Pvt/Ltd",
//    "Pvt.Limited"), and it takes NO skip: "Sharma Pvt.Ltd company mein" is a firm.
//    No [A-Z] test, so it takes `i`.
//  - ORG_LIMITED_MID: a mid-sentence "Limited" only when Title-case or ALL-CAPS, after
//    a NAME — two Capitalized tokens ("Tata Steel", "Larsen & Toubro") or one token
//    carrying "&" ("M&M"), a token optionally wrapped in quotes, brackets or markdown
//    emphasis ('"Tata Steel" Limited') — AND followed by a word only an entity takes: a
//    Hinglish postposition (mein / ki / ke / jaisi …), an English function word (is /
//    for / at / of …), or a line break ("Company: Bharat Forge Limited\nOT milega").
//    Never before a copula ("hai"), "to", or the noun an adjective modifies ("Limited
//    experience"), and never when the word before it cannot end a name — a limited
//    noun, a copula, a negation, an adverb, a determiner or pronoun, or an intensifier
//    ("Welder Vacancies Limited for freshers", "Seats Are Limited\nApply Now", "Seats
//    Not Limited for women", "Entry Strictly Limited for ITI holders", see
//    ORG_NOT_A_NAME_TAIL).
//  - ORG_LIMITED_ONE_TOKEN: one Capitalized token is enough when a Hinglish
//    postposition follows ("Thermax Limited mein", "Wipro Limited ke saath") — and only
//    then: "Thermax Limited is hiring" slips.
// The new tiers read horizontal whitespace only ([^\S\r\n]): a name and its suffix
// share a line, so "Requirement: CNC Operator" with "Limited for ITI freshers" on the
// next line stays prose.
const ORG_TRAILING_LTD = new RegExp(
  String.raw`(?:^|\s)[A-Z][\w&.'()-]*\s+(?:[Ll][Tt][Dd]|[Ll][Ii][Mm][Ii][Tt][Ee][Dd])\.?\s*(?:$|[.,;:!?)\]])`,
);

// The words after "Ltd" that make it the entity TYPE ("Ltd company") or "limited" written
// short ("ltd seats", "ltd experience"), not a suffix. CLOSED: before any other word a
// "ltd" is read as a firm's suffix, so "Seats ltd hain" and "OT ltd hai" are flagged.
const ORG_LTD_NOT_A_NAME = String.raw`(?:compan(?:y|ies)|compny|firms?|sector|jobs?|naukri|seats?|period|edition|offers?|stock|time|slots?|spots?|openings?|vacanc(?:y|ies)|posts?|positions?|experience|hours?|overtime|intake|quantity|budget|salary|insurance)`;
// The name character before the gap includes a closing quote, bracket or markdown mark —
// ) ] } > ' " ’ ” “ » › * ` — the non-ASCII five and the backtick spelled \u2019 \u201D
// \u201C \u00BB \u203A \u0060 in the class. The skip reads the NAME branch only. The second
// branch is "pvt" glued to "ltd"/"limited" by up to three non-letters — with `i`, [^a-z]
// excludes A-Z too, and \b keeps a "pvt" inside a word out — and is a firm whatever follows.
const ORG_LTD_AFTER_NAME = new RegExp(
  String.raw`(?:[\w&).'"\u2019\u201D\u201C\u00BB\u203A\]*\u0060}>][^\S\r\n]+ltd\b(?!\.?[^\S\r\n]*${ORG_LTD_NOT_A_NAME}\b)|\bpvt[^a-z\r\n]{0,3}(?:ltd|limited)\b)`,
  "i",
);

// A name token of the Limited tiers: its first LETTER is a capital, and it may sit in quotes,
// brackets or markdown emphasis — " “ ‘ [ * before it, " ” ’ ] * after ('"Tata Steel" Limited
// mein', "“Tata Steel” Limited is hiring", "**Tata Steel** Limited mein").
const ORG_NAME_OPEN = String.raw`["\u201C\u2018\[*]*`;
const ORG_NAME_CLOSE = String.raw`["\u201D\u2019\]*]*`;
const ORG_NAME_TOKEN = String.raw`${ORG_NAME_OPEN}[A-Z][\w&.'()-]*${ORG_NAME_CLOSE}`;
const ORG_GAP = String.raw`[^\S\r\n]+`;
const ORG_POSTPOSITION = String.raw`(?:mein|me|mai|men|mei|ki|ka|ke|ko|se|ne|par|pe|tak|jaisi|jaisa|jaise|wali|wala|wale|waali|waala|waale|dwara)`;
const ORG_ENTITY_FOLLOW = String.raw`(?:is|was|has|had|have|will|hires|hiring|for|at|in|of|and|or|ya|aur|group|plant|plants|factory|unit|office|branch|site)`;
// Words that never end a firm's name, so never the token right before "Limited": a noun
// that is itself "limited" ("Seats Limited", "Night Shift Limited"), and a copula, a
// negation, an adverb, a determiner or pronoun, or an intensifier ("Seats Are Limited",
// "Seats Not Limited", "Income Also Limited", "Ek Limited mein", "Aap Limited mein",
// "Entry Strictly Limited", "Bahut Limited mein"). Deliberately not "public" ("Sharma
// Public Limited mein" is a firm), "now", "off" or "abhi", nor "facility"/"facilities"
// ("XYZ Facilities Limited mein housekeeping" is a firm). Matched in Title-case and
// ALL-CAPS, because the Limited tiers have no `i`, and through the quotes a name token may
// carry ("Hurry **Seats** Limited for women"). map + concat, not flatMap (Chrome 69; the
// floor is 64).
const ORG_NOT_A_NAME_TAIL: readonly string[] = (
  "seat seats vacancy vacancies opening openings post posts position positions slot slots " +
  "spot spots experience time period overtime hour hours shift shifts day days night nights " +
  "holiday holidays leave leaves budget stock offer offers job jobs intake admission " +
  "admissions quantity space parking salary bonus " +
  "are is was were very strictly highly extremely only bahut kaafi thoda " +
  "not too also still remain remains quite sirf ek koi kisi aap mera meri hamara"
).split(" ");
const ORG_NAME_TAIL_GUARD = String.raw`(?!${ORG_NAME_OPEN}(?:${ORG_NOT_A_NAME_TAIL.map(
  (w) => w.charAt(0).toUpperCase() + w.slice(1),
)
  .concat(ORG_NOT_A_NAME_TAIL.map((w) => w.toUpperCase()))
  .join("|")})${ORG_NAME_CLOSE}[^\S\r\n])`;
const ORG_LIMITED_MID = new RegExp(
  String.raw`(?:^|\s)(?:${ORG_NAME_TOKEN}${ORG_GAP}(?:(?:&|and)${ORG_GAP})?${ORG_NAME_TAIL_GUARD}${ORG_NAME_TOKEN}|[A-Z][\w.'()-]*&[\w&.'()-]*)${ORG_GAP}L(?:imited|IMITED)(?:${ORG_GAP}(?:${ORG_POSTPOSITION}|${ORG_ENTITY_FOLLOW})\b|[^\S\r\n]*[\r\n])`,
);
const ORG_LIMITED_ONE_TOKEN = new RegExp(
  String.raw`(?:^|\s)${ORG_NAME_TAIL_GUARD}${ORG_NAME_TOKEN}${ORG_GAP}L(?:imited|IMITED)${ORG_GAP}${ORG_POSTPOSITION}\b`,
);

/**
 * Best-effort heuristic: true if a string looks like it contains a LEGAL-ENTITY
 * company name — an org-suffix marker such as "Pvt Ltd" / "Pvt. Ltd." /
 * "Private Limited" / "LLP" / "Inc" / "Corp"/"Corporation" / "& Co"/"and Co" /
 * "Co.", or a bare "Ltd"/"Limited" in entity position. The fail-closed
 * companion to {@link looksLikePii} for worker-visible job free text (title /
 * description / benefits / requirements items) — ADR-0024 final addendum
 * (2026-07-16): employer identity must never enter the worker-visible `jobs`
 * columns, so every jobs write path rejects strings this flags.
 *
 * NOT a classifier: it is deliberately TIGHT to legal-entity suffix markers and
 * will NOT catch a bare brand name ("Sharma Precision", "Tata Motors mein", "L&T
 * mein") or generic org-ish words ("Industries" / "Works" / "Engineering" alone —
 * far too many false positives on legitimate trade text). Tradeoffs, documented
 * and pinned by tests:
 *  - the strong markers (Pvt Ltd / Private Limited / LLP / Inc / Corp) are flagged
 *    anywhere, case-blind — including the generic "Pvt Ltd company mein 3 saal"
 *    and the company-law skill "LLP compliance", which name nobody;
 *  - a bare "Ltd" is flagged in ANY position and ANY case once a name character
 *    sits before it on the same line (#1927) — a closing quote, bracket or
 *    markdown mark counts as one: ) ] } > ' " ’ ” “ » › * ` — so "Tata Steel Ltd
 *    mein apply kariye", "acme ltd", "Acme Ltd hiring now", "Ashok Leyland
 *    Ltd/Hosur", '"Tata Steel" Ltd mein', "**Tata Steel** Ltd mein" and "«Tata
 *    Steel» Ltd" are flagged. A "Ltd" or "Limited" glued to a pvt by up to three
 *    non-letters is flagged whatever follows: "Sharma Pvt.Ltd company mein",
 *    "Sharma PvtLtd", "Sharma Pvt/Ltd", "Sharma Pvt.Limited mein". A "ltd" written
 *    for "limited" is clean ONLY before a closed list of nouns — the entity type
 *    and the things "ltd" limits: company / firm / sector / jobs / naukri /
 *    vacancy / openings / seats / posts / experience / hours / overtime / salary /
 *    … ("a reputed Ltd company", "Only 20 ltd seats");
 *  - a bare "Limited" is ordinary prose, so it is flagged only where nothing but a
 *    firm stands: at the end after a Capitalized token ("Tata Motors Limited"), or
 *    mid-sentence when Title-case or ALL-CAPS, after two Title-case tokens whose
 *    second is not on ORG_NOT_A_NAME_TAIL (or one token before a Hinglish
 *    postposition), and before a
 *    postposition, an entity function word or a line break ("Tata Steel Limited
 *    mein", "Larsen & Toubro Limited is hiring", "Thermax Limited ke saath"). A
 *    name token may sit in quotes, brackets or markdown emphasis — " “ ‘ [ *
 *    before it, " ” ’ ] * after ('"Tata Steel" Limited mein', "“Tata Steel”
 *    Limited is hiring"). "limited experience ok", "Experience Limited to 2
 *    years", "Mera Limited experience hai", "Welder Vacancies Limited for
 *    freshers", "Seats Are Limited\nApply Now", "Seats Not Limited for women" and
 *    "Aap Limited mein apply kar sakte ho" pass;
 *  - THE PRICE of the bare-suffix tiers, stated — a firm slips them when:
 *     - "Ltd" is followed by a word on that closed list ("Tata Steel Ltd company
 *       mein", "Tata Steel Ltd jobs", "Tata Steel Ltd naukri ke liye", "Tata Steel
 *       Ltd vacancy nikli hai") — "<Firm> Ltd experience / posts / hours" too, so
 *       the career wall serves "Aapka Tata Motors Ltd experience kaam aayega.";
 *     - a line break splits the name from its suffix ("Tata Steel\nLtd mein");
 *     - punctuation glues them ("Tata Steel-Ltd mein", "Tata Steel, Ltd mein"),
 *       nothing separates them ("Tata SteelLtd mein"), or the suffix sits in
 *       brackets ("Tata Steel (Ltd) mein");
 *     - the suffix is dotted or misspelled ("L.t.d.", "Lmtd", "Lim.", "Ld.");
 *     - "Limited" follows ONE token and an English function word follows it
 *       ("Thermax Limited is hiring") — one token needs a Hinglish postposition;
 *     - "Limited" is followed by a Title-case postposition or any word the follow
 *       list lacks ("Tata Steel Limited Mein apply", "Tata Steel Limited Jamshedpur
 *       mein", "Tata Steel Limited to hire"), or by an ALL-CAPS postposition
 *       ("BHARAT FORGE LIMITED MEIN");
 *     - the name before "limited" is lowercase ("bharat forge limited mein"), or
 *       sits in a guillemet, backtick, brace or angle bracket ("«Tata Steel»
 *       Limited is hiring") — the Limited tiers read only the quotes above;
 *    and prose is flagged though it names nobody when "Limited" ends the text or a
 *    clause after a trailing Title-case word ("Openings Limited", "Seats
 *    Limited!", "Seats Are Limited!" — the end tier reads no tail guard), when a
 *    "ltd" written for "limited" comes before a word the closed list lacks ("Seats
 *    ltd hain", "Vacancy ltd hai", "OT ltd hai"), or when "ltd"/"limited" sits up
 *    to three non-letters after a "pvt" ("Govt ya Pvt, limited experience ok"), or
 *    when a Title-case "Limited" mid-sentence follows a Title-case noun the closed
 *    ORG_NOT_A_NAME_TAIL lacks, before an entity word or a line break ("Night Duty
 *    Limited in winter", "Hostel Facility Limited for female staff"). "facility"
 *    stays off that list on purpose: "XYZ Facilities Limited mein" is a firm;
 *  - it reads ASCII Latin only: a fullwidth, lookalike, Devanagari, control- or
 *    zero-width-split suffix is invisible to it. Callers must NFKC-fold and strip
 *    \p{Cf} and \p{Cc} first (keeping \t, \n and \r, which the tiers read as a
 *    space and line breaks). The career wall scans an NFKD fold and refuses
 *    \p{Cf} outright but does not strip \p{Cc} (#1943); the job-text screen does
 *    neither (#1942);
 *  - a "co" that opens a compound is not a firm (#1914): "and co-ordinate",
 *    "& co-workers", "and co operative", "co.ordinator" pass, while "Sharma & Co",
 *    "Sharma and Co.", "Sharma & Co, Pune", "Sharma Co.-Pune" and the co-op
 *    names "Cosmos Co.op. Bank" / "Shanti Co. Operative Housing Society" are
 *    still flagged. The price: a "& Co" / "and Co" firm glued to any dash
 *    ("Sharma & Co-Pune", "Sharma & Co—Pune", "Sharma & Co-") or followed across
 *    a space by a listed compound word — worker(s), operation / operative /
 *    operate, op, curricular, ordinat…, "2 weld(ing)" / "2 gas" ("Sharma & Co workers
 *    chahiye") — slips the "Co" tier.
 * Callers must still keep employer identity out of these fields by policy.
 *
 * FOUR WALLS READ THIS, and both the #1914 narrowing and the #1927 widening apply
 * to each: the ADR-0024 job-text screen ({@link workerVisibleTextScreens}, the
 * agency and posting DTOs, payer-web's form contracts, the seed scripts), the
 * companion-v2 career-answer gate (`named_employer`), the skill certifier's org
 * wall, and the general-form brief's organisation wall. A change here moves all
 * four — and, because a posting edit resends its title and description, a stored
 * posting newly flagged here can be saved again only once its text changes.
 */
export function looksLikeOrgName(s: string): boolean {
  return (
    ORG_SUFFIX_STRONG.test(s) ||
    ORG_CO_FORM.test(s) ||
    ORG_TRAILING_LTD.test(s) ||
    ORG_LTD_AFTER_NAME.test(s) ||
    ORG_LIMITED_MID.test(s) ||
    ORG_LIMITED_ONE_TOKEN.test(s)
  );
}

// ---------------------------------------------------------------------------
// Best-effort URL / link shape detection (worker-visible job free text, ADR-0024)
// ---------------------------------------------------------------------------

// Link shapes: an explicit http(s) scheme, a "www." prefix, or a dotted common
// TLD. The TLD tier requires the dot IMMEDIATELY before the TLD token
// ("acme.in", "acme-components.com", "acme.co.in") — prose like "2.5 in" (space
// before "in") or an org-suffix "Co." (dot AFTER "co") never matches.
//
// One host is a degree, not a link (#1914): B.Com / M.Com, the commerce degrees a
// job's requirements name ("B.Com/M.Com preferred"). The TLD tier reads a HOST — a
// run of word characters, dots, dashes and "@", starting at the string or after
// any other character — and skips it only when the WHOLE run is "b.com" or "m.com"
// (any case), optionally with trailing sentence dots ("B.Com.", "B.Com..."). So
// "x.com", "a.com", "shop.b.com", "b.com.au", "a@b.com" and "B.Com.acme.in" are
// still hosts; "B.Com/M.Com", "(B.Com)" and "B.Com, M.Com" are two degrees. Closed
// on purpose: no other single-letter host is skipped. The price, stated: the hosts
// b.com and m.com themselves slip this tier, with or without a path or port
// ("b.com/apply") — a scheme or "www." still catches them. A host is read from the
// last run of ASCII host characters, so ANY other character just before a host
// that ends in "b" / "m" — a non-ASCII letter ("cafém.com"), an invisible format
// character (a U+200B before the "m" of "instagram.com"), a fullwidth dot — leaves
// "b.com" / "m.com"
// and is skipped. That opens no new class: one invisible character inside the
// TLD already beat this tier, and job text does not strip \p{Cf} (#1942). No
// lookbehind: payer-web ships this to Next's default browser target (Safari 12),
// which predates it.
const URL_SCHEME = /\bhttps?:\/\//i;
const URL_WWW = /\bwww\./i;
const URL_TLD =
  /(?:^|[^\w.@-])(?![bm]\.com\.*(?![\w.@-]))[\w.@-]*\.(?:com|net|org|co\.in|co|in|io|biz|info)\b/i;

/**
 * Best-effort heuristic: true if a string looks like it contains a URL / web
 * link — an explicit http(s) scheme, a "www." prefix, or a dotted common TLD.
 * The THIRD fail-closed companion (with {@link looksLikePii} and
 * {@link looksLikeOrgName}) for worker-visible job free text — the ADR-0024
 * final addendum's HIDDEN clause bars contact LINKS from every `jobs` write
 * path, so a link-shaped string in title/description/benefits/requirements is
 * rejected before it can reach a worker.
 *
 * NOT a classifier: spelled-out domains ("acme dot in") and exotic TLDs slip —
 * callers must still keep contact routes out of these fields by policy. The
 * degrees "B.Com" / "M.Com" are not links (#1914); the cost is that the bare
 * hosts b.com and m.com slip the TLD tier too, with a path, port, query or
 * fragment ("b.com/apply", "b.com:8080", "m.com?x=1").
 *
 * This helper OWNS the degree skip. The skill certifier and the general-form
 * brief keep their own whole-token exemptions (".net", "asp.net", …, "b.com",
 * "m.com") in front of it; their "b.com" / "m.com" entries are now redundant
 * with this skip, and their HOST_WITH_PATH wall still refuses "b.com/anything".
 */
export function looksLikeUrl(s: string): boolean {
  return URL_SCHEME.test(s) || URL_WWW.test(s) || URL_TLD.test(s);
}

/** Which of ADR-0024's worker-visible free-text heuristics a string trips. */
export type WorkerVisibleScreen = "contact_details" | "company_name" | "link";

/**
 * THE ADR-0024 WORKER-VISIBLE FREE-TEXT SCREEN, as one list: {@link looksLikePii},
 * then {@link looksLikeOrgName}, then {@link looksLikeUrl}. Returns every screen
 * the string trips, in that order, and an empty array when it is clean.
 *
 * Every writer of worker-visible job text calls this rather than its own copy of
 * the three helpers: the api's Zod screen (`screenWorkerVisibleText`), the D4
 * seed-job converter and the seed scripts. A heuristic added here therefore
 * reaches all of them at once, and the api's exhaustive message map stops
 * compiling until the new screen has a message. Names only, never the text.
 */
export function workerVisibleTextScreens(s: string): WorkerVisibleScreen[] {
  const out: WorkerVisibleScreen[] = [];
  if (looksLikePii(s)) out.push("contact_details");
  if (looksLikeOrgName(s)) out.push("company_name");
  if (looksLikeUrl(s)) out.push("link");
  return out;
}

// ---------------------------------------------------------------------------
// Vacancy band derivation (ADR-0012: job_postings is BANDED, not an integer)
// ---------------------------------------------------------------------------

/**
 * Map a RAW vacancy count to the existing shipped band (`VACANCY_BANDS`).
 *
 * The raw count is INTAKE-ONLY: it is derived to a band at the boundary and the
 * integer is then discarded — it is NEVER stored on a column and NEVER put in an
 * event. This keeps ADR-0012 intact (postings stay banded, not counted).
 *
 * Boundaries reproduce the EXACT shipped band strings:
 *   n <= 1        -> "1"
 *   2 <= n <= 5   -> "2-5"
 *   6 <= n <= 10  -> "6-10"
 *   11 <= n <= 25 -> "11-25"
 *   n >= 26       -> "25+"
 *
 * Note the 25/26 boundary: "25+" means STRICTLY GREATER than 25 — 25 itself
 * falls in "11-25". Defensive guard: a non-positive-integer `n` is invalid (the
 * DTO already blocks it, but the helper fails closed rather than guessing).
 */
export function bandForCount(n: number): VacancyBand {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`vacancy count must be a positive integer, got: ${n}`);
  }
  if (n <= 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 10) return "6-10";
  if (n <= 25) return "11-25";
  return "25+";
}

// ---------------------------------------------------------------------------
// Title-casing worker-typed labels — the worker app's rule, ported exactly (#1432)
// ---------------------------------------------------------------------------

export { titleCaseWords } from "./title-case";

export type E164Phone = z.infer<typeof e164PhoneSchema>;
export type ConsentPurposes = z.infer<typeof consentPurposesSchema>;
