import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * DIE CASTING OPERATOR (PDC / GDC) — pressure and gravity die casting: hot and cold chamber
 * machines, die setting, tonnage and trimming, from first shot to dispatch.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T25) AND FORMLESS, like the foundry: it supplies the
 * vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_die_casting`) is
 * what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE DIE SHOP, NOT THE TOOL ROOM. "die fitter" and "die ka kaam" are the Tool & Die Maker's
 * words (machining cluster), and a plastic "moulding machine" is the Injection Moulding
 * Operator's (polymer) — both veto from here. "pdc" and "gdc" alone are too short to be terms
 * (#3010 holds them); the setter and the shop carry the code.
 */
export const DIE_CASTING_OPERATOR = {
  kind: "die_casting_operator",
  packId: "qp_die_casting",
  familyId: "fam_die_casting",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Die Casting Operator (PDC / GDC)",
  offerName: "die casting operator (PDC / GDC)",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "diecast_experience",
  detection: {
    occupationTerms: [
      "die casting operator",
      "die casting setter",
      "pressure die casting",
      "gravity die casting",
      "low pressure die casting",
      "hpdc operator",
      "aluminium die casting",
      "zinc die casting",
      "alloy wheel casting",
      "डाई कास्टिंग",
      "डाई कास्टिंग ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T25 "Words": the die-casting cell: hot and cold chamber machines. Corroborate a pin; never route alone.
      "die casting machine",
      "pdc machine",
      "pdc shop",
      "hot chamber machine",
      "cold chamber machine",
      "toshiba",
      "buhler",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["die fitter", "die ka kaam", "moulding machine"],
  },
} as const satisfies RoleFormDescriptor;
