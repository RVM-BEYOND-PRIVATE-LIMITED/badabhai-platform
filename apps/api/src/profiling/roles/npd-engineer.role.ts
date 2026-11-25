import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * NPD / DEVELOPMENT ENGINEER — new product development: the plant's NPD desk — sampling, APQP
 * and costing a new part into production.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T48) AND FORMLESS, like the process desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_npd_engineer`) is what the
 * chat interview serves through retrieval once #3008 binds it.
 *
 * THE PLANT'S NPD, NOT THE LAB'S. Design engineering is the 3D CAD Designer's desk, vendor
 * development the Purchase desk's (both veto from the derivation); a pharma or lab R&D, a
 * software developer and the tool room are not this trade at all. "installation engineer"
 * is claimed by neither trade it is given to (#3015).
 */
export const NPD_ENGINEER = {
  kind: "npd_engineer",
  packId: "qp_npd_engineer",
  familyId: "fam_npd_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "NPD / Development Engineer",
  offerName: "NPD / development engineer",
  levelLadder: [
    "Trainee (GET / DET)",
    "Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "npd_experience",
  detection: {
    occupationTerms: [
      "npd engineer",
      "development engineer",
      "new product development",
      "product development engineer",
      "part development",
      "development department",
      "r&d engineer",
      "r and d engineer",
      "d&d engineer",
      "sample development",
      "tooling development engineer",
      "apqp engineer",
      "rfq engineer",
      "costing engineer",
      "project engineer npd",
      "customer project engineer",
      "एनपीडी इंजीनियर",
      "डेवलपमेंट इंजीनियर",
    ],
    machineTerms: [
      // Sheet T48 "Words": the NPD desk: sampling, APQP and costing. Corroborate a pin; never route alone.
      "ppap",
      "apqp",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["design engineer", "pharma", "developer", "tool room"],
  },
} as const satisfies RoleFormDescriptor;
