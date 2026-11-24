import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * ROBOT OPERATOR / PROGRAMMER — robot operation and teaching: spot and MIG cells, touch-ups and
 * mastering, and the PLC program where the cell has one (the T56-style second skill, #3011).
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T39) AND FORMLESS, like the lab trades: it supplies the
 * vocabulary its `maintenance`-cluster siblings veto on, and its family (`fam_robotics`) is what
 * the chat interview serves through retrieval once #3008 binds it.
 *
 * THE CELL, NOT THE GUN. A hand-held MIG welder is the Welder's trade (fabrication cluster),
 * and "PLC programmer" is the PLC technician's own word — but bare "fanuc" cannot be a veto:
 * it sits inside this role's own "fanuc robot". "automation" alone and "CNC programmer"
 * ask which cell before any form.
 */
export const ROBOT_OPERATOR_PROGRAMMER = {
  kind: "robot_operator_programmer",
  packId: "qp_robotics",
  familyId: "fam_robotics",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Robot Operator / Programmer",
  offerName: "robot operator / programmer",
  levelLadder: ["Trainee", "Operator", "Programmer", "Senior", "Supervisor"],
  tenureQuestionKey: "robot_experience",
  detection: {
    occupationTerms: [
      "robot operator",
      "robot programmer",
      "robot teacher",
      "robot welding",
      "robotic welding",
      "spot welding robot",
      "mig robot",
      "welding robot",
      "रोबोट ऑपरेटर",
      "रोबोट प्रोग्रामर",
    ],
    machineTerms: [
      // Sheet T39 "Words": the robot cell: arms, controllers and teach tools. Corroborate a pin; never route alone.
      "robot",
      "teach pendant",
      "fanuc robot",
      "yaskawa robot",
      "motoman",
      "abb robot",
      "kuka robot",
      "kawasaki robot",
      "nachi robot",
      "panasonic robot",
      "robot cell",
      "robot touch up",
      "cobot",
      "palletizer robot",
      "pick and place robot",
      "roboguide",
      "robotstudio",
      "robo operator",
      "robotic operator",
    ],
    levelTerms: ["trainee", "operator", "programmer", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "welder",
      "mig welder",
      "automation",
      "cnc programmer",
      "moulding machine ka robot",
    ],
  },
} as const satisfies RoleFormDescriptor;
