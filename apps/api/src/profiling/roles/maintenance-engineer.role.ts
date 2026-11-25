import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MAINTENANCE ENGINEER — maintenance engineering: the desk trade on the maintenance bench —
 * planning the PM, leading the breakdown crew, and answering for the line's health.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T43) AND FORMLESS: the second `engineering_desk` role,
 * it supplies the vocabulary its desk siblings veto on, and its family (`fam_maintenance_engineer`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE DESK, NOT THE SPANNER. The hands-on breakdown is the Maintenance Technician's job, fitting
 * the Fitter's, wiring the Electrician's and the PLC program the PLC technician's — three
 * clusters between them, so every veto here is authored. "plant engineer" is deliberately not
 * a term: it could be this desk or the production one, and a coin toss is not routing.
 */
export const MAINTENANCE_ENGINEER = {
  kind: "maintenance_engineer",
  packId: "qp_maintenance_engineer",
  familyId: "fam_maintenance_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Maintenance Engineer",
  offerName: "maintenance engineer",
  levelLadder: [
    "Trainee (GET / DET)",
    "Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "me_experience",
  detection: {
    occupationTerms: [
      "maintenance engineer",
      "electrical maintenance engineer",
      "mechanical maintenance engineer",
      "maintenance supervisor",
      "maintenance officer",
      "maintenance executive",
      "shift engineer maintenance",
      "jr engineer maintenance",
      "utility engineer",
      "pm planner",
      "maintenance get",
      "maintenance det",
      "maintenance manager",
      "maintenance head",
      "machine maintenance engineer",
      "मेंटेनेंस इंजीनियर",
      "प्लांट मेंटेनेंस",
    ],
    machineTerms: [
      // Sheet T43 "Words": the maintenance desk: PM, breakdowns and SAP. Corroborate a pin; never route alone.
      "preventive maintenance",
      "breakdown maintenance",
      "sap pm",
      "pm planning",
      "plant maintenance",
      "maintenance planning",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "maintenance technician",
      "fitter",
      "electrician",
      "plc engineer",
      "utility operator",
      "ac maintenance",
    ],
  },
} as const satisfies RoleFormDescriptor;
