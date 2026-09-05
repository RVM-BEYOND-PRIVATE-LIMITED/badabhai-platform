import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FITTER — assembly fitting, maintenance fitting, erection and commissioning.
 *
 * DECLARED IN BATCH 2, form to follow. `fam_fitting` stays as the generic unit pack; this role
 * binds the NCO fitting occupations beside it at specificity 50.
 *
 * ═══ THE ITI TRADE NAME IS WHY THIS ROLE NEEDS A TIGHT CLUSTER ═══
 *
 * "Fitter" is one of the highest-volume ITI trades in India, which means an enormous number of
 * workers describe themselves with it regardless of what they now do. The reference page shows the
 * range inside the word alone: gearboxes and pumps (assembly), plant breakdowns (maintenance), and
 * site erection. Two of those three are the maintenance technician's page almost line for line —
 * "Coupling alignment", "Bearing fitting", a dial gauge and a laser alignment kit appear on both.
 *
 * That is precisely the "eighteen wrong questions" test, so the two are cluster siblings and the
 * veto derives in both directions. The plan listed Fitter ↔ Maintenance Technician as a
 * cross-cluster pair needing `extraConflictTerms`; putting them in one `maintenance` cluster is
 * strictly better, because derivation is symmetric by construction and an authored pair is not.
 *
 * ═══ ASSEMBLY IS THE OTHER HALF OF THE WORD, AND IT CROSSES A BOUNDARY ═══
 *
 * "Assembly fitting" is this role's own first chip, and `assembly_line_worker` sits in
 * `production`. Nothing derives between them. A man who says "assembly ka kaam" could be either —
 * a fitter building a gearbox or a line worker torquing a seat — so it is declared as a veto from
 * this side and mirrored from that one.
 */
export const FITTER = {
  kind: "fitter",
  packId: "qp_fitter",
  familyId: "fam_fitter",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Fitter",
  offerName: "fitter",
  levelLadder: ["Helper", "Fitter", "Senior Fitter"],
  tenureQuestionKey: "fitting_experience",
  detection: {
    occupationTerms: ["fitter", "fitting", "फिटर", "फिटिंग", "fitting ka kaam"],
    machineTerms: [
      "gearbox",
      "centrifugal pump",
      "hydraulic power pack",
      "coupling alignment",
      "bearing fitting",
      "filing and scraping",
    ],
    levelTerms: ["helper", "fitter", "senior fitter", "हेल्पर"],
    /** The production line's assembly work, which sits in `production` and derives nothing here. */
    extraConflictTerms: ["assembly line", "final assembly", "sub assembly", "takt"],
  },
} as const satisfies RoleFormDescriptor;
