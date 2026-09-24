import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * INDUSTRIAL ELECTRICIAN — MCC/PCC panels, VFD and AC drives, starters, motors, LT distribution.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO once the 2026-09-24 alias tranche made its words
 * reachable — before it, every electrician phrase reached `fam_electrical`'s house wiring, and
 * "panel wiring" / "industrial electrician" reached only the generic minor-741 interview. The
 * tranche put them on 7412.0200 "Electrical Fitter", which is the one code this role binds.
 * `fam_electrical`, `fam_electrical_equipment` and `fam_lineman` stay exactly as they are: a role
 * pack sits beside the family pack, never instead of it (authoring guide §2).
 *
 * ⚠ ═══ THE HOUSE WIRING PROBLEM, WHICH IS THIS ROLE'S VERSION OF THE PAINTER TRAP ═══
 *
 * "Electrician" covers a domestic wireman changing a switchboard and a plant electrician
 * commissioning a VFD, and the platform serves both. The generic `fam_electrical` interview is the
 * right home for the first; this role is the second, and its form asks about drive parameters and
 * earth-pit testing — eighteen questions a house wireman cannot answer and should never see.
 *
 * The word therefore has to earn its route. "electrician" alone is NOT an occupation term here; it
 * is a level rung, so it corroborates a family pin and never routes on its own. What claims this
 * trade is the industrial qualifier or the equipment: "industrial electrician", "panel wiring",
 * "MCC", "VFD". A man who types only "electrician" or "bijli ka kaam" stays in the generic
 * interview, which already disambiguates him — the same reasoning, and the same fail-safe
 * direction, as `painter-coating.role.ts`.
 *
 * THE OWNER HAS SINCE RULED IT FOR RETRIEVAL TOO (worksheet Part 5, ruling A2): the generic
 * electrician vocabulary — "bijli mistri", "electric mistri", "wiring ka kaam", "ilectrician", bare
 * "electrician" — stays on the domestic wireman (7411.0100 / isco 7411, `fam_electrical`), and this
 * family binds no 7411 code. The router and the resolver now refuse the bare word for the same
 * reason, and `question-pack-reachability.test.ts` pins both halves.
 *
 * ═══ THE LICENCE IS EVIDENCE OF THE TRADE, AND IT IS STILL NOT A ROUTE ═══
 *
 * "Wireman licence" appears on the reference page as a certificate. A state wireman licence is
 * held by domestic electricians too, so it corroborates at most.
 *
 * ═══ WHY IT IS IN `maintenance` ═══
 *
 * The reference page's work rows are fault finding, motor rewind coordination and cable
 * termination on a running plant — the maintenance technician's shift, done to the electrical
 * half of the machine. The two overlap on exactly the boundary the cluster exists to police.
 */
export const INDUSTRIAL_ELECTRICIAN = {
  kind: "industrial_electrician",
  packId: "qp_industrial_electrician",
  familyId: "fam_industrial_electrician",
  cluster: "maintenance",
  formEnabled: true,
  displayName: "Industrial Electrician",
  offerName: "industrial electrician",
  levelLadder: ["Helper", "Electrician", "Senior"],
  tenureQuestionKey: "electrical_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_industrial_electrician@1.
    // An ITI Electrician trainee wires a practice board and starts a motor through a starter on a
    // bench; he does not stand at the MCC his employer will run — so this list is the WORKSHOP's
    // equipment, not the capability row's.
    workshopMachines: {
      wiring_board: "Wiring practice board",
      motor_starter: "Induction motor & starter",
      dc_machine: "DC motor / generator",
      transformer: "Transformer",
      winding_machine: "Motor winding machine",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries two credentials — "Wireman /
   * Electrician Licence (Electrical Licensing Board, Uttar Pradesh)" and "VFD & Soft Starter
   * Commissioning (Drive OEM training)" — and the education line "ITI — Electrician · NCVT". Those
   * lead; the rest are what a plant's electrical department actually asks about. The licence is
   * ALSO asked as `electrical_licence` in the pack, because the page prints it twice: once as the
   * capability row "Licence" and once in the certificates line.
   */
  suggestedCertificates: [
    "Wireman / Electrician Licence",
    "VFD & Soft Starter Commissioning",
    "ITI Electrician — NCVT",
    "Trade Test — Electrician",
    "Electrical Supervisor Licence",
    "Electrical Safety Training",
    "Fire & Safety Awareness",
    "First Aid",
  ],
  detection: {
    occupationTerms: [
      "industrial electrician",
      "panel electrician",
      "plant electrician",
      "panel wiring",
      "इंडस्ट्रियल इलेक्ट्रीशियन",
    ],
    machineTerms: [
      "mcc panel",
      "pcc panel",
      "vfd",
      "ac drive",
      "star delta",
      "dol starter",
      "induction motor",
      "megger",
      "cable termination",
      "earth pit",
    ],
    // "electrician" lives HERE, not above — see the header. A rung corroborates; it never routes.
    levelTerms: ["helper", "electrician", "senior", "इलेक्ट्रीशियन", "wireman"],
    /**
     * Domestic and construction electrical work, which `fam_electrical` already serves well. A
     * worker who says "ghar ki wiring" belongs in that interview, not in a panel-shop form.
     */
    extraConflictTerms: ["house wiring", "home wiring", "ghar ki wiring", "domestic wiring"],
  },
} as const satisfies RoleFormDescriptor;
