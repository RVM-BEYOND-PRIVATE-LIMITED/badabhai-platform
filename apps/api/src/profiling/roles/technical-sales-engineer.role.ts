import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * TECHNICAL SALES / APPLICATION ENGINEER — selling machines, tools and application know-how to
 * factories: the commercial half of the service desk.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T51) AND FORMLESS, like the project desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_technical_sales`) is what the
 * chat interview serves through retrieval once #3008 binds it.
 *
 * THE INDUSTRIAL SALE, NOT THE SHOP FLOOR PITCH. Telecalling, inside sales, showroom and
 * insurance sales are not factory selling, and software coding is not this trade at all. The
 * service engineer vetoes from the cluster derivation.
 */
export const TECHNICAL_SALES_ENGINEER = {
  kind: "technical_sales_engineer",
  packId: "qp_technical_sales",
  familyId: "fam_technical_sales",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Technical Sales / Application Engineer",
  offerName: "technical sales / application engineer",
  levelLadder: ["Trainee", "Sales Engineer", "Senior Engineer", "Lead", "Manager / Head"],
  tenureQuestionKey: "sales_experience",
  detection: {
    occupationTerms: [
      "sales engineer",
      "technical sales",
      "technical sales engineer",
      "application engineer",
      "field sales engineer",
      "industrial sales",
      "industrial marketing",
      "marketing engineer",
      "business development engineer",
      "bde industrial",
      "techno commercial",
      "presales engineer",
      "key account manager",
      "area sales manager industrial",
      "regional sales manager",
      "territory sales engineer",
      "machine tool sales",
      "cutting tool sales",
      "cad cam sales",
      "dealer sales engineer",
      "सेल्स इंजीनियर",
      "टेक्निकल सेल्स",
      "एप्लीकेशन इंजीनियर",
    ],
    machineTerms: [
      // Sheet T51 "Words": the sales bag: machines, tools and territories. Corroborate a pin; never route alone.
      "machine tool",
      "cutting tool",
      "cad cam",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "telecaller",
      "inside sales",
      "showroom sales",
      "insurance sales",
      "bank sales",
      "software coding",
    ],
  },
} as const satisfies RoleFormDescriptor;
