import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC TURNER — the first form-first trade, and the one every derivation is checked against.
 *
 * ITS CONFLICT LIST IS NOW DERIVED, AND MUST NOT MOVE. The shipped router hand-listed thirteen
 * veto terms; ten of them are simply the other machining roles' names for themselves and come
 * back from `conflictTermsFor`. The three that do not are below in `extraConflictTerms`, and
 * `trade-form-router.test.ts` pins every one of the thirteen so a derivation that quietly drops
 * one fails rather than starts routing millers into a turning form.
 */
export const CNC_TURNER = {
  kind: "cnc_turner",
  packId: "qp_cnc_turning",
  familyId: "fam_cnc_turning",
  cluster: "machining",
  formEnabled: true,
  displayName: "CNC Turner",
  offerName: "CNC turner",
  levelLadder: ["Operator", "Setter", "Setter-cum-Programmer", "Programmer"],
  tenureQuestionKey: "turning_experience",
  detection: {
    occupationTerms: ["turner", "turning", "cnc turner", "टर्नर", "टर्निंग"],
    /**
     * DEVANAGARI SITS BESIDE THE LATIN because these are the MODEL's words, not the pack's. The
     * persona constrains `reply_text` to Latin-script Hinglish; it says nothing about the draft,
     * and a model handed a Devanagari answer has every reason to echo the worker's script back
     * into `role_label`.
     */
    machineTerms: ["lathe", "cnc lathe", "khraad", "kharad", "khrad", "खराद", "लेथ"],
    levelTerms: ["setter", "setter cum programmer", "programmer", "operator", "सेटर"],
    /**
     * Wire-cut / EDM and drilling are NOT roles we model, so no cluster sibling supplies them —
     * but a wire-cut operator saying "cnc turning aur wire cut dono" must keep talking rather
     * than be handed eighteen turning questions. The role taxonomy leaves EDM out of scope
     * deliberately; the veto stays regardless, because scope is our decision and not the
     * worker's.
     */
    extraConflictTerms: ["drilling", "edm", "wire cut"],
  },
  fresher: {
    workshopMachines: {
      conventional_lathe: "Conventional lathe",
      cnc_lathe: "CNC lathe / turning centre",
      milling: "Milling machine",
      drilling: "Drilling machine",
      grinding: "Grinding machine",
      shaper: "Shaper / planer",
    },
    /**
     * `not_yet` PRINTS NOTHING — the §8.3 asymmetry rule applied to a credential. "Has not yet
     * taken the trade test" is true, costs the worker the interview, and tells the employer
     * nothing he would not assume. `appeared` does print: a man who sat the test and is waiting
     * has done something.
     */
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
