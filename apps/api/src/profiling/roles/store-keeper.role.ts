import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * STORE KEEPER / STORES EXECUTIVE — the factory store: receipt, issue, bin cards and GRNs, the
 * ledger the line draws on.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T53) AND FORMLESS: the first `supply_chain` role, it
 * supplies the vocabulary its three yard siblings veto on, and its family (`fam_stores`) is
 * what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE FACTORY STORE, NOT THE SHOP. A medical store is not a factory trade, and inventory
 * planning is the PPC desk's — both listed. "forklift" vetoes from the cluster derivation
 * (the yard sibling's own word), and dispatch and purchase the same way.
 */
export const STORE_KEEPER = {
  kind: "store_keeper",
  packId: "qp_stores",
  familyId: "fam_stores",
  cluster: "supply_chain",
  formEnabled: false,
  displayName: "Store Keeper / Stores Executive",
  offerName: "store keeper / stores executive",
  levelLadder: [
    "Store Helper / Assistant",
    "Store Keeper / Executive",
    "Senior Executive",
    "Store In-charge",
  ],
  tenureQuestionKey: "store_experience",
  detection: {
    occupationTerms: [
      "store keeper",
      "storekeeper",
      "stores executive",
      "store executive",
      "store assistant",
      "store helper",
      "store officer",
      "store supervisor",
      "store incharge",
      "godown keeper",
      "godown incharge",
      "inventory executive",
      "स्टोर कीपर",
      "स्टोर इंचार्ज",
      "गोदाम कीपर",
    ],
    machineTerms: [
      // Sheet T53 "Words": the store: bins, cards and GRNs. Corroborate a pin; never route alone.
      "factory store",
      "material store",
      "raw material store",
      "tool store",
      "tool crib",
      "grn entry",
      "stock ka hisaab",
      "bin card",
      "sap mm store",
      "tally stock entry",
      "material issue ka kaam",
      "godown",
    ],
    levelTerms: ["trainee", "executive", "senior executive", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "medical store",
      "inventory planning",
      "data entry operator",
      "packing ka kaam",
    ],
  },
} as const satisfies RoleFormDescriptor;
