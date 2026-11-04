/**
 * The three confirmation tiers for an admin write (A5, #2575) — pure rules, no React, so every
 * gate is unit-testable (confirm-tiers.test.ts).
 *
 *  - T1 `reversible` (hide a posting): act at once, then an Undo toast for UNDO_WINDOW_MS. No
 *    dialog — `runReversible` below.
 *  - T2 `consequential` (suspend, revoke, edit): a dialog showing the before/after diff, and a
 *    required reason — a category plus at least REASON_MIN_CHARS characters of explanation.
 *  - T3 `destructive` (archive a company, revoke a password): T2, plus typing the target's name;
 *    focus starts on Cancel.
 */
import type { AdminActionOutcome } from "./admin-action-result";

export type ConfirmTier = "reversible" | "consequential" | "destructive";

/** The shortest explanation a T2/T3 reason may carry, counted after trimming. */
export const REASON_MIN_CHARS = 15;

/** The reason categories a T2/T3 dialog offers unless its caller passes its own. */
export const REASON_CATEGORIES = [
  { value: "policy", label: "Policy or terms breach" },
  { value: "fraud", label: "Fraud or abuse" },
  { value: "request", label: "Requested by the account holder" },
  { value: "correction", label: "Correcting a mistake" },
  { value: "security", label: "Security concern" },
  { value: "other", label: "Other" },
] as const;

export interface ReasonCategory {
  value: string;
  label: string;
}

/** What the operator has entered in a T2/T3 dialog. */
export interface ConfirmDraft {
  category: string;
  reason: string;
  /** T3 only: the target's name as typed. */
  typedName: string;
}

/** The reason handed to the confirmed action. */
export interface ConfirmReason {
  category: string;
  text: string;
}

/** True when the trimmed reason is long enough. */
export function reasonLongEnough(reason: string): boolean {
  return reason.trim().length >= REASON_MIN_CHARS;
}

/** True when the typed name is the target's name exactly (surrounding spaces ignored). */
export function typedNameMatches(typed: string, targetName: string): boolean {
  const want = targetName.trim();
  return want.length > 0 && typed.trim() === want;
}

/** What still blocks the confirm button, in the order the fields appear; [] = ready. */
export function confirmBlockers(
  tier: Exclude<ConfirmTier, "reversible">,
  draft: ConfirmDraft,
  categories: readonly ReasonCategory[],
  targetName?: string,
): string[] {
  const out: string[] = [];
  if (!categories.some((c) => c.value === draft.category)) out.push("Choose a reason category.");
  if (!reasonLongEnough(draft.reason))
    out.push(`Explain the reason in at least ${REASON_MIN_CHARS} characters.`);
  if (tier === "destructive" && !typedNameMatches(draft.typedName, targetName ?? ""))
    out.push("Type the name exactly to confirm.");
  return out;
}

/** The reason as the action receives it: the category, and the explanation trimmed. */
export function toConfirmReason(draft: ConfirmDraft): ConfirmReason {
  return { category: draft.category, text: draft.reason.trim() };
}

/** What a T1 run needs: the action, its inverse, the copy, and somewhere to show a toast. */
export interface ReversibleRun {
  act: () => Promise<AdminActionOutcome>;
  undo: () => Promise<AdminActionOutcome>;
  /** The toast after `act` succeeds ("Posting hidden"). */
  doneMessage: string;
  /** The toast after Undo succeeds ("Posting shown again"). */
  undoneMessage: string;
  show: (opts: {
    message: string;
    tone?: "info" | "success" | "danger";
    undo?: () => void;
  }) => unknown;
}

/**
 * T1: run `act` at once; on success show `doneMessage` with an Undo (the toast stack keeps it for
 * the undo window); Undo runs `undo` and reports how that went. A failure of either is a danger
 * toast carrying the server's own text, and a failed `act` offers no Undo.
 */
export async function runReversible(run: ReversibleRun): Promise<AdminActionOutcome> {
  const outcome = await run.act();
  if (!outcome.ok) {
    run.show({ message: outcome.error, tone: "danger" });
    return outcome;
  }
  run.show({
    message: run.doneMessage,
    tone: "success",
    undo: () => {
      void run
        .undo()
        .then((u) =>
          run.show(
            u.ok
              ? { message: run.undoneMessage, tone: "info" }
              : { message: u.error, tone: "danger" },
          ),
        );
    },
  });
  return outcome;
}
