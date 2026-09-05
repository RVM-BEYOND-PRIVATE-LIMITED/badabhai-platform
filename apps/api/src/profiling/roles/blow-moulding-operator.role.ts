import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * BLOW MOULDING / EXTRUSION OPERATOR — extrusion blow, stretch blow (PET), pipe and film lines.
 *
 * DECLARED FOR BATCH 3. Declared now for the same reason as the rest of the polymer cluster: it
 * supplies the "moulding" vocabulary that makes its cluster siblings' vetoes — and Batch 2's press
 * operator veto — complete before any of those forms ship.
 */
export const BLOW_MOULDING_OPERATOR = {
  kind: "blow_moulding_operator",
  packId: "qp_blow_moulding",
  familyId: "fam_blow_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Blow Moulding / Extrusion Operator",
  offerName: "blow moulding operator",
  levelLadder: ["Helper", "Operator", "Setter"],
  tenureQuestionKey: "extrusion_experience",
  detection: {
    occupationTerms: [
      "blow moulding",
      "blow molding",
      "extrusion",
      "pipe extrusion",
      "ब्लो मोल्डिंग",
    ],
    machineTerms: [
      "stretch blow",
      "pet blow",
      "blown film",
      "extruder",
      "parison",
      "sheet extrusion",
    ],
    levelTerms: ["helper", "operator", "setter", "सेटर"],
  },
} as const satisfies RoleFormDescriptor;
