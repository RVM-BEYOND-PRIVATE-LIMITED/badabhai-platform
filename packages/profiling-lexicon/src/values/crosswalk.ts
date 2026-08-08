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
  trade: { draftPath: "primary_role", type: "string", required: true },
  skills: { draftPath: "skills", type: "string_array", required: true },
  experience_years: { draftPath: "experience_years", type: "number", unit: "years", required: true },
  current_city: { draftPath: "current_city", type: "string", required: true },
  preferred_locations: { draftPath: "preferred_locations", type: "string_array", required: true },
  // THE RENAME THIS TABLE EXISTS FOR. `salary_expected` (RFS) is `expected_salary` (draft), and
  // the two have been re-derived independently before.
  salary_expected: { draftPath: "expected_salary", type: "number", unit: "inr_per_month", required: true },
  availability: { draftPath: "availability", type: "enum", required: true },

  // --- optional -----------------------------------------------------------
  // Trade-agnostic by construction: one phrase carries a VMC and a Fanuc for a machinist, an
  // overlock for a tailor, a tandoor for a cook. The splitter routes the tokens; no per-trade code.
  tools_equipment: {
    draftPath: "machines",
    type: "string_array",
    splitter: "machines_controllers",
  },
  salary_current: { draftPath: "current_salary", type: "number", unit: "inr_per_month" },
  education_level: { draftPath: "education_level", type: "string" },
  education_field: { draftPath: "education_field", type: "string" },
  certifications: { draftPath: "certifications", type: "string_array" },
  // NOT CARRIED, DELIBERATELY. `WorkerProfileDraft` has no employer/history column and §2 forbids
  // storing employer names; the answer feeds the resume narrative and stops there. Written as an
  // explicit null so the exhaustiveness test can tell a considered omission from a forgotten one.
  work_history: { draftPath: null, type: "string_array" },
  // NOT CARRIED: no draft column today. Captured because it is cheap and useful, and will be
  // carried the moment a column exists.
  languages: { draftPath: null, type: "string_array" },
  relocation_willingness: { draftPath: "relocation_willingness", type: "boolean" },
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

/**
 * The closed `target_fields` list for a `POST /profile/parse` request.
 *
 * GATE 5 IS ONLY AS CLOSED AS THIS LIST. Any `field_id` the model returns that is not here is
 * dropped and counted — so building it from the crosswalk, which the exhaustiveness test already
 * pins against the RFS vocabulary, is what stops the two from drifting apart a third time. A
 * hand-maintained second list is a second thing to forget.
 *
 * FIELDS WITH NO DRAFT DESTINATION ARE STILL INCLUDED. `work_history` and `languages` have
 * nowhere to land in `WorkerProfileDraft` today, but the parse call reads them for the resume
 * narrative; omitting them here would make gate 5 reject values the interview deliberately
 * collected.
 *
 * SORTED, so the request body content-hashes identically across processes and deployments.
 * Object key order is stable in practice and guaranteed by nothing.
 */
export const PARSE_TARGET_FIELDS: readonly {
  readonly field_id: string;
  readonly type: string;
  readonly unit: string | null;
  readonly required: boolean;
}[] = Object.keys(FIELD_CROSSWALK)
  .sort()
  .map((field_id) => {
    const entry = FIELD_CROSSWALK[field_id] as CrosswalkEntry;
    return {
      field_id,
      type: entry.type,
      unit: entry.unit ?? null,
      required: entry.required === true,
    };
  });
