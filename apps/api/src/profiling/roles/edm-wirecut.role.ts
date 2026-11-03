import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * EDM / WIRE-CUT OPERATOR — wire-cut, sinker (die-sinking) and hole-drill EDM, from wire
 * threading and monitoring to alignment, setting and programming.
 *
 * DECLARED FOR PHASE 2 #7 (CEO Launch Plan Pack v1, sheet 16) AND FORMLESS, like PLC and the
 * 3D designer: it supplies the vocabulary its `machining`-cluster siblings veto on, and its
 * family (`fam_edm_wirecut`) is what the chat interview serves through retrieval.
 *
 * THE OPERATOR, NOT THE TOOL ROOM. A tool maker who also runs a wire-cut keeps the Tool & Die
 * form (`tool-die-maker.role.ts` carries "wire cut edm" / "sinker edm" for exactly that), so bare
 * "wire cut", "sinker" and "electrode" are NOT terms here: as this role's vocabulary they would
 * become a veto on every tool maker who names the machine he uses. The routable words name the
 * JOB ("edm operator", "wire cut operator"); the brands corroborate a family pin.
 */
export const EDM_WIRECUT = {
  kind: "edm_wirecut_operator",
  packId: "qp_edm_wirecut",
  familyId: "fam_edm_wirecut",
  cluster: "machining",
  formEnabled: false,
  displayName: "EDM / Wire-cut Operator",
  offerName: "EDM wire-cut operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Setter-cum-Programmer", "Supervisor"],
  tenureQuestionKey: "edm_experience",
  detection: {
    occupationTerms: [
      "edm operator",
      "wire cut operator",
      "wirecut operator",
      "wire edm operator",
      "spark erosion",
    ],
    machineTerms: [
      // Sheet 16 "Words": the EDM makes. Corroborate a pin; never route alone.
      "electronica",
      "sodick",
      "robocut",
      "charmilles",
      "hole drill edm",
    ],
    levelTerms: ["trainee", "operator", "setter", "setter cum programmer", "सेटर"],
  },
} as const satisfies RoleFormDescriptor;
