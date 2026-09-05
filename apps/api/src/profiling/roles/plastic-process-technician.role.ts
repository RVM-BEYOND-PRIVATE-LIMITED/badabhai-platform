import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PLASTIC PROCESS / QUALITY TECHNICIAN — process setting, parameter optimisation, rejection control.
 *
 * DECLARED FOR BATCH 3.
 *
 * IT IS THE POLYMER CLUSTER'S QC ROLE, AND IT HAS THE SAME NARROWNESS PROBLEM. Like
 * `quality-inspector.role.ts`, its work is described in words every neighbouring role uses —
 * "process setting" is what a moulding setter does all shift, and "in-process QC" is what the
 * inspector at the end of the line does. It sits in `polymer` with the moulding roles precisely so
 * those vetoes derive, and its terms below name the ANALYSIS rather than the machine: nobody but
 * this role runs a rejection analysis or a mould trial report.
 */
export const PLASTIC_PROCESS_TECHNICIAN = {
  kind: "plastic_process_technician",
  packId: "qp_plastic_process",
  familyId: "fam_plastic_process",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Plastic Process / Quality Technician",
  offerName: "plastic process technician",
  levelLadder: ["Technician", "Process Engineer"],
  tenureQuestionKey: "process_experience",
  detection: {
    occupationTerms: [
      "plastic process technician",
      "process technician",
      "plastic quality technician",
      "प्रोसेस टेक्नीशियन",
    ],
    machineTerms: [
      "rejection analysis",
      "parameter optimisation",
      "parameter optimization",
      "mould trial",
      "shrinkage check",
      "melt flow index",
    ],
    levelTerms: ["technician", "process engineer", "टेक्नीशियन"],
  },
} as const satisfies RoleFormDescriptor;
