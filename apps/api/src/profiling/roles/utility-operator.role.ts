import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * UTILITY OPERATOR (BOILER / COMPRESSOR / DG / ETP) — plant utilities: boilers, compressors, DG
 * sets, ETP/STP and water treatment, fired, run and logged round the clock. The licence gate
 * lives here.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T42) AND FORMLESS, like HVAC: it supplies the vocabulary
 * its `maintenance`-cluster siblings veto on, and its family (`fam_utility`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE UTILITY, NOT THE FIRE CREW. A fireman asks boiler fireman or fire safety; the chiller
 * plant, the substation and the generator and pump mechanics are their own trades. Bare
 * "fireman" cannot be a veto: it sits inside this role's own "boiler fireman".
 */
export const UTILITY_OPERATOR = {
  kind: "utility_operator",
  packId: "qp_utility",
  familyId: "fam_utility",
  cluster: "maintenance",
  formEnabled: false,
  displayName: "Utility Operator (Boiler / Compressor / DG / ETP)",
  offerName: "utility operator",
  levelLadder: ["Trainee", "Operator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "utility_experience",
  detection: {
    occupationTerms: [
      "utility operator",
      "boiler operator",
      "boiler attendant",
      "boiler fireman",
      "first class boiler attendant",
      "second class boiler attendant",
      "compressor operator",
      "dg operator",
      "dg set operator",
      "generator operator",
      "etp operator",
      "stp operator",
      "wtp operator",
      "ro plant operator",
      "dm plant operator",
      "pump operator",
      "pump house operator",
      "thermopack operator",
      "thermic fluid heater",
      "cooling tower operator",
      "utility ka kaam",
      "बॉयलर ऑपरेटर",
      "यूटिलिटी ऑपरेटर",
      "डीजी ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T42 "Words": the utility house: boilers, compressors and treatment. Corroborate a pin; never route alone.
      "boiler",
      "compressor",
      "dg set",
      "water treatment plant",
      "pump house",
      "thermopack",
      "thermic fluid heater",
      "cooling tower",
    ],
    levelTerms: ["trainee", "operator", "skilled", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "fire safety officer",
      "substation operator",
      "generator mechanic",
      "pump mechanic",
    ],
  },
} as const satisfies RoleFormDescriptor;
