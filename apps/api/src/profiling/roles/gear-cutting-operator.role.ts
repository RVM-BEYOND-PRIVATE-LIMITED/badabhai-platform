import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * GEAR CUTTING OPERATOR — hobbing, shaping, shaving and grinding gear teeth, from blank OD
 * and change-gear calculation to setting the hob, shifting it, and passing the first piece.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T18) AND FORMLESS, like PLC and EDM: it supplies the
 * vocabulary its `machining`-cluster siblings veto on, and its family (`fam_gear_cutting`) is
 * what the chat interview serves through retrieval. Enabling a form later is a boolean on one
 * line.
 *
 * THE CUTTER, NOT THE BOX. "gearbox fitting" and "gearbox assembly" are the Fitter's job — a
 * man who builds gearboxes says them — so they veto here from the maintenance cluster. Bare
 * "grinding" is the CNC Grinding Operator's word (ask if gear grinding); bare "milling" the
 * VMC Operator's. The routable words name the gear-cutting job and its machines.
 */
export const GEAR_CUTTING_OPERATOR = {
  kind: "gear_cutting_operator",
  packId: "qp_gear_cutting",
  familyId: "fam_gear_cutting",
  cluster: "machining",
  formEnabled: false,
  displayName: "Gear Cutting Operator",
  offerName: "gear cutting operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Setter-cum-Programmer", "Supervisor"],
  tenureQuestionKey: "gear_experience",
  detection: {
    occupationTerms: [
      "gear cutting operator",
      "gear cutter",
      "gear hobbing",
      "hobbing operator",
      "gear shaper",
      "gear shaping",
      "gear grinding",
      "gear shaving",
      "cnc hobbing",
      "spline hobbing",
      "गियर कटिंग",
      "गियर हॉबिंग",
    ],
    machineTerms: [
      // Sheet T18 "Words": the gear shop: hobbing, shaping and the machines that cut teeth. Corroborate a pin; never route alone.
      "hobbing machine",
      "hob machine",
      "shaving machine",
      "bevel generator",
      "gleason machine",
      "sprocket cutting",
      "worm wheel cutting",
      "hmt hobbing",
      "liebherr hobbing",
    ],
    levelTerms: ["trainee", "operator", "setter", "setter cum programmer", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["gearbox fitting", "gearbox assembly"],
  },
} as const satisfies RoleFormDescriptor;
