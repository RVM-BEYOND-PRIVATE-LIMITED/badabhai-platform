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
 * preferred_cities, availability "unknown". Every leg below is false by
 * construction, so this is a structural guarantee, not a heuristic threshold.
 *
 * SIGNALS DELIBERATELY NOT USED:
 *  - `worker_profiles.rich_profile_draft` (issue #419 / PR #428) is null on the
 *    mock/AI-down path, so it looks like a cleaner marker. It is not: the column
 *    only exists once migration 0046 is applied, so keying the guard on it would
 *    turn every extract into a 500 on a deploy that runs ahead of its migration.
 *    It is also null for every row written before 0046 and, per
 *    `ProfileExtractionOutputSchema`, `worker_profile_draft` is
 *    `.nullable().default(null)` — a real extraction may legitimately carry none.
 *  - `ai_jobs.real_call` is false on the mock path, but ALSO false for every
 *    healthy extraction while `AI_ENABLE_REAL_CALLS=false` (CLAUDE.md §2
 *    invariant 5, and TD81 for staging), which would disable the completed-job
 *    dedupe in precisely the environment #420 was reported in.
 * The columns below predate both and are written on every path.
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

  return false;
}
