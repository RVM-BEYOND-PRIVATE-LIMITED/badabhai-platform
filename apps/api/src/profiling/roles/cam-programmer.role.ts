import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CAM PROGRAMMER — a DESK role, and the taxonomy keeps it separate for exactly that reason.
 *
 * ENABLED IN BATCH 1, with `qp_cam_programming@1` authored against the ratified reference sheet
 * (Nitin Deshmukh, "CAM Programmer — Programmer · 7 yrs · Mastercam, PowerMill, SolidCAM").
 *
 * ── THE OWNER RULING THAT SHAPES EVERYTHING BELOW ────────────────────────────────────────────
 *
 * `fam_cam_programming` is scoped as PART PROGRAMMING IN GENERAL, not desk-CAM-only. NCO 7223.6003
 * defines a CNC Programmer as producing the component program "using manual data input or by use
 * of a remote computer" — one trade with two work surfaces: the man at a CAM seat and the man
 * typing the program into the controller. So `cnc programmer` is an occupation term here, and the
 * pack's FIRST question (`programming_mode`) splits CAM-software from at-machine MDI before any
 * capability question is asked, exactly as `qp_machining`'s `machine_type` splits the machine.
 *
 * IT IS CLUSTERED WITH DESIGN, NOT WITH MACHINING, and that is a routing decision rather than a
 * filing one. Cluster membership means "these roles veto each other", and a CNC turner who also
 * drives Mastercam is a SETTER-CUM-PROGRAMMER — a rung of their own ladder — not an ambiguous
 * case that should be sent back to the interview. Putting this role in the machining cluster
 * would make "mastercam" and "toolpath" veto a turning handover, which is precisely backwards:
 * the taxonomy's own note is that CAM "stays a separate role — it is a desk role, not a machine
 * role", and the software words are evidence FOR this role rather than against its neighbours.
 *
 * WHAT THE CLUSTER NOW BUYS, which it did not while this role was alone in it: CAD Draughtsman
 * lands in `design` too, so the two veto each other symmetrically. That pair genuinely competes —
 * "CAD/CAM" is one ITI course name — and a worker who names both a modeller and a CAM package has
 * given ambiguous evidence, which must reach NO form rather than the alphabetically luckier one.
 *
 * WHY IT HAS NO `machineTerms` WORTH THE NAME. Every other role in this cluster is identified by
 * the machine the worker stands at; this one is identified by the SOFTWARE they sit in front of.
 * Mastercam and PowerMill are the equivalent evidence, and they are unambiguous in a way "lathe"
 * never is — nobody says "Mastercam" about a job that is not CAM programming — so they are
 * occupation-tier evidence rather than corroboration.
 *
 * THE INVERSE RISK IS THE REAL ONE, and it is why the level terms matter here. A CNC programmer
 * who edits G-code at the machine is NOT necessarily a CAM programmer, and the two describe
 * themselves with the same word. "Programmer" is therefore a level rung on three roles in this
 * cluster and an occupation term on none of them, so a bare "programmer" corroborates a family
 * pin and never routes on its own.
 */
export const CAM_PROGRAMMER = {
  kind: "cam_programmer",
  packId: "qp_cam_programming",
  familyId: "fam_cam_programming",
  cluster: "design",
  formEnabled: true,
  displayName: "CAM Programmer",
  offerName: "CAM programmer",
  /**
   * THREE RUNGS, AND THE BOTTOM ONE IS NAMED IN FULL. The taxonomy's ladder is
   * "Junior Programmer → Programmer → Senior Programmer"; a bare "Junior" would print
   * "CAM Programmer — Junior" in the sheet headline, which reads as a seniority band rather than
   * as the job title the reference sheet carries.
   */
  levelLadder: ["Junior Programmer", "Programmer", "Senior Programmer"],
  /**
   * THE PACK'S OWN GATE, not a name invented beside it. This was `cam_experience` while the role
   * was declared-but-not-enabled and the pack did not exist; `qp_cam_programming` asks
   * `programming_experience`, because the ruling above scopes the trade wider than desk CAM.
   * A `tenureQuestionKey` that names no pack item leaves the gate un-hoisted and the headline's
   * years figure with no fallback (#1377) — silently, which is why `role-corpus-parity.guard`
   * checks it against the corpus.
   */
  tenureQuestionKey: "programming_experience",
  detection: {
    occupationTerms: [
      "cam programmer",
      "cam programming",
      // THE NCO TITLE ON 7223.6003, and therefore the label retrieval pins for this trade. Without
      // it the handover waits for the model to write "CAM" into a draft field, which costs the
      // worker a turn they have already answered.
      "cnc programmer",
      "part programming",
      "mastercam",
      "powermill",
      "solidcam",
      "edgecam",
      "कैम प्रोग्रामर",
      "सीएनसी प्रोग्रामर",
    ],
    machineTerms: ["toolpath", "tool path", "post processor"],
    levelTerms: ["junior programmer", "programmer", "senior programmer", "प्रोग्रामर"],
  },
  /**
   * THE FRESHER BLOCK IS NOT OPTIONAL FOR THIS PACK, and leaving it out is the §11 #1 failure
   * that already shipped twice. `qp_cam_programming` asks `iti_workshop_machines`,
   * `trade_test_status` and `iti_project_work` on its `lte 0` branch; `resume-fresher-rows.ts`
   * reads the vocabulary off THIS field, so a role without one renders an empty History heading
   * for a worker who answered all three — 125 mm of blank page, measured on the turner sheet.
   *
   * KEYED BY THE PACK's STORED `value_text`, NEVER BY `option_key`. The two are equal in this
   * pack's fresher item by construction (it is the sibling packs' item verbatim), which is
   * exactly what makes the mistake invisible when a later pack diverges — so the rule is stated
   * rather than inferred, and `role-corpus-parity.guard.test.ts` now checks it against the corpus.
   */
  fresher: {
    workshopMachines: {
      vmc: "VMC / machining centre",
      conventional_lathe: "Conventional lathe",
      milling: "Milling machine",
      drilling: "Drilling machine",
      grinding: "Grinding machine",
    },
    /**
     * `not_yet` PRINTS NOTHING — the §8.3 asymmetry rule applied to a credential, as on every
     * other role. `appeared` does print: a man who sat the test and is waiting has done something.
     */
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE FOR THE QUALIFICATIONS PAGE, NOT A CLOSED SET — the endpoint stores whatever the
   * worker types. See {@link RoleFormDescriptor.suggestedCertificates}.
   *
   * THE SOFTWARE COURSE IS THE CERTIFICATE THAT MOVES THIS TRADE's PAY, which is what separates
   * this list from the machining roles'. A turner's list leads with a controller course because a
   * controller sits on his machine; a programmer's leads with the CAM package, because that is the
   * seat he is hired for. `RoleFormDescriptor.suggestedCertificates` names
   * "Mastercam Advanced Multiaxis" as a reference-sheet credential, so it is first here.
   *
   * THE POST-PROCESSOR AND SIMULATION ENTRIES ARE THIS ROLE's SENIOR HALF — the tier-2 questions
   * the pack gates at five years — and no other role in the registry can carry them.
   */
  suggestedCertificates: [
    "Mastercam Advanced Multiaxis",
    "Mastercam Mill — 3-Axis",
    "PowerMill Multi-Axis Programming",
    "SolidCAM Certified Programmer",
    "Fanuc Programming — G & M Codes",
    "Heidenhain TNC Programming",
    "Post-Processor Development",
    "Vericut Simulation & Verification",
    "GD&T / Drawing Reading",
    "Trade Test — Machinist",
    "Fire & Safety Awareness",
    "First Aid",
  ],
} as const satisfies RoleFormDescriptor;
