import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PRESS / MACHINE OPERATOR — mechanical, hydraulic and pneumatic presses, by tonnage.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO once the 2026-09-24 alias tranche made its words
 * reachable — "power press" reached masonry and "stamping" was NO MATCH before it. There was no
 * generic press pack to sit beside: `fam_press_operation` binds five NCO press occupations out of
 * `fam_machining` (unit 7223) and `fam_sheet_metal` (minor 721), and both of those stay as they
 * are for everybody else. The family row in `_families.jsonl` records each binding and each
 * rejected neighbour.
 *
 * ═══ METAL FORMING ONLY — OWNER RULING R4-a, SIGNED 2026-09-24 ═══
 *
 * The worksheet signed what this descriptor already did: all moulding belongs to Injection
 * Moulding Operator, and `qp_press_operation` asks no moulding question and offers no moulding
 * chip. The section below is the reasoning the ruling adopted.
 *
 * ═══ "press operator" IS THE METAL PRESS — ITEM 21, RETIRED INTO PLACE 2026-09-25 ═══
 *
 * The woollen-cloth press's published title "Press Operator" (8159.0400) is retired
 * (`rvm-alias-retirements.jsonl`), and the phrase now reaches 7211.0101 "Press Shop Operator";
 * the woollen press keeps "woollen press operator". The junk "Machine" alias is retired with it
 * (A4), so "machine operator" and "machine chalana" (item 24, struck) reach no trade at all
 * instead of dairy — the interview keeps asking.
 *
 * ═══ PRINTING PRESSES ARE VETOED ═══
 *
 * "press operator" is also how a printing-press worker names the trade, and every more specific
 * title ("offset", "web", "flexographic" …) sits on ISCO unit 7322, which production shadows — so
 * without help that worker would reach this family AND, because "press operator" is an occupation
 * term, this form. Guard aliases send those phrases to printing codes; they then become those codes'
 * chip labels, which still contain "press operator", so the words that make them printing are
 * vetoed below as well (owner ruling 2026-09-25, the QC guard pattern).
 *
 * ═══ THE TAXONOMY PUTS "injection moulding" ON THIS ROLE'S ATTRIBUTE LIST. WE DO NOT ═══
 *
 * The master sheet's attribute column reads "Power press · injection moulding · general machine
 * operation · tonnage", and copying that here would be the single worst routing decision available
 * in Batch 2: `injection_moulding_operator` is its own role with its own reference page, its own
 * level ladder and its own eighteen questions about machine make, materials and robot take-out.
 * Claiming "injection moulding" as a machine term here would hand every moulding setter a press
 * form and there is no cluster relationship to veto it, because the two sit in `fabrication` and
 * `polymer` respectively.
 *
 * The taxonomy is describing what a generic "machine operator" might be doing; this descriptor has
 * to decide which FORM he gets, and those are different questions. Moulding is therefore declared
 * as an extra CONFLICT rather than as a machine term — the ambiguous man keeps talking.
 *
 * ═══ DIE SETTING IS THE TOOL ROOM'S WORD TOO ═══
 *
 * "Die setting & alignment", "shut-height setting" and "die change" are on this role's reference
 * page AND the tool maker's. They sit in different clusters, so the veto is authored: a man who
 * says "die setting" alone could be either, and neither form is safe to guess at.
 *
 * ═══ NO BARE "press" ═══
 *
 * A press brake is a sheet-metal machine, a hydraulic press is a maintenance-shop fixture, and
 * "press" on its own is also the word for a printing press. Every term below names the machine.
 */
export const PRESS_OPERATOR = {
  kind: "press_operator",
  packId: "qp_press_operation",
  familyId: "fam_press_operation",
  cluster: "fabrication",
  formEnabled: true,
  displayName: "Press / Machine Operator",
  offerName: "press operator",
  levelLadder: ["Helper", "Operator", "Setter"],
  tenureQuestionKey: "press_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_press_operation@1.
    // The ITI route into a press shop runs through another trade (Fitter, Sheet Metal Worker) or a
    // short NSQF press-shop course, and that workshop has a small power press and a fly press — not
    // the 250-ton line his employer will run. So this is the WORKSHOP's list, not the Machines row.
    workshopMachines: {
      power_press: "Power press",
      fly_press: "Fly press / hand press",
      shearing_machine: "Shearing machine",
      drilling_machine: "Drilling machine",
      grinder: "Grinding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries no certificate at all — its only
   * credential is "10th standard" — so these are the credentials a press shop actually asks about:
   * the NSQF Press Shop Operator qualification NCO 7211.0101 cites (ASC/Q3402), the ITI trade most
   * press setters come through, and the safety training the page's own safety row implies.
   */
  suggestedCertificates: [
    "Press Shop Operator — NSQF Level 4",
    "ITI Fitter — NCVT",
    "Power Press Operation",
    "Press Die Setting",
    "Lockout-Tagout (LOTO) Training",
    "Fire & Safety Awareness",
    "First Aid",
  ],
  detection: {
    occupationTerms: [
      "press operator",
      "power press operator",
      "press setter",
      "प्रेस ऑपरेटर",
      "प्रेस",
    ],
    machineTerms: [
      "power press",
      "mechanical press",
      "hydraulic press",
      "pneumatic press",
      "progressive tooling",
      "strip layout",
      "shut height",
    ],
    levelTerms: ["helper", "operator", "setter", "सेटर"],
    /**
     * Three rivals this role cannot derive a veto from.
     *
     * The tool room (`machining`) shares this role's entire setting vocabulary — it BUILDS the die
     * this role changes. The moulding shop (`polymer`) is what the taxonomy's own attribute list
     * would have folded into this role; see the header for why it is a veto instead. The printing
     * press is not a modelled trade at all; see the header. Its words are matched as whole words,
     * so "offset press" rather than bare "offset", which a press setter can say about a die.
     */
    extraConflictTerms: [
      "die setting",
      "die change",
      "tool room",
      "injection moulding",
      "injection molding",
      "moulding machine",
      "printing",
      "प्रिंटिंग",
      "offset press",
      "web press",
      "digital press",
      "flexographic",
      // The woollen-cloth press (8159.0400) keeps "woollen press operator" as its way in, and
      // that phrase is also its chip label — which contains "press operator".
      "woollen",
    ],
  },
} as const satisfies RoleFormDescriptor;
