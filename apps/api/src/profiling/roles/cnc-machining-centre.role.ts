import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC MACHINING CENTRE OPERATOR — VMC and HMC, which the role taxonomy collapses into one role
 * because the machine type is an attribute and not a second occupation.
 *
 * DECLARED BUT NOT YET ENABLED. `qp_vmc_milling@1` and its resume map are already shipped — this
 * is the cheapest of the twenty remaining roles — but Phase 0 changes no behaviour, so the form
 * is switched on in Batch 1 rather than here. What the declaration buys immediately is CNC
 * Turner's veto: eight of turning's thirteen shipped conflict terms are this role's own
 * vocabulary, and deriving them requires this file to exist.
 *
 * ITS FRESHER BLOCK IS NEW, and it closes a live gap rather than adding a feature.
 * `qp_vmc_milling` asks `iti_workshop_machines` and `trade_test_status`, but
 * `resume-fresher-rows.ts` had an entry for turning only — so a VMC pass-out answered both
 * questions and got the empty History heading that §11 #1 forbids and that measured 125 mm of
 * blank page on the turner sheet before it was fixed there.
 */
export const CNC_MACHINING_CENTRE = {
  kind: "vmc_milling",
  packId: "qp_vmc_milling",
  familyId: "fam_vmc_milling",
  cluster: "machining",
  formEnabled: false,
  displayName: "CNC Machining Centre Operator",
  offerName: "CNC machining centre operator",
  levelLadder: ["Operator", "Setter", "Setter-cum-Programmer", "Programmer"],
  tenureQuestionKey: "milling_experience",
  detection: {
    occupationTerms: [
      "milling",
      "miller",
      "machining centre",
      "machining center",
      "vmc operator",
      "hmc operator",
      "मिलिंग",
    ],
    machineTerms: ["vmc", "hmc", "mill", "vertical machining centre", "वीएमसी", "एचएमसी"],
    levelTerms: ["setter", "setter cum programmer", "programmer", "operator", "सेटर"],
    extraConflictTerms: ["edm", "wire cut"],
  },
  fresher: {
    workshopMachines: {
      milling: "Milling machine",
      vmc: "VMC",
      conventional_lathe: "Conventional lathe",
      drilling: "Drilling machine",
      grinding: "Grinding machine",
      shaper: "Shaper / planer",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
} as const satisfies RoleFormDescriptor;
