import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * WELDER — MIG/MAG, arc/rod, TIG and gas cutting, on structural and sheet fabrication.
 *
 * DECLARED IN BATCH 2, form to follow.
 *
 * ═══ `qp_welding` ALREADY EXISTS AND THIS ROLE DOES NOT TOUCH IT ═══
 *
 * `fam_welding` is the generic ISCO-unit pack and stays bound exactly where it is. This role binds
 * the NCO welding occupations directly, at job-domain specificity 50 against the unit's 40, so a
 * welder gets welding depth and every other worker in the unit keeps the interview they have
 * today. That is why the ids differ (`qp_welding_trade`, `fam_welding_trade`) rather than the new
 * pack overwriting the old: `assertRegistryIsCoherent` would reject a duplicate, and
 * `descriptorForPack` would start answering for the generic pack's workers if it did not.
 *
 * ⚠ THE PACK THAT #776 WAS FOUND IN. Two `qp_welding` questions were never asked for the life of
 * that pack because their predicates used the older `{op, args:[…]}` shape and `predicate.field`
 * was `undefined`. The new pack uses `{op, left:{field}, right:{const}}` and its gate options carry
 * `value_number` and nothing else — and `role-corpus-parity.guard.test.ts` will assert both the
 * moment `formEnabled` flips.
 *
 * ═══ WHAT ROUTES AND WHAT ONLY CORROBORATES ═══
 *
 * The process names are MACHINE terms, not occupation terms, and the distinction is load-bearing
 * here in a way it is not elsewhere: a fitter, a sheet metal worker and a maintenance technician
 * all tack-weld, and every one of them will say "welding" about part of their day. "MIG" alone is
 * a process a man mentions, not a trade he claims. What claims the trade is calling yourself a
 * welder — so "welder"/"वेल्डर" route, and "mig"/"tig"/"arc welding" corroborate a family pin.
 *
 * "welding" IS an occupation term despite that argument, because it is overwhelmingly how the
 * trade is named in a first message ("welding ka kaam karta hoon"), and because its cluster
 * siblings veto the fabricators who would otherwise be caught by it.
 */
export const WELDER = {
  kind: "welder",
  packId: "qp_welding_trade",
  familyId: "fam_welding_trade",
  cluster: "fabrication",
  formEnabled: true,
  displayName: "Welder",
  offerName: "welder",
  levelLadder: ["Helper", "Welder", "Certified Welder"],
  tenureQuestionKey: "welding_experience",
  detection: {
    occupationTerms: ["welder", "welding", "वेल्डर", "वेल्डिंग", "welding ka kaam"],
    machineTerms: [
      "mig",
      "mag",
      "gmaw",
      "tig",
      "gtaw",
      "smaw",
      "arc welding",
      "gas cutting",
      "oxy acetylene",
      "spot welding",
    ],
    levelTerms: ["helper", "welder", "certified welder", "हेल्पर"],
  },
  fresher: {
    // KEYED BY STORED `value_text`. THE LIST IS WELDING SETS, NOT MACHINE TOOLS, which is the
    // first time in this registry that the "ITI workshop" block is not four machining machines:
    // an ITI Welder trainee stands at an arc set, not a lathe. Copying the machining list here
    // would have asked him which milling machine he ran, and he ran none.
    workshopMachines: {
      arc_set: "Arc welding set",
      mig_set: "MIG / CO2 machine",
      tig_set: "TIG welding set",
      gas_set: "Gas welding and cutting set",
      grinder: "Grinding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET, and this trade is the clearest case in the programme for why
   * it must not be closed: the reference sheet carries "Welder Qualification Test — 3G, MS plate
   * (Al Barsha Steel Fabrication LLC, 2023)", issued by an EMPLOYER in another country. A WQT is
   * named for the position, process and material it was sat on, so the real strings are open-ended
   * by construction and no register exists to validate them against.
   *
   * THE POSITION-SPECIFIC ENTRIES ARE THE POINT. "Certified Welder" is this role's top rung and a
   * certificate naming 3G or 6G is worth more to a supervisor than any generic course, because it
   * is the one credential in the trade that states exactly what the man can hold.
   */
  suggestedCertificates: [
    "Welder Qualification Test — 3G, MS plate",
    "Welder Qualification Test — 6G, pipe",
    "ITI Welder — NCVT",
    "MIG / MAG (GMAW) Welding",
    "TIG (GTAW) Welding",
    "Arc Welding — SMAW",
    "Site Safety Induction",
    "Trade Test — Welder",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
