import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC GRINDING OPERATOR — cylindrical, surface and centreless, CNC or conventional.
 *
 * DECLARED BUT NOT YET ENABLED (Batch 1). Its pack is not authored yet; what this file supplies
 * today is the two words — "grinding" and "grinder" — that CNC Turner and CNC Machining Centre
 * have always vetoed on and that are now derived from here rather than copied into each of them.
 *
 * ITS LADDER STOPS AT SETTER-CUM-PROGRAMMER. The taxonomy gives grinding three rungs where
 * turning and milling get four: grinding wheels are dressed and compensated rather than
 * programmed as toolpaths, so there is no "Programmer" rung to claim. Copying the four-rung
 * ladder across would offer a grinder a level that does not exist on their shop floor.
 */
export const CNC_GRINDING = {
  kind: "cnc_grinding",
  packId: "qp_cnc_grinding",
  familyId: "fam_cnc_grinding",
  cluster: "machining",
  formEnabled: false,
  displayName: "CNC Grinding Operator",
  offerName: "CNC grinding operator",
  levelLadder: ["Operator", "Setter", "Setter-cum-Programmer"],
  tenureQuestionKey: "grinding_experience",
  detection: {
    occupationTerms: ["grinding", "grinder", "ग्राइंडिंग", "ghisai"],
    machineTerms: [
      "cylindrical grinder",
      "surface grinder",
      "centreless grinder",
      "centerless grinder",
      "internal grinder",
    ],
    levelTerms: ["setter", "setter cum programmer", "operator", "सेटर"],
  },
  fresher: {
    workshopMachines: {
      surface_grinder: "Surface grinder",
      cylindrical_grinder: "Cylindrical grinder",
      centreless_grinder: "Centreless grinder",
      conventional_lathe: "Conventional lathe",
      milling: "Milling machine",
      drilling: "Drilling machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
