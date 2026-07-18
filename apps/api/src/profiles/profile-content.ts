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
   * extraction as `result.worker_profile_draft ?? null`. jsonb → `unknown`; its
   * CONTENT-BEARING fields are inspected (see `hasRichDraftContent`), never merely
   * its nullness — non-null proves only that the AI was reachable.
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
 * `WorkerProfileDraft` list fields that are empty unless the AI extracted
 * something. Names verified against `WorkerProfileDraftSchema`
 * (packages/ai-contracts/src/index.ts) and its Pydantic mirror
 * (apps/ai-service/app/contracts.py) — they must stay in step with both.
 *
 * `missing_fields` / `clarification_questions` are NOT here on purpose: they are
 * filled when the AI has the least to say, so counting them would restore the
 * vacuous reachability probe this replaced.
 */
const RICH_DRAFT_CONTENT_ARRAYS = [
  "skills",
  "controllers",
  "education",
  "certifications",
] as const;

/**
 * `WorkerProfileDraft` scalar fields that are null unless the AI extracted
 * something. `role_family` is excluded (always "cnc_vmc"), as are the enums that
 * default to "unknown" (`experience_level`, `availability`, the `*_knowledge`
 * trio) — every draft carries those.
 */
const RICH_DRAFT_CONTENT_STRINGS = ["primary_role", "current_city"] as const;

/**
 * Does the rich draft carry anything a real extraction produced?
 *
 * Tolerant of malformed jsonb by construction: a null/scalar/array draft narrows
 * to null, and a field of the wrong shape simply fails its type check rather than
 * throwing. Blank strings do not count as content.
 */
function hasRichDraftContent(value: unknown): boolean {
  const draft = asRecord(value);
  if (!draft) return false;

  const isNonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

  for (const field of RICH_DRAFT_CONTENT_ARRAYS) {
    const entries = draft[field];
    if (Array.isArray(entries) && entries.some(isNonBlank)) return true;
  }
  for (const field of RICH_DRAFT_CONTENT_STRINGS) {
    if (isNonBlank(draft[field])) return true;
  }
  return false;
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
 * WHY `rich_profile_draft` IS ONE OF THE LEGS (PR #430 review):
 * the legacy columns are a strict SUBSET of what an extraction produces — they
 * mirror `countFields`, which counts only canonical/legacy columns. The skill
 * labels and the rest of the rich draft live inside the draft jsonb and are
 * counted by NOTHING. So a REAL extraction where the gazetteer canonicalized
 * nothing (TD94: a plain "CNC operator" yields no canonical role) persists with
 * null ids and empty arrays and would read as "no content" — leaving that
 * worker's session permanently dedupe-INELIGIBLE, i.e. a fresh ai_job, a fresh
 * worker_profiles row and a fresh AI call on EVERY profile-preview mount,
 * indefinitely. That is the unbounded-spend loop #420 was filed about.
 *
 * WHY THE LEG INSPECTS CONTENT AND NOT NULLNESS (PR #438 review, corrected):
 * PR #438 first wrote this leg as `richProfileDraft != null`. That was WRONG, and
 * wrong in exactly the way PR #430 had already rejected `ai_jobs.real_call` for:
 * it is a REACHABILITY probe, not a content check. `/profile/extract` returns
 * `worker_profile_draft=rich` UNCONDITIONALLY on its success path
 * (apps/ai-service/app/main.py), and the extractor always returns a draft object,
 * so whenever the AI service is UP every completed extraction satisfies a
 * nullness test — including one run on an empty transcript, whose draft carries
 * nothing but `role_family: "cnc_vmc"`, `"unknown"` enums, `missing_fields` and
 * `clarification_questions`. That re-opened the #430 HIGH through the AI-UP door:
 * one early/near-empty extraction would persist a contentless profile, read as
 * "usable", and pin the session forever with no self-heal.
 *
 * So the leg reads the fields that only a real extraction fills — see
 * `RICH_DRAFT_CONTENT_*` below. Fields present on EVERY draft are deliberately
 * IGNORED (`role_family` is always "cnc_vmc"; `experience_level`/`availability`
 * default to "unknown"; `missing_fields`/`clarification_questions`/
 * `confidence_score` are populated precisely when the AI has the LEAST to say) —
 * those are what made the nullness form vacuous. This keeps the two cases apart:
 * "main CNC operator hoon" yields `skills: ["machine operation"]` and DOES
 * dedupe (TD94, no spend loop); "hmm" yields empty everything and does NOT.
 *
 * The remaining #430 objections stand and are unaffected by the above:
 *  - the column is null for every row written before migration 0046, and per
 *    `ProfileExtractionOutputSchema` `worker_profile_draft` is
 *    `.nullable().default(null)`, so a real extraction may legitimately carry
 *    none. As an OR leg that never bites: when null this degrades to exactly the
 *    pre-#438 behaviour.
 *  - `ai_jobs.real_call` remains REJECTED: it is false on the mock path, but ALSO
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

  // The rich-draft content the legacy columns do not cover. Empty on the AI-down
  // fallback (null draft), on every pre-0046 row, AND on a draft the AI returned
  // with nothing in it — that last case is why this is not a nullness check.
  if (hasRichDraftContent(profile.richProfileDraft)) return true;

  return false;
}
