import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * NDT TECHNICIAN — non-destructive testing: UT, radiography, MPI/MPT and dye penetrant, graded
 * by certification level (I/II/III), not by years alone.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T34) AND FORMLESS, like CMM: it supplies the vocabulary
 * its `quality_lab`-cluster siblings veto on, and its family (`fam_ndt`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE TEST LAB, NOT THE HOSPITAL. An X-ray technician asks weld radiography or hospital — only
 * one of them is this trade — and "testing" alone asks which testing. Bare "x-ray" cannot
 * be a veto: it sits inside this role's own "weld ka x-ray". The lab question, the tensile
 * question and the QC inspector are listed.
 */
export const NDT_TECHNICIAN = {
  kind: "ndt_technician",
  packId: "qp_ndt",
  familyId: "fam_ndt",
  cluster: "quality_lab",
  formEnabled: false,
  displayName: "NDT Technician",
  offerName: "NDT technician",
  levelLadder: ["Trainee", "Level I", "Level II", "Level III"],
  tenureQuestionKey: "ndt_experience",
  detection: {
    occupationTerms: [
      "ndt technician",
      "ndt inspector",
      "ut technician",
      "radiographer",
      "rt technician",
      "paut operator",
      "film interpreter",
      "ultrasonic testing",
      "एनडीटी टेक्नीशियन",
      "रेडियोग्राफी",
    ],
    machineTerms: [
      // Sheet T34 "Words": the NDT kit: radiography, penetrants and ultrasonics. Corroborate a pin; never route alone.
      "radiography",
      "magnetic particle",
      "dye penetrant",
      "eddy current testing",
      "thickness gauging",
      "weld ka x-ray",
      "dp test",
      "pt mt",
    ],
    levelTerms: [
      "trainee",
      "technician",
      "senior technician",
      "lead",
      "level i",
      "level ii",
      "level iii",
    ],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "lab technician",
      "tensile",
      "welding inspector",
      "qc inspector",
      "ultrasonic welding",
      "sonography",
    ],
  },
} as const satisfies RoleFormDescriptor;
