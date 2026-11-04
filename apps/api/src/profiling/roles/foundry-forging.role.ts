import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * FOUNDRY / FORGING OPERATOR — sand and shell moulding, core making, melting and pouring, die
 * casting (HPDC / GDC) and fettling, and hammer, press and upset forging.
 *
 * DECLARED FOR PHASE 2 #11 (CEO Launch Plan Pack v1, sheet 19) AND FORMLESS, like PLC, EDM and
 * heat treatment: it supplies the vocabulary its `fabrication`-cluster siblings veto on, and its
 * family (`fam_foundry_forging`) is what the chat interview serves through retrieval.
 *
 * THE SHOP, NOT THE SHARED WORD. Bare "moulding" and "moulder" are NOT terms: they are the
 * injection-moulding operator's words first. Bare "hammer", "upset" and "trimming" are not either:
 * a hammer is every trade's tool, "upset" is a feeling and trimming is garments and hair. The
 * routable words name the shop ("foundry", "forging", "die casting operator"); the furnaces and
 * the die-casting machine corroborate a family pin.
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
    occupationTerms: [
      "foundry",
      "foundryman",
      "forging",
      "forging operator",
      "die casting operator",
      "hpdc operator",
      "core maker",
    ],
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
