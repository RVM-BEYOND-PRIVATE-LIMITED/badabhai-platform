import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * EOT CRANE OPERATOR / RIGGER — overhead material handling: EOT, gantry and mobile cranes,
 * rigging, slinging and signalling the load.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T57) AND FORMLESS, like the forklift: it completes the
 * `supply_chain` cluster, and its family (`fam_crane_rigging`) is what the chat interview serves
 * through retrieval once #3008 binds it.
 *
 * THE HOOK, NOT THE JCB. Excavators and poclains are earthmoving, a lift operator serves
 * buildings, and crane maintenance is the Maintenance Technician's trade. Bare "operator"
 * cannot be a veto: it sits inside this role's own "crane operator".
 */
export const CRANE_OPERATOR = {
  kind: "crane_operator",
  packId: "qp_crane_rigging",
  familyId: "fam_crane_rigging",
  cluster: "supply_chain",
  formEnabled: false,
  displayName: "EOT Crane Operator / Rigger",
  offerName: "EOT crane operator / rigger",
  levelLadder: ["Trainee", "Operator", "Senior", "Supervisor"],
  tenureQuestionKey: "crane_experience",
  detection: {
    occupationTerms: [
      "crane operator",
      "eot crane operator",
      "eot operator",
      "crane driver",
      "rigger",
      "rigar",
      "slinger",
      "khalasi",
      "signalman",
      "hydra operator",
      "hydra driver",
      "farana operator",
      "mobile crane operator",
      "gantry crane",
      "goliath crane",
      "tower crane operator",
      "hoist operator",
      "pendant crane",
      "ladle crane",
      "क्रेन ऑपरेटर",
      "रिगर",
      "खलासी",
      "हाइड्रा ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T57 "Words": the hook: EOT, gantry and mobile cranes with rigging. Corroborate a pin; never route alone.
      "eot crane",
      "overhead crane",
      "hydra crane",
      "mobile crane",
      "gantry crane",
      "goliath crane",
      "tower crane",
      "hoist",
      "pendant crane",
      "ladle crane",
      "farana",
      "crane",
    ],
    levelTerms: ["trainee", "operator", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "jcb",
      "excavator",
      "poclain operator",
      "lift operator",
      "crane mechanic",
      "crane maintenance",
      "erection fitter",
    ],
  },
} as const satisfies RoleFormDescriptor;
