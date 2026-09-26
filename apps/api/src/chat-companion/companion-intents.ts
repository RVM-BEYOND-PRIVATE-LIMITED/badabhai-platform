/**
 * What a companion message is asking for (ADR-0044) — deterministic, stateless, no model.
 *
 * THE RÉSUMÉ MENU KEEPS EVERYTHING IT OWNS, AND THAT IS THE COMPATIBILITY STORY. Its chips — the
 * four labels and the six section labels/keys — are tried FIRST and served verbatim by
 * `resolveResumeMenu`, so "Apna resume edit karein", "Chat se resume banayein" and the section
 * chips do exactly what they do today, from the same function.
 *
 * ITS ALIASES DO NOT GET FIRST REFUSAL HERE. They are substring matches ("update", "phir se",
 * "dobara", "edit", a section name) that its own comment calls narrow only because they "run on
 * ENDED sessions". The companion is a status surface, and "koi update hai?", "phir se jobs
 * dikhao" or "mere location mein job hai" are questions ABOUT status and jobs. So the aliases run
 * after the companion's own strong signals, and still before its weak ones:
 *
 *   1. the menu's exact chips (verbatim);
 *   2. the companion's own chips — what the app posts when a server-answered chip is tapped;
 *   3. "job milegi?" — "guarantee" alone, or a promise word WITH a job word ("naukri milegi",
 *      "job pakki"), so "resume kab milega" is not refused as a job promise;
 *   4. applications — an apply word ("apply", "application"); "kitne" alone is NOT one, or "kitne
 *      naye jobs aaye" would be answered with the applied count;
 *   5. a strong jobs word (job, naukri, vacancy) — "phir se jobs dikhao" is a jobs question;
 *   6. a status question ("koi update", "kya hua", "ho gaya", "kab banega") — the recap, so
 *      "resume update ho gaya?" gets the résumé's status, not the six-section edit menu;
 *   7. the menu's aliases (verbatim) — "resume update karna hai", "dobara banana hai";
 *   8. résumé words — the recap, which says how the résumé was made and what it records;
 *   9. "kaam" — a weak jobs word ("kaam ka anubhav" is a résumé section), so it waits for the
 *      aliases above it;
 *  10. greetings — the recap;
 *  11. anything else — the fallback line and chips.
 *
 * NEVER LOGS, NEVER THROWS, never keeps the text: the worker's words are classified and dropped.
 */
import type { CompanionIntent } from "@badabhai/types";
import {
  RESUME_MENU_CHAT_LABEL,
  RESUME_MENU_EDIT_LABEL,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_ROOT_REPLY,
  RESUME_MENU_UPLOAD_LABEL,
  RESUME_SECTIONS,
  normalizeResumeMenuText,
  resolveResumeMenu,
  type ResumeMenuChoice,
} from "../chat/resume-menu";
import {
  COMPANION_APPLIED_KEY,
  COMPANION_APPLIED_LABEL,
  COMPANION_JOBS_TAB_KEY,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_JOB_KEY_PREFIX,
  COMPANION_NEW_JOBS_KEY,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_KEY,
  COMPANION_RESUME_LABEL,
} from "./companion-keys";

export type CompanionResolution =
  | { readonly kind: "resume_menu"; readonly menu: ResumeMenuChoice }
  | { readonly kind: "intent"; readonly intent: Exclude<CompanionIntent, "resume_menu"> };

/** "Guarantee" is the question on its own; a promise word needs a job word beside it. */
const GUARANTEE_WORDS = ["guarantee", "gaurantee"];
const PROMISE_WORDS = ["milegi", "milega", "milegee", "pakka", "pakki"];
const APPLIED_WORDS = ["apply", "applied", "application", "applications"];
const STRONG_JOBS_WORDS = ["job", "jobs", "naukri", "naukriyan", "vacancy", "vacancies"];
const WEAK_JOBS_WORDS = ["kaam"];
const RESUME_WORDS = ["resume", "cv", "biodata", "profile"];
const GREETING_WORDS = ["namaste", "namaskar", "hello", "hi", "hii", "hey", "status"];
const STATUS_PHRASES = [
  "koi update",
  "kya update",
  "kya hua",
  "hua kya",
  "ho gaya",
  "ho gya",
  "ab tak",
  "kya chal raha",
  "kya naya",
  "kab tak",
  "kab hoga",
  "kab hogi",
  "kab banega",
  "kab milega",
];

/**
 * The menu's CHIPS, normalized exactly as `resolveResumeMenu` normalizes its input — the only
 * menu inputs that bypass the companion's own signals.
 */
const MENU_CHIP_TEXTS: ReadonlySet<string> = new Set(
  [
    RESUME_MENU_EDIT_LABEL,
    RESUME_MENU_REDO_LABEL,
    RESUME_MENU_UPLOAD_LABEL,
    RESUME_MENU_CHAT_LABEL,
    ...RESUME_SECTIONS.flatMap((s) => [s.label, s.key]),
  ].map((t) => normalizeResumeMenuText(t)),
);

/** Words, lowercased, split on anything that is not a letter or digit in any script. */
function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
}

function hasAny(words: Set<string>, list: readonly string[]): boolean {
  return list.some((w) => words.has(w));
}

const normalizedLabel = (label: string): string => normalizeResumeMenuText(label);

const intent = (i: Exclude<CompanionIntent, "resume_menu">): CompanionResolution => ({
  kind: "intent",
  intent: i,
});

export function resolveCompanionText(text: string): CompanionResolution {
  const normalized = normalizeResumeMenuText(text);
  if (normalized.length === 0) return intent("digest");

  // 1. The shipped résumé menu's own chips, verbatim.
  if (MENU_CHIP_TEXTS.has(normalized)) return { kind: "resume_menu", menu: resolveResumeMenu(text) };

  // 2. Companion chips: the label the app posts, or the key itself.
  if (normalized === normalizedLabel(COMPANION_RESUME_LABEL) || normalized === COMPANION_RESUME_KEY) {
    return { kind: "resume_menu", menu: resolveResumeMenu("") };
  }
  if (
    normalized === normalizedLabel(COMPANION_NEW_JOBS_LABEL) ||
    normalized === COMPANION_NEW_JOBS_KEY ||
    normalized === normalizedLabel(COMPANION_JOBS_TAB_LABEL) ||
    normalized === COMPANION_JOBS_TAB_KEY ||
    normalized.startsWith(COMPANION_JOB_KEY_PREFIX)
  ) {
    return intent("jobs");
  }
  if (normalized === normalizedLabel(COMPANION_APPLIED_LABEL) || normalized === COMPANION_APPLIED_KEY) {
    return intent("applied");
  }

  const words = tokens(normalized);
  const jobWord = hasAny(words, STRONG_JOBS_WORDS) || hasAny(words, WEAK_JOBS_WORDS);

  // 3–6. The companion's strong signals.
  if (hasAny(words, GUARANTEE_WORDS) || (hasAny(words, PROMISE_WORDS) && jobWord)) return intent("guarantee");
  if (hasAny(words, APPLIED_WORDS)) return intent("applied");
  if (hasAny(words, STRONG_JOBS_WORDS)) return intent("jobs");
  if (STATUS_PHRASES.some((p) => normalized.includes(p))) return intent("digest");

  // 7. The menu's aliases, verbatim — anything it answers with more than its generic root.
  const menu = resolveResumeMenu(text);
  if (menu.reply !== RESUME_MENU_ROOT_REPLY) return { kind: "resume_menu", menu };

  // 8–11. The weak signals.
  if (hasAny(words, RESUME_WORDS)) return intent("digest");
  if (hasAny(words, WEAK_JOBS_WORDS)) return intent("jobs");
  if (hasAny(words, GREETING_WORDS)) return intent("digest");
  return intent("fallback");
}
