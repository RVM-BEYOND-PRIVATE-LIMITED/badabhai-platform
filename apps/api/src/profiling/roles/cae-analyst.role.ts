import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CAE / FEA ANALYST — simulation on the design desk: meshing, solving and reading crash, NVH
 * and durability runs back into the CAD that ships.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T59) AND FORMLESS: it supplies the vocabulary its
 * `engineering_desk`-cluster siblings veto on, and its family (`fam_cae_fea`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE SOLVER, NOT THE SPREADSHEET. Data analysis, lab analysis and physical testing are not
 * simulation; design engineering is the 3D CAD Designer's desk and pipe stress the Piping
 * Designer's (both veto from the derivation as well). Staad and Etabs are civil work, Vericut
 * and CNC simulation the CAM Programmer's.
 */
export const CAE_ANALYST = {
  kind: "cae_analyst",
  packId: "qp_cae_fea",
  familyId: "fam_cae_fea",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "CAE / FEA Analyst",
  offerName: "CAE / FEA analyst",
  levelLadder: ["Trainee", "Analyst", "Senior Analyst", "Lead", "Manager / Head"],
  tenureQuestionKey: "cae_experience",
  detection: {
    occupationTerms: [
      "cae engineer",
      "cae analyst",
      "fea engineer",
      "fea analyst",
      "analysis engineer",
      "simulation engineer",
      "meshing engineer",
      "सीएई इंजीनियर",
      "एफईए एनालिस्ट",
    ],
    machineTerms: [
      // Sheet T59 "Words": the solver desk: meshers, solvers and post-processing. Corroborate a pin; never route alone.
      "hypermesh",
      "meshing",
      "ansys",
      "abaqus",
      "nastran",
      "optistruct",
      "ls dyna",
      "ansa",
      "fluent",
      "star ccm",
      "moldflow",
      "mould flow analysis",
      "crash analysis",
      "durability analysis",
      "structural analysis",
      "stress analysis",
      "autoform",
      "casting simulation",
    ],
    levelTerms: ["trainee", "analyst", "senior analyst", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "data analysis",
      "testing",
      "design engineer",
      "caesar",
      "staad",
      "etabs",
      "vericut",
      "cnc simulation",
    ],
  },
} as const satisfies RoleFormDescriptor;
