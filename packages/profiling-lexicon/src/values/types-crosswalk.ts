/**
 * The `FIELD_CROSSWALK` entry shape.
 *
 * DECLARED BY PHASE 3, FILLED BY PHASE 7. It lives in its own module so `crosswalk.ts` can import
 * the type without importing the barrel that re-exports it, which would be a cycle.
 */
export interface CrosswalkEntry {
  /**
   * The `WorkerProfileDraft` field this answer lands on.
   *
   * `null` means DELIBERATELY NOT CARRIED — there is no draft column and that is a decision, not
   * an oversight. Phase 3 typed this as a bare `string`; Phase 7 widened it precisely so the
   * exhaustiveness test can distinguish a considered omission from a forgotten mapping. Without
   * the null, `work_history` and `languages` would have had to invent a destination or be left
   * out of the table entirely — and being left out is the failure the table exists to prevent.
   */
  readonly draftPath: string | null;
  readonly type: "string" | "number" | "string[]" | "bool" | "enum";
  readonly unit?: "years" | "inr_per_month";
  /** For `tools_equipment`, which routes tokens to `machines[]` vs `controllers[]`. */
  readonly splitter?: "machines_controllers";
}
