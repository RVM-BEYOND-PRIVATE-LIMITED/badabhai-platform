import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * BLOW MOULDING OPERATOR — bottles, jerry cans, drums and tanks: extrusion and stretch blow,
 * parison control, preform handling and deflashing.
 *
 * DECLARED FOR BATCH 3 AND RE-SHEETED BY CEO PACK v2 (#3004, sheet T30): the ladder, the words
 * and the tenure gate follow the T30 sheet now (it keeps its pack and family ids, which the
 * registry's coherence check pins). Still formless: it supplies the "blow moulding" vocabulary
 * its `polymer`-cluster siblings veto on.
 *
 * THE BOTTLE, NOT THE FILM OR THE FILLING LINE. Blown film is the Extrusion Operator's line;
 * a filling line fills bottles instead of making them, and an air blower moves air, not
 * parisons — each keeps the worker talking. Bare "moulding" cannot be a veto: it sits inside
 * this role's own "blow moulding".
 */
export const BLOW_MOULDING_OPERATOR = {
  kind: "blow_moulding_operator",
  packId: "qp_blow_moulding",
  familyId: "fam_blow_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Blow Moulding Operator",
  offerName: "blow moulding operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "blow_experience",
  detection: {
    occupationTerms: [
      "blow moulding",
      "blow molding",
      "blow moulding operator",
      "blow moulding setter",
      "blow machine operator",
      "bottle plant operator",
      "blowing operator",
      "blow mold",
      "ब्लो मोल्डिंग",
      "ब्लो मशीन ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T30 "Words": the blow shop: bottles, drums and the parison. Corroborate a pin; never route alone.
      "blow machine",
      "bottle machine",
      "bottle banane ki machine",
      "pet blowing",
      "pet blow machine",
      "pet bottle plant",
      "stretch blow machine",
      "ebm machine",
      "isbm machine",
      "extrusion blow moulding",
      "jerry can machine",
      "drum blow moulding",
      "tank blow moulding",
      "parison",
      "hdpe bottle machine",
      "kautex",
      "sidel",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor", "सेटर"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "bottle filling",
      "filling line",
      "plastic tank",
      "air blower",
      "ac blower",
      "preform machine",
      "roto moulding",
    ],
  },
} as const satisfies RoleFormDescriptor;
