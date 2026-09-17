/**
 * FIELD PRECEDENCE — the single place that says, for each fact the worker spine stores more than
 * once, WHICH SOURCE WINS.
 *
 * ═══ WHY THIS FILE EXISTS, AND WHY IT DECIDES NOTHING ═══
 *
 * The platform grew duplicate sources for the same fact the way most systems do: an interview
 * writes a profile field, a form writes an attribute, a worker types the same thing at signup, a
 * matcher derives a projection. Each reader then made its own choice about which one to believe,
 * and those choices were never written down together — they were spread across
 * `profile-summary.mapper.ts`, `resume-render-input.ts`, `resume-preference-facts.ts`,
 * `resume-qualification-rows.ts` and the match engine.
 *
 * THIS MODULE DOES NOT RE-DECIDE ANY OF THEM (ADR-0042 D9, and the owner ruling behind the Layer
 * A programme). Every rule here is the rule the shipped reader already implements, restated in
 * one file with a citation, so that:
 *
 *   * a new surface (the universal renderer, Layer A (i)) has ONE place to look instead of five;
 *   * a change to a winner is a change to THIS FILE, reviewable as a rule change rather than as
 *     a one-line edit in a renderer;
 *   * a test can pin each rule without standing up a database, a template or a queue.
 *
 * ═══ THE DUPLICATE SETS, AND THE RULE FOR EACH ═══
 *
 *   CITY ×3      `workers.current_city` > `worker_profiles.location_preference.current_city` >
 *                `location_preference.preferred_cities[0]` — for "where the worker IS"
 *                (`profile-summary.mapper.ts` `readCity`). `preferred_cities` /
 *                `preferred_locations` answer a DIFFERENT question ("where he WANTS to work") and
 *                are not a fallback for it. Owner ruling 2026-09-05: the first-party answer
 *                outranks the extraction's guess.
 *   SALARY ×3    `salary_expected` (the interview's ask, the lower bound) and
 *                `salary_expected_max` (the form's upper end) are ONE band in two attribute keys;
 *                `draft.salary_expectation.amount_min/amount_max` is the same band on the
 *                extraction container. A container exists ⇒ it wins outright (the "no merge"
 *                rule in `resume-render-input.ts`); otherwise the attributes compose the band.
 *                THE UPPER END IS NEVER DERIVED — a worker who gave one figure prints one figure.
 *   AVAILABILITY ×3  The worker's own structured answer (`availability` json attribute, 0111)
 *                outranks the model's `draft.availability.status`; the shift (`shift_preference`)
 *                and the night-shift toggle (`workers.resume_night_shift_ready`) are SEPARATE
 *                clauses on the same line and are never substituted for the status.
 *   EDUCATION ×3 `worker_education` rows win per-field; the four `education_*` scalars are the
 *                fallback for workers with no rows; `draft.education_level` is read only where
 *                neither exists. Encoded by `qualificationFactsFrom` + the caller's `??` — this
 *                file restates it and its test pins it against the real function.
 *   SKILLS ×4    `worker_profiles.skills` is the display source of record;
 *                `worker_profile_skill` is the AUTHORED table (edits land there and re-project);
 *                `worker_skill` is the DERIVED projection the match engine reads and nobody
 *                authors; `raw_profile.skills` is historical evidence, never a display source.
 *
 * ═══ THE LAYER A (c) RULES ARE NEW FACTS, NOT NEW ANSWERS TO OLD QUESTIONS ═══
 *
 * `work_types` is the multi beside `job_type` (a non-empty multi wins, the single is the
 * fallback); `salary_period` changes the UNIT of the existing salary keys and its absence means
 * `month`, the meaning those keys already had; `commute_max_km` and `willing_to_travel` are two
 * independent facts and neither derives from the other; `availability`'s three parts come only
 * from the worker's structured answer.
 *
 * PURE — no I/O, no clock, no DI, no models. Nothing here is a rank input (ADR-0042 D9).
 */

/** The period a salary figure is quoted in. ABSENT MEANS `month` — the pre-existing meaning. */
export type SalaryPeriod = "month" | "day" | "year";

/**
 * `work_types` (multi) over `job_type` (single) — Layer A (c).
 *
 * THE MULTI WINS WHENEVER IT HAS A VALUE, and an empty multi is not a value: the row is cleared,
 * not emptied, so a caller cannot observe "answered none" here. `job_type` is read only when the
 * multi is absent, which is every worker whose data predates the field — the compatibility rule
 * the migration header states.
 */
export function resolveWorkTypes(
  workTypes: readonly string[] | null | undefined,
  jobType: string | null | undefined,
): readonly string[] {
  if (workTypes !== null && workTypes !== undefined && workTypes.length > 0) return workTypes;
  return jobType === null || jobType === undefined || jobType === "" ? [] : [jobType];
}

/**
 * `salary_period` → a period, defaulting to `month`. NEVER derived from the figure: a number
 * cannot say its own unit, and guessing one is the class of claim §8 forbids. The default is not
 * a guess — it is the meaning every salary key had before this field existed.
 */
export function resolveSalaryPeriod(period: string | null | undefined): SalaryPeriod {
  return period === "day" || period === "year" ? period : "month";
}

/**
 * The expected-salary band from its two attribute keys, or `null` when neither is stated.
 *
 * THE UPPER END IS NEVER DERIVED FROM THE LOWER. A one-sided band prints a point figure, which
 * is the rule `formatSalaryBand` already implements and this function restates without changing:
 * `high` is `null` unless the worker stated it.
 */
export function resolveSalaryBand(figures: {
  readonly expected: number | null | undefined;
  readonly expectedMax: number | null | undefined;
}): { low: number; high: number | null } | null {
  const low = typeof figures.expected === "number" ? figures.expected : null;
  const high = typeof figures.expectedMax === "number" ? figures.expectedMax : null;
  if (low === null && high === null) return null;
  // A band whose top is BELOW its bottom is a typo on one of the two figures; the shipped
  // `formatSalaryBand` prints the lower figure alone rather than an inverted range, and the same
  // normalisation is applied here so the two cannot disagree.
  if (low !== null && high !== null && high <= low) return { low, high: null };
  if (low !== null) return { low, high };
  // Only the upper end was stated. It is still the worker's number, and it prints as the band's
  // single figure — `formatSalaryBand(null, hi)` is exactly that case.
  return { low: high as number, high: null };
}

/**
 * The worker's structured availability answer, with the model's status as a read-only fallback.
 *
 * THE THREE PARTS COME FROM ONE PLACE WHEN THE WORKER ANSWERED: `available_from` and
 * `notice_period_days` have no other source and stay null even when `legacyStatus` fills the
 * status. `legacyStatus` is the extraction's `draft.availability.status`, which the caller
 * supplies; this function never looks it up.
 *
 * A malformed part is dropped, never repaired — the DTO validates at the write, so a value that
 * fails these narrow checks arrived from a hand-written row.
 */
export function resolveAvailabilityState(input: {
  readonly workerAnswer:
    | {
        readonly status?: unknown;
        readonly available_from?: unknown;
        readonly notice_period_days?: unknown;
      }
    | null
    | undefined;
  readonly legacyStatus?: string | null;
}): {
  status: string | null;
  availableFrom: string | null;
  noticePeriodDays: number | null;
} {
  const answer = input.workerAnswer ?? null;
  const status =
    answer !== null && typeof answer.status === "string"
      ? answer.status
      : (input.legacyStatus ?? null);
  const availableFrom =
    answer !== null &&
    typeof answer.available_from === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(answer.available_from)
      ? answer.available_from
      : null;
  const noticePeriodDays =
    answer !== null &&
    typeof answer.notice_period_days === "number" &&
    Number.isInteger(answer.notice_period_days) &&
    answer.notice_period_days >= 0
      ? answer.notice_period_days
      : null;
  return { status, availableFrom, noticePeriodDays };
}

/**
 * "Where the worker IS" — the rule `profile-summary.mapper.ts` `readCity` implements, restated.
 *
 * THE FIRST-PARTY ANSWER WINS (owner ruling 2026-09-05): `workers.current_city` is what the
 * worker typed on the onboarding screen; `location_preference.current_city` is the extraction's
 * reading of a conversation. A blank/whitespace value is absence at every level — the shipped
 * reader treats it so, and so does this.
 *
 * `preferredCities` here is the PROFILE's `preferred_cities` list, which supplies the third
 * fallback in the shipped reader. It is deliberately NOT the `preferred_locations` attribute or
 * the `preferred_cities` wire list: those are "where he wants to work", a different question.
 */
export function resolveCityForSummary(input: {
  readonly workersColumn: string | null | undefined;
  readonly profileCurrentCity: string | null | undefined;
  readonly profilePreferredCities: readonly string[] | null | undefined;
}): string | null {
  const own = nonBlank(input.workersColumn);
  if (own !== null) return own;
  const current = nonBlank(input.profileCurrentCity);
  if (current !== null) return current;
  for (const city of input.profilePreferredCities ?? []) {
    const candidate = nonBlank(city);
    if (candidate !== null) return candidate;
  }
  return null;
}

function nonBlank(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * WHICH SKILL STORE A READER MUST CONSULT — the four sources and their roles, as a closed map.
 *
 * This is documentation made executable: a caller passes the surface it is building and gets the
 * one source it may read. `worker_skill` is the DERIVED projection (`backfill-worker-skills.ts`,
 * `WorkerSkillsService.rebuildForWorker`) and must never be treated as authored data;
 * `worker_profile_skill` is authored and re-projects into `worker_skill`; `raw_profile.skills` is
 * historical evidence from before the canonical store existed and is never a display source.
 */
export const SKILL_SOURCE_OF_RECORD = {
  /** The sheet and the profile screens: the extraction's canonicalised ids. */
  display: "worker_profiles.skills",
  /** The editing surface's destination: one row per (profile, skill), with confidence. */
  authored: "worker_profile_skill",
  /** The match engine's input: a projection over authored + derived rows. NEVER authored here. */
  matching: "worker_skill",
  /** Historical only — read for forensics, never printed. */
  historical: "worker_profiles.raw_profile.skills",
} as const;

export type SkillSurface = keyof typeof SKILL_SOURCE_OF_RECORD;

/**
 * EDUCATION's per-field rule, restated for the reader that has not met `qualificationFactsFrom`.
 *
 * THE ROWS WIN, PER FIELD. With any `worker_education` row the row lists are authoritative —
 * empty ones included, because a worker who used the qualifications page is saying he has none —
 * and the four `education_*` scalars apply only where NO row exists. `draft.education_level` is
 * the last resort and is composed by the caller. The test pins this against the real
 * `qualificationFactsFrom` so the two cannot drift.
 */
export const EDUCATION_PRECEDENCE = {
  rows: "worker_education",
  scalars: "worker_attributes.education_*",
  draft: "worker_profiles.resume_profile.education_level",
} as const;
