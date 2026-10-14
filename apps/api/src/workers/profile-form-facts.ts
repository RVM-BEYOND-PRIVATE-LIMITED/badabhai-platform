import { resolveSalaryBand } from "../profiles/worker-field-precedence";
import { descriptorForPack } from "../profiling/roles/role-registry";
import { capabilityLinesFrom } from "../resume/resume-draft-overlay";
import { readPreferenceFacts } from "../resume/resume-preference-facts";

/**
 * #2201 — the worker's own FORM answers that fill a profile-strength dimension, read off
 * `worker_attributes` (the bag `WorkerAttributesRepository.loadTradeSheet` returns).
 *
 * WHY STRENGTH READS THESE AT ALL. The trade form writes `worker_attributes` and
 * `worker_pack_answer`, never the `worker_profiles` columns `computeStrength` scored. So a worker
 * who answered every question kept salary, location, availability, experience and machines
 * "missing" forever, while the résumé, which already reads these attributes, printed them. The
 * card was the one reader that ignored the worker's own answers.
 *
 * READ, NEVER WRITTEN BACK. Copying these onto the profile row would merge two stores the
 * precedence rules keep apart (`worker-field-precedence.ts`: a salary container wins outright, and
 * the stores are never merged). It would also move the values reach and matching read. Each fact
 * goes through the SAME reader the résumé uses, so the card and the sheet read a fact the same
 * way. One known gap: the résumé applies the chat transcript veto (`applyTranscriptVeto`) first,
 * so the card can count a capability answer the worker later withdrew in chat. The sources are:
 *   - salary       `resolveSalaryBand` over `salary_expected_min` / `salary_expected_max`
 *   - location     `preferred_locations` (where he wants to work, the profile's `preferred_cities`)
 *   - availability the worker's structured `availability` answer, vocabulary-narrowed
 *   - experience   the pack's own tenure gate (`descriptor.tenureQuestionKey`), any settled value
 *   - machines / skills  the trade-sheet capability rows, split as the résumé text lines are
 *
 * PRESENCE ONLY. No value leaves this module: the summary never projects a form answer, so the
 * wire shape and its PII posture are unchanged.
 *
 * PURE. No I/O, no clock, no models.
 */
export interface ProfileFormFacts {
  readonly hasSalary: boolean;
  readonly hasPreferredLocations: boolean;
  readonly hasAvailability: boolean;
  readonly hasExperience: boolean;
  readonly hasMachines: boolean;
  readonly hasSkills: boolean;
}

export const NO_FORM_FACTS: ProfileFormFacts = {
  hasSalary: false,
  hasPreferredLocations: false,
  hasAvailability: false,
  hasExperience: false,
  hasMachines: false,
  hasSkills: false,
};

/**
 * The tenure answer is stored as the option's `value_number` (`under_one` → 0). Zero is a stated
 * "less than a year", the same way `experience.total_years: 0` counts on the profile. A declined
 * tenure question writes no attribute, so it never reaches this check.
 */
function isSettledTenure(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && value.trim().length > 0;
}

export function readProfileFormFacts(sheet: {
  readonly packId: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}): ProfileFormFacts {
  const prefs = readPreferenceFacts(sheet.attributes);
  const tenureKey = descriptorForPack(sheet.packId)?.tenureQuestionKey;
  const { machines, skills } = capabilityLinesFrom(sheet.packId, sheet.attributes);
  return {
    hasSalary:
      resolveSalaryBand({ expected: prefs.salaryMin, expectedMax: prefs.salaryMax }) !== null,
    hasPreferredLocations: prefs.preferredLocations.some((city) => city.trim().length > 0),
    hasAvailability: prefs.availabilityStatus !== null && prefs.availabilityStatus !== "unknown",
    hasExperience: tenureKey !== undefined && isSettledTenure(sheet.attributes[tenureKey]),
    hasMachines: machines.length > 0,
    hasSkills: skills.length > 0,
  };
}
