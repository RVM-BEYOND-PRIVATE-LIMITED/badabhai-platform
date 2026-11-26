import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FORGING OPERATOR — the forging half of the split: hammer, press and upset forging, from billet
 * heating to trimming. The legacy `foundry_forging_operator` stays live and related.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T26) AND FORMLESS, like die casting: it supplies the
 * vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_forging`) is what
 * the chat interview serves through retrieval once #3008 binds it.
 *
 * THE FORGE SHOP, NOT THE SMITHY. "lohar ka kaam" by hand is not factory forging, and "bhatti
 * ka kaam" needs the asking the sheet asks — melting, billet heating or heat treatment. Bare
 * "hammer" cannot be a veto: it sits inside this role's own "hammer operator". The press
 * shop, the foundry and the tool room veto from the cluster derivation.
 */
export const FORGING_OPERATOR = {
  kind: "forging_operator",
  packId: "qp_forging",
  familyId: "fam_forging",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Forging Operator",
  offerName: "forging operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "forging_experience",
  detection: {
    occupationTerms: [
      "forging operator",
      "forging",
      "forger",
      "hammerman",
      "hammer operator",
      "hammer driver",
      "upsetter operator",
      "header operator",
      "bolt former",
      "nut former",
      "billet heater operator",
      "forging die setter",
      "फोर्जिंग ऑपरेटर",
      "हैमरमैन",
    ],
    machineTerms: [
      // Sheet T26 "Words": the forge shop: hammers, presses and upsetting. Corroborate a pin; never route alone.
      "forging hammer",
      "power hammer",
      "screw press",
      "friction press",
      "upsetter",
      "upset forging",
      "ring rolling",
      "hot forging",
      "cold forging",
      "cold heading",
      "drop hammer",
      "forging press",
      "forging type",
      "forging trimming",
      "thread rolling",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["bhatti ka kaam", "lohar ka kaam"],
  },
  fresher: {
    workshopMachines: {
      hand_forging: "Hand forging",
      power_hammer: "Power hammer",
      heating_furnace: "Furnace heating",
      press: "Press machine",
      heat_treatment: "Hardening & tempering",
      grinding: "Grinding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
