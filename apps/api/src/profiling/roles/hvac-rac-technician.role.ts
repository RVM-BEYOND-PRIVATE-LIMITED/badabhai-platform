import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * REFRIGERATION & AC (HVAC) TECHNICIAN — refrigeration and air conditioning: split and ductable
 * plant, VRF/VRV, chillers and cold rooms, installed, gassed and serviced.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T41) AND FORMLESS, like instrumentation: it supplies
 * the vocabulary its `maintenance`-cluster siblings veto on, and its family (`fam_hvac_rac`)
 * is what the chat interview serves through retrieval.
 *
 * THE PLANT, NOT THE CAR OR THE DUCT. A car AC is workshop work, a duct fabricator is sheet
 * metal, and the cooling tower, the electrician and the pipe fitter are their own trades —
 * each listed, since the sheet asks every one of them before any form.
 */
export const HVAC_RAC_TECHNICIAN = {
  kind: "hvac_rac_technician",
  packId: "qp_hvac_rac",
  familyId: "fam_hvac_rac",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Refrigeration & AC (HVAC) Technician",
  offerName: "refrigeration & AC (HVAC) technician",
  levelLadder: ["Trainee", "Technician", "Senior Technician", "Supervisor"],
  tenureQuestionKey: "hvac_experience",
  detection: {
    occupationTerms: [
      "hvac",
      "hvac technician",
      "hvac operator",
      "ac technician",
      "ac mechanic",
      "ac mistri",
      "fridge ac mechanic",
      "chiller technician",
      "chiller operator",
      "ahu operator",
      "ac ka kaam",
      "hvac ka kaam",
      "एसी टेक्नीशियन",
      "एचवीएसी",
    ],
    machineTerms: [
      // Sheet T41 "Words": the refrigeration plant: splits, packages and chillers. Corroborate a pin; never route alone.
      "ductable ac",
      "package ac",
      "split ac",
      "cassette ac",
      "cold storage",
      "cold room",
      "ammonia plant",
      "gas charging",
      "ac installation",
      "ac servicing",
      "ac fitting",
    ],
    levelTerms: ["trainee", "technician", "senior technician", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "duct fabricator",
      "cooling tower",
      "electrician",
      "pipe fitter",
      "car ac",
    ],
  },
} as const satisfies RoleFormDescriptor;
