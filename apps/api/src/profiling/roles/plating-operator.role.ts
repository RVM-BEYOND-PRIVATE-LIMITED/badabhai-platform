import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PLATING / SURFACE TREATMENT OPERATOR — plating and surface treatment: zinc, nickel and hard
 * chrome, anodising, phosphating and CED, from pretreatment to passivation.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T28) AND FORMLESS, like forging: it supplies the
 * vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_surface_treatment`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE PLATING LINE, NOT THE PAINT SHOP. Powder coating, painting and the paint shop are the
 * Painter's trade (same cluster, so the veto derives as well as being listed); buffing is
 * shared with honing across the cluster line, the ETP with utilities, the chemist with the
 * met lab. Each is authored because derivation cannot see it.
 */
export const PLATING_OPERATOR = {
  kind: "plating_operator",
  packId: "qp_surface_treatment",
  familyId: "fam_surface_treatment",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Plating / Surface Treatment Operator",
  offerName: "plating / surface treatment operator",
  levelLadder: ["Trainee", "Operator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "plating_experience",
  detection: {
    occupationTerms: [
      "plating operator",
      "plater",
      "electroplater",
      "plating ka kaam",
      "प्लेटिंग",
      "प्लेटर",
    ],
    machineTerms: [
      // Sheet T28 "Words": the plating line: tanks, rectifiers and finishing. Corroborate a pin; never route alone.
      // Bare "plating" is NOT a term: it vetoes the live painter form's own "zinc plating" /
      // "chrome plating" occupation words at whole-token match, and its skeleton is garments'
      // "pleating" / hair's "plaiting" (see `painter-coating.role.ts`). The named processes carry it.
      "plating plant",
      "electroplating",
      "zinc plating",
      "nickel plating",
      "nickel chrome",
      "nikal polish",
      "hard chrome",
      "anodising",
      "anodizing",
      "phosphating",
      "blackening",
      "galvanising",
      "galvanizing",
      "hot dip galvanizing",
      "ced line",
      "ced coating",
      "electroless nickel",
      "barrel plating",
      "vat plating",
      "passivation",
      "surface treatment",
      "pretreatment",
      "jasta chadhana",
    ],
    levelTerms: ["trainee", "operator", "skilled", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "powder coating",
      "painter",
      "paint shop",
      "buffing",
      "etp operator",
      "chemist",
    ],
  },
} as const satisfies RoleFormDescriptor;
