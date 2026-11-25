import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * INSTRUMENTATION TECHNICIAN — plant instrumentation: transmitters, control valves, loops and
 * shutdown systems, calibrated and commissioned on live plant.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T40) AND FORMLESS, like the robot cell: it supplies the
 * vocabulary its `maintenance`-cluster siblings veto on, and its family (`fam_instrumentation`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE LOOP, NOT THE GAUGE ROOM. Calibration is the Calibration Lab's trade (quality_lab
 * cluster) — but bare "calibration" sits inside this role's own "transmitter calibration",
 * so it cannot be a veto. The electrician, the panel and DCS operators, the valve fitter and
 * the vernier-and-micrometer quality check are listed.
 */
export const INSTRUMENTATION_TECHNICIAN = {
  kind: "instrumentation_technician",
  packId: "qp_instrumentation",
  familyId: "fam_instrumentation",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Instrumentation Technician",
  offerName: "instrumentation technician",
  levelLadder: ["Trainee", "Technician", "Senior Technician", "Supervisor"],
  tenureQuestionKey: "instr_experience",
  detection: {
    occupationTerms: [
      "instrument technician",
      "instrumentation technician",
      "instrument mechanic",
      "instrument fitter",
      "iti instrument mechanic",
      "e and i technician",
      "इंस्ट्रूमेंट टेक्नीशियन",
      "इंस्ट्रूमेंटेशन",
    ],
    machineTerms: [
      // Sheet T40 "Words": the instrument air: transmitters, valves and loops. Corroborate a pin; never route alone.
      "instrumentation",
      "transmitter calibration",
      "pressure transmitter",
      "level transmitter",
      "flow meter",
      "control valve",
      "positioner",
      "loop checking",
      "hart communicator",
      "rtd thermocouple",
      "impulse line",
      "dcs instrument",
      "instrument shutdown",
      "instrument tubing",
      "valve ka kaam",
      "load cell",
    ],
    levelTerms: ["trainee", "technician", "senior technician", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "electrician",
      "dcs operator",
      "panel operator",
      "valve fitting",
      "micrometer",
      "vernier",
    ],
  },
} as const satisfies RoleFormDescriptor;
