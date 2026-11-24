import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PROJECT / SITE ENGINEER (MECHANICAL) — project and site engineering: erection and commissioning
 * on the customer's site, the plant built anywhere but home.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T50) AND FORMLESS, like the safety desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_project_site`) is what the
 * chat interview serves through retrieval.
 *
 * THE MECHANICAL SITE, NOT THE CIVIL ONE. Civil supervision and erection are construction work;
 * the service engineer services machines where this desk erects plants, and the site safety
 * officer, the rigger and the hands-on site fabricator are their own trades. "installation
 * engineer" is claimed by neither trade it is given to (#3015).
 */
export const PROJECT_SITE_ENGINEER = {
  kind: "project_site_engineer",
  packId: "qp_project_site",
  familyId: "fam_project_site",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Project / Site Engineer (Mechanical)",
  offerName: "project / site engineer",
  levelLadder: ["Trainee", "Engineer", "Senior Engineer", "Lead", "Manager"],
  tenureQuestionKey: "site_experience",
  detection: {
    occupationTerms: [
      "site engineer",
      "project engineer",
      "project site engineer",
      "erection engineer",
      "erection and commissioning",
      "e&c engineer",
      "site incharge",
      "site in charge",
      "erection supervisor",
      "site execution engineer",
      "project execution",
      "fire fighting site engineer",
      "peb site engineer",
      "structural erection engineer",
      "plant erection",
      "project manager mechanical",
      "साइट इंजीनियर",
      "प्रोजेक्ट इंजीनियर",
      "इरेक्शन इंजीनियर",
    ],
    machineTerms: [
      // Sheet T50 "Words": the site office: erection and commissioning. Corroborate a pin; never route alone.
      "site execution",
      "plant erection",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "civil site engineer",
      "civil supervisor",
      "site supervisor",
      "electrical site engineer",
      "site safety officer",
      "erector",
      "site fabricator",
    ],
  },
} as const satisfies RoleFormDescriptor;
