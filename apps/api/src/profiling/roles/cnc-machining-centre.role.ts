import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC MACHINING CENTRE OPERATOR — VMC and HMC, which the role taxonomy collapses into one role
 * because the machine type is an attribute and not a second occupation.
 *
 * ENABLED IN BATCH 1, AND IT REALLY WAS ONE BOOLEAN. That was the claim the descriptor registry
 * was built on, so it is worth recording what promoting this role actually cost: the flag below,
 * a suggested-certificate list, and one test pin. Everything else was already derived —
 * `TRADE_FORM_KINDS`, the routing row, the handover copy, the pack→kind mapping and the fresher
 * vocabulary all follow from this file. `qp_vmc_milling@1`, its resume map, its NCO bindings and
 * its Devanagari TTS twins were all shipped before Phase 0 began.
 *
 * WHAT THE DECLARATION ALREADY BOUGHT, before the form existed: CNC Turner's veto. Eight of
 * turning's thirteen shipped conflict terms are this role's own vocabulary, and deriving them
 * required this file to exist while the form did not. The two now veto each other symmetrically,
 * which is what stops a worker who says "vmc aur turning dono" reaching either form.
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
  formEnabled: true,
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
  /**
   * AUTOCOMPLETE FOR THE QUALIFICATIONS PAGE, NOT A CLOSED SET — the endpoint stores whatever the
   * worker types. See {@link RoleFormDescriptor.suggestedCertificates}.
   *
   * THE CONTROLLER AND THE CAM PACKAGE ARE THE TWO THAT EARN THEIR PLACE HERE, and they are what
   * separates this list from the turner's. A machining-centre certificate that names Fanuc or
   * Siemens is worth more to a supervisor than a generic "CNC course", for the same reason the
   * controller is its own capability row on this trade's sheet; and Mastercam / NX / PowerMill are
   * what a setter-cum-programmer trains on to move up this role's own level ladder.
   *
   * `Trade Test — Machinist` RATHER THAN `— Turner`, which is the one entry a copy-paste from the
   * turner list would have got wrong: an ITI trade test is named for the trade sat, and a milling
   * pass-out sits Machinist.
   */
  suggestedCertificates: [
    "CNC Milling & Fanuc Programming",
    "VMC Operator — NSQF",
    "Fanuc Oi-MF Programming",
    "Siemens Sinumerik 828D Programming",
    "Heidenhain TNC Programming",
    "Mastercam Mill — 3-Axis",
    "CNC Setter cum Programmer (Milling)",
    "Metrology & Inspection",
    "Trade Test — Machinist",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
