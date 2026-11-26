import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * SERVICE ENGINEER (FIELD / MACHINE SERVICE) — field and machine service: installation,
 * breakdown calls and AMC visits on the customer's floor, across machine tools and utilities.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T44) AND FORMLESS, like the maintenance desk: it
 * supplies the vocabulary its desk siblings veto on, and its family (`fam_service_engineer`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE MACHINE'S SERVICE, NOT THE PLANT'S PROJECT. "site engineer" is the Project / Site
 * Engineer's word and vetoes from the cluster derivation; "installation engineer" is claimed
 * by neither trade (the pack gives it to both, so routing takes it nowhere — #3015). Car and
 * bike service are workshop work, and an AC service call belongs to HVAC.
 */
export const SERVICE_ENGINEER = {
  kind: "service_engineer",
  packId: "qp_service_engineer",
  familyId: "fam_service_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Service Engineer (Field / Machine Service)",
  offerName: "service engineer",
  levelLadder: ["Trainee", "Service Engineer", "Senior Engineer", "Lead", "Manager"],
  tenureQuestionKey: "service_experience",
  detection: {
    occupationTerms: [
      "service engineer",
      "field service engineer",
      "field engineer",
      "service technician",
      "machine service engineer",
      "cnc service engineer",
      "customer support engineer",
      "amc engineer",
      "service executive",
      "service ka kaam",
      "machine installation",
      "service incharge",
      "service manager",
      "सर्विस इंजीनियर",
      "फील्ड सर्विस इंजीनियर",
    ],
    machineTerms: [
      // Sheet T44 "Words": the service kit: breakdown calls and field repair. Corroborate a pin; never route alone.
      "breakdown call",
      "cnc machine repair",
      "spindle repair",
      "after sales service",
      "customer site service",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["ac service", "car service", "bike service"],
  },
  fresher: {
    workshopMachines: {
      internship: "Internship",
      apprenticeship: "Apprenticeship (NATS / NAPS)",
      college_project: "College major project",
      industrial_visit: "Industrial visit",
    },
    // The pack asks no trade-test question, so no status ever maps here.
    tradeTest: {},
    trainingLabel: "Training and projects",
  },
} as const satisfies RoleFormDescriptor;
