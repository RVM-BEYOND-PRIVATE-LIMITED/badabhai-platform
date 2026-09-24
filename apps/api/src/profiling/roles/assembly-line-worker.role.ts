import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * ASSEMBLY LINE WORKER — sub-assembly, final assembly and end-of-line testing, to a takt.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO. Unlike sheet metal, this role's words were already
 * reachable before the 2026-09-24 alias tranche — "assembly line" and "असेंबली" sat on
 * jd_nco_8219_0100 — and the tranche added the stem "assembly" (item 25). What it lacked was a
 * binding, and a binding ships only with its pack. `fam_assembly` (unit 8219) and
 * `fam_assemblers_other` (minor 821) stay exactly where they are as the generic packs; this role
 * binds three NCO occupations beside them, on the rule in the authoring guide's §2 — a role pack
 * sits beside the family pack, never instead of it. Bare English "assembler" does NOT reach it:
 * that span's first claimant is 8211.1300 (motor cycle), a rejected neighbour — see
 * `_families.jsonl`.
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
  formEnabled: true,
  displayName: "Assembly Line Worker",
  offerName: "assembly line worker",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "assembly_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_assembly_line@1. Line
    // workers come out of the ITI Fitter and Mechanic Motor Vehicle trades (the reference page's
    // own worker is ITI MMV), whose workshops have an engine stand and a hydraulic press rather
    // than the nut runners and poka-yoke fixtures of a plant — so this list is the WORKSHOP's
    // equipment, not the capability row's.
    workshopMachines: {
      engine_stand: "Engine assembly stand",
      pneumatic_tools: "Pneumatic tools",
      hydraulic_press: "Hydraulic press",
      drilling_machine: "Drilling machine",
      grinder: "Grinding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries one certificate — "Assembly Line
   * Safety & Torque Discipline" (RVM CAD, Faridabad) — and the education line "ITI — Mechanic
   * Motor Vehicle · NCVT", so both lead; the rest are the shop-floor-system credentials a line
   * employer asks about, and the safety pair every shipped role carries.
   */
  suggestedCertificates: [
    "Assembly Line Safety & Torque Discipline",
    "ITI Mechanic Motor Vehicle — NCVT",
    "ITI Fitter — NCVT",
    "5S Workplace Organisation",
    "Kaizen & Continuous Improvement",
    "Fire & Safety Awareness",
    "First Aid",
  ],
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
