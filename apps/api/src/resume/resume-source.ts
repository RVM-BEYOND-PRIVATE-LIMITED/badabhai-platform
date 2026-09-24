import type { ProfileSource, ResumeSource } from "@badabhai/types";

/** The two profile facts a résumé's label is decided from. */
export interface ResumeSourceFacts {
  /** `worker_profiles.source` — the road that produced the profile, or null (pre-0107). */
  readonly source: ProfileSource | null;
  /** `worker_profiles.seeded_from_import_id` — the CV import the interview accepted, or null. */
  readonly seededFromImportId: string | null;
}

/**
 * Which flow a résumé generated from this profile was made from — the label on the worker's
 * history card (ADR-0043).
 *
 * AN ACCEPTED IMPORT WINS (owner ruling R1, 2026-09-24). A CV the worker uploaded and then said
 * "haan, ye main hoon" to — or confirmed facts from — still finishes through the chat or the
 * form, so the profile's road alone would label it `chat` or `form` and the worker would never
 * see that their upload made the résumé. An import the worker REJECTED never sets
 * `seededFromImportId`, so it falls through to the road like any other interview.
 *
 * NULL STAYS NULL. A profile written before its road was recorded carries no source, and the
 * history shows no label for it rather than a guessed one.
 *
 * PURE and deterministic over two stored facts: resolved once, at generation time, and written
 * on the row — never re-derived on read, because a history entry records what it was made from
 * THEN.
 */
export function resolveResumeSource(profile: ResumeSourceFacts): ResumeSource | null {
  if (profile.seededFromImportId !== null) return "resume_upload";
  return profile.source;
}
