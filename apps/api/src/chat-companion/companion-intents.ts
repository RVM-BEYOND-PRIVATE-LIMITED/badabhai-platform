/**
 * What a companion message is asking for (ADR-0044) — deterministic, stateless, no model.
 *
 * THE RÉSUMÉ MENU GETS FIRST REFUSAL, AND THAT IS THE WHOLE COMPATIBILITY STORY. Every label,
 * alias and section key the shipped post-completion menu understands (`resolveResumeMenu`) is
 * tried BEFORE anything the companion adds, and a hit is served verbatim. So "Apna resume edit
 * karein", "Chat se resume banayein", "upload", "dobara" and the six section chips do exactly what
 * they do today, from the same function. The companion only answers what that menu would have
 * answered with its generic root ("Aap kya karna chahte hain") — detected by that exact reply, so
 * nothing here re-implements the menu's aliases.
 *
 * ORDER AFTER THE MENU, and why:
 *   1. companion chip labels/keys — what the app posts when a server-answered chip is tapped;
 *   2. "job milegi?" — BEFORE the jobs words, or "naukri milegi" would read as "show me jobs"
 *      when it is a request for a promise the persona must refuse honestly;
 *   3. applications — BEFORE jobs, because "kitne jobs par apply kiya" contains both;
 *   4. résumé words — answered with the recap, which says how the résumé was made and what it
 *      says (the edit/redo menu is the "Resume badlein" chip, one tap away);
 *   5. jobs words;
 *   6. greetings / "ab tak kya hua" — the recap;
 *   7. anything else — the fallback line and chips.
 *
 * NEVER LOGS, NEVER THROWS, never keeps the text: the worker's words are classified and dropped.
 */
import type { CompanionIntent } from "@badabhai/types";
import {
  RESUME_MENU_ROOT_REPLY,
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

const GUARANTEE_WORDS = ["milegi", "milega", "milegee", "guarantee", "pakka", "pakki", "confirm"];
const APPLIED_WORDS = ["apply", "applied", "application", "applications", "kitne", "kitni"];
const RESUME_WORDS = ["resume", "cv", "biodata", "profile"];
const JOBS_WORDS = ["job", "jobs", "naukri", "naukriyan", "kaam", "vacancy", "vacancies"];
const GREETING_WORDS = ["namaste", "namaskar", "hello", "hi", "hii", "hey", "status"];
const GREETING_PHRASES = ["kya hua", "ab tak", "kya chal raha"];

/** Words, lowercased, split on anything that is not a letter or digit in any script. */
function tokens(normalized: string): Set<string> {
  return new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));
}

function hasAny(words: Set<string>, list: readonly string[]): boolean {
  return list.some((w) => words.has(w));
}

const normalizedLabel = (label: string): string => normalizeResumeMenuText(label);

export function resolveCompanionText(text: string): CompanionResolution {
  const normalized = normalizeResumeMenuText(text);
  if (normalized.length === 0) return { kind: "intent", intent: "digest" };

  // 0. The shipped résumé menu, verbatim, for everything it recognises.
  const menu = resolveResumeMenu(text);
  if (menu.reply !== RESUME_MENU_ROOT_REPLY) return { kind: "resume_menu", menu };

  // 1. Companion chips: the label the app posts, or the key itself.
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
    return { kind: "intent", intent: "jobs" };
  }
  if (normalized === normalizedLabel(COMPANION_APPLIED_LABEL) || normalized === COMPANION_APPLIED_KEY) {
    return { kind: "intent", intent: "applied" };
  }

  const words = tokens(normalized);
  if (hasAny(words, GUARANTEE_WORDS)) return { kind: "intent", intent: "guarantee" };
  if (hasAny(words, APPLIED_WORDS)) return { kind: "intent", intent: "applied" };
  if (hasAny(words, RESUME_WORDS)) return { kind: "intent", intent: "digest" };
  if (hasAny(words, JOBS_WORDS)) return { kind: "intent", intent: "jobs" };
  if (hasAny(words, GREETING_WORDS) || GREETING_PHRASES.some((p) => normalized.includes(p))) {
    return { kind: "intent", intent: "digest" };
  }
  return { kind: "intent", intent: "fallback" };
}
