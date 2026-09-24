import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * SHEET METAL WORKER — laser cutting, CNC press brake, turret punch, shearing, on thin gauge.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO once the 2026-09-24 alias tranche made its words
 * reachable — "sheet metal", "press brake" and "fabricator" were NO MATCH before it. `fam_sheet_metal`
 * stays exactly where it is as the generic unit pack; this role binds the NCO occupations beside
 * it, on the rule in the authoring guide's §2 — a role pack sits beside the family pack, never
 * instead of it.
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
  formEnabled: true,
  displayName: "Sheet Metal Worker",
  offerName: "sheet metal worker",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "sheet_metal_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_sheet_metal_fab@1. An
    // ITI Sheet Metal Worker trainee stands at a hand shear and a folding machine, not at the
    // laser and turret his employer will run — so this list is the WORKSHOP's machines, not the
    // capability row's.
    workshopMachines: {
      shearing_machine: "Shearing machine",
      bending_machine: "Hand bending machine",
      spot_welder: "Spot welding machine",
      drilling_machine: "Drilling machine",
      grinder: "Grinding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries no certificate at all — its only
   * credential is the education line "ITI — Sheet Metal Worker · NCVT" — so these are the
   * credentials a thin-gauge shop actually asks about, led by the ITI trade itself.
   */
  suggestedCertificates: [
    "ITI Sheet Metal Worker — NCVT",
    "Trade Test — Sheet Metal Worker",
    "CNC Press Brake Operation",
    "Laser Cutting Machine Operation",
    "Site Safety Induction",
    "Fire & Safety Awareness",
    "First Aid",
  ],
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
