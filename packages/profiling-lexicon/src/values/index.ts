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
 * | `parseAvailability` / `parseRelocationWillingness` | **declared only** |
 * | `FIELD_CROSSWALK` | Phase 7 |
 *
 * Availability is a separate increment rather than a rushed port: it carries `_self_state_blocked`
 * plus the notice-period parser, and needs its own differential against the shipped Python and its
 * own corpus cases. Landing it half-checked alongside the rest is how a silent regression ships.
 *
 * It stays `declare`d — exactly as Phase 0 left it — so a caller that imports it gets a TypeScript
 * error at the call site rather than `undefined` at runtime.
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

import type { Availability, NormalizedValue } from "./types.js";

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
