import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FORKLIFT / REACH TRUCK OPERATOR — yard material handling on forklifts and reach trucks, licensed
 * and load-charted. The Hydra crane is the one chip that moves its reach (#3011).
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T56) AND FORMLESS, like dispatch: it supplies the
 * vocabulary its yard siblings veto on, and its family (`fam_forklift`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE FORKLIFT, NOT THE CRANE. Hydra and crane operation is the Crane Operator / Rigger's trade
 * (same cluster, listed as well as derived); JCBs, loaders and tractors are earthmoving, a lift
 * operator serves buildings, and loading by hand is helper work. Bare "driver" cannot be a
 * veto: it sits inside this role's own "forklift driver".
 */
export const FORKLIFT_OPERATOR = {
  kind: "forklift_operator",
  packId: "qp_forklift",
  familyId: "fam_forklift",
  cluster: "supply_chain",
  formEnabled: false,
  displayName: "Forklift / Reach Truck Operator",
  offerName: "forklift / reach truck operator",
  levelLadder: ["Trainee", "Operator", "Senior", "Supervisor"],
  tenureQuestionKey: "forklift_experience",
  detection: {
    occupationTerms: [
      "forklift operator",
      "forklift driver",
      "reach truck",
      "reach truck operator",
      "stacker operator",
      "bopt operator",
      "order picker",
      "telehandler",
      "forklift ka kaam",
      "forklift wala",
      "फोर्कलिफ्ट ऑपरेटर",
      "फोर्कलिफ्ट ड्राइवर",
      "रीच ट्रक",
    ],
    machineTerms: [
      // Sheet T56 "Words": the yard fleet: forklifts, pallet trucks and stackers. Corroborate a pin; never route alone.
      "forklift",
      "fork lift",
      "pallet truck",
      "battery pallet truck",
      "lifter gaadi",
      "tow truck operator",
      "godrej forklift",
      "voltas forklift",
      "battery forklift",
      "diesel forklift",
    ],
    levelTerms: ["trainee", "operator", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "hydra crane",
      "jcb operator",
      "loader operator",
      "excavator",
      "poclain operator",
      "loading unloading",
      "lift operator",
      "tractor driver",
    ],
  },
} as const satisfies RoleFormDescriptor;
