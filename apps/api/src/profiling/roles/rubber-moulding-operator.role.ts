import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * RUBBER MOULDING / COMPRESSION OPERATOR — compression, transfer and rubber injection.
 *
 * DECLARED FOR BATCH 3. `fam_rubber_plastic` stays as the generic unit pack; this role will bind
 * the rubber occupations beside it when its form is authored.
 *
 * ITS "injection" IS QUALIFIED, ALWAYS. Bare "injection" belongs to the plastics moulding shop
 * next door — a cluster sibling, so the veto derives either way, but a term that reads as another
 * role's trade is a term worth writing precisely rather than relying on the veto to clean up.
 */
export const RUBBER_MOULDING_OPERATOR = {
  kind: "rubber_moulding_operator",
  packId: "qp_rubber_moulding",
  familyId: "fam_rubber_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Rubber Moulding / Compression Operator",
  offerName: "rubber moulding operator",
  levelLadder: ["Helper", "Operator", "Setter"],
  tenureQuestionKey: "rubber_experience",
  detection: {
    occupationTerms: [
      "rubber moulding",
      "rubber molding",
      "compression moulding",
      "रबर मोल्डिंग",
    ],
    machineTerms: [
      "transfer moulding",
      "rubber injection",
      "mixing mill",
      "kneader",
      "curing press",
      "vulcanising",
    ],
    levelTerms: ["helper", "operator", "setter", "सेटर"],
  },
} as const satisfies RoleFormDescriptor;
