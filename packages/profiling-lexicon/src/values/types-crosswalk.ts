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
  /**
   * THE `TargetField.type` VOCABULARY, SPELLED THE WAY THE CONTRACT SPELLS IT.
   *
   * This is the only table in the repo that declares a type per RFS field, so it is what builds
   * `target_fields` on a parse request — and gate 3 branches on those exact strings. Phase 7
   * originally wrote `"string[]"` and `"bool"` here, which matched nothing: gate 3 tests for
   * `"string_array"` and `"boolean"`, so its array and boolean branches were DEAD and every
   * array- or boolean-valued field went through the type gate unexamined. The frozen contract
   * settles the spelling — `TargetFieldSchema.type` in `@badabhai/ai-contracts` documents
   * `"string" | "number" | "boolean" | "enum" | "string_array"` — and a test now asserts every
   * value used here is one gate 3 actually branches on, so the two cannot drift apart again.
   */
  readonly type: "string" | "number" | "string_array" | "boolean" | "enum";
  readonly unit?: "years" | "inr_per_month";
  /** For `tools_equipment`, which routes tokens to `machines[]` vs `controllers[]`. */
  readonly splitter?: "machines_controllers";
}
