import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MATERIAL TESTING / MET LAB TECHNICIAN — material testing and the metallurgy lab: spectrometry,
 * hardness, tensile and microstructure, the coupons the foundry and the heat treat prove against.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T36) AND FORMLESS, like calibration: it completes the
 * `quality_lab` cluster, and its family (`fam_material_lab`) is what the chat interview serves
 * through retrieval.
 *
 * THE MET LAB, NOT THE NDT BAY. NDT, UT and DP testing are the NDT Technician's trade (same
 * cluster, listed as well as derived, since bare "ndt" can never be a term); hardening and the
 * furnace belong to heat treatment, the calibration lab to its own room, and a pharma QC
 * chemist is not this trade at all.
 */
export const MATERIAL_LAB_TECHNICIAN = {
  kind: "material_lab_technician",
  packId: "qp_material_lab",
  familyId: "fam_material_lab",
  cluster: "quality_lab",
  formEnabled: false,
  displayName: "Material Testing / Met Lab Technician",
  offerName: "material testing / met lab technician",
  levelLadder: ["Trainee", "Technician", "Senior Technician", "Supervisor"],
  tenureQuestionKey: "matlab_experience",
  detection: {
    occupationTerms: [
      "metallurgist",
      "spectro operator",
      "spectrometer operator",
      "utm operator",
      "lab technician metallurgy",
      "testing lab incharge",
      "lab chemist",
      "मेटलर्जी लैब",
      "स्पेक्ट्रो ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T36 "Words": the met lab: spectro, hardness and tensile. Corroborate a pin; never route alone.
      "material testing",
      "material testing lab",
      "material lab",
      "met lab",
      "metallurgy lab",
      "metallurgical lab",
      "hardness testing",
      "hardness checker",
      "tensile test",
      "tensile testing",
      "tensile",
      "microstructure",
      "metallography",
      "physical lab",
      "mechanical testing lab",
      "chemical lab foundry",
      "wet analysis",
      "sand testing",
      "sand lab",
      "salt spray test",
      "spectro lab",
      "spectro ka kaam",
    ],
    levelTerms: ["trainee", "technician", "senior technician", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "ndt",
      "ut testing",
      "dp test",
      "hardening",
      "furnace operator",
      "calibration lab",
      "quality inspector",
      "qc chemist pharma",
    ],
  },
} as const satisfies RoleFormDescriptor;
