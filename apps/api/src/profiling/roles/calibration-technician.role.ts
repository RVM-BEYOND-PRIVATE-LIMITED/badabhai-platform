import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CALIBRATION / METROLOGY LAB TECHNICIAN — calibration and the metrology lab: gauge, instrument
 * and standard-room calibration against masters, with NABL discipline.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T35) AND FORMLESS, like NDT: it supplies the vocabulary
 * its `quality_lab`-cluster siblings veto on, and its family (`fam_calibration`) is what the
 * chat interview serves through retrieval.
 *
 * THE GAUGE LAB, NOT THE PLANT FLOOR. Instrumentation is the Instrumentation Technician's trade
 * (maintenance cluster), machine and laser calibration the Service Engineer's — both listed, as
 * is the weighbridge. "iso 17025" carries digits the alias layer refuses, so it stays a lab
 * record, never a term: the NABL lab and the standards room carry the routing.
 */
export const CALIBRATION_TECHNICIAN = {
  kind: "calibration_technician",
  packId: "qp_calibration",
  familyId: "fam_calibration",
  cluster: "quality_lab",
  formEnabled: false,
  displayName: "Calibration / Metrology Lab Technician",
  offerName: "calibration / metrology lab technician",
  levelLadder: ["Trainee", "Technician", "Senior Technician", "Supervisor"],
  tenureQuestionKey: "calib_experience",
  detection: {
    occupationTerms: [
      "calibration technician",
      "calibration engineer",
      "calibration executive",
      "gauge incharge",
      "calibration ka kaam",
      "कैलिब्रेशन टेक्नीशियन",
      "कैलिब्रेशन",
    ],
    machineTerms: [
      // Sheet T35 "Words": the gauge lab: masters, standards and references. Corroborate a pin; never route alone.
      "calibration",
      "gauge calibration",
      "instrument calibration",
      "dimensional calibration",
      "pressure gauge calibration",
      "torque wrench calibration",
      "on-site calibration",
      "slip gauge",
      "master instrument",
      "gauge room",
      "standard room",
      "standards room",
      "metrology lab",
      "nabl calibration lab",
      "gauge r&r",
      "msa study",
      "instrument checking lab",
    ],
    levelTerms: ["trainee", "technician", "senior technician", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "instrumentation",
      "lab technician",
      "nabl lab",
      "quality inspector",
      "machine calibration",
      "laser calibration",
      "weighbridge",
      "instrument technician",
    ],
  },
} as const satisfies RoleFormDescriptor;
