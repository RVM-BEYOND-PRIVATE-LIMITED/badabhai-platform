import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CAD DESIGNER / DRAUGHTSMAN — the drawing office, and the one role in the registry whose
 * PRIMARY worker is a fresher.
 *
 * ENABLED IN BATCH 1, with `qp_cad_drafting@1` authored against the ratified reference sheet
 * (Pooja Chaudhary, "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD, SolidWorks,
 * Fusion 360"). The taxonomy calls this RVM's core student profile and the highest-volume warm
 * supply we own; "Fresher" is a status chip on that sheet, not an absence, and the sheet carries
 * no work-history section at all.
 *
 * ── WHY THE OCCUPATION TERMS ARE ALL QUALIFIED, AND THE BARE ONES ARE RUNGS ───────────────────
 *
 * This is the first role whose ISCO unit is SHARED with eleven trades we deliberately do not
 * profile. NCO unit 3118 holds fourteen occupations and their catalogue labels are
 * "Draughtsperson, Architectural", "Draughtsperson, Civil", "Draughtsperson, Electrical",
 * "Draught person, Structural", "Draughtsperson, Topographical", "Tracer", "Blue Printer" and so
 * on — every one of which normalises to a string containing the bare token `draughtsperson` or
 * `draftsman`. `occupationTerms` route ON THEIR OWN, without a family pin, so putting a bare
 * "draughtsman" there would hand a CIVIL draughtsman the mechanical form and eighteen questions
 * about sheet-metal flat patterns. The bare spellings therefore sit in `levelTerms` —
 * "Draughtsman" is genuinely the bottom rung of this role's own ladder — where they corroborate a
 * `fam_cad_drafting` pin and can never carry a route by themselves. `fam_draughting`, the
 * unit-3118 router bound at specificity 40, is what those eleven trades pin instead, and
 * `qp_draughting`'s first question asks which line they are in.
 *
 * THE SAME RULE BINDS THE ALIAS CORPUS, AND IT IS UPSTREAM OF THIS FILE. An alias row pins the
 * FAMILY directly, before any router term is consulted, so a bare "draughtsman" row on
 * `jd_nco_3118_0401` re-creates the exact defect this file's `levelTerms` split avoids — and the
 * first draft of the Batch 1 tranche did precisely that: every civil, electrical, architectural,
 * structural and topographical draughtsman was measured landing on `fam_cad_drafting@50`. The
 * generic spellings therefore sit on `jd_nco_3118_0301` inside the router's unit; only the
 * mechanical-qualified forms point here. See the block in `rvm-aliases.jsonl` and the
 * DRAUGHTING_PHRASES table in `question-pack-reachability.test.ts`, which is what fails now.
 *
 * The MECHANICAL-QUALIFIED forms are what route: they are the two catalogue labels this role's
 * family actually binds (`jd_nco_3118_0401` "Draughtsperson, Mechanical" and `jd_nco_3118_0402`
 * "Draughtsman-Mechanical"), plus the word orders a worker or a model would write.
 *
 * REACH DEPENDS ON THE ALIAS TRANCHE, not on this file. Measured live before Batch 1: "cad" and
 * "cad operator" resolved to jd_nco_9621_0300 "Caddie" (GOLF), "cad designer" and "mechanical
 * designer" to jd_nco_7532_0100 "Designer (Garment)", and "autocad" / "solidworks" /
 * "draughtsman" to nothing at all. The rows added to `rvm-aliases.jsonl` are what make the pin
 * possible; `question-pack-reachability.test.ts` resolves through the REAL retrieval index — not
 * through a re-read of the alias file, which could only ever confirm that the author wrote the
 * row — so a regression reads as "this phrase moved from A to B".
 */
export const CAD_DRAUGHTSMAN = {
  kind: "cad_draughtsman",
  packId: "qp_cad_drafting",
  familyId: "fam_cad_drafting",
  /**
   * `design`, WITH CAM. The two genuinely compete — "CAD/CAM" is one ITI course name and a worker
   * who names both a modeller and a CAM package has given ambiguous evidence — so they veto each
   * other symmetrically and that worker keeps talking instead of being handed either form.
   */
  cluster: "design",
  formEnabled: true,
  /** Both halves, exactly as the ratified sheet's headline prints them. */
  displayName: "CAD Designer / Draughtsman",
  offerName: "CAD draughtsman",
  levelLadder: ["Draughtsman", "CAD Designer", "Design Engineer"],
  tenureQuestionKey: "drafting_experience",
  detection: {
    occupationTerms: [
      // The two catalogue labels `fam_cad_drafting` binds, normalised — this is what the pinned
      // occupation label contributes to the haystack on the SAME turn the worker names the trade.
      "draughtsperson mechanical",
      "draughtsman mechanical",
      // The word orders a worker or a model writes instead.
      "mechanical draughtsman",
      "mechanical draftsman",
      "cad designer",
      "cad draughtsman",
      "cad operator",
      // A DESK ROLE IS IDENTIFIED BY ITS SOFTWARE, the same argument the CAM descriptor makes for
      // Mastercam. `fusion` is deliberately ABSENT despite being on the reference sheet: it is one
      // token away from "fusion welding", and a welder must never be handed a drawing-office form.
      "autocad",
      "solidworks",
      "कैड डिजाइनर",
    ],
    /**
     * The drawing office itself, which corroborates a `fam_cad_drafting` pin. These are also what
     * VETO a CAM handover through the cluster derivation, and that is the right direction: a
     * programmer who says "drafting" is claiming a second trade.
     */
    machineTerms: ["drafting", "draughting", "drawing office", "drawing board"],
    /**
     * THE BOTTOM RUNG IS THE AMBIGUOUS WORD — see the header. Every bare spelling of
     * "draughtsman" belongs to twelve other occupations in unit 3118, so it corroborates and
     * never routes. `design engineer` is the top rung and equally shared, with electronics and
     * every other engineering discipline.
     */
    levelTerms: ["draughtsman", "draughtsperson", "draftsman", "design engineer", "ड्राफ्ट्समैन"],
    /**
     * THE OTHER DRAUGHTING LINES, and this is the second kind of extra conflict the field
     * documents: a competing trade we do not model at all. `fam_draughting` catches them in
     * RETRIEVAL, but the router reads model labels and worker text too, and a mechanical
     * draughtsman who volunteers "civil ki drawing bhi banata hoon" is a mixed case that must
     * keep talking. Revit, STAAD and SketchUp are the packages those lines run and this role
     * does not — they are in `qp_draughting`'s software list and absent from `qp_cad_drafting`'s.
     *
     * "electrical" IS DELIBERATELY NOT HERE. It is far too common a word in a manufacturing
     * worker's sentence to spend as a veto, and the electrical draughtsman is already handled
     * where he should be: his catalogue label pins `fam_draughting`, which no term here reaches.
     */
    extraConflictTerms: ["civil", "architectural", "structural", "revit", "staad", "sketchup"],
  },
  /**
   * THE FRESHER BLOCK IS THIS ROLE's PRIMARY PATH, not its fallback — which is the whole reason
   * the pack puts five `is_core` items behind `drafting_experience <= 1` and every capability row
   * at tier 0. A student fills the entire Section B without passing an experience gate, and this
   * block is what fills Zone 4 for him.
   *
   * KEYED BY THE PACK's STORED `value_text`, NEVER BY `option_key` — the bug class that shipped
   * twice on grinding and that `role-corpus-parity.guard.test.ts` now checks for every role.
   * `qp_cad_drafting` REUSES the attribute key `iti_workshop_machines` from the machining packs
   * (because `buildFresherRows` reads that key literally) while diverging on its option VALUES,
   * so none of the sibling roles' slugs appear here: a CAD student's training is a drawing board
   * and a computer lab, not a lathe.
   *
   * `unknown_machine` HAS NO ENTRY, like every none-of-above chip in every dictionary on this
   * sheet: a worker's non-answer must never print as an answer.
   */
  fresher: {
    workshopMachines: {
      drawing_board: "Hand drafting on drawing board",
      cad_lab: "CAD lab — drawing on computer",
      plotter_print: "Plotter printing",
      machine_shop: "Machine shop exposure",
      measuring_practice: "Vernier & micrometer measurement",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
    /**
     * "ITI workshop training" WOULD BE A FALSE CLAIM ON THIS ROLE's OWN SHEET, which is why
     * `RoleFresherVocabulary.trainingLabel` exists at all. The pack's `cad_training_source` chips
     * are ITI, diploma, engineering college, PRIVATE CAD INSTITUTE and self-taught, and a large
     * part of this supply learns at the fourth. Printing an ITI heading over a private-institute
     * student's training block asserts a credential he does not hold, which §8 forbids as plainly
     * as it forbids a fabricated sentence. "CAD training" is true of all five.
     */
    trainingLabel: "CAD training",
    /**
     * `fresher_course` STORES 0, AND ON THIS PACK ALONE THAT MEANS A FRESHER — the rung reads
     * "Course kiya hai, kaam ka tajurba nahi" and `under_one` ("1 saal se kam") is a SEPARATE
     * rung storing 1. The ratified sheet's headline is "CAD Designer / Draughtsman — Draughtsman ·
     * Fresher · AutoCAD, SolidWorks, Fusion 360"; see the note at the top of this file — "Fresher"
     * is a status chip on that sheet, not an absence. See
     * {@link RoleFresherVocabulary.tenureValue} for why no other role may copy this line.
     */
    tenureValue: 0,
  },
  /**
   * AUTOCOMPLETE FOR THE QUALIFICATIONS PAGE, NOT A CLOSED SET — the endpoint stores whatever the
   * worker types. See {@link RoleFormDescriptor.suggestedCertificates}.
   *
   * THE ONLY LIST IN THE REGISTRY WRITTEN FOR A FRESHER FIRST. Every other role's list leads with
   * a capability a working man earned on a shop floor; this one leads with the ITI trade and the
   * software courses a student actually walks out of an institute holding, because the worker
   * this list exists for has no employer to have sent him on a course.
   */
  suggestedCertificates: [
    "ITI Draughtsman (Mechanical)",
    "AutoCAD — 2D Drafting",
    "AutoCAD — 3D Modelling",
    "SolidWorks — Part & Assembly Modelling",
    "SolidWorks Associate (CSWA)",
    "Autodesk Fusion 360",
    "CATIA / Creo Modelling",
    "GD&T / Drawing Reading",
    "Sheet Metal Design",
    "Diploma — Mechanical Engineering",
    "Trade Test — Draughtsman",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
