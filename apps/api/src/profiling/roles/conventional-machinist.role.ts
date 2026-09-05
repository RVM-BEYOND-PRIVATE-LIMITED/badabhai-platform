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
  formEnabled: true,
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
  fresher: {
    // KEYED BY THE PACK'S STORED `value_text`, never by `option_key` — the rule that has already
    // shipped wrong twice on qp_cnc_grinding. Read off `iti_workshop_machines` in
    // qp_conventional_machining@1 and verified against it by `role-corpus-parity.guard.test.ts`.
    workshopMachines: {
      conventional_lathe: "Conventional lathe",
      milling: "Milling machine",
      drilling: "Drilling machine",
      shaper: "Shaper / planer",
      grinding: "Grinding machine",
    },
    // `not_yet` PRINTS NOTHING, on the turner's §8.3 asymmetry ruling: "has not yet taken the
    // trade test" is true, costs the worker the reading, and tells an employer nothing he would
    // not already assume.
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET — the qualifications endpoint stores whatever the worker types.
   *
   * `Trade Test — Machinist` IS THE ITI TRADE NAME FOR THIS ROLE, and it is the entry a copy-paste
   * from the turner's list would have got wrong: an ITI trade test is named for the trade sat, and
   * a manual machine-shop hand sits Machinist, not Turner. No controller courses here — this trade
   * has no controller, which is the whole distinction from the three CNC roles.
   */
  suggestedCertificates: [
    "Trade Test — Machinist",
    "ITI Machinist — NCVT",
    "ITI Machinist — SCVT",
    "Machine Shop Operator — NSQF",
    "Metrology & Inspection",
    "Blueprint Reading & GD&T",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
