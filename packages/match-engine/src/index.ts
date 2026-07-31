/**
 * @badabhai/match-engine — Matching V1 (CEO-ratified 2026-07-30).
 *
 * The PURE match core. Given a posting's skills and a worker's skill rows it answers
 * three questions and nothing else:
 *
 *   WHO CAN SEE THIS JOB?   `resolveReachSet` + `matchTierFor` + `wantedSkillIds`
 *   HOW LONG HAS HE DONE IT? `bucketMonths` + `computeIndustryTenure` + `skillMonthsFor`
 *   WHO GOES FIRST?          `rankKeyCompare` (+ the feed's `interleaveMaxPerCompany`)
 *
 * WHAT THIS PACKAGE IS NOT: it has no database, no HTTP, no clock, no randomness, no
 * model, and no weights. Every input is handed in; every output is a pure function of
 * those inputs. `purity.test.ts` enforces all of that statically, and it is a release
 * gate, not a style preference.
 *
 * V1 REPLACES the weighted `@badabhai/reach-engine` ordering. This package does not
 * import it, extend it, or share a dial with it.
 */
export {
  MatchConfigSchema,
  DEFAULT_MATCH_CONFIG,
  parseMatchConfig,
  type MatchConfig,
} from "./config";

export type { MatchSkillRef, WorkerSkillRow, RankInputs, FeedRow } from "./types";

export { bucketMonths, bucketMonthValue } from "./months";

export { deriveWorkerSkills, type DeriveWorkerSkillsInput } from "./derive";

export {
  computeIndustryTenure,
  tenureFor,
  mergeIntervals,
  calendarMonthsBetween,
  calendarMonthsOf,
  type DateRange,
} from "./tenure";

export {
  resolveReachSet,
  matchTierFor,
  wantedSkillIds,
  type ResolveReachSetInput,
  type ReachSet,
} from "./reach";

export {
  effectiveTier,
  rankKeyCompare,
  skillMonthsFor,
  interleaveMaxPerCompany,
  type SkillMonthsInput,
} from "./rank";
