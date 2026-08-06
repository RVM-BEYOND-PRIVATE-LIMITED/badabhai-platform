/**
 * Value normalizers + the negation engine.
 *
 * These run at CAPTURE TIME, on every turn — not at parse time. That timing is the whole reason
 * the system can fail closed: because `AnswerRecord.valueNormalized` is already populated when
 * the interview ends, a profile can be projected from the deterministic answer map alone when the
 * parsing LLM is down, blocked, or fails its provenance gates. The LLM is an overlay, never a
 * dependency.
 *
 * Owner: Prakash (Conversation & Profiling). Lifted from `signals.py` in Phase 3.
 *
 * ## Port status
 *
 * | Normalizer | State |
 * | --- | --- |
 * | negation engine (`applyNegation`, `isNegated`) | ported |
 * | `canonicalCity` / `canonicalState` / `canonicalRegion` | ported |
 * | `parseExperienceYears` | ported |
 * | `parseSalaryMonthly` / `detectSalaries` | ported |
 * | `parseAvailability` / `parseRelocationWillingness` | ported |
 * | `FIELD_CROSSWALK` | Phase 7 |
 *
 * Every normalizer Phase 3 named is now real. `FIELD_CROSSWALK` stays `declare`d because it maps
 * RFS field ids onto `WorkerProfileDraft` paths, which is Phase 7's contract to define — a caller
 * that imports it gets a TypeScript error at the call site rather than `undefined` at runtime.
 */

export type { Availability, MonthlyInr, NormalizedValue } from "./types.js";

export {
  applyNegation,
  isNegated,
  NEGATION_ANSWERS_TOPICS,
  type NegationResult,
} from "./negation.js";

export { canonicalCity, canonicalRegion, canonicalState } from "./gazetteer.js";

export { parseExperienceYears } from "./experience.js";

export { detectSalaries, parseAmount, parseSalaryMonthly, type SalaryReading } from "./salary.js";

export {
  asksImmediateInContext,
  askedNoticeDuration,
  firstImmediateCue,
  firstNoticeCue,
  firstRelocateCue,
  hasAnywhereCue,
  noticePeriodDays,
  parseAvailability,
  parseRelocationWillingness,
  selfStateBlocked,
} from "./availability.js";

/**
 * RFS field id → the `WorkerProfileDraft` path it lands on.
 *
 * Published as DATA, not glue code, because the two vocabularies have drifted before and nothing
 * connected them: the interview captured `trade` / `salary_expected` / `tools_equipment` while
 * extraction independently re-parsed the transcript looking for `primary_role` /
 * `expected_salary` / `machines` + `controllers`.
 *
 * Guarded by an exhaustiveness test: every id in `PROFILING_REQUIRED_FIELDS ∪
 * PROFILING_OPTIONAL_FIELDS` must have an entry here or CI fails. THAT TEST is the actual fix for
 * the drift — the contract field is just the pipe.
 *
 * Phase 7.
 */
export interface CrosswalkEntry {
  readonly draftPath: string;
  readonly type: "string" | "number" | "string[]" | "bool" | "enum";
  readonly unit?: "years" | "inr_per_month";
  /** For `tools_equipment`, which routes tokens to `machines[]` vs `controllers[]`. */
  readonly splitter?: "machines_controllers";
}

export declare const FIELD_CROSSWALK: Readonly<Record<string, CrosswalkEntry>>;
