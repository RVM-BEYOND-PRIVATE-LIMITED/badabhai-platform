import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * MAINTENANCE TECHNICIAN — mechanical, hydraulic, pneumatic and basic electrical, on plant.
 *
 * DECLARED IN BATCH 2, SHIPPED LAST IN PART TWO — it waited on ruling A1, which needed a way to
 * retire an alias: plain "fitter" sat on 7233.0101 "Maintenance Fitter-Mechanical", the code A1
 * gives this role. With the retirement mechanism (#1718) that alias is retired, "fitter" moves to
 * Bench Fitter, and 0101 leaves the Fitter's interim binding for `fam_maintenance_tech`, which also
 * binds the factory maintenance technicians of the technician band (3113 / 3115) and the plant
 * maintenance mechanics of unit 7233. `fam_fitting` and `fam_machinery_repair` stay as the generic
 * packs for everybody else; `_families.jsonl` records each binding and each rejected neighbour.
 *
 * ═══ IT IS DEFINED BY BREADTH, WHICH IS EXACTLY WHY IT NEEDS TWO SIBLINGS ═══
 *
 * The reference page's first row is "Disciplines — Mechanical · Hydraulic · Pneumatic · Basic
 * electrical", and that breadth is the trade rather than a description of one man. It also means
 * this role overlaps its two cluster siblings by construction: the mechanical half is the fitter's
 * page, and the "basic electrical" quarter is the industrial electrician's. Putting all three in
 * `maintenance` makes both vetoes derive, so a man who names two disciplines reaches no form and
 * keeps talking — which is the correct outcome, because the interview can ask which one pays him.
 *
 * ═══ BARE "maintenance" NEEDS THE FAMILY PIN — OWNER RULING 2026-09-25 ═══
 *
 * Declared, bare "maintenance" / "मेंटेनेंस" was an occupation term, which routes on its own.
 * Measured before shipping, that offered this form to AC, building, house, road, computer and
 * vehicle maintenance, and to maintenance electricians, engineers and supervisors — the one-word
 * magnet worksheet Part 5 struck as an ALIAS (item 15). So, as for the fitter's bare words (B3),
 * it is a machine term: it hands over the form only once retrieval has placed the worker in
 * `fam_maintenance_tech`. "machine repair" and "machine ki marammat" (tranche items 12-13, which
 * reach 7233.0101 here) are the same, so a worker pinned there is offered the form. The occupation
 * terms left are names nobody outside the trade uses. "breakdown" and "preventive" were already
 * corroboration only: a fitter attends breakdowns and an electrician does preventive rounds.
 *
 * ═══ "maintenance fitter" HANDS OVER ON THE PIN, NOT ON THE MODEL'S LABEL ═══
 *
 * It contains "fitter", the Fitter's word, and cluster vetoes are derived from every sibling term.
 * So a pin to 7233.0101 hands over this form, but a model label reading "maintenance fitter" is
 * vetoed and the worker keeps talking — the fail-safe direction, pinned in the router test.
 *
 * ═══ NO "cnc machine", DESPITE IT BEING THE FIRST THING ON THE EQUIPMENT ROW ═══
 *
 * "Equipment maintained — CNC machines" is on the reference page and must NOT become a machine
 * term: it would corroborate against `fam_cnc_turning` and `fam_vmc_milling`, whose workers say
 * those words about the machine they OPERATE. The distinction the router cannot see is who is
 * holding the spanner. Left off entirely; the pack asks it as a question instead, where the
 * worker's answer is unambiguous.
 */
export const MAINTENANCE_TECHNICIAN = {
  kind: "maintenance_technician",
  packId: "qp_maintenance_tech",
  familyId: "fam_maintenance_tech",
  cluster: "maintenance",
  formEnabled: true,
  displayName: "Maintenance Technician",
  offerName: "maintenance technician",
  levelLadder: ["Helper", "Technician", "Senior Technician"],
  tenureQuestionKey: "maintenance_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_maintenance_tech@1. The
    // page's worker came through ITI Mechanic Machine Tool Maintenance, whose workshop is a fitting
    // bench, a lathe and a drill — plus the hydraulic and pneumatic trainer kits that trade trains on.
    workshopMachines: {
      fitting_bench: "Fitting bench & vice work",
      lathe: "Lathe machine",
      drilling_machine: "Drilling machine",
      hydraulic_trainer: "Hydraulic trainer kit",
      pneumatic_trainer: "Pneumatic trainer kit",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. Led by the two credentials the ratified page itself prints —
   * the ITI trade and the MSME Technology Centre hydraulics & pneumatics course — then the NSQF
   * qualification NCO 3115.0103 cites (ASC/Q6805; 3115.0102's own NCO text is spliced with an
   * unrelated body-shop QP by the PDF scrape) and the safety training a plant maintenance job asks for.
   */
  suggestedCertificates: [
    "ITI Mechanic Machine Tool Maintenance — NCVT",
    "Hydraulics & Pneumatics — Industrial Maintenance",
    "Maintenance Technician – Mechanical — NSQF Level 3",
    "ITI Fitter — NCVT",
    "Lockout-Tagout (LOTO) Training",
    "Fire & Safety Awareness",
    "First Aid",
  ],
  detection: {
    occupationTerms: ["maintenance technician", "maintenance fitter", "plant maintenance"],
    machineTerms: [
      "maintenance",
      "मेंटेनेंस",
      "machine repair",
      "machine ki marammat",
      "preventive maintenance",
      "breakdown maintenance",
      "condition monitoring",
      "air compressor",
      "vibration pen",
      "lubrication schedule",
      "shutdown overhaul",
    ],
    levelTerms: ["helper", "technician", "senior technician", "टेक्नीशियन"],
  },
} as const satisfies RoleFormDescriptor;
