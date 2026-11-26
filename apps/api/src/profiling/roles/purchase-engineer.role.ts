import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PURCHASE / VENDOR DEVELOPMENT ENGINEER — buying and vendor development: the desk that sources
 * the line's material and rates its vendors.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T54) AND FORMLESS, like the PPC desk: it supplies the
 * vocabulary its desk siblings veto on, and its family (`fam_purchase`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE BUYER, NOT THE STORE. "supply chain" asks which function; vendor quality is the Quality
 * Engineer's word, a store purchase entry the Store's, tally entry the accounts'. Bare
 * "marketing" is the Technical Sales desk's question, answered from the derivation.
 */
export const PURCHASE_ENGINEER = {
  kind: "purchase_engineer",
  packId: "qp_purchase",
  familyId: "fam_purchase",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Purchase / Vendor Development Engineer",
  offerName: "purchase / vendor development engineer",
  levelLadder: [
    "Trainee",
    "Purchase Executive / Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "purchase_experience",
  detection: {
    occupationTerms: [
      "purchase engineer",
      "purchase executive",
      "purchase officer",
      "purchase manager",
      "purchase assistant",
      "purchasing",
      "buyer",
      "vendor development engineer",
      "supplier development",
      "strategic sourcing",
      "sourcing engineer",
      "procurement engineer",
      "procurement executive",
      "rate negotiation",
      "outsourcing engineer",
      "परचेज इंजीनियर",
      "वेंडर डेवलपमेंट",
    ],
    machineTerms: [
      // Sheet T54 "Words": the purchase desk: vendors, rates and POs. Corroborate a pin; never route alone.
      "purchase",
      "sap mm",
      "vendor follow up",
      "material purchase",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "supply chain",
      "vendor quality",
      "store purchase",
      "tally entry",
      "marketing",
    ],
  },
  fresher: {
    workshopMachines: {
      internship: "Internship",
      apprenticeship: "Apprenticeship (NATS / NAPS)",
      college_project: "College major project",
      software_course: "SAP MM / Advanced Excel course",
      industrial_visit: "Industrial visit",
    },
    // The pack asks no trade-test question, so no status ever maps here.
    tradeTest: {},
    trainingLabel: "Training and projects",
  },
} as const satisfies RoleFormDescriptor;
