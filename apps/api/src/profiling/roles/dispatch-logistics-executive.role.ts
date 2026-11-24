import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * DISPATCH / LOGISTICS EXECUTIVE — dispatch and logistics: the yard's paperwork and movement —
 * invoices, e-way bills, ASN and the trucks that carry them out.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T55) AND FORMLESS, like the store desk: it supplies
 * the vocabulary its yard siblings veto on, and its family (`fam_dispatch_logistics`) is what
 * the chat interview serves through retrieval.
 *
 * THE DISPATCH, NOT THE DRIVING. A driver names which gaadi before any form; delivery boys and
 * couriers are not factory trades. "billing" cannot be a veto: it sits inside this role's own
 * task list, and a veto on it would veto the role itself. Packing work and loading ask first;
 * dispatch planning is the PPC desk's.
 */
export const DISPATCH_LOGISTICS_EXECUTIVE = {
  kind: "dispatch_logistics_executive",
  packId: "qp_dispatch_logistics",
  familyId: "fam_dispatch_logistics",
  cluster: "supply_chain",
  formEnabled: false,
  displayName: "Dispatch / Logistics Executive",
  offerName: "dispatch / logistics executive",
  levelLadder: [
    "Dispatch Helper / Assistant",
    "Dispatch Executive",
    "Senior Executive",
    "Dispatch / Logistics In-charge",
  ],
  tenureQuestionKey: "dispatch_experience",
  detection: {
    occupationTerms: [
      "dispatch",
      "dispatch executive",
      "dispatch incharge",
      "dispatch supervisor",
      "dispatch assistant",
      "logistics executive",
      "logistic executive",
      "logistics ka kaam",
      "warehouse executive",
      "warehouse incharge",
      "transport executive",
      "export documentation",
      "loading supervisor",
      "डिस्पैच",
      "लॉजिस्टिक्स",
    ],
    machineTerms: [
      // Sheet T55 "Words": the dispatch yard: invoices, gates and trucks. Corroborate a pin; never route alone.
      "finished goods store",
      "fg store",
      "eway bill",
      "invoice banana",
      "gaadi lagana",
      "maal bhejna",
    ],
    levelTerms: ["trainee", "executive", "senior executive", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "driver",
      "gaadi chalata hoon",
      "packing ka kaam",
      "delivery boy",
      "courier",
      "dispatch planning",
      "loading unloading",
    ],
  },
} as const satisfies RoleFormDescriptor;
