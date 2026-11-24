import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PRODUCTION ENGINEER — production engineering: the desk trade that owns the line's output —
 * shifts, shops and the ERP entries behind them.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T46) AND FORMLESS, like the service desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_production_engineer`) is what
 * the chat interview serves through retrieval. Its machine vocabulary is empty on purpose: the
 * sheet's words are all titles, and a process word here would claim a neighbouring trade.
 *
 * THE LINE'S OWNER, NOT ITS SUPERVISOR. The supervisor and the line incharge stand on the line
 * (production cluster); PPC and planning make the plan this desk executes — all listed, since
 * bare "planning" can never be a routing term.
 */
export const PRODUCTION_ENGINEER = {
  kind: "production_engineer",
  packId: "qp_production_engineer",
  familyId: "fam_production_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Production Engineer",
  offerName: "production engineer",
  levelLadder: [
    "Trainee (GET / DET)",
    "Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "prod_experience",
  detection: {
    occupationTerms: [
      "production engineer",
      "production executive",
      "production officer",
      "shift engineer",
      "line engineer",
      "shop engineer",
      "machine shop engineer",
      "assembly engineer",
      "press shop engineer",
      "weld shop engineer",
      "moulding production engineer",
      "production manager",
      "production head",
      "प्रोडक्शन इंजीनियर",
      "शिफ्ट इंजीनियर",
    ],
    // No machineTerms: the sheet's words are all titles, and a process word here would claim a
    // neighbouring trade. The key stays so the shape holds.
    machineTerms: [],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["production supervisor", "line incharge", "ppc", "planning"],
  },
} as const satisfies RoleFormDescriptor;
