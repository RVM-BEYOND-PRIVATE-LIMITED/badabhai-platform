import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PLASTIC EXTRUSION OPERATOR — extrusion lines: pipe, blown film, sheet, cable and tape, from
 * die and screen-pack changes to haul-off speed and bubble control.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T31) AND FORMLESS, like the polymer batch: it supplies
 * the "extrusion" vocabulary its `polymer`-cluster siblings veto on, and its family
 * (`fam_plastic_extrusion`) is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE PLASTIC LINE, NOT THE METAL ONE. Aluminium extrusion is a metal press, cable work asks
 * extrusion line or electrician, and rubber extrusion is the Rubber Moulding Operator's (same
 * cluster, listed as well as derived). Printing, lamination and pouch machines are not this
 * trade at all.
 */
export const PLASTIC_EXTRUSION_OPERATOR = {
  kind: "plastic_extrusion_operator",
  packId: "qp_plastic_extrusion",
  familyId: "fam_plastic_extrusion",
  cluster: "polymer",
  formEnabled: false,
  displayName: "Plastic Extrusion Operator",
  offerName: "plastic extrusion operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "extrusion_experience",
  detection: {
    occupationTerms: [
      "plastic extrusion operator",
      "extrusion operator",
      "extrusion line operator",
      "एक्सट्रूज़न",
      "एक्सट्रूडर ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T31 "Words": the extrusion line: pipes, film, sheet and cable. Corroborate a pin; never route alone.
      "extrusion",
      "pipe plant",
      "pvc pipe machine",
      "hdpe pipe plant",
      "cpvc pipe line",
      "profile extrusion",
      "blown film",
      "film plant",
      "multilayer film plant",
      "sheet line",
      "sheet extrusion",
      "thermoforming machine",
      "cable extrusion",
      "wire insulation line",
      "tape plant",
      "raffia tape line",
      "monofilament plant",
      "compounding",
      "masterbatch plant",
      "twin screw extruder",
      "recycling pelletizer",
      "dana machine",
      "kabra machine",
      "rajoo machine",
      "plastic dana plant",
      "poly film machine",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "pipe ka kaam",
      "cable ka kaam",
      "aluminium extrusion",
      "rubber extrusion",
      "printing",
      "lamination",
      "pouch machine",
    ],
  },
} as const satisfies RoleFormDescriptor;
