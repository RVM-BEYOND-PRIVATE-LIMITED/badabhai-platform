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
  formEnabled: false,
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
} as const satisfies RoleFormDescriptor;
