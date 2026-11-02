import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * 3D CAD DESIGNER — parts, assemblies and surfacing from a requirement, in
 * SolidWorks, Creo, NX, CATIA, Inventor, Fusion 360 or Solid Edge.
 *
 * DECLARED FOR TRACK A #4 (CEO Launch Plan Pack v1, sheet 4 — RULED 2026-11-02)
 * AND FORMLESS, like the polymer batch: it supplies the vocabulary that makes
 * its `design`-cluster siblings' vetoes whole (CAM's "design" rival, the
 * draughtsman's 3D words) before any form ships, and its family
 * (`fam_cad_design_3d`) is what the chat interview serves through retrieval.
 * Enabling a form later is a boolean on one line.
 *
 * NOT A 2D DRAUGHTSMAN WITH A PROMOTION. The 2D pack's reference sheet headlines
 * "CAD Designer / Draughtsman" because that worker DRAUGHTS; this trade's sheet
 * headlines "3D CAD Designer · Senior Designer" because this worker DESIGNS
 * from a requirement — tolerance stack-ups, DFM, shop changes. A worker who
 * only edits another man's model is a trainee here, and the separating
 * questions (senior/lead) are what stop his chips printing as a designer.
 */
export const CAD_DESIGN_3D = {
  kind: "cad_designer_3d",
  packId: "qp_cad_design_3d",
  familyId: "fam_cad_design_3d",
  /**
   * `design`, WITH CAM AND THE DRAUGHTSMAN. The three genuinely compete —
   * "design" is all three trades' own word for themselves — so they veto each
   * other symmetrically and a worker who names two keeps talking instead of
   * being handed the wrong form.
   */
  cluster: "design",
  formEnabled: false,
  displayName: "3D CAD Designer",
  offerName: "3D CAD designer",
  levelLadder: ["Trainee", "Designer", "Senior Designer", "Lead", "Supervisor"],
  tenureQuestionKey: "design_experience",
  detection: {
    occupationTerms: [
      // The trade's own names for itself (sheet 4 Hinglish words). "cad" and
      // "cad operator" stay OFF: the former is a skeleton collision (golf),
      // the latter is the 2D operator's title. "design engineer" stays OFF
      // here too: it is the draughtsman's own top rung, so routing it would
      // veto the drafting form on its own word — it corroborates from the
      // level tier below instead.
      "3d designer",
      "3d cad designer",
    ],
    machineTerms: [
      // The seat is identified by its software — the same argument the CAM
      // descriptor makes for Mastercam. Bare "fusion" is deliberately ABSENT:
      // it is one token away from "fusion welding", and a welder must never
      // be handed a drawing-office form. "fusion 360" is the routable form.
      "solidworks",
      "creo",
      "nx",
      "catia",
      "inventor",
      "fusion 360",
      "solid edge",
      "unigraphics",
      "3d modelling",
      "3d modeling",
    ],
    levelTerms: [
      "trainee",
      "designer",
      "senior designer",
      "lead",
      "design engineer",
      "design head",
    ],
  },
} as const satisfies RoleFormDescriptor;
