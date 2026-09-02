import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC GRINDING OPERATOR — cylindrical, surface and centreless, CNC or conventional.
 *
 * ENABLED IN BATCH 1, with qp_cnc_grinding@1 authored against the ratified reference sheet.
 *
 * WHAT THE DECLARATION BOUGHT BEFORE THE PACK EXISTED: the two words — "grinding" and "grinder" —
 * that CNC Turner and CNC Machining Centre have always vetoed on, derived from here rather than
 * copied into each of them.
 *
 * ⚠ REACH IS NOT WHAT BINDING ALONE BUYS, unlike the turning precedent. Turning went from one
 * phrase to six purely by binding, because 7223.0701 already carried six vernacular aliases.
 * The ENTIRE grinding vernacular in the alias corpus is three phrases — "grinding machine",
 * "ghisai", "घिसाई" — all on jd_nco_7223_2200, plus "ग्राइंडिंग" added with this pack. The bare
 * English words below route the FORM (they are detection terms) but reach nothing in retrieval,
 * so a worker who only ever types "grinder" still needs the interview to name the trade.
 * Widening the alias corpus further is ratification work, not typing: "grinder" alone is also
 * what an angle-grinder hand in a fabrication shop says.
 *
 * ITS LADDER STOPS AT SETTER-CUM-PROGRAMMER. The taxonomy gives grinding three rungs where
 * turning and milling get four: grinding wheels are dressed and compensated rather than
 * programmed as toolpaths, so there is no "Programmer" rung to claim. Copying the four-rung
 * ladder across would offer a grinder a level that does not exist on their shop floor.
 */
export const CNC_GRINDING = {
  kind: "cnc_grinding",
  packId: "qp_cnc_grinding",
  familyId: "fam_cnc_grinding",
  cluster: "machining",
  formEnabled: true,
  displayName: "CNC Grinding Operator",
  offerName: "CNC grinding operator",
  levelLadder: ["Operator", "Setter", "Setter-cum-Programmer"],
  tenureQuestionKey: "grinding_experience",
  detection: {
    occupationTerms: ["grinding", "grinder", "ग्राइंडिंग", "ghisai"],
    machineTerms: [
      "cylindrical grinder",
      "surface grinder",
      "centreless grinder",
      "centerless grinder",
      "internal grinder",
    ],
    levelTerms: ["setter", "setter cum programmer", "operator", "सेटर"],
  },
  fresher: {
    workshopMachines: {
      // KEYED BY THE PACK's STORED value_text, not by its option_key. These keys were authored
      // before qp_cnc_grinding existed and matched none of them, which would have rendered an
      // EMPTY workshop row for every grinding fresher — the §11 #1 failure this block exists to
      // prevent, reintroduced by a dictionary nobody could see was wrong.
      grinding: "Grinding machine",
      conventional_lathe: "Conventional lathe",
      milling: "Milling machine",
      drilling: "Drilling machine",
      shaper: "Shaper / planer",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE FOR THE QUALIFICATIONS PAGE, NOT A CLOSED SET — the endpoint stores whatever the
   * worker types. See {@link RoleFormDescriptor.suggestedCertificates}.
   *
   * THE FIRST ENTRY IS THE REFERENCE SHEET's OWN: "Precision Grinding — wheel selection &
   * dressing (MSME Tool Room, Aurangabad, 2021)". MSME tool rooms are where a grinder in the Pune
   * belt actually trains, which is why one is named here and no OEM controller course is.
   */
  suggestedCertificates: [
    "Precision Grinding — wheel selection & dressing",
    "CNC Cylindrical Grinding",
    "Centreless Grinding Setting",
    "Surface Grinding Operator — NSQF",
    "Metrology & Inspection",
    "Trade Test — Grinder",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
