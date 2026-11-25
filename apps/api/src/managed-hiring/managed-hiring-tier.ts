import {
  normalizeTradeLevelKey,
  postingTradeFor,
  priceTierForTradeSkill,
} from "@badabhai/taxonomy";
import type { ManagedHiringTier, VacancyBand } from "@badabhai/types";

/**
 * #2751 item 4 — WHICH MANAGED HIRING TIER A JOB GETS (brief section 2; register B2-31, B2-33,
 * B7-05). The server decides; a client never names a tier. Pure, no I/O.
 *
 * | The job                                                        | Tier          |
 * | -------------------------------------------------------------- | ------------- |
 * | 11 or more vacancies (`11-25`, `25+`)                          | no checkout: a callback request |
 * | 6 to 10 vacancies (`6-10`)                                     | `large`       |
 * | 1 to 5 vacancies, and EXPERIENCED                              | `large`       |
 * | 1 to 5 vacancies (`1`, `2-5`), fresher to mid level            | `standard`    |
 *
 * EXPERIENCED (#2751's default rule, owner "yes", 2026-11-18, #2931 C4): the job asks for 3 or more
 * years (`min_experience_years` ≥ 3), or its "Level needed" (`trade_level`) is a rung the trade's
 * sheet prices Higher (`priceTierForTradeSkill` on the trade's own skill: setter and above,
 * programmer, senior designer). An unknown trade, an unknown rung or no rung is NOT experienced:
 * the tier is never priced up on missing data.
 */
export interface ManagedHiringJobFacts {
  readonly vacancyBand: VacancyBand;
  readonly minExperienceYears: number | null;
  /** The posting's `role_kind` (a posting trade, `postingTradeFor`), or null. */
  readonly roleKind: string | null;
  /** The posting's `trade_level` ("Level needed"), or null. */
  readonly tradeLevel: string | null;
}

export type ManagedHiringTierChoice =
  | { readonly kind: "tier"; readonly tier: ManagedHiringTier; readonly experienced: boolean }
  | { readonly kind: "callback" };

/** The years at or above which a job is experienced. */
export const EXPERIENCED_MIN_YEARS = 3;

/** Vacancy bands with no checkout (more than 10 vacancies). */
const CALLBACK_BANDS: ReadonlySet<VacancyBand> = new Set<VacancyBand>(["11-25", "25+"]);

/** Does this job need skilled workers (the brief's "experienced")? */
export function isExperiencedJob(job: ManagedHiringJobFacts): boolean {
  if (job.minExperienceYears !== null && job.minExperienceYears >= EXPERIENCED_MIN_YEARS) {
    return true;
  }
  if (job.tradeLevel === null) return false;
  const trade = postingTradeFor(job.roleKind);
  if (trade === undefined) return false;
  const level = normalizeTradeLevelKey(job.tradeLevel);
  if (level === null) return false;
  return priceTierForTradeSkill(trade.matchSkillId, level) === "higher";
}

export function managedHiringTierFor(job: ManagedHiringJobFacts): ManagedHiringTierChoice {
  if (CALLBACK_BANDS.has(job.vacancyBand)) return { kind: "callback" };
  const experienced = isExperiencedJob(job);
  if (job.vacancyBand === "6-10" || experienced) {
    return { kind: "tier", tier: "large", experienced };
  }
  return { kind: "tier", tier: "standard", experienced };
}

/**
 * The terms line every Managed Hiring surface carries (brief 9; a lawyer must check it). The
 * service is sourcing and screening; it never promises a hire.
 */
export const MANAGED_HIRING_TERMS =
  "Managed Hiring is a sourcing and screening service. BadaBhai does not promise a hire.";
