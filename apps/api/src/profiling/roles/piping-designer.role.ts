import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PIPING DESIGNER / DRAUGHTSMAN — process piping design: layouts, isometrics and spools in PDMS
 * and SP3D, with pipe stress from Caesar.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T60) AND FORMLESS, like the analyst: it completes
 * the `engineering_desk` cluster, and its family (`fam_piping_design`) is what the chat interview
 * serves through retrieval once #3008 binds it.
 *
 * THE PROCESS PIPING DESK, NOT THE BUILDING'S. Pipe fitting and plumbing are hand trades, the
 * piping supervisor stands on site, and HVAC/MEP drafting is building services — each listed.
 * The plastic pipe plant is the Extrusion Operator's line (plastics cluster), and a piping
 * welder welds for the Welder's trade.
 */
export const PIPING_DESIGNER = {
  kind: "piping_designer",
  packId: "qp_piping_design",
  familyId: "fam_piping_design",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Piping Designer / Draughtsman",
  offerName: "piping designer / draughtsman",
  levelLadder: ["Trainee", "Designer", "Senior Designer", "Lead", "Head"],
  tenureQuestionKey: "piping_experience",
  detection: {
    occupationTerms: [
      "piping designer",
      "piping draughtsman",
      "piping draftsman",
      "piping engineer",
      "piping design",
      "pdms designer",
      "pdms modeller",
      "cadworx",
      "isometric drawing",
      "spool drawing",
      "piping layout",
      "piping detailing",
      "pipe support design",
      "piping mto",
      "navisworks",
      "caesar ii",
      "पाइपिंग डिज़ाइनर",
      "पाइपिंग ड्राफ्ट्समैन",
    ],
    machineTerms: [
      // Sheet T60 "Words": the piping desk: PDMS, isos and spools. Corroborate a pin; never route alone.
      "pdms",
      "cadworx",
      "navisworks",
      "caesar",
      "isometric",
      "spool",
    ],
    levelTerms: ["trainee", "designer", "senior designer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "pipe fitter",
      "piping fitter",
      "piping supervisor",
      "electrical site engineer",
      "plumber",
      "pipe plant",
      "pvc pipe machine",
      "piping welder",
      "hvac draughtsman",
      "mep draughtsman",
    ],
  },
} as const satisfies RoleFormDescriptor;
