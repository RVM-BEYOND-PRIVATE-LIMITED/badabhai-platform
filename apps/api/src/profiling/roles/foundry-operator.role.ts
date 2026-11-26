import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FOUNDRY / CASTING OPERATOR — the foundry half of the T24 split: sand moulding and core making,
 * melting, pouring and fettling. The legacy `foundry_forging_operator` stays live and related;
 * new workers come here.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T24) AND FORMLESS, like tube bending: it supplies the
 * vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_foundry_casting`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE SAND SHOP, NOT THE DIE SHOP. Die casting is the Die Casting Operator's trade (same
 * cluster, so the veto derives), and bare "grinding" is the CNC Grinding Operator's word —
 * a fettling grinder says which fettling. Bare "moulding" cannot be a veto: it sits inside
 * this role's own "sand moulding", and a veto on it would veto the role itself.
 */
export const FOUNDRY_OPERATOR = {
  kind: "foundry_operator",
  packId: "qp_foundry_casting",
  familyId: "fam_foundry_casting",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Foundry / Casting Operator",
  offerName: "foundry / casting operator",
  levelLadder: ["Trainee", "Operator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "foundry_experience",
  detection: {
    occupationTerms: [
      "foundry operator",
      "casting operator",
      "moulder",
      "hand moulder",
      "core maker",
      "melter",
      "ladle man",
      "fettler",
      "foundryman",
      "induction furnace operator",
      "फाउंड्री ऑपरेटर",
      "मोल्डर",
      "ढलाई का काम",
    ],
    machineTerms: [
      // Sheet T24 "Words": the foundry floor: moulding, melting and fettling. Corroborate a pin; never route alone.
      "foundry",
      "foundry ka kaam",
      "dhalai",
      "dhalai ka kaam",
      "sand casting",
      "sand moulding",
      "sand moulding machine",
      "core shop",
      "cold box operator",
      "cupola",
      "pouring ka kaam",
      "knock out",
      "shot blasting",
      "disa line",
      "arpa machine",
      "investment casting",
      "lost wax casting",
      "shell moulding",
      "no bake moulding",
      "metal galana",
    ],
    levelTerms: ["trainee", "operator", "skilled", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["die casting", "grinding"],
  },
  fresher: {
    workshopMachines: {
      hand_moulding: "Hand moulding",
      core_making: "Core making",
      melting: "Furnace melting",
      pouring: "Pouring",
      fettling: "Fettling & grinding",
      sand_testing: "Sand testing",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
