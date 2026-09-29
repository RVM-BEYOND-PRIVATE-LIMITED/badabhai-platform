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

/**
 * WHICH TASK CHIP A MESSAGE IS (ADR-0046 P2) — exact label/key recognition for the
 * `companion_task:*` chips, the deterministic step the phase-2 order puts FIRST:
 *
 *     chip keys → cool-down → v1 text resolver → lexicon → classifier
 *
 * WHY IT CANNOT BE LEFT TO THE RESOLVERS. The app posts a chip's LABEL as ordinary text, and
 * v1's weak signals would swallow two of these labels before any classifier saw them:
 * "Resume badlo" and "Naya resume" both contain "resume", which v1 answers with the recap
 * (`resolveCompanionText` step 8). A tapped chip that answers with the digest — or that the
 * cool-down gate blocks as free text — is a dead door. So an exact match on a task chip's label
 * or key routes deterministically to its handler, before the cool-down gate and before v1.
 *
 * EXACT, NEVER SUBSTRING. "resume badalna hai" typed by hand is FREE TEXT and still goes through
 * the normal flow (v1 first, then the router); only the chip's own bytes take this path. The
 * comparison uses the résumé menu's normalizer, the same one v1's chip checks use, so case,
 * spacing and the odd trailing danda cannot make a tap miss.
 */
const normalized = (label: string): string => normalizeResumeMenuText(label);

const TASK_CHIP_INTENTS: ReadonlyMap<string, CompanionV2Intent> = new Map([
  [normalized(COMPANION_TASK_EDIT_RESUME_LABEL), "edit_resume"],
  [COMPANION_TASK_EDIT_RESUME_KEY, "edit_resume"],
  [normalized(COMPANION_TASK_NEW_RESUME_LABEL), "new_resume"],
  [COMPANION_TASK_NEW_RESUME_KEY, "new_resume"],
  [normalized(COMPANION_TASK_CAREER_LABEL), "career_talk"],
  [COMPANION_TASK_CAREER_KEY, "career_talk"],
]);

/** The intent a task-chip tap stands for, or null when the text is not a chip tap. */
export function resolveCompanionTaskChip(text: string): CompanionV2Intent | null {
  return TASK_CHIP_INTENTS.get(normalizeResumeMenuText(text)) ?? null;
}
