/**
 * The subset of a `worker_profiles` row needed to decide whether an extraction
 * actually produced anything. Kept narrow so the dedupe query selects only these
 * columns (projection discipline) rather than the whole row.
 *
 * Every field is nullable even though `skills`/`machines` are NOT NULL in the
 * table: these arrive through a LEFT JOIN, so a job with no profile row yields
 * nulls across the board.
 */
export interface ProfileContentFields {
  canonicalTradeId: string | null;
  canonicalRoleId: string | null;
  skills: string[] | null;
  machines: string[] | null;
  experience: unknown;
  salaryExpectation: unknown;
  locationPreference: unknown;
  availability: unknown;
  /**
   * `worker_profiles.rich_profile_draft` (issue #419 / PR #428). Written on every
   * extraction as `result.worker_profile_draft ?? null`, so non-null means the AI
   * returned a real rich draft. jsonb → `unknown`; only its nullness is read.
   */
  richProfileDraft: unknown;
}

/** Narrow an untyped jsonb column to a plain object without reaching for `any`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Did this extraction actually extract anything?
 *
 * Mirrors `ProfileExtractionProcessor.countFields` (the codebase's existing
 * definition of profile content — it is what feeds `field_count` on
 * `profile.extraction_completed`) reduced to "> 0", field for field.
 *
 * WHY THIS EXISTS (issue #420 review): when the AI service is unreachable,
 * `AiService.extractProfile` falls back to `DraftProfileSchema.parse({})` with
 * `blocked: false`. The processor therefore persists that EMPTY profile with
 * status "extracted" and marks the ai_job `completed` with a real
 * `output_ref.profile_id`. Such a job is "successful" by every status check yet
 * carries nothing. Deduping against it would pin the session to an empty profile
 * forever, since nothing ever re-runs extraction for a completed job.
 *
 * A fallback-produced profile can NEVER satisfy this predicate: it is
 * `DraftProfileSchema.parse({})`, i.e. every field at its schema default — null
 * ids, empty skills/machines arrays, null total_years, null salary bounds, empty
 * preferred_cities, availability "unknown", and (since it carries no
 * `worker_profile_draft`) a null `rich_profile_draft`. Every leg below is false
 * by construction, so this is a structural guarantee, not a heuristic threshold.
 *
 * WHY `rich_profile_draft` IS ONE OF THE LEGS (PR #430 review, corrected):
 * the legacy columns are a strict SUBSET of what an extraction produces — they
 * mirror `countFields`, which counts only canonical/legacy columns. `skill_labels`
 * and the rest of the rich draft live inside the draft jsonb and are counted by
 * NOTHING. So a REAL extraction where the gazetteer canonicalized nothing (TD94:
 * a plain "CNC operator" yields no canonical role) persists with null ids and
 * empty arrays and would read as "no content" — leaving that worker's session
 * permanently dedupe-INELIGIBLE, i.e. a fresh ai_job, a fresh worker_profiles row
 * and a fresh AI call on EVERY profile-preview mount, indefinitely. That is the
 * unbounded-spend loop #420 was filed about. A non-null rich draft proves the AI
 * answered, so it is added as an ADDITIONAL disjunct.
 *
 * PR #430 rejected this signal for three reasons; the FIRST was wrong and is
 * retracted here:
 *  - RETRACTED: "the column only exists once migration 0046 is applied, so
 *    reading it 500s on a deploy that runs ahead of its migration." Reading it
 *    adds NO coupling that the write path does not already have:
 *    `ProfilesRepository.create` (profiles.repository.ts) already does
 *    `.insert(workerProfiles).values(input)` where `input.richProfileDraft` is
 *    always set (profile-extraction.processor.ts), and `.returning()` with no
 *    projection selects every column. Extraction therefore already fails hard
 *    without 0046 — the incremental risk from READING the column is nil.
 *  - STILL TRUE, but only against using it ALONE: it is null for every row
 *    written before 0046, and per `ProfileExtractionOutputSchema`
 *    `worker_profile_draft` is `.nullable().default(null)`, so a real extraction
 *    may legitimately carry none. As an OR leg neither bites: when null this
 *    degrades to exactly the previous behaviour.
 *  - STILL REJECTED: `ai_jobs.real_call` is false on the mock path, but ALSO
 *    false for every healthy extraction while `AI_ENABLE_REAL_CALLS=false`
 *    (CLAUDE.md §2 invariant 5, and TD81 for staging), which would disable the
 *    completed-job dedupe in precisely the environment #420 was reported in.
 */
export function hasExtractedContent(profile: ProfileContentFields | null | undefined): boolean {
  if (!profile) return false;

  if (profile.canonicalRoleId) return true;
  if (profile.canonicalTradeId) return true;
  if (profile.skills != null && profile.skills.length > 0) return true;
  if (profile.machines != null && profile.machines.length > 0) return true;

  const experience = asRecord(profile.experience);
  if (experience?.["total_years"] != null) return true;

  const salary = asRecord(profile.salaryExpectation);
  if (salary?.["amount_min"] != null || salary?.["amount_max"] != null) return true;

  const location = asRecord(profile.locationPreference);
  const cities = location?.["preferred_cities"];
  if (Array.isArray(cities) && cities.length > 0) return true;

  const availability = asRecord(profile.availability);
  const status = availability?.["status"];
  if (typeof status === "string" && status !== "unknown") return true;

  // The rich draft the legacy columns do not cover. Null on the AI-down fallback
  // (and on every pre-0046 row), non-null whenever the AI actually answered.
  if (profile.richProfileDraft != null) return true;

  return false;
}
