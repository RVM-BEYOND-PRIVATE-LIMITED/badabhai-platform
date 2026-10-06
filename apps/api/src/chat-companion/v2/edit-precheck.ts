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
