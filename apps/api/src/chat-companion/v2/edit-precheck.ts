import { isCompanionStatusQuestion } from "../companion-intents";
import { normalizeResumeMenuText } from "../../chat/resume-menu";

/**
 * THE EDIT PRE-CHECK (TD146, WP6) — a small REVIEWED table, deterministic, no model.
 *
 * v1's keyword resolver answers most edit phrasings before companion v2 can see them: "edit my
 * resume" hits the résumé menu's `edit` alias, "location Mumbai kar do" its `location` section
 * alias, and the worker never reaches the edit card. Under
 * `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` (and only while the edit phase flag is on), the
 * service routes a text this table recognises to the v2 edit handler BEFORE v1.
 *
 * THE SHAPE IT MATCHES, AND THE SHAPE IT REFUSES. An unambiguous request is an EDIT VERB plus the
 * FIELD it targets ("… kar do / badal do / hata do / add karo" + location / salary / shift /
 * language …), or a generic English edit verb plus `resume` / `cv` / `profile` / `biodata` ("edit
 * my resume"). It refuses anything that is a NAMED v1 intent: the caller never calls it for an
 * exact chip tap (`isCompanionChipTap`), and a status question ("resume update ho gaya?") is
 * refused here by the shared status predicate. Jobs, applications and guarantee words are not in
 * the field vocabulary, so those named intents are never claimed.
 *
 * A FALSE POSITIVE costs one edit-parse call and the "kya badalna hai" line; a false negative
 * leaves today's v1 answer. Nothing here writes, logs or calls a model; the text is classified
 * and dropped.
 *
 * ON THE BRAIN (#2295, owner ruling 2026-10-15) a text either predicate below recognises is
 * answered with the résumé's EDIT SECTION MENU instead, with no model call
 * (`editAsksGetSectionMenu`); the edit handler is the kill-switch route only.
 */

/** Multi-word Hinglish imperatives — matched as substrings, so spacing is the only variable. */
const VERB_PHRASES = [
  "kar do",
  "kar dena",
  "badal do",
  "hata do",
  "jod do",
  "nikal do",
  "nikaal do",
  "likh do",
  "add karo",
  "add kar do",
  "change karo",
  "set kar do",
  "theek karna",
  "badal dena",
] as const;

/** Single-word verbs — matched as whole tokens, so "address" never reads as "add". */
const VERB_WORDS = [
  "badlo",
  "badalna",
  "badle",
  "hatao",
  "nikalo",
  "jodo",
  "likho",
  "edit",
  "update",
  "change",
  "modify",
  "sudhar",
] as const;

/** The field the request names, as whole tokens. The catalogue's own vocabulary, in Hinglish. */
const FIELD_WORDS = [
  "location",
  "city",
  "sheher",
  "shahar",
  "salary",
  "tankhwah",
  "tankha",
  "shift",
  "language",
  "bhasha",
  "skill",
  "skills",
  "certificate",
  "certification",
  "education",
  "padhai",
  "padhaai",
  "training",
  "role",
  "designation",
  "title",
  "employer",
  "naam",
  "name",
  "phone",
  "mobile",
] as const;

/** The generic subjects a plain English edit verb may act on ("edit my resume"). */
const GENERIC_SUBJECTS = ["resume", "cv", "profile", "biodata"] as const;

/** A plain English edit verb — the only verbs that pair with a bare subject. */
const GENERIC_VERBS = ["edit", "update", "change", "modify"] as const;

function tokensOf(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

export function looksLikeEditRequest(text: string): boolean {
  const normalized = normalizeResumeMenuText(text);
  if (normalized.length === 0) return false;
  // A status question is a NAMED v1 intent and keeps its zero-model answer (TD146).
  if (isCompanionStatusQuestion(normalized)) return false;

  const words = new Set(tokensOf(normalized));
  const has = (list: readonly string[]) => list.some((w) => words.has(w));
  const verb = VERB_PHRASES.some((p) => normalized.includes(p)) || has(VERB_WORDS);
  if (verb && has(FIELD_WORDS)) return true;
  return has(GENERIC_VERBS) && has(GENERIC_SUBJECTS);
}

/**
 * The edit words a GENERIC request is made of: the English verbs above, plus the Hinglish ones a
 * worker types for "change my résumé" without saying what ("resume badalna hai", "cv sahi karna").
 */
const GENERIC_EDIT_WORDS = [
  ...GENERIC_VERBS,
  "editing",
  "changes",
  // "correction" only: a bare "correct" is mostly a statement ("resume correct hai", "is my cv
  // correct") — the request form is the phrase "correct kar" below.
  "correction",
  "badalna",
  "badalni",
  "badalne",
  "badlna",
  "badlo",
  "badle",
  "badal",
  "badlav",
  "badlaav",
  "sudhar",
  "sudharna",
  "sudhaarna",
  "sudharo",
] as const;

/**
 * "Theek", "sahi" and "correct" ask for a change only beside a "karna" verb: "resume theek karna
 * hai" is a request, "resume theek hai" / "resume correct hai" (the résumé is fine) is not.
 */
const GENERIC_EDIT_PHRASES = ["theek kar", "thik kar", "sahi kar", "correct kar"] as const;

/**
 * The words that carry no change of their own — pronouns, particles and the "I want to / please do"
 * frame. CLOSED ON PURPOSE: a word missing here makes a message NOT generic, which is today's path.
 * "Will it be / has it been" forms (hoga, hua, gaya) are absent, so a question about an update is
 * never read as a request for one.
 */
const GENERIC_FILLER_WORDS = [
  "mera",
  "meri",
  "mere",
  "apna",
  "apni",
  "apne",
  "mujhe",
  "mujhko",
  "main",
  "mai",
  "mein",
  "me",
  "ko",
  "ka",
  "ki",
  "ke",
  "se",
  "par",
  "pe",
  "hai",
  "hain",
  "karna",
  "karni",
  "karne",
  "karein",
  "karen",
  "kare",
  "karo",
  "kar",
  "karwana",
  "do",
  "dena",
  "dijiye",
  "de",
  "chahta",
  "chahti",
  "chahte",
  "chahiye",
  "hoon",
  "hun",
  "hu",
  "ho",
  "theek",
  "thik",
  "sahi",
  "correct",
  "sakta",
  "sakti",
  "sakte",
  "kaise",
  "kya",
  "kuch",
  "thoda",
  "abhi",
  "please",
  "plz",
  "pls",
  "ji",
  "bhai",
  "bhaiya",
  "sir",
  "i",
  "my",
  "want",
  "to",
  "the",
  "a",
  "need",
  "can",
  "you",
  "it",
  "is",
  "this",
] as const;

const GENERIC_ALLOWED: ReadonlySet<string> = new Set<string>([
  ...GENERIC_EDIT_WORDS,
  ...GENERIC_SUBJECTS,
  ...GENERIC_FILLER_WORDS,
]);

/**
 * #2295 — A GENERIC EDIT REQUEST: the worker asks to change the résumé and names NO change — "resume
 * edit karein", "mera resume update karna hai", "resume badalna hai". The edit parse has nothing to
 * read in such a message (measured: empty rows, the clarify line, a model call spent), so the caller
 * answers it with the résumé's EDIT SECTION MENU instead — the answer v1's menu alias gave before the
 * brain's route precedence (#2284) sent it to the model.
 *
 * DETERMINISTIC, AND AN ALLOWLIST. True only when the message has an edit word AND a résumé subject
 * AND every other word is a closed filler. A field word ("salary"), a value ("25000", "Pune",
 * "Fanuc") or any word not on the lists makes it NOT generic, which is today's path — the edit parse
 * — so a concrete change is never swallowed by the menu. A status question is never generic.
 */
export function isGenericEditRequest(text: string): boolean {
  const normalized = normalizeResumeMenuText(text);
  if (normalized.length === 0 || isCompanionStatusQuestion(normalized)) return false;
  const words = tokensOf(normalized);
  const editWord =
    words.some((w) => (GENERIC_EDIT_WORDS as readonly string[]).includes(w)) ||
    GENERIC_EDIT_PHRASES.some((p) => normalized.includes(p));
  return (
    editWord &&
    words.some((w) => (GENERIC_SUBJECTS as readonly string[]).includes(w)) &&
    words.every((w) => GENERIC_ALLOWED.has(w))
  );
}
