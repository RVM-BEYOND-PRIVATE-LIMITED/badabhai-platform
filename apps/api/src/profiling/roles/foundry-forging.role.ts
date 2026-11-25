import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FOUNDRY / FORGING OPERATOR — the legacy combined label: sand and shell moulding, core making,
 * melting and pouring. New workers go to the precise trades (CEO pack v2, #3004: T24 foundry /
 * casting, T25 die casting, T26 forging); no new worker is given this kind.
 *
 * DECLARED FOR PHASE 2 #11 (CEO Launch Plan Pack v1, sheet 19) AND FORMLESS, like PLC, EDM and
 * heat treatment: it supplies the vocabulary its `fabrication`-cluster siblings veto on, and its
 * family (`fam_foundry_forging`) is what the chat interview serves through retrieval.
 *
 * THE SHOP, NOT THE SHARED WORD. The precise occupation words now live on the three trades that
 * actually do the work — "foundryman" and "core maker" on the foundry, "forging" and "forging
 * operator" on the forge, "die casting operator" on the die-casting cell — so this descriptor
 * keeps only the umbrella word plus the furnaces and the die-casting machine that corroborate a
 * pin. Bare "moulding" and "moulder" are NOT terms: they are the injection-moulding operator's
 * words first. Bare "hammer", "upset" and "trimming" are not either: a hammer is every trade's
 * tool, "upset" is a feeling and trimming is garments and hair. The routable word names the
 * shop ("foundry"); the furnaces corroborate a family pin.
 */
export const FOUNDRY_FORGING = {
  kind: "foundry_forging_operator",
  packId: "qp_foundry_forging",
  familyId: "fam_foundry_forging",
  cluster: "fabrication",
  formEnabled: false,
  displayName: "Foundry / Forging Operator",
  offerName: "foundry or forging operator",
  levelLadder: ["Trainee", "Operator", "Skilled", "Senior", "Supervisor"],
  tenureQuestionKey: "foundry_experience",
  detection: {
    occupationTerms: ["foundry"],
    machineTerms: [
      // Sheet 19 "Words": the melt shop and the die-casting cell. Corroborate a pin; never route.
      "cupola",
      "induction furnace",
      "hpdc",
      "power hammer",
      "toshiba",
    ],
    levelTerms: ["trainee", "operator", "skilled", "senior"],
  },
} as const satisfies RoleFormDescriptor;
