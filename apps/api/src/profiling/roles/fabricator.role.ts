import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FABRICATOR / STRUCTURAL FITTER — structural fabrication and fitting: marking, fit-up, tacking
 * and gas cutting plate into sheds, tanks, vessels and PEB structures.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T22) AND FORMLESS, like the router: it supplies the
 * vocabulary its `fabrication`-cluster siblings veto on, and its family (`fam_fabrication`) is
 * what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE STRUCTURAL FITTER, NOT EVERY FITTER. Bare "fitter" sits inside this role's own
 * "structural fitter", so it cannot be a veto — it would veto the role itself — and lives in
 * machineTerms instead, corroborated: it hands over only under the family pin (the fitter
 * pattern). The cross-cluster rivals it must NOT reach — pipe fitting, rigging, machine
 * grinding, laser cutting, sheet metal, the press brake, welding work — are listed.
 */
export const FABRICATOR = {
  kind: "fabricator",
  packId: "qp_fabrication",
  familyId: "fam_fabrication",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Fabricator / Structural Fitter",
  offerName: "fabricator / structural fitter",
  levelLadder: ["Trainee", "Fabricator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "fab_experience",
  detection: {
    occupationTerms: [
      "structural fitter",
      "fitter fabricator",
      "plate fitter",
      "peb fitter",
      "pressure vessel fitter",
      "marking fitter",
      "फैब्रिकेटर",
      "स्ट्रक्चर फिटर",
    ],
    machineTerms: [
      // Sheet T22 "Words": the fabrication shop: fit-up, cutting and heavy structures. Corroborate a pin; never route alone.
      "fabricator",
      "fitter",
      "fitting",
      "fabrication",
      "fabrication ka kaam",
      "fit up",
      "tacking",
      "tacking ka kaam",
      "gas cutting",
      "gas cutter",
      "plate cutting",
      "plate rolling",
      "heavy fabrication",
      "structural fabrication",
      "tank fabrication",
      "vessel fabrication",
    ],
    levelTerms: ["trainee", "fabricator", "skilled", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "pipe fitter",
      "rigger",
      "khalasi",
      "grinder",
      "laser cutting",
      "sheet metal",
      "press brake",
      "welding ka kaam",
    ],
  },
} as const satisfies RoleFormDescriptor;
