import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * ASSEMBLY LINE WORKER — sub-assembly, final assembly and end-of-line testing, to a takt.
 *
 * DECLARED IN BATCH 2, form to follow. `fam_assembly` stays as the generic unit pack.
 *
 * ═══ `production`, WITH THE QC INSPECTOR, AND THE PAIRING IS NOT ARBITRARY ═══
 *
 * These two are the only Batch 2 roles that own no fabrication process of their own: they work ON
 * the line rather than at a machine, and both describe themselves in the line's vocabulary —
 * "first-off checking" is on the assembly page, "in-process patrol" on the inspector's, and a go/
 * no-go gauge is on both. A man who says "line pe kaam karta hoon, checking bhi karta hoon" is
 * genuinely either, which is the test for a cluster sibling and the reason neither is left alone
 * in a cluster of one, where nothing at all would derive.
 *
 * ═══ THE FITTER IS THE RIVAL THAT CROSSES THE BOUNDARY ═══
 *
 * "Assembly fitting" is the fitter's own first chip and this role's entire job. `fitter` sits in
 * `maintenance`, so the veto is authored on both descriptors — see the mirror in
 * `fitter.role.ts`. Nothing derives it, and forgetting one side would leave the veto working in
 * only one direction, which is worse than not having it: the trade that forgot would silently
 * claim every ambiguous worker.
 *
 * ═══ "operator" IS NOT AN OCCUPATION TERM ANYWHERE, AND ESPECIALLY NOT HERE ═══
 *
 * It is the second rung of eight ladders in this registry. The reference page's own headline is
 * "Assembly Line Worker — Skilled" and its work history says "Assembly Operator"; the word that
 * carries the trade is "assembly", not the rung beside it.
 */
export const ASSEMBLY_LINE_WORKER = {
  kind: "assembly_line_worker",
  packId: "qp_assembly_line",
  familyId: "fam_assembly_line",
  cluster: "production",
  formEnabled: false,
  displayName: "Assembly Line Worker",
  offerName: "assembly line worker",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "assembly_experience",
  detection: {
    occupationTerms: [
      "assembly line worker",
      "assembly line",
      "assembly operator",
      "final assembly",
      "sub assembly",
      "असेंबली",
    ],
    machineTerms: [
      "nut runner",
      "torque wrench",
      "pneumatic gun",
      "poka yoke",
      "leak test rig",
      "end of line testing",
      "takt",
      "kanban",
    ],
    levelTerms: ["helper", "operator", "skilled", "ऑपरेटर"],
    /** Assembly FITTING, which is the fitter's trade and sits in `maintenance`. Mirrored there. */
    extraConflictTerms: ["fitter", "fitting", "फिटर", "erection", "commissioning"],
  },
} as const satisfies RoleFormDescriptor;
