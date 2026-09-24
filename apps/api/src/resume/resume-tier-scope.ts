/**
 * TIERED PROFILING ON THE SHEET — one pure transform of the sheet context. No I/O, no clock.
 *
 * A worker who profiled at Easy or Medium was never asked the deeper questions, and his résumé
 * prints only his tier's rows: "render only rows whose min_tier ≤ the profile's tier AND that have
 * an answer". Filtering the CONTEXT — before any row is built — keeps every renderer rule exactly
 * as it is: a dropped attribute is simply an unanswered question, which the row builders already
 * collapse, and the rank budget then runs over what is left (so a Medium sheet can never print a
 * row the Hard budget would shed; `tier-tagging.md` rule R6 is what guarantees that).
 *
 * NULL SCOPE IS TODAY. With tiers off, or for a sheet whose tier could not be read, the context is
 * returned untouched and the sheet is byte-for-byte what it was. A HARD scope filters nothing
 * either: Hard asks every question and every shared field, so its only visible change is the
 * footer label, which the caller composes (`buildSheetFooterMeta`).
 *
 * WHAT A TIER DROPS, and where the rule lives:
 *   · trade-pack attributes whose question is above the tier    — the pack's `min_tier` tags
 *   · documents, certificates, trainings, "also works as"       — `SHARED_FIELD_MIN_TIER`
 *   · every job but the latest, and every job description      — `SHARED_FIELD_MIN_TIER`
 * and what it ADDS: the tier itself (the capability and qualification headings read it) and, on
 * a sheet that keeps only the latest job, the worker's stated total experience for the headline
 * (owner decision D1 — the sum of one job is not his career).
 */
import { tierIncludes, type ProfilingTier } from "@badabhai/types";

import { sharedFieldIncluded, type ItemTierMap } from "../profiling/tiers/profiling-tier.policy";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import type { TradeSheetContext } from "./resume-render-input";

export interface ResumeTierScope {
  readonly tier: ProfilingTier;
  /** `question_key` → `min_tier` for the pack the sheet renders as. */
  readonly itemTiers: ItemTierMap;
  /**
   * The chat's `experience_years` answer, in years — the headline's total when the tier keeps
   * only the latest job. Null when he gave none; the sheet then sums what it has, as today.
   */
  readonly statedExperienceYears: number | null;
}

/** The documents attribute the preferences page writes. */
const DOCUMENTS_ATTRIBUTE = "documents_ready";

export function applyTierScope(
  context: TradeSheetContext,
  scope: ResumeTierScope | null,
): TradeSheetContext {
  if (scope === null) return context;
  const { tier } = scope;

  // A trade-pack key is dropped only when ITS OWN tag excludes it. A key the pack does not own
  // (a universal answer, a preference) is not this pack's to drop, and the shared-field rules
  // below decide it instead.
  const dropped = (key: string): boolean =>
    (scope.itemTiers.has(key) && !tierIncludes(tier, scope.itemTiers.get(key) ?? null)) ||
    (key === DOCUMENTS_ATTRIBUTE && !sharedFieldIncluded("documents_ready", tier));
  const keep = <V>(record: Readonly<Record<string, V>>): Record<string, V> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !dropped(key)));

  const keepsPreviousJobs = sharedFieldIncluded("previous_jobs", tier);
  const keepsDescriptions = sharedFieldIncluded("job_descriptions", tier);
  const employments = scopeEmployments(context.employments, keepsPreviousJobs, keepsDescriptions);

  const qualification = {
    ...context.qualification,
    ...(sharedFieldIncluded("certificates", tier) ? {} : { certifications: [] }),
    ...(sharedFieldIncluded("trainings", tier) ? {} : { trainings: [] }),
    ...(sharedFieldIncluded("documents_ready", tier) ? {} : { documents: [] }),
  };

  return {
    ...context,
    profilingTier: tier,
    attributes: keep(context.attributes),
    ...(context.polishedAttributes ? { polishedAttributes: keep(context.polishedAttributes) } : {}),
    ...(employments === undefined ? {} : { employments }),
    // An explicitly empty list, not an absent one: `??` falls through to the snapshot on
    // `undefined`, and a tier that does not ask for a field must not print the snapshot's either.
    qualification:
      Object.keys(qualification).length > 0 || context.qualification !== undefined
        ? qualification
        : context.qualification,
    ...(sharedFieldIncluded("secondary_occupations", tier) ? {} : { occupations: [] }),
    ...(!keepsPreviousJobs && scope.statedExperienceYears !== null
      ? { tierExperienceYears: scope.statedExperienceYears }
      : {}),
  };
}

/**
 * Zone 4 at a tier. DISPLAY ORDER IS MOST RECENT FIRST (`sort_order`, see
 * `resume-employment-rows.ts`), so "the current or latest job" is the first entry — the same
 * one the approved Easy target prints.
 */
function scopeEmployments(
  employments: readonly WorkerEmploymentRecord[] | undefined,
  keepsPreviousJobs: boolean,
  keepsDescriptions: boolean,
): readonly WorkerEmploymentRecord[] | undefined {
  if (employments === undefined) return undefined;
  const kept = keepsPreviousJobs ? employments : employments.slice(0, 1);
  if (keepsDescriptions) return kept;
  return kept.map((employment) => ({
    ...employment,
    roles: employment.roles.map((role) => ({
      ...role,
      workDone: null,
      workDonePolished: null,
    })),
  }));
}
