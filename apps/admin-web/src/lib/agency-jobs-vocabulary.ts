/**
 * Agency match skills — display copy. Literals only, mirroring
 * `admin-action-vocabulary.ts`: the API owns every value (statuses, skill
 * ids, the cap); this file only decides what an operator READS. Sentence
 * case, no `&` (nav-model terminology fence).
 */

/** Poster-facing job lifecycle as the operator reads it. Unknown values render de-snaked. */
export const AGENCY_JOB_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  live: "Live",
  filled: "Filled",
  closed: "Closed",
  review: "In review",
};

export function agencyJobStatusLabel(status: string): string {
  return AGENCY_JOB_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

/** A closed posting is terminal — the API refuses writes with a 400, so the form never renders. */
export const AGENCY_JOB_CLOSED_NOTICE =
  "This posting is closed. Match skills cannot be changed on a closed posting.";

/** The picker vocabulary could not be read — the editor is withheld, not guessed. */
export const AGENCY_JOB_VOCABULARY_UNAVAILABLE =
  "The skill list could not be loaded. The current selection below is still accurate.";

/** Empty states. */
export const AGENCY_JOBS_EMPTY = "No agency jobs yet.";
export const AGENCY_JOB_NO_SKILLS = "No match skills chosen yet.";

/** `mskill_*` shape guard message for the client precheck (mirrors the API regex). */
export const AGENCY_JOB_BAD_SKILL_ID = "Unknown skill id — pick from the list.";
