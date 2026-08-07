/**
 * `FIELD_CROSSWALK` — RFS field id → the `WorkerProfileDraft` path it lands on.
 *
 * PHASE 3 DECLARED THIS AND LEFT IT UNIMPLEMENTED, on purpose: `export declare const` so that a
 * caller importing it got a TypeScript error at the call site rather than `undefined` at runtime.
 * This file is Phase 7 paying that debt. The `CrosswalkEntry` shape is Phase 3's; the data and the
 * `null` refinement below are Phase 7's contract to define, exactly as its doc comment says.
 *
 * WHY DATA AND NOT GLUE CODE. The two vocabularies have drifted before, and nothing connected
 * them: the interview captured `trade` / `salary_expected` / `tools_equipment` while extraction
 * independently re-parsed the transcript looking for `primary_role` / `expected_salary` /
 * `machines` + `controllers`. A `switch` missing a case drops a captured answer silently — the
 * worker answered, and the field simply never reaches their profile. As data it can be checked for
 * EXHAUSTIVENESS, and that test is the actual fix; the mapping itself is just the pipe.
 */

import type { CrosswalkEntry } from "./types-crosswalk.js";

/**
 * THE MAPPING. Keys are RFS ids EXACTLY as `apps/ai-service/app/config.py` spells them, because
 * the exhaustiveness test reads that file — a rename on either side is a red build rather than a
 * silently dropped answer.
 */
export const FIELD_CROSSWALK: Readonly<Record<string, CrosswalkEntry>> = {
  // --- required -----------------------------------------------------------
  trade: { draftPath: "primary_role", type: "string" },
  skills: { draftPath: "skills", type: "string[]" },
  experience_years: { draftPath: "experience_years", type: "number", unit: "years" },
  current_city: { draftPath: "current_city", type: "string" },
  preferred_locations: { draftPath: "preferred_locations", type: "string[]" },
  // THE RENAME THIS TABLE EXISTS FOR. `salary_expected` (RFS) is `expected_salary` (draft), and
  // the two have been re-derived independently before.
  salary_expected: { draftPath: "expected_salary", type: "number", unit: "inr_per_month" },
  availability: { draftPath: "availability", type: "enum" },

  // --- optional -----------------------------------------------------------
  // Trade-agnostic by construction: one phrase carries a VMC and a Fanuc for a machinist, an
  // overlock for a tailor, a tandoor for a cook. The splitter routes the tokens; no per-trade code.
  tools_equipment: {
    draftPath: "machines",
    type: "string[]",
    splitter: "machines_controllers",
  },
  salary_current: { draftPath: "current_salary", type: "number", unit: "inr_per_month" },
  education_level: { draftPath: "education_level", type: "string" },
  education_field: { draftPath: "education_field", type: "string" },
  certifications: { draftPath: "certifications", type: "string[]" },
  // NOT CARRIED, DELIBERATELY. `WorkerProfileDraft` has no employer/history column and §2 forbids
  // storing employer names; the answer feeds the resume narrative and stops there. Written as an
  // explicit null so the exhaustiveness test can tell a considered omission from a forgotten one.
  work_history: { draftPath: null, type: "string[]" },
  // NOT CARRIED: no draft column today. Captured because it is cheap and useful, and will be
  // carried the moment a column exists.
  languages: { draftPath: null, type: "string[]" },
  relocation_willingness: { draftPath: "relocation_willingness", type: "bool" },
};

/** Every RFS id the crosswalk knows. */
export const CROSSWALK_FIELD_IDS: ReadonlySet<string> = new Set(Object.keys(FIELD_CROSSWALK));

/** Where does this RFS answer land? `undefined` when the id is not in the RFS vocabulary at all. */
export function crosswalkFor(fieldId: string): CrosswalkEntry | undefined {
  return FIELD_CROSSWALK[fieldId];
}

/**
 * Every draft field a projection may write to.
 *
 * `machines_controllers` contributes `controllers` too, which no `draftPath` names — the splitter
 * is the only thing that knows about it, so it is declared here rather than inferred.
 */
export const CROSSWALK_DRAFT_FIELDS: ReadonlySet<string> = new Set(
  [
    ...Object.values(FIELD_CROSSWALK).map((e) => e.draftPath),
    "controllers",
  ].filter((f): f is string => f !== null),
);
