import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CAM PROGRAMMER — a DESK role, and the taxonomy keeps it separate for exactly that reason.
 *
 * DECLARED BUT NOT YET ENABLED (Batch 1).
 *
 * IT IS CLUSTERED WITH DESIGN, NOT WITH MACHINING, and that is a routing decision rather than a
 * filing one. Cluster membership means "these roles veto each other", and a CNC turner who also
 * drives Mastercam is a SETTER-CUM-PROGRAMMER — a rung of their own ladder — not an ambiguous
 * case that should be sent back to the interview. Putting this role in the machining cluster
 * would make "mastercam" and "toolpath" veto a turning handover, which is precisely backwards:
 * the taxonomy's own note is that CAM "stays a separate role — it is a desk role, not a machine
 * role", and the software words are evidence FOR this role rather than against its neighbours.
 *
 * WHY IT HAS NO `machineTerms` WORTH THE NAME. Every other role in this cluster is identified by
 * the machine the worker stands at; this one is identified by the SOFTWARE they sit in front of.
 * Mastercam and PowerMill are the equivalent evidence, and they are unambiguous in a way "lathe"
 * never is — nobody says "Mastercam" about a job that is not CAM programming — so they are
 * occupation-tier evidence rather than corroboration.
 *
 * THE INVERSE RISK IS THE REAL ONE, and it is why the cluster veto matters here. A CNC programmer
 * who edits G-code at the machine is NOT a CAM programmer, and the two describe themselves with
 * the same word. "Programmer" is therefore a level rung on three roles in this cluster and an
 * occupation term on none of them, so a bare "programmer" corroborates and never routes.
 */
export const CAM_PROGRAMMER = {
  kind: "cam_programmer",
  packId: "qp_cam_programming",
  familyId: "fam_cam_programming",
  cluster: "design",
  formEnabled: false,
  displayName: "CAM Programmer",
  offerName: "CAM programmer",
  levelLadder: ["Junior", "Programmer", "Senior Programmer"],
  tenureQuestionKey: "cam_experience",
  detection: {
    occupationTerms: [
      "cam programmer",
      "cam programming",
      "mastercam",
      "powermill",
      "solidcam",
      "edgecam",
      "कैम प्रोग्रामर",
    ],
    machineTerms: ["toolpath", "tool path", "post processor"],
    levelTerms: ["junior", "programmer", "senior programmer", "प्रोग्रामर"],
  },
} as const satisfies RoleFormDescriptor;
