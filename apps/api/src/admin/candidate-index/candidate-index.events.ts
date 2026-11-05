import { isEventName } from "@badabhai/event-schema";

/**
 * The spine events the candidate-index poll tick projects (B4, #2557 —
 * ADR-0062 §3.5). One source of truth for the poll reader + tests, the
 * `LEARN_EVENT_NAMES` shape in `learn/learn-labels.repository.ts`.
 *
 * Filtered with `inArray(events.eventName, [...])` on the indexed `event_name`
 * column — no wildcard prefixes. A worker is resolved from
 * `subject_type = 'worker'` / `subject_id`, else from `payload->>'worker_id'`;
 * an event naming no worker is skipped.
 *
 * DELIBERATELY ABSENT (verified against the registry — they do not exist yet):
 * - `admin.candidate_field_corrected`, `admin.candidate_field_reverted`,
 *   `worker.admin_correction_superseded` — #2561 registers these; add them to
 *   this list in that issue (the poll tolerates unknown names, but the
 *   validity test below would fail on a name the registry rejects).
 * - `worker.suspended`, `worker.reinstated` — no such worker events exist
 *   (suspension is an admin action surfaced via `admin.action_performed`,
 *   which IS listed); the status column is re-read from the row on every
 *   projection and converges fully on the nightly rebuild.
 */
export const ADMIN_CANDIDATE_EVENT_NAMES = [
  "worker.created",
  "worker.name_recorded",
  "worker.location_recorded",
  "worker.languages_recorded",
  "worker.employment_recorded",
  "worker.occupations_recorded",
  "worker.preferences_recorded",
  "worker.qualifications_recorded",
  "worker.whatsapp_recorded",
  "worker.photo_uploaded",
  "worker.photo_removed",
  "worker.resume_prefs_updated",
  "worker.active",
  "worker.match_skills_rebuilt",
  "worker.match_skill_wants_set",
  "profile.extraction_completed",
  "profile.confirmed",
  "profile.answer_corrected",
  "profile.form_completed",
  "profile.resume_imported",
  "profile.tier_completed",
  "resume.generated",
  "resume.regenerated",
  "resume.edited",
  "resume.edited_v2",
  "consent.accepted",
  "consent.revoked",
  "consent.purposes_granted",
  "consent.purposes_withdrawn",
  "admin.action_performed",
  "worker.logged_out_all",
  "worker.pin_reset",
  "worker.account_deleted",
  "worker.deletion_scheduled",
  "worker.deletion_cancelled",
] as const;

/** Every listed name must be a real registry event — a typo here would silently project nothing. */
export function assertCandidateEventNamesValid(): void {
  for (const name of ADMIN_CANDIDATE_EVENT_NAMES) {
    if (!isEventName(name)) throw new Error(`unknown candidate-index event: ${name}`);
  }
}
