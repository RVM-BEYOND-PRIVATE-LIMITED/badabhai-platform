import type { ServerConfig } from "@badabhai/config";
import type { CompanionV2Intent } from "@badabhai/types";
import { normalizeResumeMenuText } from "../../chat/resume-menu";
import {
  COMPANION_TASK_CAREER_KEY,
  COMPANION_TASK_CAREER_LABEL,
  COMPANION_TASK_EDIT_RESUME_KEY,
  COMPANION_TASK_EDIT_RESUME_LABEL,
  COMPANION_TASK_NEW_RESUME_KEY,
  COMPANION_TASK_NEW_RESUME_LABEL,
} from "../companion-task-keys";

/** The three intents a server-answered task chip stands for (contracts §5.3). */
export type CompanionTaskChipIntent = Extract<CompanionV2Intent, "edit_resume" | "new_resume" | "career_talk">;

/** The phase flags that open the task-chip doors — read here and by `taskChips`, nowhere else. */
export type CompanionTaskChipFlags = Pick<
  ServerConfig,
  "CHAT_COMPANION_V2_EDIT_ENABLED" | "CHAT_COMPANION_V2_NEW_RESUME_ENABLED" | "CHAT_COMPANION_V2_CAREER_ENABLED"
>;

export interface CompanionTaskChip {
  readonly intent: CompanionTaskChipIntent;
  readonly key: string;
  /** The server-authored label: what the chip shows, and the only text a tap hands a handler. */
  readonly label: string;
  /** The phase flag that must be on for the chip to be shown OR recognised. */
  readonly flag: keyof CompanionTaskChipFlags;
}

/**
 * THE TASK CHIPS, ONE TABLE (ADR-0046 §5.3) — in the order a turn offers them. The chip row a
 * turn shows (`taskChips`) and the taps this file recognises are both read from here, so a
 * chip is recognised exactly while it can be shown: "shown ⇔ routed" by construction.
 */
export const COMPANION_TASK_CHIPS: readonly CompanionTaskChip[] = [
  {
    intent: "edit_resume",
    key: COMPANION_TASK_EDIT_RESUME_KEY,
    label: COMPANION_TASK_EDIT_RESUME_LABEL,
    flag: "CHAT_COMPANION_V2_EDIT_ENABLED",
  },
  {
    intent: "new_resume",
    key: COMPANION_TASK_NEW_RESUME_KEY,
    label: COMPANION_TASK_NEW_RESUME_LABEL,
    flag: "CHAT_COMPANION_V2_NEW_RESUME_ENABLED",
  },
  {
    intent: "career_talk",
    key: COMPANION_TASK_CAREER_KEY,
    label: COMPANION_TASK_CAREER_LABEL,
    flag: "CHAT_COMPANION_V2_CAREER_ENABLED",
  },
];

/** The task chips whose phase flag is on, in offer order. */
export function openTaskChips(flags: CompanionTaskChipFlags): CompanionTaskChip[] {
  return COMPANION_TASK_CHIPS.filter((chip) => flags[chip.flag]);
}

/** The server-authored label for a task-chip intent. */
export function taskChipLabel(intent: CompanionTaskChipIntent): string {
  return COMPANION_TASK_CHIPS.find((chip) => chip.intent === intent)!.label;
}

/**
 * WHICH TASK CHIP A MESSAGE IS (ADR-0046 P2) — exact label/key recognition for the
 * `companion_task:*` chips, the deterministic step the phase-2 order puts FIRST:
 *
 *     chip keys → cool-down → v1 text resolver → lexicon → classifier
 *
 * WHY IT CANNOT BE LEFT TO THE RESOLVERS. The app posts a chip's LABEL as ordinary text, and
 * v1 would answer a tapped chip before any classifier saw it: "Resume badlo" contains "resume",
 * which v1 answers with the recap (`resolveCompanionText` step 8), and "Naya resume" is one of
 * the résumé menu's own aliases, which v1 answers with the redo menu (step 7). A tapped chip
 * that answers with something else — or that the cool-down gate blocks as free text — is a
 * dead door. So an exact match on an OPEN task chip's label or key routes deterministically,
 * before the cool-down gate and before v1.
 *
 * ONLY WHILE THE CHIP'S PHASE IS ON. A chip whose phase flag is off is never shown, so text
 * matching its label is a worker TYPING it — and typed text belongs to v1 first, exactly as it
 * did before the chip existed (README rule 6: a phase flag off ⇒ the earlier phase's behaviour,
 * byte for byte). "naya resume" with NEW_RESUME off therefore still gets v1's redo menu, never
 * the phase-off line.
 *
 * EXACT, NEVER SUBSTRING. "resume badalna hai" typed by hand is FREE TEXT and still goes through
 * the normal flow (v1 first, then the router); only the chip's own bytes take this path. The
 * comparison uses the résumé menu's normalizer, the same one v1's chip checks use, so case,
 * spacing and the odd trailing danda cannot make a tap miss.
 */
export function resolveCompanionTaskChip(
  text: string,
  flags: CompanionTaskChipFlags,
): CompanionTaskChipIntent | null {
  const normalized = normalizeResumeMenuText(text);
  const chip = COMPANION_TASK_CHIPS.find(
    (c) => normalized === normalizeResumeMenuText(c.label) || normalized === c.key,
  );
  return chip !== undefined && flags[chip.flag] ? chip.intent : null;
}
