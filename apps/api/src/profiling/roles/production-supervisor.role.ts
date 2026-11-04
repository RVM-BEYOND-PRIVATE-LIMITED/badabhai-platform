import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PRODUCTION SUPERVISOR — the shift, section or line across trades: output, quality and
 * manpower, from line leader to production in-charge.
 *
 * DECLARED FOR PHASE 2 #10 (CEO Launch Plan Pack v1, sheet 23) AND FORMLESS, like EDM and PLC:
 * `qp_production_supervisor` is served through the chat interview on its family
 * (`fam_production_supervisor`).
 *
 * A TRADE SUPERVISOR KEEPS HIS TRADE. Sheet 23's rule: "VMC · Supervisor" stays on the VMC
 * trade. This role is for the man whose job IS supervision across trades or lines, so bare
 * "supervisor" is NOT a term here — it is every trade's top rung (A3: ask the department first).
 * The routable words name the cross-trade JOB ("production supervisor", "shift incharge").
 *
 * THE `production` CLUSTER, BESIDE ASSEMBLY AND QC. Its occupation terms therefore veto those
 * two forms, which is right: a "production supervisor" who mentions the assembly line is not an
 * assembly technician. The machine terms stay narrow for the same reason — "5S", "kaizen" and
 * "TPM" are words an assembler and an inspector use every day, and as vocabulary here they would
 * veto both forms on the shop floor's commonest words.
 */
export const PRODUCTION_SUPERVISOR = {
  kind: "production_supervisor",
  packId: "qp_production_supervisor",
  familyId: "fam_production_supervisor",
  cluster: "production",
  formEnabled: false,
  displayName: "Production Supervisor",
  offerName: "production supervisor",
  // Sheet 23's own level chips.
  levelLadder: ["Line Leader", "Supervisor", "Production In-charge"],
  tenureQuestionKey: "supervision_experience",
  detection: {
    occupationTerms: [
      "production supervisor",
      "shift incharge",
      "shift in charge",
      "shift in-charge",
      "production incharge",
      "production in charge",
      "production in-charge",
      "plant incharge",
      "plant in charge",
      "plant in-charge",
      "प्रोडक्शन सुपरवाइजर",
    ],
    machineTerms: ["shift report"],
    levelTerms: ["line leader", "supervisor", "in-charge", "सुपरवाइजर"],
  },
} as const satisfies RoleFormDescriptor;
