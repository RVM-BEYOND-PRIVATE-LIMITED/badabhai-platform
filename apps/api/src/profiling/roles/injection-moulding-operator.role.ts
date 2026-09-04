import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * INJECTION MOULDING OPERATOR — machine make, tonnage, materials, robot take-out.
 *
 * DECLARED FOR BATCH 3. Its form is not authored, and the reason it is declared NOW is Batch 2:
 * `press-operator.role.ts` had to veto injection moulding, because the taxonomy's own attribute
 * list would otherwise have folded this trade into the press form. A veto needs the words, and the
 * words live here.
 */
export const INJECTION_MOULDING_OPERATOR = {
  kind: "injection_moulding_operator",
  packId: "qp_injection_moulding",
  familyId: "fam_injection_moulding",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Injection Moulding Operator",
  offerName: "injection moulding operator",
  levelLadder: ["Operator", "Setter", "Setter-cum-Process Technician"],
  tenureQuestionKey: "moulding_experience",
  detection: {
    occupationTerms: [
      "injection moulding",
      "injection molding",
      "moulding operator",
      "molding operator",
      "इंजेक्शन मोल्डिंग",
    ],
    machineTerms: [
      "ferromatik",
      "windsor",
      "haitian",
      "toshiba",
      "robot take out",
      "clamping tonnage",
      "abs",
      "nylon",
    ],
    levelTerms: ["operator", "setter", "process technician", "सेटर"],
  },
} as const satisfies RoleFormDescriptor;
