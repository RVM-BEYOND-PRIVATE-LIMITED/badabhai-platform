import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MAINTENANCE TECHNICIAN — mechanical, hydraulic, pneumatic and basic electrical, on plant.
 *
 * DECLARED IN BATCH 2, form to follow. `fam_machinery_repair` stays as the generic unit pack.
 *
 * ═══ IT IS DEFINED BY BREADTH, WHICH IS EXACTLY WHY IT NEEDS TWO SIBLINGS ═══
 *
 * The reference page's first row is "Disciplines — Mechanical · Hydraulic · Pneumatic · Basic
 * electrical", and that breadth is the trade rather than a description of one man. It also means
 * this role overlaps its two cluster siblings by construction: the mechanical half is the fitter's
 * page, and the "basic electrical" quarter is the industrial electrician's. Putting all three in
 * `maintenance` makes both vetoes derive, so a man who names two disciplines reaches no form and
 * keeps talking — which is the correct outcome, because the interview can ask which one pays him.
 *
 * ═══ "maintenance" ROUTES; "breakdown" AND "preventive" ONLY CORROBORATE ═══
 *
 * A fitter attends breakdowns, an electrician does preventive rounds, and a press setter does
 * both — the words describe a shift pattern, not a trade. What claims this role is being called
 * the maintenance man. The equipment terms below are the same: "air compressor" is corroboration,
 * not a claim.
 *
 * ═══ NO "cnc machine", DESPITE IT BEING THE FIRST THING ON THE EQUIPMENT ROW ═══
 *
 * "Equipment maintained — CNC machines" is on the reference page and must NOT become a machine
 * term: it would corroborate against `fam_cnc_turning` and `fam_vmc_milling`, whose workers say
 * those words about the machine they OPERATE. The distinction the router cannot see is who is
 * holding the spanner. Left off entirely; the pack asks it as a question instead, where the
 * worker's answer is unambiguous.
 */
export const MAINTENANCE_TECHNICIAN = {
  kind: "maintenance_technician",
  packId: "qp_maintenance_tech",
  familyId: "fam_maintenance_tech",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Maintenance Technician",
  offerName: "maintenance technician",
  levelLadder: ["Helper", "Technician", "Senior Technician"],
  tenureQuestionKey: "maintenance_experience",
  detection: {
    occupationTerms: [
      "maintenance technician",
      "maintenance",
      "maintenance fitter",
      "plant maintenance",
      "मेंटेनेंस",
    ],
    machineTerms: [
      "preventive maintenance",
      "breakdown maintenance",
      "condition monitoring",
      "air compressor",
      "vibration pen",
      "lubrication schedule",
      "shutdown overhaul",
    ],
    levelTerms: ["helper", "technician", "senior technician", "टेक्नीशियन"],
  },
} as const satisfies RoleFormDescriptor;
