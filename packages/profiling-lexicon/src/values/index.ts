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
 * | `parseSalaryMonthly` | **declared only** — see below |
 * | `parseAvailability` / `parseRelocationWillingness` | **declared only** |
 * | `FIELD_CROSSWALK` | Phase 7 |
 *
 * The remaining three are deliberately a separate increment rather than a rushed port. Salary
 * carries the period disambiguation ("18k" is monthly, "2.5 lakh" is annual, "700 rupaye" is
 * daily) where getting it wrong is a **12x error** in the very field employers filter on, and
 * availability carries `_self_state_blocked` plus the notice-period parser. Each needs its own
 * differential against the shipped Python and its own corpus cases; landing them half-checked
 * alongside the easy ones is how a silent regression ships.
 *
 * They stay `declare`d — exactly as Phase 0 left them — so a caller that imports one gets a
 * TypeScript error at the call site rather than `undefined` at runtime.
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

import type { Availability, MonthlyInr, NormalizedValue } from "./types.js";

/**
 * Expected/current salary, normalized to rupees per MONTH. `signals._SALARY_RE` plus the period
 * detection that disambiguates "18000" (month), "18k" (month), "2.5 lakh" (year), "700 rupaye"
 * (day). Getting the period wrong is a 12x error, so period detection is not optional — a bare
 * number with no period cue resolves by magnitude heuristic and records lower confidence.
 *
 * NOT YET PORTED — see the port-status table above.
 */
export declare function parseSalaryMonthly(text: string): NormalizedValue<MonthlyInr> | null;

/**
 * Availability + notice period. `signals._has_immediate_cue` / `_has_notice_cue` /
 * `_notice_period_days`, with `_apply_negation` guarding every cue.
 *
 * NOT YET PORTED — see the port-status table above.
 */
export declare function parseAvailability(
  text: string,
): NormalizedValue<{ availability: Availability; noticeDays: number | null }> | null;

/**
 * Willingness to relocate. `signals._has_relocate_cue`, negation-guarded.
 *
 * NOT YET PORTED — see the port-status table above.
 */
export declare function parseRelocationWillingness(text: string): NormalizedValue<boolean> | null;

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
