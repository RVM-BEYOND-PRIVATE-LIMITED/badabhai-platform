import { APPLICANT_STAGES, isApplicantStage, type ApplicantStage } from "@badabhai/types";

/**
 * SAVED APPLICANT STAGES (owner ruling 2026-10-07, #2139 — the API half is #2137): the New /
 * Shortlist / Passed board an applicant sits on, per posting. PURE — no I/O, no React, no
 * server-only import — so the data seam, the Candidates page and the board (a client component)
 * read ONE vocabulary.
 *
 * The stages themselves are the shared `@badabhai/types` vocabulary the API validates with
 * (`APPLICANT_STAGES`, `isApplicantStage`), re-exported HERE only — so no screen imports them
 * directly and the portal's three can never drift from the server's.
 *
 * WHO DECIDES WHETHER STAGES ARE SAVED: the server. `PAYER_APPLICANT_STAGES_ENABLED` is a
 * server-side flag the portal cannot read; its only visible effect is that every row of the
 * applicant feeds carries `stage` while it is on, and no row does while it is off. So the portal
 * reads availability from the ROWS ({@link hasSavedStages}) and never from a setting of its own —
 * with no `stage` on the rows the board stays the local one it has always been, and nothing
 * calls the stage route.
 */
export { APPLICANT_STAGES, isApplicantStage };
export type { ApplicantStage };

/** The stage's name on a tab, a filter option and a status line (copy rulings: Shortlist, Passed). */
export const STAGE_LABEL: Record<ApplicantStage, string> = {
  new: "New",
  shortlist: "Shortlist",
  passed: "Passed",
};

/**
 * Does this list come from a server that SAVES stages? True only when it has rows and EVERY row
 * carries a `stage` — the flag-on contract. No row with one is the flag off; a mix is neither
 * (the contract never sends one), so it is read as "not saved": the board stays local and the
 * stage route is never called on the strength of a partial answer.
 */
export function hasSavedStages(rows: readonly { stage?: ApplicantStage }[]): boolean {
  return rows.length > 0 && rows.every((r) => r.stage !== undefined);
}
