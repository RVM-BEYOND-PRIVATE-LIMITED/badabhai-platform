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
    occupationTerms: [
      "turner",
      "turning",
      "cnc turner",
      "टर्नर",
      "टर्निंग",
      // P4 MIDDLE-WAY §8.1 ALIAS STARTER (Turner + VMC only; Grinding/CAM in P6).
      // Occupation-tier: a worker who says one has claimed the trade. "kharad" stays
      // a machine term (shared with conventional machining by value); these longer
      // phrases are unambiguous enough to route alone.
      "cnc kharad",
      "lathe wala",
      "turning karta hoon",
      "kharad wala",
    ],
    /**
     * DEVANAGARI SITS BESIDE THE LATIN because these are the MODEL's words, not the pack's. The
     * persona constrains `reply_text` to Latin-script Hinglish; it says nothing about the draft,
     * and a model handed a Devanagari answer has every reason to echo the worker's script back
     * into `role_label`.
     */
    machineTerms: [
      "lathe",
      "cnc lathe",
      "khraad",
      "kharad",
      "khrad",
      "खराद",
      "लेथ",
      // P4 MIDDLE-WAY §8.1 (slot 2 machine types). Machine-tier: corroborate a family
      // pin, never route alone. Hyphens are written spaced — the router's normaliser
      // turns punctuation into spaces, so "turn-mill" in text is "turn mill" here.
      // "turn mill" is DELIBERATELY NOT HERE: it contains the standalone word "mill",
      // a competing machine term that vetoes this route — and rightly so, because a
      // bare "mill" is a milling machine. It lives in rvm-aliases.jsonl instead, where
      // it pins the turning family for pack depth without touching the handover.
      "live tool",
      "c axis",
      "twin spindle",
      "sliding head",
      "swiss",
      "vtl",
    ],
    levelTerms: [
      "setter",
      "setter cum programmer",
      "programmer",
      "operator",
      "सेटर",
      // P4 MIDDLE-WAY §8.1 (level signals). Level-tier like the rungs above: corroborate
      // a family pin, never route alone, never veto. Full phrases, not stems — "setting"
      // alone would claim too much, "setting karta hoon" is a worker describing his rung.
      "machine chalata hoon",
      "production karta hoon",
      "running karta hoon",
      "setting karta hoon",
      "job lagata hoon",
      "setter hoon",
      "program edit karta hoon",
      "program edit kar leta hoon",
      "program likhta hoon",
      "drawing se program banata hoon",
      "in charge hoon",
      "line sambhalta hoon",
    ],
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
  /**
   * AUTOCOMPLETE FOR THE QUALIFICATIONS PAGE, NOT A CLOSED SET. The endpoint stores whatever the
   * worker types; these are what a turner is most likely to be reaching for.
   *
   * READ OFF THE REFERENCE SHEETS AND THE CONTROLS A TURNER ACTUALLY MEETS. The first is the one
   * both RVM student sheets lead with. The controller entries are here because "Fanuc" and
   * "Siemens" are the words a worker uses for a course they took, and because a certificate
   * naming the control is worth more to a supervisor than a generic "CNC course" — the same
   * argument that makes the controller its own capability row on this trade's sheet.
   */
  suggestedCertificates: [
    "CNC Turning & Fanuc Programming",
    "CNC Turning Operator — NSQF",
    "Fanuc Oi-TF Programming",
    "Siemens Sinumerik 828D Programming",
    "CNC Setter cum Programmer (Turning)",
    "Advanced CNC Turning — Live Tooling",
    "Metrology & Inspection",
    "Trade Test — Turner",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
