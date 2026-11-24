import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PPC / PRODUCTION PLANNING ENGINEER — production planning and control: the desk that makes the
 * plan the line executes — schedules, material and customer follow-up.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T52) AND FORMLESS, like the sales desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_ppc`) is what the chat
 * interview serves through retrieval.
 *
 * THE PLAN, NOT THE LINE. Running the line is the Production Engineer's job and owning it the
 * supervisor's; project planning (MS Project, Primavera) is the Project desk's. Bare "ppc"
 * is too short to route (#3010 holds it) and "planning" alone asks whose plan — both keep
 * the worker talking.
 */
export const PPC_ENGINEER = {
  kind: "ppc_engineer",
  packId: "qp_ppc",
  familyId: "fam_ppc",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "PPC / Production Planning Engineer",
  offerName: "PPC / production planning engineer",
  levelLadder: [
    "Trainee",
    "PPC Executive / Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "ppc_experience",
  detection: {
    occupationTerms: [
      "ppc engineer",
      "ppc executive",
      "ppc incharge",
      "ppc head",
      "ppc assistant",
      "production planning",
      "production planning and control",
      "planning engineer",
      "material planning",
      "material planner",
      "planning department",
      "schedule engineer",
      "customer schedule follow up",
      "पीपीसी इंजीनियर",
      "प्रोडक्शन प्लानिंग",
    ],
    machineTerms: [
      // Sheet T52 "Words": the PPC desk: schedules, material and follow-up. Corroborate a pin; never route alone.
      "sap ppc",
      "ppc mis",
      "schedule",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "production ka kaam",
      "project planning",
      "ms project",
      "primavera",
      "material ka kaam",
    ],
  },
} as const satisfies RoleFormDescriptor;
