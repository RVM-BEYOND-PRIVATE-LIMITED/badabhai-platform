import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PLASTIC PROCESS / QUALITY TECHNICIAN — RETIRED, FOLDED INTO INJECTION MOULDING (#3030).
 *
 * CEO pack v2 Q4 (ruled 23 Nov 2026): "Plastic Process Technician is not a trade: it is the Senior
 * rung of Injection Moulding (T29), and the phrase leads there."
 *
 * The kind stays in `TRADE_FORM_KINDS_ALL` and this file stays registered so the kind can still
 * be named on stored events — removing either breaks the event spine. But its detection is empty
 * on purpose: "plastic process technician", "process technician" and "प्रोसेस टेक्नीशियन" moved to
 * `injection-moulding-operator.role.ts` as level words for its Senior rung (the sheet shows that
 * rung as "Process Technician"), and this descriptor competes with nobody.
 * `assertRegistryIsCoherent` allows a disabled role with no occupation terms.
 */
export const PLASTIC_PROCESS_TECHNICIAN = {
  kind: "plastic_process_technician",
  packId: "qp_plastic_process",
  familyId: "fam_plastic_process",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Plastic Process / Quality Technician",
  offerName: "plastic process technician",
  levelLadder: ["Technician", "Process Engineer"],
  tenureQuestionKey: "process_experience",
  detection: {
    occupationTerms: [],
    machineTerms: [],
    levelTerms: [],
  },
} as const satisfies RoleFormDescriptor;
