/**
 * THE EXTRACTED-PROFILE CORRECTION CONTRACT (#1311 backend half).
 *
 * WHAT WAS MISSING. A worker could answer, review and confirm — but never correct what
 * the extraction made of their answers. Skills, machines, experience, education and
 * certificates were write-once at extraction: the four safe résumé fields, the
 * `POST /profiling/correct` answer path and the finishing PUTs each cover something
 * adjacent, and none of them reaches the extracted profile itself (§8.4).
 *
 * ═══ THE FIVE FIELDS, AND WHERE EACH CORRECTION LANDS ═══
 *
 * Every correction writes the stores that already own the fact — there is exactly one
 * writer per fact and this contract invents none. A second writer for one fact is how
 * two readers end up disagreeing, so the mapping below is exhaustive by construction:
 * a field not listed here is not correctable, and the DTO refuses it.
 *
 *   skills       → `worker_profile_skill` rows (source `worker_confirmed`, confidence
 *                  NULL — a machine confidence on a human assertion would be a fiction)
 *                  + `worker_profiles.skills` (display source of record) +
 *                  `raw_profile.skills` (the generate snapshot) + a quiet match rebuild
 *                  (`rebuildQuietly`, so `worker_skill`/`job_reach` keep tracking).
 *                  Closed vocabulary: canonical `skill_*` ids (`getSkill`).
 *   machines     → `worker_profiles.machines` + `raw_profile.machines`. There is NO
 *                  authored machines relation — the profile columns ARE the store, so
 *                  the correction patches them verbatim. Closed vocabulary: `getMachine`.
 *   experience   → `worker_profiles.experience.total_years` + the same key on the
 *                  raw profile (surgical key patch; sibling keys preserved). The total
 *                  is worker-stated (extraction read it off their answer); restating it
 *                  is a first-party correction, not a derivation. Integer 0..60.
 *   education    → `worker_education` rows THROUGH `WorkerQualificationsService`
 *                  (full-list replace, same as the finishing PUT — the client
 *                  read-modify-writes off the GET). No profile patch: Zone 5 reads
 *                  the rows first on both render branches, so corrected rows
 *                  already win — exactly the standing behavior of a form edit.
 *   certificates → `worker_certificate` rows, same rule as education.
 *
 * §1.2 (structured fields, never a free-text override) holds three ways: skill/machine
 * ids are closed-vocabulary; education/certificate entries reuse the PUT schemas
 * verbatim (`CertificateEntrySchema`/`EducationEntrySchema` — length caps, CHECK
 * parity, non-empty refinement included); experience is a bounded integer. The route
 * DTO carries no rendered line and no sentence anywhere.
 *
 * ═══ WHY CORRECTIONS NEVER WRITE `worker_pack_answer` ═══
 *
 * That table is the transcript-attributed record (one row per worker/pack/question,
 * F1: no row without a worker turn behind it). A post-extraction correction has no
 * turn and no span — writing one would mint provenance the interview never produced.
 * For the same reason Divyanshu's generate-time overlay (#1585) and this contract
 * cannot double-apply: the overlay reads live PACK ANSWERS (+attributes) into the
 * `machines`/`skill_labels` LABEL lines; this contract writes authored stores,
 * profile columns and the raw profile's canonical slots. Different inputs, different
 * slots, no shared write.
 *
 * ═══ GATES ═══
 *
 * Ownership both sides (worker owns profile AND session — 404 otherwise, no oracle).
 * A DURABLE PACK PIN on the session (occupation pins and close-pinned universal
 * pointers alike — Defect-A option a): the pin is interview provenance, proving the
 * corrected profile came from a run the worker actually did. Unpinned sessions
 * (in-progress, abandoned, form-road, pre-pin rows) are deferred, not guessed —
 * `UNPINNED_ROAD_DEFERRED`. The profile's road is NOT re-checked: a chat-road worker
 * with a form profile corrects through the same door (the PUTs stay available too).
 *
 * ═══ CAPS ═══
 *
 * `MAX_CORRECTIONS_PER_PROFILE` (20) mirrors `MAX_CORRECTIONS_PER_SESSION` (20): bounded
 * writes, per-profile-lifetime instead of per-session. Counted off `profile_correction`
 * rows (the audit fact doubles as the counter — no second counter to disagree).
 * Per-entry list caps ride the reused schemas (`EDUCATIONS_MAX`, `CERTIFICATES_MAX`);
 * skill/machine lists carry generous anti-abuse ceilings, not product judgments.
 *
 * ═══ EVENTS ═══
 *
 * One `resume.edited` per applied correction (ids + closed field enum only — the values
 * live in the authored stores). Idempotency key `resume.edited:${correctionId}`.
 * This closes #1311's event acceptance; #1318 (`skin_changed`, `qr_scanned`, and the
 * safe-field-edit emission) stays open and untouched.
 *
 * ═══ CORRECTED-WINS ═══
 *
 * Confirm and (re)generate read the patched profile row, so a corrected profile
 * confirms and renders corrected — §8.4 against corrected content. Proven by test
 * (correct → profile row carries corrected values → generate snapshot equals them).
 *
 * PURE except where marked — no I/O, no clock, no DI. Nothing here is a rank input.
 */

/** Every extracted fact this contract corrects. A sixth needs this list, the DTO union, the event enum AND the table CHECK changed together — deliberately. */
export const CORRECTABLE_FIELDS = [
  "skills",
  "machines",
  "experience",
  "education",
  "certificates",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * Bounded writes, per-profile-lifetime. Mirrors `MAX_CORRECTIONS_PER_SESSION` (20) from
 * the answer-correction path: same philosophy (a correction surface must not be an
 * unbounded write surface), same number, different scope.
 */
export const MAX_CORRECTIONS_PER_PROFILE = 20;

/** Generous anti-abuse ceilings on id-list corrections (the closed vocabulary is the real guard). */
export const MAX_CORRECTION_SKILLS = 50;
export const MAX_CORRECTION_MACHINES = 32;

/** Worker-stated total years: an integer working life, with typo-guard rails. */
export const EXPERIENCE_YEARS_MIN = 0;
export const EXPERIENCE_YEARS_MAX = 60;

/** Stable machine-readable reason when the session anchor has no durable pin. */
export const UNPINNED_ROAD_DEFERRED = "unpinned_road_deferred" as const;

/** Stable machine-readable reason when the profile used its lifetime correction budget. */
export const CORRECTION_CAP_REACHED = "correction_cap_reached" as const;

export function isCorrectableField(value: unknown): value is CorrectableField {
  return typeof value === "string" && (CORRECTABLE_FIELDS as readonly string[]).includes(value);
}
