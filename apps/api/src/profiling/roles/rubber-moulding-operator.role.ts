import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * RUBBER MOULDING OPERATOR — compression, transfer and rubber injection: mixing mills and
 * calenders, hose and oil-seal lines, curing and deflashing.
 *
 * DECLARED FOR BATCH 3 AND RE-SHEETED BY CEO PACK v2 (#3004, sheet T32): the ladder, the words
 * and the tenure gate follow the T32 sheet now (it keeps its pack and family ids, which the
 * registry's coherence check pins). Still formless: it supplies the "rubber moulding"
 * vocabulary its `polymer`-cluster siblings veto on.
 *
 * THE RUBBER PRESS, NOT THE SHEET-METAL ONE. A sheet-metal press is the Press Operator's
 * (fabrication cluster); a tyre fitting is garage work, not a trade; PU foam asks which
 * machine. Bare "mixing" cannot be a veto: it sits inside this role's own "mixing mill".
 */
export const RUBBER_MOULDING_OPERATOR = {
  kind: "rubber_moulding_operator",
  packId: "qp_rubber_moulding",
  familyId: "fam_rubber_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Rubber Moulding Operator",
  offerName: "rubber moulding operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "rubber_experience",
  detection: {
    occupationTerms: [
      "rubber moulding",
      "rubber molding",
      "rubber press operator",
      "rubber mill operator",
      "calender operator",
      "kneader operator",
      "autoclave operator",
      "rubber technician",
      "compression moulding",
      "oil seal ka kaam",
      "o ring moulding",
      "gasket moulding",
      "rubber deflashing",
      "rubber trimming",
      "rubber compound mixing",
      "रबर मोल्डिंग",
      "रबर प्रेस ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T32 "Words": the rubber shop: mills, presses and curing. Corroborate a pin; never route alone.
      "rubber press",
      "compression press",
      "transfer moulding",
      "rubber injection machine",
      "mixing mill",
      "rubber mill",
      "banbury",
      "calender",
      "rubber extruder",
      "hose plant",
      "curing press",
      "vulcanising",
      "vulcanizing press",
      "tyre building",
      "tyre curing",
      "o ring",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor", "सेटर"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "press operator",
      "hydraulic press",
      "tyre fitting",
      "puncture",
      "pu foam",
      "seat foam",
      "plastic moulding",
    ],
  },
} as const satisfies RoleFormDescriptor;
