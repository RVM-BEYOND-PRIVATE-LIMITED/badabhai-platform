/**
 * TIERED PROFILING — the pure rules. No I/O, no DI, no clock.
 *
 * A worker on the Chat path chooses Easy, Medium or Hard. Every pack question carries a
 * `min_tier` (the lowest tier that asks it; untagged = Hard), and a tier asks every question
 * whose `min_tier` is at or below it. The tiers are CUMULATIVE by construction: Medium asks
 * everything Easy asks, Hard asks everything, and Hard is exactly today's full profiling.
 *
 * The tagging itself, with the reasoning per question, is `docs/profiling-tiers/tier-tagging.md`.
 * This file owns only what the tags MEAN, so the form, the upgrade flow and the résumé all read
 * one definition.
 */
import {
  DEFAULT_PROFILING_TIER,
  profilingTierRank,
  tierIncludes,
  type ProfilingTier,
} from "@badabhai/types";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { predicateFields } from "../form/form-eligibility";

/** `question_key` → the item's `min_tier` (null/absent = untagged = Hard). */
export type ItemTierMap = ReadonlyMap<string, ProfilingTier | null>;

type TierScopedItem = Pick<
  QuestionPackItem,
  "question_key" | "ask_if" | "skip_if" | "parent_item_key"
>;

/**
 * The question keys a worker at `tier` is NOT asked.
 *
 * TWO REASONS A QUESTION IS OUT, and the second is the one that is easy to miss:
 *   1. its own `min_tier` is above the worker's tier;
 *   2. it DEPENDS on a question that is out — its `ask_if`/`skip_if` reads one, or it is the
 *      follow-up of one (`parent_item_key`). A gate the worker is never asked stays unresolved
 *      forever, and an unresolved gate SHOWS its dependants (`isFormQuestionVisible`), so without
 *      this rule excluding a parent would put its children back on screen with nothing to gate
 *      them. Resolved to a fixpoint, so a chain of dependants goes out with its root.
 *
 * Only keys of THIS pack's items count as dependencies. A predicate on a field another pack owns
 * (e.g. the chat's `experience_years`) is not something this tier filter can exclude.
 */
export function keysExcludedAtTier(
  items: readonly TierScopedItem[],
  tiers: ItemTierMap,
  tier: ProfilingTier,
): ReadonlySet<string> {
  const excluded = new Set(
    items
      .filter((item) => !tierIncludes(tier, tiers.get(item.question_key) ?? null))
      .map((item) => item.question_key),
  );
  const packKeys = new Set(items.map((item) => item.question_key));
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (excluded.has(item.question_key)) continue;
      const dependsOn = [
        ...predicateFields(item.ask_if),
        ...predicateFields(item.skip_if),
        ...(item.parent_item_key ? [item.parent_item_key] : []),
      ].filter((key) => packKeys.has(key));
      if (dependsOn.some((key) => excluded.has(key))) {
        excluded.add(item.question_key);
        grew = true;
      }
    }
  }
  return excluded;
}

/**
 * Does this pack carry ANY tier tag in the database?
 *
 * THE GUARD FOR "FLAG ON BEFORE THE SEED". Tags reach `question_pack_item.min_tier` only through
 * `db:seed:packs --apply`, which is manual. A pack whose rows are all NULL has not been seeded
 * since the tags landed, and reading every question as Hard would then make Easy ask NOTHING of
 * the trade — not even the machines that give a turner his posting reach. So an untagged pack is
 * treated as tiers-off for its form (no tier screen, today's full form, today's sheet), which is
 * the direction that loses nothing.
 */
export function packIsTagged(tiers: ItemTierMap): boolean {
  for (const tier of tiers.values()) if (tier !== null) return true;
  return false;
}

/** The items a worker at `tier` is asked, in their original order. */
export function itemsForTier<T extends TierScopedItem>(
  items: readonly T[],
  tiers: ItemTierMap,
  tier: ProfilingTier,
): T[] {
  const excluded = keysExcludedAtTier(items, tiers, tier);
  return items.filter((item) => !excluded.has(item.question_key));
}

/**
 * THE SHARED FIELDS THAT ARE NOT EASY — the §2 table of `tier-tagging.md`, as data.
 *
 * These are not pack questions: they live on the preferences / employment / qualifications pages
 * and on the occupations surface, which every role shares. Anything NOT listed here is Easy —
 * name, phone, city, role, total experience, salary, preferred locations, relocation, shift, job
 * type, accommodation, availability, commute, the current job's employer/title/dates, education
 * and languages. Hard adds no shared field: every page field is at most Medium.
 */
export const SHARED_FIELD_MIN_TIER = {
  /** `worker_attributes.documents_ready`, set on the preferences page. */
  documents_ready: "medium",
  /** The description (`work_done`) of every job, the current one included. */
  job_descriptions: "medium",
  /** Every job after the first (latest) one. */
  previous_jobs: "medium",
  /** `worker_certificate` rows (the qualifications page). */
  certificates: "medium",
  /** `worker_training` rows (the qualifications page). */
  trainings: "medium",
  /** `worker_occupation` — "Also works as". A skill claim, not a term (judgement call J10). */
  secondary_occupations: "medium",
} as const satisfies Record<string, ProfilingTier>;
export type SharedTieredField = keyof typeof SHARED_FIELD_MIN_TIER;

/** Is this shared field part of a `tier` profile? */
export function sharedFieldIncluded(field: SharedTieredField, tier: ProfilingTier): boolean {
  return tierIncludes(tier, SHARED_FIELD_MIN_TIER[field]);
}

/** The three shared pages a form serves as markers — and that a tier can narrow. */
export type TieredPage = "preferences" | "employment" | "qualifications";

/**
 * What a page marker on the trade form does NOT ASK at this tier — wire names of the PUT body the
 * page owns (`documents_ready`, `work_done`, `certificates`, `trainings`), plus
 * `additional_entries` on the employment page: do not prompt for jobs beyond the current one.
 *
 * ═══ AN ASK-ONLY HINT, NEVER A WRITE FILTER ═══
 *
 * Every one of these pages is a WHOLE-RECORD REPLACE (`PUT /workers/me/employment` replaces the
 * list, and an omitted `work_done` is written as null). So a hidden field is one the page does not
 * PROMPT for — its stored value, and every stored entry, must still be loaded from the page's GET
 * and sent back unchanged. A client that dropped them would delete a worker's saved history on an
 * Easy save; that is why this is a list of fields not to ask, and deliberately carries no "max
 * entries" a client could read as a truncation.
 *
 * A Hard (or tier-less) form gets `{ hidden_fields: [] }`, which is exactly today's page.
 */
export interface PageTierScope {
  readonly hidden_fields: string[];
}

/** The employment page's pseudo-field: do not prompt for jobs beyond the current/latest one. */
export const ADDITIONAL_ENTRIES = "additional_entries";

export function pageTierScope(page: TieredPage, tier: ProfilingTier): PageTierScope {
  const hidden = (field: SharedTieredField, wire: string): string[] =>
    sharedFieldIncluded(field, tier) ? [] : [wire];
  switch (page) {
    case "preferences":
      return { hidden_fields: hidden("documents_ready", "documents_ready") };
    case "employment":
      return {
        hidden_fields: [
          ...hidden("job_descriptions", "work_done"),
          ...hidden("previous_jobs", ADDITIONAL_ENTRIES),
        ],
      };
    case "qualifications":
      return {
        hidden_fields: [
          ...hidden("certificates", "certificates"),
          ...hidden("trainings", "trainings"),
        ],
      };
  }
}

/**
 * The fields an UPGRADE brings onto a page — hidden at the shallowest tier (Easy) and asked at
 * `tier`. The upgrade view serves a page only when this is non-empty, and the client asks only
 * these fields, and of those only the ones with NO saved value: an answer already given is never
 * asked again.
 *
 * MEASURED FROM EASY, NOT FROM THE PREVIOUS TIER, and that is the fix for a two-step upgrade:
 * Easy → Medium (upgrade view abandoned) → Hard would, measured step by step, compare Medium with
 * Hard, find no page difference, and never ask the documents, certificates or previous jobs Easy
 * skipped. From Easy, every page field a deeper tier adds is offered, and the "no saved value"
 * rule is what keeps a worker who did complete them from being asked twice.
 */
export function pageRevealFields(page: TieredPage, tier: ProfilingTier): string[] {
  const now = new Set(pageTierScope(page, tier).hidden_fields);
  return pageTierScope(page, "easy").hidden_fields.filter((field) => !now.has(field));
}

/** The footer segment the résumé prints for a tier ("Generated … · Ref … · Quick profile"). */
export const PROFILING_TIER_FOOTER_LABEL: Readonly<Record<ProfilingTier, string>> = {
  easy: "Quick profile",
  medium: "Detailed profile",
  hard: "BadaBhai Recommended profile",
};

/** Is `to` strictly deeper than `from`? Upgrades only — a tier is never lowered. */
export function isUpgrade(from: ProfilingTier, to: ProfilingTier): boolean {
  return profilingTierRank(to) > profilingTierRank(from);
}

/** A worker with no recorded tier profiles at Hard — today's behaviour. */
export function effectiveTier(recorded: ProfilingTier | null | undefined): ProfilingTier {
  return recorded ?? DEFAULT_PROFILING_TIER;
}
