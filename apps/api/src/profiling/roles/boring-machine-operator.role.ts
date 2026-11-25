import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * BORING MACHINE OPERATOR (HBM) — horizontal boring on HBMs: facing, line boring and jig
 * boring heavy jobs, from centre zero and tool offset to optical alignment.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T19) AND FORMLESS, like gear cutting: it supplies the
 * vocabulary its `machining`-cluster siblings veto on, and its family (`fam_boring_machine`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE MACHINE TOOL, NOT THE BOREWELL. "paani ki boring" is a borewell driller, "cylinder
 * boring" and "engine boring" are garage reboring — none of them stands at an HBM — so they
 * veto here and the worker keeps talking. "HMC" and "VMC" are too short to be terms (#3010
 * holds them); the milling-centre veto derives from the cluster once those words clear.
 */
export const BORING_MACHINE_OPERATOR = {
  kind: "boring_machine_operator",
  packId: "qp_boring_machine",
  familyId: "fam_boring_machine",
  cluster: "machining",
  formEnabled: false,
  displayName: "Boring Machine Operator (HBM)",
  offerName: "boring machine operator (HBM)",
  levelLadder: ["Trainee", "Operator", "Setter", "Setter-cum-Programmer", "Supervisor"],
  tenureQuestionKey: "boring_experience",
  detection: {
    occupationTerms: [
      "hbm operator",
      "boring machine operator",
      "horizontal boring",
      "line boring",
      "jig borer",
      "floor borer",
      "plano miller",
      "boring mill",
      "cnc boring machine",
      "बोरिंग मशीन ऑपरेटर",
      "हॉरिजॉन्टल बोरिंग",
    ],
    machineTerms: [
      // Sheet T19 "Words": the boring shop: HBMs, floor and table types, jig boring. Corroborate a pin; never route alone.
      "hbm machine",
      "horizontal boring machine",
      "floor boring",
      "table type boring",
      "jig boring",
      "horizontal borer",
      "planomiller",
      "plano milling",
      "heavy machining",
      "hmt boring machine",
      "wmw boring",
      "tos boring",
      "skoda boring",
    ],
    levelTerms: ["trainee", "operator", "setter", "setter cum programmer", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["paani ki boring", "borewell", "engine boring", "cylinder boring"],
  },
} as const satisfies RoleFormDescriptor;
