import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * HEAT-TREATMENT TECHNICIAN — hardening and tempering, case carburising, nitriding, induction
 * hardening and annealing, from loading the furnace to setting the cycle and checking hardness.
 *
 * DECLARED FOR PHASE 2 #8 (CEO Launch Plan Pack v1, sheet 17) AND FORMLESS, like PLC and EDM: it
 * supplies the vocabulary its `fabrication`-cluster siblings veto on, and its family
 * (`fam_heat_treatment`) is what the chat interview serves through retrieval.
 *
 * THE JOB, NOT THE PROCESS WORD. Bare "heat treatment" is NOT a term here: a welder who does
 * post-weld heat treatment says it, and as this role's vocabulary it would veto his welder form.
 * The routable words name the HT job ("heat treatment operator", "furnace operator"); the furnaces
 * corroborate a family pin. "hardness" and "Rockwell" are the QC inspector's instrument words too
 * (sheet 12), so they are capture chips in the pack and never terms here.
 */
export const HEAT_TREATMENT = {
  kind: "heat_treatment_technician",
  packId: "qp_heat_treatment",
  familyId: "fam_heat_treatment",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Heat-Treatment Technician",
  offerName: "heat treatment technician",
  levelLadder: ["Trainee", "Operator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "heat_experience",
  detection: {
    occupationTerms: [
      "heat treatment operator",
      "heat treatment technician",
      "ht operator",
      "hardening operator",
      "furnace operator",
    ],
    machineTerms: [
      // Sheet 17 "Words": the HT furnaces. Corroborate a pin; never route alone.
      "sealed quench",
      "pit furnace",
      "vacuum furnace",
      "salt bath",
      "ipsen",
    ],
    levelTerms: ["trainee", "operator", "skilled", "senior"],
  },
} as const satisfies RoleFormDescriptor;
