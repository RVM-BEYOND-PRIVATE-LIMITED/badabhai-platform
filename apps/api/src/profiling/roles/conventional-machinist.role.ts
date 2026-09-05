import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CONVENTIONAL MACHINIST — centre lathe, vertical milling, radial drill, boring, by hand.
 *
 * DECLARED IN BATCH 2, form to follow. Until then this file exists for its VOCABULARY: it is what
 * finally gives CNC Turner and CNC Machining Centre a rival to be vetoed by on the manual side of
 * the shop, which no descriptor supplied before.
 *
 * ═══ IT IS IN THE `machining` CLUSTER EVEN THOUGH THE TAXONOMY FILES IT UNDER FABRICATION ═══
 *
 * `ROLE_CLUSTERS` says this outright and this role is the case it was written about: batching and
 * vetoing are different questions. The taxonomy groups this role with metal fabrication because
 * that is where the hiring belt puts it; the router has to care about something else entirely,
 * which is that a conventional machinist and a CNC turner collide on the single most common word
 * either of them says.
 *
 * ═══ "lathe" AND "खराद" ARE DECLARED HERE **ON PURPOSE**, AND THAT IS NOT A COPY-PASTE SLIP ═══
 *
 * `conflictTermsFor` excludes a role's own vocabulary BY VALUE, not by owner. So a word this role
 * shares with CNC Turner is filtered out of its rival set and vetoes neither of them — which is
 * exactly right, because "khraad par kaam karta hoon" is a true sentence for both trades and must
 * not stop either form.
 *
 * Leaving them off would have been the quiet bug: turning would have kept "lathe" as its own term,
 * this role would have inherited it as a CONFLICT, and every conventional machinist who described
 * his own machine would have been vetoed out of his own form. The two roles are then separated by
 * what actually separates them on a shop floor — turning is claimed by "turner"/"turning", this
 * role by "conventional"/"manual", and a man who says only "lathe" is corroboration for whichever
 * family retrieval independently pinned.
 *
 * ═══ NO BARE "machinist" ═══
 *
 * It is the NCO title's word, not the shop floor's, and a CNC setter will call himself one as
 * readily as a manual hand. Routing on it would hand this role's eighteen manual questions to a
 * machining-centre programmer. Unrouted evidence keeps the interview going, which is the safe
 * direction; a wrong form is not.
 */
export const CONVENTIONAL_MACHINIST = {
  kind: "conventional_machinist",
  packId: "qp_conventional_machining",
  familyId: "fam_conventional_machining",
  cluster: "machining",
  formEnabled: false,
  displayName: "Conventional Machinist",
  offerName: "conventional machinist",
  levelLadder: ["Helper", "Operator", "Skilled"],
  tenureQuestionKey: "machining_experience",
  detection: {
    occupationTerms: [
      "conventional machinist",
      "manual machinist",
      "conventional machining",
      "manual machining",
      "मशीनिस्ट",
    ],
    // "lathe" and "खराद" are shared with CNC Turner deliberately — see the header.
    machineTerms: [
      "lathe",
      "centre lathe",
      "center lathe",
      "khraad",
      "kharad",
      "खराद",
      "radial drill",
      "boring machine",
      "shaper",
    ],
    levelTerms: ["helper", "operator", "skilled", "ऑपरेटर"],
  },
} as const satisfies RoleFormDescriptor;
