import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * TUBE BENDING / ROLL FORMING OPERATOR — bending pipe and tube, and roll forming sections: mandrel
 * bending, end forming and swaging for exhausts, handle bars and furniture frames.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T23) AND FORMLESS, like the fabricator: it supplies
 * the vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_tube_forming`)
 * is what the chat interview serves through retrieval.
 *
 * THE TUBE, NOT THE BAR OR THE SHEET. Bar bending and sariya bending are construction work, a
 * rolling mill is a steel mill, and pipe fitting and plumbing are the Fitter's — different
 * cluster, so the veto is authored here. Plate rolling is the fabricator's own word and vetoes
 * from the cluster derivation.
 */
export const TUBE_BENDING_OPERATOR = {
  kind: "tube_bending_operator",
  packId: "qp_tube_forming",
  familyId: "fam_tube_forming",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Tube Bending / Roll Forming Operator",
  offerName: "tube bending / roll forming operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "tube_experience",
  detection: {
    occupationTerms: [
      "tube bender",
      "pipe bender",
      "roll forming operator",
      "tube mill operator",
      "pipe mill operator",
      "cnc bender",
      "पाइप बेंडर",
      "ट्यूब बेंडर",
    ],
    machineTerms: [
      // Sheet T23 "Words": the tube shop: benders, mills and roll forming. Corroborate a pin; never route alone.
      "tube bending",
      "pipe bending",
      "tube bending machine",
      "pipe bending machine",
      "cnc tube bending",
      "cnc pipe bending",
      "nc bending machine",
      "mandrel bending",
      "roll forming",
      "roll forming machine",
      "tube mill",
      "pipe mill",
      "end forming",
      "tube end forming",
      "swaging machine",
      "pipe cutting machine",
      "section bending",
      "profile bending",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "bar bending",
      "sariya bending",
      "rolling mill",
      "pipe fitter",
      "plumber",
      "wire bending",
      "spring machine",
    ],
  },
} as const satisfies RoleFormDescriptor;
