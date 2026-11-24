/**
 * Middle-Way trade level (P1, additive; moved to taxonomy in P5 so the C6 crosswalk,
 * the persist writer and the headline share one union with the column).
 *
 * Per worker per trade, stored on the `worker_profile_skill` row whose skillId is the
 * trade's `mskill_*`. NULL = not stated, never guessed. Closed per-trade ladders live
 * in `docs/middle-way/LADDERS.md`; validation is app-level so new ladders never need
 * a migration. Old `level` column is untouched.
 */
export type TradeLevel =
  | "helper"
  | "trainee"
  | "operator"
  | "draughtsman"
  | "trainee_modeller"
  | "cad_designer"
  | "setter"
  | "setter_programmer"
  | "programmer"
  | "junior_programmer"
  | "senior_programmer"
  | "senior_draughtsman"
  | "senior_designer"
  | "lead_checker"
  | "design_engineer_lead"
  | "supervisor"
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — the shared rung vocabulary.
  // `helper`, `junior_programmer` and the CAD keys above stay for history (stored rows
  // keep rendering); new packs use these. "Do not invent new keys" — these are the
  // CEO's, not ours.
  | "skilled"
  | "senior"
  | "technician"
  | "senior_technician"
  | "inspector"
  | "senior_inspector"
  | "qc_engineer"
  | "designer"
  | "lead"
  // Track B #1 (CEO Launch Plan Pack v1, sheet 6) — the fitter rungs. `fitter`
  // is Lower (operator rung), `senior_fitter` Higher; both stored by
  // qp_fitter@1 already, rendered null until this extension.
  | "fitter"
  | "senior_fitter"
  // Track B #2 (CEO Launch Plan Pack v1, sheet 7) — the electrician operator
  // rung. Lower; stored by qp_industrial_electrician@1 already, rendered null
  // until this extension.
  | "electrician"
  // Track B #3 (CEO Launch Plan Pack v1, sheet 8) — the welder operator rung.
  // Lower; stored by qp_welding_trade@1 already, rendered null until now.
  | "welder"
  // CEO pack v2 (RULED 2026-11-23, #3000) — the desk and supply-chain rungs. The
  // engineer and senior-engineer rows carry the desk ladders; the executive rows
  // carry Stores and Dispatch. Appended, never renamed: stored answers keep rendering.
  | "engineer"
  | "senior_engineer"
  | "executive"
  | "senior_executive";

/**
 * C6 CROSSWALK — pack level answers → trade skill + `trade_level` (Middle Way P5).
 *
 * WHAT THIS IS. The sample names its rungs per trade ("Setter", "Programmer"); the
 * code stores one `TradeLevel` key per worker per trade on the `worker_profile_skill`
 * row whose skill is the trade's `mskill_*`. This file is the whole of that mapping:
 * which pack answers carry a level, which trade skill each pack's level attaches to,
 * how a stored answer normalises to a `TradeLevel`, which rungs count as confirmed,
 * and which price tier a rung prices at.
 *
 * WHAT THIS IS NOT. It is never read by the match engine's derive path —
 * `PACK_ANSWER_SKILLS` is the only table the derive path reads, and nothing here is
 * imported by it. Writing a level row changes zero reach rows and zero rank positions
 * (P5 DoD §7.7/8). Engine v1.1 (ADR-0061) freezes the stated rung onto each NEW
 * application at apply time, and only that frozen copy sorts a "Level needed" list — so
 * a later write here still moves nobody already on a list.
 *
 * KEY CANONICALISATION. Packs author `option_key: setter_cum_programmer` but store
 * `value_text: setter_programmer` (qp_cnc_turning@3); either spelling — and the
 * label the worker tapped — must land on the one `TradeLevel`. Unknown strings
 * return null rather than guessing: NULL is "not stated", never a wrong rung.
 */

/** A pack whose level answer carries a trade rung, and the trade it attaches to. */
export interface TradeLevelPack {
  /** The trade skill the level row is written against. */
  readonly skillId: string;
  /** The `worker_attributes` key holding the level answer (the pack's `target_field`). */
  readonly levelKey: string;
  /**
   * Per-trade display labels, when the trade's own words differ from the shared
   * crosswalk (CEO Launch Plan Pack v1, Track A #5): the 2D sheet headlines
   * "Senior Draughtsman", never "Senior Designer". Absent = shared labels.
   */
  readonly labels?: Readonly<Partial<Record<TradeLevel, string>>>;
  /**
   * Rungs the shared rung rule confirms but THIS sheet places below its confirmed rung
   * (CEO Launch Plan Pack v1, Phase 2 #10): Production Supervisor is "confirmed from
   * supervisor", so its Line Leader (`senior`) is not confirmed there, although `senior`
   * confirms in every trade that rules it a separating rung. A separating-confirm answer
   * still wins; with none, these rungs read unconfirmed. Absent = the shared rule.
   */
  readonly unconfirmedRungs?: readonly TradeLevel[];
  /**
   * Per-trade price tiers where THIS sheet prices a rung differently from the shared rule
   * (CEO Launch Plan Pack v1 §2: "Lower / Higher per rung, per sheet"; A4 item 8). The
   * shared `levelTier` is right for 22 of the 23 sheets; PLC (sheet 14) rules
   * "technician+ Higher" while the electrician and maintenance sheets keep `technician`
   * Lower. HOOK ONLY: both tiers still charge one credit. Absent = the shared rule.
   */
  readonly tierOverrides?: Readonly<Partial<Record<TradeLevel, PriceTier>>>;
}

/** The unlock price tier a rung prices at (spec §4.1 — hook only; ₹40 flat stays live). */
export type PriceTier = "higher" | "lower";

export const TRADE_LEVEL_PACKS: Readonly<Record<string, TradeLevelPack>> = {
  qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
  qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
  // Phase 2 #2 — the CNC grinder (CEO Launch Plan Pack v1, sheet 15). No union
  // extension: every sheet-15 rung is already a member. Supervisor by rule.
  qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
  qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
  // Track A #4 — the 3D CAD Designer (CEO Launch Plan Pack v1, sheet 4; labels and
  // designer tier from CEO pack v2 sheet T58, #3000). #3008 publishes the v2 form.
  qp_cad_design_3d: {
    skillId: "mskill_cad_designer_3d",
    levelKey: "design_level",
    labels: { lead: "Lead / Design Engineer", supervisor: "Design Head" },
    tierOverrides: { designer: "higher" },
  },
  // Track A #5 — the 2D Draughtsman (CEO Launch Plan Pack v1, sheet 5). Labels
  // are the trade's own words (sheet headline "Senior Draughtsman").
  qp_cad_drafting: {
    skillId: "mskill_designer",
    levelKey: "cad_level",
    labels: {
      trainee: "Trainee",
      designer: "Draughtsman",
      senior_designer: "Senior Draughtsman",
      lead: "Lead",
      supervisor: "Head",
    },
  },
  // Track B #1 — the fitter (CEO Launch Plan Pack v1, sheet 6). Shared labels
  // already print the trade's words (Fitter / Skilled / Senior Fitter).
  qp_fitter: { skillId: "mskill_fitter", levelKey: "fitter_level" },
  // Track B #2 — the electrician (CEO Launch Plan Pack v1, sheet 7). The
  // stored `senior` key IS the sheet's senior_technician rung (Higher,
  // confirmed); shared labels print it. Supervisor by rule (no confirm item).
  qp_industrial_electrician: {
    skillId: "mskill_industrial_electrician",
    levelKey: "electrician_level",
  },
  // Track B #3 — the welder (CEO Launch Plan Pack v1, sheet 8). Shared labels
  // already print the trade's words (Welder / Skilled / Senior / Supervisor).
  qp_welding_trade: { skillId: "mskill_welder", levelKey: "welder_level" },
  // Track B #4 — the conventional machinist (CEO Launch Plan Pack v1,
  // sheet 9). No union extension: `skilled`/`senior` already confirm,
  // helper/operator already Lower. Supervisor by rule (no confirm item).
  qp_conventional_machining: {
    skillId: "mskill_conventional_machinist",
    levelKey: "machining_level",
  },
  // Track B #5 — the sheet-metal operator (CEO Launch Plan Pack v1,
  // sheet 10). No union extension either. Supervisor by rule.
  // #2753 item 1 (@3) — the @2 "Senior / Programmer" chip is split: `senior`
  // and `programmer` are separate rungs (helper < operator < skilled < senior
  // < programmer < supervisor). Still no union extension: `programmer` is a
  // member (confirmed, Higher), and the shared labels print "Senior" and
  // "Programmer". Stored @2 `senior` answers keep printing "Senior".
  qp_sheet_metal_fab: { skillId: "mskill_sheet_metal_worker", levelKey: "sheet_metal_level" },
  // Track B #6 — the assembly technician (CEO Launch Plan Pack v1,
  // sheet 11). Display name "Assembly Technician"; key unchanged. No union
  // extension: `skilled`/`senior` already confirm, helper/operator already
  // Lower. Supervisor by rule.
  qp_assembly_line: { skillId: "mskill_assembly_line_worker", levelKey: "assembly_level" },
  // Track B #7 — the QC inspector (CEO Launch Plan Pack v1, sheet 12).
  // No union extension: `senior`/`senior_inspector`/`qc_engineer` already
  // confirm, trainee/inspector already Lower. Supervisor by rule.
  qp_quality_inspection: { skillId: "mskill_quality_inspector", levelKey: "inspection_level" },
  // Phase 2 #1 — the tool & die maker (CEO Launch Plan Pack v1, sheet 13).
  // Stored `tool_maker` aliases to `skilled`. Supervisor by rule.
  qp_tool_die_making: { skillId: "mskill_tool_die_maker", levelKey: "toolroom_level" },
  // Phase 2 #3 — the press-shop operator (CEO Launch Plan Pack v1, sheet 18).
  // No union extension: every sheet-18 rung is already a member, and @1's
  // stored `helper` renders as it always did. Supervisor by rule.
  qp_press_operation: { skillId: "mskill_press_operator", levelKey: "press_level" },
  // Phase 2 #4 — the painter / powder-coating / plating operator (CEO Launch
  // Plan Pack v1, sheet 20). No union extension: every sheet-20 rung is already
  // a member, and @1's stored `helper`/`skilled` render as they always did.
  qp_powder_coating: { skillId: "mskill_painter_coater", levelKey: "coating_level" },
  // Phase 2 #5 — the maintenance technician (CEO Launch Plan Pack v1, sheet 21).
  // No union extension: technician (Lower) and senior_technician (confirmed,
  // Higher) are already members. Supervisor by rule.
  qp_maintenance_tech: { skillId: "mskill_maintenance_technician", levelKey: "maintenance_level" },
  // Phase 2 #6 — the PLC / automation technician (CEO Launch Plan Pack v1, sheet 14), a
  // new trade. No union extension: trainee, technician, senior_technician, lead and
  // supervisor are all members. Supervisor by rule.
  // A4 item 8: pack v1 priced "technician+ Higher" (the deviation EXPAND-12 recorded
  // for #2536). CEO pack v2 sheet T38 rules Higher from `senior_technician`, so the
  // override is removed and `technician` takes the shared Lower tier (#3000; #2995
  // point 8 default).
  qp_plc_automation: {
    skillId: "mskill_plc_automation_tech",
    levelKey: "plc_level",
    labels: { senior_technician: "Automation Engineer" },
  },
  // Phase 2 #7 — the EDM / wire-cut operator (CEO Launch Plan Pack v1, sheet 16), a new
  // trade. No union extension: the CNC ladder's rungs are all members. Supervisor by rule.
  qp_edm_wirecut: { skillId: "mskill_edm_wirecut_operator", levelKey: "edm_level" },
  // Phase 2 #8 — the heat-treatment technician (CEO Launch Plan Pack v1, sheet 17), a new
  // trade. No union extension: trainee, operator, skilled, senior and supervisor are all
  // members. Supervisor by rule.
  qp_heat_treatment: { skillId: "mskill_heat_treatment_tech", levelKey: "heat_level" },
  // Phase 2 #11 — the foundry / forging operator (CEO Launch Plan Pack v1, sheet 19), a new
  // trade. No union extension: trainee, operator, skilled, senior and supervisor are all
  // members. Supervisor by rule.
  qp_foundry_forging: { skillId: "mskill_foundry_forging_operator", levelKey: "foundry_level" },
  // Phase 2 #9 — the injection-moulding operator / setter (CEO Launch Plan Pack v1, sheet 22),
  // the first pack for the declared kind. No union extension: trainee, operator, setter,
  // senior and supervisor are all members. Supervisor by rule.
  qp_injection_moulding: {
    skillId: "mskill_imm_operator",
    levelKey: "moulding_level",
    labels: { senior: "Process Technician" },
  },
  // Phase 2 #10 — the production supervisor (CEO Launch Plan Pack v1, sheet 23), a new
  // cross-trade trade. No union extension: senior, supervisor and lead are all members (all
  // Higher). Labels print the sheet's own chips; confirmed FROM supervisor, so the Line Leader
  // rung reads unconfirmed here.
  qp_production_supervisor: {
    skillId: "mskill_production_supervisor",
    levelKey: "supervision_level",
    labels: {
      senior: "Line Leader",
      supervisor: "Supervisor",
      lead: "Production In-charge",
    },
    unconfirmedRungs: ["senior"],
  },
  // ══ Wave 1 — the 12 new forms (CEO pack v2, #3000) ═════════════════════════
  qp_cnc_router: {
    skillId: "mskill_cnc_router_operator",
    levelKey: "router_level",
    labels: { programmer: "Designer-cum-Programmer" },
    tierOverrides: { setter: "lower" },
  }, // T21
  qp_foundry_casting: { skillId: "mskill_foundry_operator", levelKey: "foundry_level" }, // T24
  qp_die_casting: {
    skillId: "mskill_die_casting_operator",
    levelKey: "diecast_level",
    labels: { senior: "Process Technician" },
  }, // T25
  qp_forging: {
    skillId: "mskill_forging_operator",
    levelKey: "forging_level",
    labels: { setter: "Die Setter / Hammerman" },
  }, // T26
  qp_cmm: { skillId: "mskill_cmm_operator", levelKey: "cmm_level" }, // T33
  qp_quality_engineer: {
    skillId: "mskill_quality_engineer",
    levelKey: "qe_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T37
  qp_maintenance_engineer: {
    skillId: "mskill_maintenance_engineer",
    levelKey: "me_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T43
  qp_production_engineer: {
    skillId: "mskill_production_engineer",
    levelKey: "prod_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T46
  qp_process_engineer: {
    skillId: "mskill_process_engineer",
    levelKey: "proc_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T47
  qp_npd_engineer: {
    skillId: "mskill_npd_engineer",
    levelKey: "npd_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T48
  qp_ppc: {
    skillId: "mskill_ppc_engineer",
    levelKey: "ppc_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      engineer: "PPC Executive / Engineer",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T52
  qp_purchase: {
    skillId: "mskill_purchase_engineer",
    levelKey: "purchase_level",
    labels: {
      engineer: "Purchase Executive / Engineer",
      lead: "Lead / Asst. Manager",
      supervisor: "Manager / HOD",
    },
  }, // T54
  // ══ Wave 2 — the 18 shop-floor forms (CEO pack v2, #3000) ══════════════════
  qp_gear_cutting: { skillId: "mskill_gear_cutting_operator", levelKey: "gear_level" }, // T18
  qp_boring_machine: {
    skillId: "mskill_boring_machine_operator",
    levelKey: "boring_level",
  }, // T19
  qp_spm_finishing: {
    skillId: "mskill_spm_finishing_operator",
    levelKey: "spm_level",
  }, // T20
  qp_fabrication: {
    skillId: "mskill_fabricator",
    levelKey: "fab_level",
    labels: { operator: "Fabricator" },
  }, // T22
  qp_tube_forming: {
    skillId: "mskill_tube_bending_operator",
    levelKey: "tube_level",
  }, // T23
  qp_surface_treatment: {
    skillId: "mskill_plating_operator",
    levelKey: "plating_level",
  }, // T28
  qp_blow_moulding: {
    skillId: "mskill_blow_moulding_operator",
    levelKey: "blow_level",
  }, // T30
  qp_plastic_extrusion: {
    skillId: "mskill_plastic_extrusion_operator",
    levelKey: "extrusion_level",
  }, // T31
  qp_rubber_moulding: {
    skillId: "mskill_rubber_moulding_operator",
    levelKey: "rubber_level",
  }, // T32
  qp_ndt: {
    skillId: "mskill_ndt_technician",
    levelKey: "ndt_level",
    labels: { technician: "Level I", senior_technician: "Level II", lead: "Level III" },
  }, // T34
  qp_calibration: {
    skillId: "mskill_calibration_technician",
    levelKey: "calib_level",
  }, // T35
  qp_material_lab: {
    skillId: "mskill_material_lab_technician",
    levelKey: "matlab_level",
  }, // T36
  qp_robotics: {
    skillId: "mskill_robot_operator_programmer",
    levelKey: "robot_level",
  }, // T39
  qp_instrumentation: {
    skillId: "mskill_instrumentation_technician",
    levelKey: "instr_level",
  }, // T40
  qp_hvac_rac: {
    skillId: "mskill_hvac_rac_technician",
    levelKey: "hvac_level",
  }, // T41
  qp_utility: {
    skillId: "mskill_utility_operator",
    levelKey: "utility_level",
    labels: { skilled: "Licensed / Certified Operator" },
  }, // T42
  qp_forklift: { skillId: "mskill_forklift_operator", levelKey: "forklift_level" }, // T56
  qp_crane_rigging: { skillId: "mskill_crane_operator", levelKey: "crane_level" }, // T57
  // ══ Wave 3 — the 8 forms that complete the catalogue (CEO pack v2, #3000) ══
  qp_service_engineer: {
    skillId: "mskill_service_engineer",
    levelKey: "service_level",
    labels: {
      engineer: "Service Engineer",
      lead: "Area / Team Lead",
      supervisor: "Service Manager",
    },
  }, // T44
  qp_safety_ehs: {
    skillId: "mskill_safety_officer",
    levelKey: "ehs_level",
    labels: {
      trainee: "Safety Supervisor / Trainee",
      engineer: "Safety Officer",
      senior_engineer: "Senior Safety Officer",
      lead: "Lead / Asst. Manager EHS",
      supervisor: "EHS Manager / HOD",
    },
  }, // T49
  qp_project_site: {
    skillId: "mskill_project_site_engineer",
    levelKey: "site_level",
    labels: {
      trainee: "Trainee (GET / DET)",
      lead: "Site In-charge",
      supervisor: "Manager",
    },
  }, // T50
  qp_technical_sales: {
    skillId: "mskill_technical_sales_engineer",
    levelKey: "sales_level",
    labels: {
      engineer: "Sales Engineer",
      lead: "Area / Regional Manager",
      supervisor: "Manager / Head",
    },
  }, // T51
  qp_stores: {
    skillId: "mskill_store_keeper",
    levelKey: "store_level",
    labels: {
      trainee: "Store Helper / Assistant",
      executive: "Store Keeper / Executive",
      supervisor: "Store In-charge",
    },
  }, // T53
  qp_dispatch_logistics: {
    skillId: "mskill_dispatch_logistics_executive",
    levelKey: "dispatch_level",
    labels: {
      trainee: "Dispatch Helper / Assistant",
      executive: "Dispatch Executive",
      supervisor: "Dispatch / Logistics In-charge",
    },
  }, // T55
  qp_cae_fea: {
    skillId: "mskill_cae_analyst",
    levelKey: "cae_level",
    labels: {
      engineer: "Analyst",
      senior_engineer: "Senior Analyst",
      supervisor: "Manager / Head",
    },
  }, // T59
  qp_piping_design: {
    skillId: "mskill_piping_designer",
    levelKey: "piping_level",
    labels: { supervisor: "Head" },
    tierOverrides: { designer: "higher" },
  }, // T60
};

/** Legacy/alias spellings that name a `TradeLevel` without being one. */
const LEVEL_KEY_ALIASES: Readonly<Record<string, TradeLevel>> = {
  setter_cum_programmer: "setter_programmer",
  settercumprogrammer: "setter_programmer",
  "setter-cum-programmer": "setter_programmer",
  // Track B #3 (CEO Launch Plan Pack v1, sheet 8): qp_welding_trade@1 stored
  // `certified_welder` for the skilled rung; @2 keeps the key as a history
  // chip. The alias lands old answers on `skilled` (confirmed, Higher).
  certified_welder: "skilled",
  // Phase 2 #1 (CEO Launch Plan Pack v1, sheet 13): qp_tool_die_making@1
  // stored `tool_maker` for the skilled rung; @2 keeps the key as a history
  // chip. Same mechanism, same reason.
  tool_maker: "skilled",
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled): bare "junior" is a trainee
  // claim now (no ladder carries `junior_programmer` anymore; that key stays for
  // history). Bare "senior" needs no alias: it IS a union member and the union
  // check runs first — the old `senior → senior_programmer` row is deleted, not
  // left to mislead.
  junior: "trainee",
};

/** A stored level answer → its `TradeLevel`, or null when it names no rung. */
export function normalizeTradeLevelKey(raw: unknown): TradeLevel | null {
  if (typeof raw !== "string") return null;
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "_");
  if ((Object.keys(TRADE_LEVEL_LABELS) as string[]).includes(folded)) {
    return folded as TradeLevel;
  }
  const aliased = LEVEL_KEY_ALIASES[folded] ?? LEVEL_KEY_ALIASES[raw.trim().toLowerCase()];
  return aliased ?? null;
}

/** The display label for a rung — the closed vocabulary the headline prints. */
export const TRADE_LEVEL_LABELS: Readonly<Record<TradeLevel, string>> = {
  helper: "Helper",
  trainee: "Trainee",
  operator: "Operator",
  draughtsman: "Draughtsman",
  trainee_modeller: "Trainee Modeller",
  cad_designer: "CAD Designer",
  setter: "Setter",
  setter_programmer: "Setter-cum-Programmer",
  programmer: "Programmer",
  junior_programmer: "Junior Programmer",
  senior_programmer: "Senior Programmer",
  senior_draughtsman: "Senior Draughtsman",
  senior_designer: "Senior Designer",
  lead_checker: "Lead Checker",
  design_engineer_lead: "Design Engineer Lead",
  supervisor: "Supervisor",
  // CEO shared vocabulary — display labels from the trade sheets (chip-adjacent,
  // not chip text: chips vary by trade, keys do not).
  skilled: "Skilled",
  senior: "Senior",
  technician: "Technician",
  senior_technician: "Senior Technician",
  inspector: "Inspector",
  senior_inspector: "Senior Inspector",
  qc_engineer: "QC Engineer",
  designer: "Designer",
  lead: "Lead",
  // Track B #1 — the fitter rungs (CEO Launch Plan Pack v1, sheet 6).
  fitter: "Fitter",
  senior_fitter: "Senior Fitter",
  // Track B #2 — the electrician operator rung (sheet 7).
  electrician: "Electrician",
  // Track B #3 — the welder operator rung (sheet 8).
  welder: "Welder",
  // CEO pack v2 — the desk and supply-chain rungs (#3000). Per-trade labels override
  // these where the sheet speaks its own words (Service Engineer, Store Keeper, ...).
  engineer: "Engineer",
  senior_engineer: "Senior Engineer",
  executive: "Executive",
  senior_executive: "Senior Executive",
};

/**
 * Rungs that confirm the level (P1 column contract: "Setter and above only").
 *
 * PER LADDER, stated once. Turner/VMC: setter and up. Grinding stops at
 * setter-cum-programmer (no programmer rung exists). CAM: programmer and up —
 * a junior is still proving out. CAD ladders: senior/lead rungs only.
 *
 * CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — one separating rung per
 * sheet: skilled-ladder trades confirm from `skilled`; technician ladders from
 * `senior_technician`; QC from `senior_inspector`; design ladders from
 * `senior_designer`; `lead` and `senior` confirm everywhere they appear (all
 * Higher). Supervisor confirms in every trade (Q4).
 */
const CONFIRMED_RUNGS: ReadonlySet<string> = new Set([
  "setter",
  "setter_programmer",
  "programmer",
  "senior_programmer",
  "supervisor",
  "senior_draughtsman",
  "senior_designer",
  "lead_checker",
  "design_engineer_lead",
  "skilled",
  "senior",
  "senior_technician",
  "senior_inspector",
  "qc_engineer",
  "lead",
  // Track B #1 — the fitter senior rung confirms (sheet 6: Senior Fitter Higher).
  "senior_fitter",
  // CEO pack v2 — the desk and supply-chain confirming rungs (#3000). `engineer` and
  // `executive` are the first rungs of their ladders, so they confirm only through
  // their own question (T49, T53, T55); the senior keys confirm by rule.
  "senior_engineer",
  "senior_executive",
]);

/** True once the separating question was answered (Setter and above only). */
export function isLevelConfirmed(level: TradeLevel | null): boolean {
  return level !== null && CONFIRMED_RUNGS.has(level);
}

/**
 * The unlock price tier for a rung (spec §4.1 — HOOK ONLY, ₹40 flat stays live).
 *
 * Higher: Setter and above (+ Senior/Lead equivalents). Lower: Helper, Operator,
 * null and the CAD trainee/draughtsman/modeller equivalents. Null prices Lower —
 * an unstated level must never price a worker up.
 */
export function priceTierForTradeLevel(level: TradeLevel | null): PriceTier {
  if (level === null) return "lower";
  return levelTier(level);
}

/** The crosswalk entry whose trade skill is `skillId` — one pack per trade skill. */
const PACK_BY_SKILL: ReadonlyMap<string, TradeLevelPack> = new Map(
  Object.values(TRADE_LEVEL_PACKS).map((pack) => [pack.skillId, pack]),
);

/**
 * The unlock price tier for ONE trade's rung, as that trade's sheet prices it (A4 item 8).
 *
 * A pack's `tierOverrides` wins for its own rungs; every other rung, and every skill with no
 * crosswalk entry (legacy rows), prices by the shared rule. Null still prices Lower.
 */
export function priceTierForTradeSkill(
  skillId: string | null | undefined,
  level: TradeLevel | null,
): PriceTier {
  if (level === null) return "lower";
  const override = skillId == null ? undefined : PACK_BY_SKILL.get(skillId)?.tierOverrides?.[level];
  return override ?? levelTier(level);
}

/** One stated rung on one trade — a `worker_profile_skill` row's (skill, trade_level). */
export interface TradeLevelRow {
  readonly skillId: string;
  readonly tradeLevel: TradeLevel | null;
}

/**
 * The unlock price tier for a worker's stated rungs, each priced by its OWN trade's sheet
 * (the hook's input since A4 item 8). HIGHER if any row prices Higher, else Lower; no rows —
 * a worker who stated no rung — prices Lower.
 */
export function priceTierForTradeRows(rows: readonly TradeLevelRow[]): PriceTier {
  return rows.some((row) => priceTierForTradeSkill(row.skillId, row.tradeLevel) === "higher")
    ? "higher"
    : "lower";
}

/**
 * The unlock price tier for a list of bare rungs by the SHARED rule (spec §4.1).
 *
 * HIGHER if any rung prices Higher, else Lower. An empty list — or a worker who
 * never stated a rung — prices Lower: an unstated level must never price a worker up.
 * TRADE-BLIND: it cannot apply a sheet's own tiers. The unlock hook reads
 * {@link priceTierForTradeRows} instead (A4 item 8); this stays for callers without a skill.
 */
export function priceTierForLevels(levels: readonly (TradeLevel | null)[]): PriceTier {
  return levels.some((level) => priceTierForTradeLevel(level) === "higher") ? "higher" : "lower";
}

function levelTier(level: TradeLevel): PriceTier {
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — per-sheet tiers. Lower: the
  // trainee/operator/designer rungs. Everything else Higher.
  // Track B #1 — the fitter operator rung is Lower (sheet 6).
  // Track B #2 — the electrician operator rung is Lower (sheet 7).
  // Track B #3 — the welder operator rung is Lower (sheet 8).
  switch (level) {
    case "helper":
    case "trainee":
    case "operator":
    case "draughtsman":
    case "trainee_modeller":
    case "cad_designer":
    case "junior_programmer":
    case "technician":
    case "inspector":
    case "designer":
    case "fitter":
    case "electrician":
    case "welder":
    // CEO pack v2 — the Stores and Dispatch entry rung (#3000). `engineer` and the
    // two senior keys fall through to Higher, as the desk sheets rule.
    case "executive":
      return "lower";
    default:
      return "higher";
  }
}

/**
 * The headline label for one pack's stored level answer, or null when the worker
 * stated no rung. Read by the Verdict Line and the profile headline — the same
 * closed vocabulary on both, so the sheet and the headline can never disagree.
 *
 * A pack with its own `labels` (2D Draughtsman today) prints the trade's own
 * words; every other pack prints the shared crosswalk labels.
 */
export function tradeLevelLabelFor(packId: string, rawValue: unknown): string | null {
  if (!(packId in TRADE_LEVEL_PACKS)) return null;
  const entry = TRADE_LEVEL_PACKS[packId]!;
  const level = normalizeTradeLevelKey(rawValue);
  if (level === null) return null;
  const own = entry.labels?.[level];
  if (own !== undefined) return own;
  // `noUncheckedIndexedAccess` widens the lookup; the key is known-good, so a miss
  // is a type-system artefact rather than a second null path — still, never undefined.
  return TRADE_LEVEL_LABELS[level] ?? null;
}

/** One level answer, as the extraction projection carries it. */
export interface LevelAnswerInput {
  readonly attributeKey: string;
  readonly value: unknown;
}

/** A `worker_profile_skill` row the level answer earns. */
export interface TradeLevelEntry {
  readonly skillId: string;
  readonly tradeLevel: TradeLevel;
  readonly levelConfirmed: boolean;
}

/**
 * Separating-confirm items (CEO Launch Plan Pack v1, Track A #1): rung → the
 * pack item that asks the separating question for it. Turner @6 ships four;
 * later retags add their packs' rows here (VMC, CAM, ...), never a new
 * mechanism.
 *
 * The answers are `self` (khud — confirms) or `other` (koi aur — disconfirms).
 * Anything else stored under a confirm key (e.g. the supervisor's free-text
 * team count) counts as an answer, hence confirmed: the worker engaged the
 * separating question instead of skipping it.
 */
export const TRADE_LEVEL_CONFIRM_ITEMS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    qp_cnc_turning: {
      setter: "setting_confirm",
      setter_programmer: "program_edit_confirm",
      programmer: "program_write_confirm",
      supervisor: "team_confirm",
    },
    // Track A #2 — the VMC/HMC confirms (CEO Launch Plan Pack v1, sheet 2).
    qp_vmc_milling: {
      setter: "milling_setting_confirm",
      setter_programmer: "milling_program_edit_confirm",
      programmer: "milling_program_write_confirm",
      supervisor: "milling_team_confirm",
    },
    // Track A #3 — the CAM confirms (CEO Launch Plan Pack v1, sheet 3).
    // Confirmed from `programmer`: programmer, senior, lead, supervisor.
    qp_cam_programming: {
      programmer: "cam_program_confirm",
      senior: "cam_senior_confirm",
      lead: "cam_lead_confirm",
      supervisor: "cam_team_confirm",
    },
    // Track A #4 — the 3D design confirms (CEO Launch Plan Pack v1, sheet 4).
    // Confirmed from `senior_designer`: senior_designer, lead, supervisor.
    qp_cad_design_3d: {
      senior_designer: "design_senior_confirm",
      lead: "design_lead_confirm",
      supervisor: "design_team_confirm",
    },
    // Track A #5 — the 2D draughtsman confirms (CEO Launch Plan Pack v1, sheet 5).
    // Confirmed from `senior_designer`: senior_designer, lead, supervisor.
    qp_cad_drafting: {
      senior_designer: "cad_senior_confirm",
      lead: "cad_lead_confirm",
      supervisor: "cad_team_confirm",
    },
    // Track B #1 — the fitter confirms (CEO Launch Plan Pack v1, sheet 6).
    // Confirmed from `skilled`: skilled, senior_fitter; supervisor by rule.
    qp_fitter: {
      skilled: "fitter_skilled_confirm",
      senior_fitter: "fitter_team_confirm",
    },
    // Track B #2 — the electrician confirm (CEO Launch Plan Pack v1, sheet 7).
    // Confirmed from `senior` (the sheet's senior_technician rung): senior only;
    // supervisor by rule.
    qp_industrial_electrician: {
      senior: "electrician_senior_confirm",
    },
    // Track B #3 — the welder confirms (CEO Launch Plan Pack v1, sheet 8).
    // Confirmed from `skilled`: skilled, senior; supervisor by rule.
    qp_welding_trade: {
      skilled: "welder_skilled_confirm",
      senior: "welder_senior_confirm",
    },
    // Track B #4 — the conventional confirms (CEO Launch Plan Pack v1, sheet 9).
    // Confirmed from `skilled`: skilled, senior; supervisor by rule.
    qp_conventional_machining: {
      skilled: "machining_skilled_confirm",
      senior: "machining_senior_confirm",
    },
    // Track B #5 — the sheet-metal confirms (CEO Launch Plan Pack v1, sheet 10).
    // Confirmed from `skilled`: skilled, senior; supervisor by rule.
    // #2753 item 1 (@3) — `programmer` is the rung above `senior` and has no sheet
    // question of its own, so the standing owner rule (2026-11-03) asks it the
    // senior's one question, which is the programmer's evidence anyway ("Nesting /
    // press-brake program khud banate ho?").
    qp_sheet_metal_fab: {
      skilled: "sheet_skilled_confirm",
      senior: "sheet_senior_confirm",
      programmer: "sheet_senior_confirm",
    },
    // Track B #6 — the assembly confirms (CEO Launch Plan Pack v1, sheet 11).
    // Confirmed from `skilled`: skilled, senior (team count); supervisor by rule.
    qp_assembly_line: {
      skilled: "assembly_skilled_confirm",
      senior: "assembly_team_confirm",
    },
    // Track B #7 — the QC confirms (CEO Launch Plan Pack v1, sheet 12).
    // Confirmed from `senior_inspector`: senior_inspector, qc_engineer;
    // supervisor by rule.
    qp_quality_inspection: {
      senior_inspector: "inspection_senior_confirm",
      qc_engineer: "inspection_engineer_confirm",
    },
    // Phase 2 #1 — the tool-room confirms (CEO Launch Plan Pack v1, sheet 13).
    // Confirmed from `skilled`: skilled, senior; supervisor by rule.
    qp_tool_die_making: {
      skilled: "toolroom_skilled_confirm",
      senior: "toolroom_senior_confirm",
    },
    // Phase 2 #2 — the grinding confirm (CEO Launch Plan Pack v1, sheet 15).
    // Confirmed from `setter`. The sheet writes one separating question (the
    // setter's) and none for setter-cum-programmer, so by owner ruling
    // (2026-11-03) that one question is asked of both rungs. Supervisor by rule.
    qp_cnc_grinding: {
      setter: "grinding_setting_confirm",
      setter_programmer: "grinding_setting_confirm",
    },
    // Phase 2 #3 — the press-shop confirm (CEO Launch Plan Pack v1, sheet 18).
    // Confirmed from `setter`. The sheet writes one separating question (the
    // setter's) and none for senior, so — the grinding ruling of 2026-11-03,
    // applied here by owner decision — that one question is asked of both.
    // Supervisor by rule.
    qp_press_operation: {
      setter: "press_setting_confirm",
      senior: "press_setting_confirm",
    },
    // Phase 2 #4 — the coating confirm (CEO Launch Plan Pack v1, sheet 20).
    // Confirmed from `skilled`; the sheet's one question is asked of skilled and
    // senior (standing owner rule, 2026-11-03). Supervisor by rule.
    qp_powder_coating: {
      skilled: "coating_skilled_confirm",
      senior: "coating_skilled_confirm",
    },
    // Phase 2 #5 — the maintenance confirm (CEO Launch Plan Pack v1, sheet 21).
    // Confirmed from `senior_technician`; the only rung above is supervisor,
    // confirmed by rule — so one rung, one question.
    qp_maintenance_tech: {
      senior_technician: "maintenance_senior_confirm",
    },
    // Phase 2 #6 — the PLC confirms (CEO Launch Plan Pack v1, sheet 14). Confirmed from
    // `technician`: the sheet writes a question for technician and one for senior
    // technician; lead has none, so it takes the senior question (standing owner rule,
    // 2026-11-03). Supervisor by rule. The technician confirm is what confirms that rung:
    // its shared key is not in CONFIRMED_RUNGS (maintenance/electrician sheets rule it
    // Lower), so with no answer the rung rule leaves it unconfirmed.
    qp_plc_automation: {
      technician: "plc_technician_confirm",
      senior_technician: "plc_senior_confirm",
      lead: "plc_senior_confirm",
    },
    // Phase 2 #7 — the EDM confirms (CEO Launch Plan Pack v1, sheet 16). Confirmed from
    // `setter`; the sheet writes a question for setter and one for setter-cum-programmer, both
    // verbatim. Supervisor by rule.
    qp_edm_wirecut: {
      setter: "edm_setting_confirm",
      setter_programmer: "edm_program_confirm",
    },
    // Phase 2 #8 — the heat-treatment confirm (CEO Launch Plan Pack v1, sheet 17). Confirmed
    // from `skilled`; the sheet writes one question, for skilled, and none for senior, so the
    // owner's standing rule asks the same question of both. Supervisor by rule.
    qp_heat_treatment: {
      skilled: "heat_skilled_confirm",
      senior: "heat_skilled_confirm",
    },
    // Phase 2 #11 — the foundry / forging confirm (CEO Launch Plan Pack v1, sheet 19). Confirmed
    // from `skilled`; the sheet writes one question, for skilled, and none for senior, so the
    // owner's standing rule asks the same question of both. Supervisor by rule.
    qp_foundry_forging: {
      skilled: "foundry_skilled_confirm",
      senior: "foundry_skilled_confirm",
    },
    // Phase 2 #9 — the injection-moulding confirms (CEO Launch Plan Pack v1, sheet 22).
    // Confirmed from `setter`; the sheet writes a question for setter and one for senior
    // (process technician), both verbatim. Supervisor by rule.
    qp_injection_moulding: {
      setter: "moulding_setting_confirm",
      senior: "moulding_senior_confirm",
    },
    // Phase 2 #10 — the production supervisor confirm (CEO Launch Plan Pack v1, sheet 23). The
    // sheet's two-question prompt is split along its own rows (owner ruling 2026-11-04): the
    // shift-report half confirms supervisor, and — by the standing owner rule of 2026-11-03 —
    // production in-charge (`lead`), for which the sheet writes none.
    qp_production_supervisor: {
      supervisor: "supervision_report_confirm",
      lead: "supervision_report_confirm",
    },
    // ══ Wave 1 — the 12 new forms (CEO pack v2, #3000) ═════════════════════════
    qp_cnc_router: {
      setter: "router_setter_confirm",
      programmer: "router_programmer_confirm",
      supervisor: "router_team_confirm",
    },
    qp_foundry_casting: {
      skilled: "foundry_skilled_confirm",
      senior: "foundry_senior_confirm",
      supervisor: "foundry_team_confirm",
    },
    qp_die_casting: {
      setter: "diecast_setter_confirm",
      senior: "diecast_senior_confirm",
      supervisor: "diecast_team_confirm",
    },
    qp_forging: {
      setter: "forging_setter_confirm",
      senior: "forging_senior_confirm",
      supervisor: "forging_team_confirm",
    },
    qp_cmm: {
      programmer: "cmm_programmer_confirm",
      senior: "cmm_senior_confirm",
      supervisor: "cmm_team_confirm",
    },
    qp_quality_engineer: {
      senior_engineer: "qe_senior_engineer_confirm",
      lead: "qe_lead_confirm",
      supervisor: "qe_team_confirm",
    },
    qp_maintenance_engineer: {
      senior_engineer: "me_senior_engineer_confirm",
      lead: "me_lead_confirm",
      supervisor: "me_team_confirm",
    },
    qp_production_engineer: {
      senior_engineer: "prod_senior_engineer_confirm",
      lead: "prod_lead_confirm",
      supervisor: "prod_team_confirm",
    },
    qp_process_engineer: {
      senior_engineer: "proc_senior_engineer_confirm",
      lead: "proc_lead_confirm",
      supervisor: "proc_team_confirm",
    },
    qp_npd_engineer: {
      senior_engineer: "npd_senior_engineer_confirm",
      lead: "npd_lead_confirm",
      supervisor: "npd_team_confirm",
    },
    qp_ppc: {
      senior_engineer: "ppc_senior_engineer_confirm",
      lead: "ppc_lead_confirm",
      supervisor: "ppc_team_confirm",
    },
    qp_purchase: {
      senior_engineer: "purchase_senior_engineer_confirm",
      lead: "purchase_lead_confirm",
      supervisor: "purchase_team_confirm",
    },
    // ══ Wave 2 — the 18 shop-floor forms (CEO pack v2, #3000) ══════════════════
    qp_gear_cutting: {
      setter: "gear_setter_confirm",
      setter_programmer: "gear_setter_programmer_confirm",
      supervisor: "gear_team_confirm",
    },
    qp_boring_machine: {
      setter: "boring_setter_confirm",
      setter_programmer: "boring_setter_programmer_confirm",
      supervisor: "boring_team_confirm",
    },
    qp_spm_finishing: {
      setter: "spm_setter_confirm",
      senior: "spm_senior_confirm",
      supervisor: "spm_team_confirm",
    },
    qp_fabrication: {
      skilled: "fab_skilled_confirm",
      senior: "fab_senior_confirm",
      supervisor: "fab_team_confirm",
    },
    qp_tube_forming: {
      setter: "tube_setter_confirm",
      senior: "tube_senior_confirm",
      supervisor: "tube_team_confirm",
    },
    qp_surface_treatment: {
      skilled: "plating_skilled_confirm",
      senior: "plating_senior_confirm",
      supervisor: "plating_team_confirm",
    },
    qp_blow_moulding: {
      setter: "blow_setter_confirm",
      senior: "blow_senior_confirm",
      supervisor: "blow_team_confirm",
    },
    qp_plastic_extrusion: {
      setter: "extrusion_setter_confirm",
      senior: "extrusion_senior_confirm",
      supervisor: "extrusion_team_confirm",
    },
    qp_rubber_moulding: {
      setter: "rubber_setter_confirm",
      senior: "rubber_senior_confirm",
      supervisor: "rubber_team_confirm",
    },
    qp_ndt: {
      senior_technician: "ndt_senior_technician_confirm",
      lead: "ndt_lead_confirm",
    },
    qp_calibration: {
      senior_technician: "calib_senior_technician_confirm",
      supervisor: "calib_team_confirm",
    },
    qp_material_lab: {
      senior_technician: "matlab_senior_technician_confirm",
      supervisor: "matlab_team_confirm",
    },
    qp_robotics: {
      programmer: "robot_programmer_confirm",
      senior: "robot_senior_confirm",
      supervisor: "robot_team_confirm",
    },
    qp_instrumentation: {
      senior_technician: "instr_senior_technician_confirm",
      supervisor: "instr_team_confirm",
    },
    qp_hvac_rac: {
      senior_technician: "hvac_senior_technician_confirm",
      supervisor: "hvac_team_confirm",
    },
    qp_utility: {
      skilled: "utility_skilled_confirm",
      senior: "utility_senior_confirm",
      supervisor: "utility_team_confirm",
    },
    qp_forklift: {
      operator: "forklift_operator_confirm",
      senior: "forklift_senior_confirm",
      supervisor: "forklift_team_confirm",
    },
    qp_crane_rigging: {
      operator: "crane_operator_confirm",
      senior: "crane_senior_confirm",
      supervisor: "crane_team_confirm",
    },
    // ══ Wave 3 — the 8 forms that complete the catalogue (CEO pack v2, #3000) ══
    qp_service_engineer: {
      senior_engineer: "service_senior_engineer_confirm",
      lead: "service_lead_confirm",
      supervisor: "service_team_confirm",
    },
    qp_safety_ehs: {
      engineer: "ehs_engineer_confirm",
      senior_engineer: "ehs_senior_engineer_confirm",
      lead: "ehs_lead_confirm",
      supervisor: "ehs_team_confirm",
    },
    qp_project_site: {
      senior_engineer: "site_senior_engineer_confirm",
      lead: "site_lead_confirm",
      supervisor: "site_team_confirm",
    },
    qp_technical_sales: {
      senior_engineer: "sales_senior_engineer_confirm",
      lead: "sales_lead_confirm",
      supervisor: "sales_team_confirm",
    },
    qp_stores: {
      senior_executive: "store_senior_executive_confirm",
      supervisor: "store_team_confirm",
    },
    qp_dispatch_logistics: {
      senior_executive: "dispatch_senior_executive_confirm",
      supervisor: "dispatch_team_confirm",
    },
    qp_cae_fea: {
      senior_engineer: "cae_senior_engineer_confirm",
      lead: "cae_lead_confirm",
      supervisor: "cae_team_confirm",
    },
    qp_piping_design: {
      senior_designer: "piping_senior_designer_confirm",
      lead: "piping_lead_confirm",
      supervisor: "piping_team_confirm",
    },
    // ══ The six deepened forms' v2 maps (#3000) ═══════════════════════════════
    // VERSIONED ON PURPOSE. The live v1 entries above stay authoritative for v1; a
    // v2 pack id prefers its own map, so a v1 "koi aur" answer keeps its meaning until
    // #3008 publishes the v2 forms. #3008 then makes v2 the base entry.
    "qp_edm_wirecut@2": {
      setter: "edm_setting_confirm",
      setter_programmer: "edm_program_confirm",
      supervisor: "edm_team_confirm",
    },
    "qp_heat_treatment@2": {
      skilled: "heat_skilled_confirm",
      senior: "ht_senior_confirm",
      supervisor: "ht_team_confirm",
    },
    "qp_injection_moulding@2": {
      setter: "moulding_setting_confirm",
      senior: "moulding_senior_confirm",
      supervisor: "moulding_team_confirm",
    },
    "qp_plc_automation@2": {
      senior_technician: "plc_senior_confirm",
      lead: "plc_lead_confirm",
      supervisor: "plc_team_confirm",
    },
    "qp_production_supervisor@2": {
      supervisor: "prodsup_team_confirm",
      lead: "prodsup_incharge_confirm",
    },
    "qp_cad_design_3d@2": {
      senior_designer: "design_senior_confirm",
      lead: "design_lead_confirm",
      supervisor: "design_team_confirm",
    },
  };

/**
 * The authored skill rows for one pack's projected answers (Middle Way P5 persist).
 *
 * AT MOST ONE ENTRY: v1 packs ask one level question each. Unknown packs, unstated
 * rungs and unmapped spellings yield nothing — NULL is "not stated", and a row is
 * never written for a rung the worker did not claim. Version suffixes (`@3`) are
 * stripped: the crosswalk is keyed by pack, and packs are immutable per version.
 *
 * `levelConfirmed` follows the P1 column contract (Setter and above only); the
 * trade skill comes from the pack, never from the worker's words.
 *
 * CEO Launch Pack v1 (Track A #1): a separating-confirm answer OVERRIDES the
 * rung rule for the rung it asks about — `self` confirms, `other` disconfirms,
 * no confirm answer falls back to the rung rule. The worker's own answer about
 * his own rung outranks the ladder's presumption.
 */
export function tradeLevelEntriesForPackAnswers(
  packId: string | null | undefined,
  attributes: readonly LevelAnswerInput[],
): TradeLevelEntry[] {
  if (packId == null) return [];
  const entry = TRADE_LEVEL_PACKS[packId.split("@")[0]!];
  if (entry === undefined) return [];
  const raw = attributes.find((a) => a.attributeKey === entry.levelKey)?.value;
  const level = normalizeTradeLevelKey(singleText(raw));
  if (level === null) return [];
  return [
    {
      skillId: entry.skillId,
      tradeLevel: level,
      levelConfirmed: isConfirmed(packId, level, attributes),
    },
  ];
}

/**
 * The `level_confirmed` bit for one stated rung: the separating-confirm answer
 * wins when there is one, the rung rule otherwise.
 */
function isConfirmed(
  packId: string,
  level: TradeLevel,
  attributes: readonly LevelAnswerInput[],
): boolean {
  // Prefer the exact pack revision's map when one exists (#3000). The deepened forms
  // keep their v1 map for stored v1 answers and gain a `@2` map for the new sheet's
  // keys; a base-only id still resolves to the base map, so every existing caller is
  // unchanged.
  const confirmItem =
    TRADE_LEVEL_CONFIRM_ITEMS[packId] ?? TRADE_LEVEL_CONFIRM_ITEMS[packId.split("@")[0]!];
  const confirmKey = confirmItem?.[level];
  if (confirmKey !== undefined) {
    const raw = attributes.find((a) => a.attributeKey === confirmKey)?.value;
    const text = singleText(raw);
    if (text !== null) {
      if (text === "self") return true;
      if (text === "other") return false;
      // A non-chip answer (the supervisor's team count) is still an engagement
      // with the separating question — confirmed, never guessed-against.
      return true;
    }
  }
  if (TRADE_LEVEL_PACKS[packId.split("@")[0]!]?.unconfirmedRungs?.includes(level)) return false;
  return isLevelConfirmed(level);
}

/** A single-select answer's text, or null when it is not one clean string. */
function singleText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") return raw[0];
  return null;
}
