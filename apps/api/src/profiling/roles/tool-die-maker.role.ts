import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * TOOL & DIE MAKER — press tools, progressive dies, jigs and fixtures, built in a tool room.
 *
 * DECLARED IN BATCH 2, form to follow.
 *
 * ═══ `machining`, BECAUSE THE TOOL ROOM IS WHERE ITS MACHINES ARE ═══
 *
 * The reference sheet's machine row is "Surface grinder · Wire-cut EDM · Sinker EDM · Milling" —
 * three of those four are another machining role's daily equipment. A tool maker who says
 * "surface grinder par kaam karta hoon" is genuinely ambiguous against CNC Grinding, and that is
 * the definition of a cluster sibling.
 *
 * ═══ IT INHERITS TURNING'S "edm" VETO AND SUPPLIES THE OTHER HALF ═══
 *
 * `cnc-turner.role.ts` hand-declares `edm` and `wire cut` as extras, on the reasoning that wire-cut
 * is a trade we do not model and its worker must keep talking. That reasoning survives this file
 * unchanged — this role uses an EDM, it is not an EDM operator — so the narrow, qualified machine
 * terms below ("wire cut edm", "sinker edm") sit beside turning's broad ones rather than replacing
 * them. `conflictTermsFor` de-duplicates, so nothing double-counts.
 *
 * ═══ THE CROSS-CLUSTER PAIR THE PLAN NAMED ═══
 *
 * Tool & Die Maker against Mould / Die Maker (Plastics) is the genuine rival that no cluster can
 * express: they share a tool room, an EDM, a surface grinder and half a vocabulary, and they sit
 * in `machining` and `polymer` respectively because their MATERIALS and their employers differ.
 * `extraConflictTerms` is what that field exists for. The veto is declared from both sides —
 * symmetry inside a cluster is derived, but symmetry across one is authored twice or not at all.
 *
 * ═══ NO BARE "die" AND NO BARE "grinder" ═══
 *
 * "Die" is a word a press operator, a mould maker and a forging hand all use, and "grinder" is
 * CNC Grinding's own occupation term — claiming either would either misroute this role or veto
 * that one. The qualified phrases below say what this trade actually builds.
 */
export const TOOL_DIE_MAKER = {
  kind: "tool_die_maker",
  packId: "qp_tool_die_making",
  familyId: "fam_tool_die_making",
  cluster: "machining",
  formEnabled: true,
  displayName: "Tool & Die Maker",
  offerName: "tool and die maker",
  levelLadder: ["Trainee", "Tool Maker", "Senior"],
  tenureQuestionKey: "toolroom_experience",
  detection: {
    occupationTerms: [
      "tool and die maker",
      "tool & die maker",
      "tool maker",
      "toolmaker",
      "die maker",
      "tool room",
      "toolroom",
      "टूल रूम",
      "टूल मेकर",
    ],
    machineTerms: [
      "press tool",
      "progressive die",
      "jigs and fixtures",
      "jig and fixture",
      "wire cut edm",
      "sinker edm",
      "check gauge",
    ],
    levelTerms: ["trainee", "tool maker", "senior", "सीनियर"],
    /**
     * The plastics mould room, which sits in `polymer` and therefore supplies no derived veto.
     * Declared here and mirrored on `mould-die-maker.role.ts`: a cross-cluster conflict is authored
     * from both ends because nothing derives it in either direction.
     */
    extraConflictTerms: ["mould", "mold", "injection mould", "hot runner", "मोल्ड"],
  },
  fresher: {
    // KEYED BY STORED `value_text`. THE FITTING BENCH LEADS, and that is this trade's difference
    // from the three CNC roles: a tool-room apprentice is made on a vice with a file long before
    // he is put on a surface grinder, and the reference page's own capability row is
    // "Benchwork & scraping". A workshop list that opened with machines would ask him to claim
    // equipment he has not been trusted with yet.
    workshopMachines: {
      fitting_bench: "Fitting bench and vice work",
      surface_grinder: "Surface grinder",
      milling: "Milling machine",
      conventional_lathe: "Conventional lathe",
      drilling: "Drilling machine",
      shaper: "Shaper / planer",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The first entry is the reference sheet's own — "Press Tool
   * Design & Tryout (RVM CAD, Faridabad, 2022)". MSME tool rooms and the CIPET/NTTF circuit are
   * where a tool maker in the Ahmedabad and Pune belts actually trains, which is why those and not
   * an OEM controller course.
   */
  suggestedCertificates: [
    "Press Tool Design & Tryout",
    "ITI Tool & Die Maker — NCVT",
    "Jigs & Fixtures Design",
    "Wire-cut EDM Operation",
    "CNC Surface Grinding",
    "Metrology & Inspection",
    "Trade Test — Tool & Die Maker",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
