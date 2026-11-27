import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * SAFETY / EHS OFFICER — industrial safety and EHS: the statutory trade nothing substitutes for
 * — audits, permits and the fire crew's drills, never anyone's second job.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T49) AND FORMLESS, like the NPD desk: it supplies the
 * vocabulary its desk siblings veto on, and its family (`fam_safety_ehs`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE STATUTORY TRADE, NOT THE GATE. Security supervision is guard work, a fireman alone is a
 * crew posting, and food safety is food quality — none of them is this trade. "suraksha" asks
 * guard or industrial safety before any form.
 */
export const SAFETY_OFFICER = {
  kind: "safety_officer",
  packId: "qp_safety_ehs",
  familyId: "fam_safety_ehs",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Safety / EHS Officer",
  offerName: "safety / EHS officer",
  levelLadder: [
    "Safety Supervisor / Trainee",
    "Safety Officer",
    "Senior Safety Officer",
    "Lead / Asst. Manager EHS",
    "EHS Manager / HOD",
  ],
  tenureQuestionKey: "ehs_experience",
  detection: {
    occupationTerms: [
      "safety officer",
      "safety supervisor",
      "safety engineer",
      "safety incharge",
      "safety steward",
      "safety marshal",
      "safety trainee",
      "ehs officer",
      "ehs executive",
      "ehs engineer",
      "ehs manager",
      "hse officer",
      "hse engineer",
      "hse supervisor",
      "she officer",
      "fire and safety",
      "fire safety officer",
      "fire safety supervisor",
      "industrial safety",
      "environment officer",
      "सेफ्टी ऑफिसर",
      "ईएचएस ऑफिसर",
    ],
    machineTerms: [
      // Sheet T49 "Words": the safety office: permits, audits and the fire crew. Corroborate a pin; never route alone.
      "nebosh",
      "pdis",
      "adis",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "security",
      "security supervisor",
      "suraksha",
      "fireman",
      "etp operator",
      "food safety",
      "fssai",
      "electrical safety",
      "housekeeping supervisor",
    ],
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
