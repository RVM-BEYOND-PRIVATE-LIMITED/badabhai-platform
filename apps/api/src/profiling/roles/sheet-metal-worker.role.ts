import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * SHEET METAL WORKER — laser cutting, CNC press brake, turret punch, shearing, on thin gauge.
 *
 * DECLARED IN BATCH 2, form to follow. `fam_sheet_metal` stays exactly where it is as the generic
 * unit pack; this role binds the NCO occupations beside it, on the rule in the authoring guide's
 * §2 — a role pack sits beside the family pack, never instead of it.
 *
 * ═══ THE PRESS BRAKE IS THE WORD THIS ROLE AND THE PRESS OPERATOR FIGHT OVER ═══
 *
 * The reference pages put "Press brake" on BOTH sheets — it is this role's fourth machine and the
 * press operator's fourth machine, and the two trades are genuinely different: one develops a flat
 * pattern and bends an enclosure, the other sets a progressive die and runs a strip. They are
 * cluster siblings, so `conflictTermsFor` derives the veto in both directions automatically and
 * the ambiguous worker keeps talking instead of being handed the wrong eighteen questions.
 *
 * "press brake" is declared HERE as a machine term and NOT on the press operator, which is the
 * asymmetry the evidence supports: the sheet-metal page leads with cutting and bending, and the
 * press page leads with tonnage and die setting. A man who says "press brake" without saying
 * "press" is describing this trade.
 *
 * ═══ "laser" IS QUALIFIED, BECAUSE THE BARE WORD IS A MAINTENANCE INSTRUMENT ═══
 *
 * "Laser alignment kit" is on the fitter's page and "laser" alone would collide with it across a
 * cluster boundary, where nothing derives a veto. "fibre laser" and "laser cutting" say the
 * machine rather than the beam.
 */
export const SHEET_METAL_WORKER = {
  kind: "sheet_metal_worker",
  packId: "qp_sheet_metal_fab",
  familyId: "fam_sheet_metal_fab",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Sheet Metal Worker",
  offerName: "sheet metal worker",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "sheet_metal_experience",
  detection: {
    occupationTerms: [
      "sheet metal worker",
      "sheet metal",
      "sheetmetal",
      "fabricator",
      "fabrication",
      "शीट मेटल",
    ],
    machineTerms: [
      "press brake",
      "turret punch",
      "fibre laser",
      "fiber laser",
      "laser cutting",
      "shearing machine",
      "plasma cutting",
      "notching",
    ],
    levelTerms: ["helper", "operator", "skilled", "ऑपरेटर"],
  },
} as const satisfies RoleFormDescriptor;
