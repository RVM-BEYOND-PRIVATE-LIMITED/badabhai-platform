/**
 * First-question routing table (CEO pack v2, section 6, #3015).
 *
 * Shared words ("machine operator", "helper", "maintenance", ...) must not lead to any one
 * form. Each row gives the worker's words, the routing question verbatim (passes
 * checkPromptPersona: one question mark, at most 20 words), and chips whose outcomes are
 * exactly one of: a trade ({ familyId }), a trade with a level ({ familyId, level }),
 * a chained question ({ next }), free text ({ ask: "free_text" }), or label-only
 * ({ outOfScope: true }).
 *
 * Source: docs/reference/BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md section 6
 * (17 rows) plus the installation/commissioning entry (point 10 of #2995, default: machine
 * service T44 or plant erection T50). Never invented: labels and prompts are the pack's words.
 *
 * PRIVACY: authored routing copy only. No worker data.
 */

export interface RoutingTradeChip {
  readonly kind: "trade";
  readonly label: string;
  readonly familyId: string;
  readonly jobDomainId: string;
  /** Level rung to store as unconfirmed answer under the target form's levelKey. */
  readonly level?: { readonly levelKey: string; readonly rung: string };
}

export interface RoutingNextChip {
  readonly kind: "next";
  readonly label: string;
  readonly next: string;
  readonly level?: { readonly levelKey: string; readonly rung: string };
}

export interface RoutingAskChip {
  readonly kind: "ask";
  readonly label: string;
  readonly ask: "free_text";
  readonly level?: { readonly levelKey: string; readonly rung: string };
}

export interface RoutingOutOfScopeChip {
  readonly kind: "outOfScope";
  readonly label: string;
}

export type RoutingChip =
  | RoutingTradeChip
  | RoutingNextChip
  | RoutingAskChip
  | RoutingOutOfScopeChip;

export interface RoutingEntry {
  readonly id: string;
  /** Raw worker phrases from the pack's "Worker says" column. Matched after normalisation. */
  readonly phrases: readonly string[];
  readonly prompt: string;
  readonly chips: readonly RoutingChip[];
}

/** Job domain per trade chip: first NCO code, or the minted RVM entry where the pack mints one. */
const JD = {
  T01: "jd_nco_7223_6001",
  T02: "jd_nco_7223_5004",
  T03: "jd_nco_7223_2200",
  T04: "jd_nco_7223_6003",
  T05: "jd_nco_3118_0401",
  T06: "jd_nco_7223_0500",
  T07: "jd_nco_7222_0200",
  T08: "jd_nco_7212_0100",
  T09: "jd_nco_7213_0101",
  T10: "jd_nco_7211_0101",
  T12: "jd_nco_7233_0200",
  T13: "jd_nco_7233_0101",
  T14: "jd_nco_7412_0200",
  T15: "jd_nco_8219_0100",
  T16: "jd_nco_7543_2001",
  T17: "jd_nco_7223_2800",
  T21: "jd_nco_7523_0500",
  T22: "jd_nco_7212_0400",
  T24: "jd_nco_7211_0201",
  T25: "jd_nco_8121_4200",
  T26: "jd_nco_7221_0301",
  T29: "jd_nco_8142_0501",
  T30: "jd_nco_8142_0700",
  T32: "jd_nco_8141_0711",
  T33: "jd_rvm_cmm_operator",
  T34: "jd_rvm_ndt_technician",
  T35: "jd_nco_2111_1000",
  T36: "jd_nco_1223_0102",
  T37: "jd_nco_2152_0601",
  T38: "jd_nco_7412_0101",
  T39: "jd_nco_3139_1400",
  T40: "jd_nco_2141_0200",
  T41: "jd_nco_2144_1200",
  T42: "jd_nco_3122_1600",
  T43: "jd_nco_2144_0600",
  T44: "jd_nco_2144_0601",
  T45: "jd_nco_3122_9900",
  T46: "jd_nco_2144_0403",
  T47: "jd_nco_2141_0300",
  T48: "jd_nco_2144_0402",
  T49: "jd_nco_2141_2500",
  T50: "jd_nco_8211_1000",
  T51: "jd_nco_3322_0101",
  T52: "jd_nco_2141_0501",
  T53: "jd_nco_4321_0100",
  T54: "jd_nco_3323_0100",
  T55: "jd_nco_1324_1200",
  T56: "jd_nco_8344_0100",
  T57: "jd_nco_7215_0100",
  T58: "jd_nco_2144_0200",
  T59: "jd_nco_2152_0301",
  T60: "jd_rvm_piping_designer",
} as const;

const FAM = {
  T01: "fam_cnc_turning",
  T02: "fam_vmc_milling",
  T03: "fam_cnc_grinding",
  T04: "fam_cam_programming",
  T05: "fam_cad_drafting",
  T06: "fam_conventional_machining",
  T07: "fam_tool_die_making",
  T08: "fam_welding_trade",
  T09: "fam_sheet_metal_fab",
  T10: "fam_press_operation",
  T12: "fam_fitter",
  T13: "fam_maintenance_tech",
  T14: "fam_industrial_electrician",
  T15: "fam_assembly_line",
  T16: "fam_quality_inspection",
  T17: "fam_edm_wirecut",
  T21: "fam_cnc_router",
  T22: "fam_fabrication",
  T24: "fam_foundry_casting",
  T25: "fam_die_casting",
  T26: "fam_forging",
  T29: "fam_injection_moulding",
  T30: "fam_blow_moulding",
  T32: "fam_rubber_moulding",
  T33: "fam_cmm",
  T34: "fam_ndt",
  T35: "fam_calibration",
  T36: "fam_material_lab",
  T37: "fam_quality_engineer",
  T38: "fam_plc_automation",
  T39: "fam_robotics",
  T40: "fam_instrumentation",
  T41: "fam_hvac_rac",
  T42: "fam_utility",
  T43: "fam_maintenance_engineer",
  T44: "fam_service_engineer",
  T45: "fam_production_supervisor",
  T46: "fam_production_engineer",
  T47: "fam_process_engineer",
  T48: "fam_npd_engineer",
  T49: "fam_safety_ehs",
  T50: "fam_project_site",
  T51: "fam_technical_sales",
  T52: "fam_ppc",
  T53: "fam_stores",
  T54: "fam_purchase",
  T55: "fam_dispatch_logistics",
  T56: "fam_forklift",
  T57: "fam_crane_rigging",
  T58: "fam_cad_design_3d",
  T59: "fam_cae_fea",
  T60: "fam_piping_design",
} as const;

const LEVEL = {
  T13: "maintenance_level",
  T15: "assembly_level",
  T29: "moulding_level",
  T45: "supervision_level",
  T53: "store_level",
  T55: "dispatch_level",
  T01: "turning_level",
  T02: "milling_level",
} as const;

function trade(
  label: string,
  trade: keyof typeof FAM,
  level?: { readonly levelKey: string; readonly rung: string },
): RoutingTradeChip {
  return { kind: "trade", label, familyId: FAM[trade], jobDomainId: JD[trade], ...(level ? { level } : {}) };
}

export const ROUTING_TABLE: readonly RoutingEntry[] = [
  {
    id: "machine",
    phrases: ["machine operator", "operator hoon", "machine chalata hoon", "production operator"],
    prompt: "Aap kaunsi machine chalate hain?",
    chips: [
      trade("CNC lathe / turning", "T01"),
      trade("VMC / HMC / milling", "T02"),
      trade("Grinding", "T03"),
      trade("Manual lathe ya milling", "T06"),
      trade("Power press", "T10"),
      trade("Laser ya bending", "T09"),
      trade("Moulding machine", "T29"),
      trade("Die casting", "T25"),
      { kind: "ask", label: "Koi aur machine", ask: "free_text" },
    ],
  },
  {
    id: "cnc",
    phrases: ["cnc operator", "cnc ka kaam"],
    prompt: "CNC me kaunsi machine chalate hain?",
    chips: [
      trade("Turning / lathe", "T01"),
      trade("VMC / HMC", "T02"),
      trade("Grinding", "T03"),
      trade("Wire cut / EDM", "T17"),
      trade("Router / engraving", "T21"),
      trade("Laser / bending / punch", "T09"),
    ],
  },
  {
    id: "helper",
    phrases: ["helper", "helper ka kaam"],
    prompt: "Aap kis department me helper hain?",
    chips: [
      {
        kind: "next",
        label: "Machine shop",
        next: "machine",
        level: { levelKey: LEVEL.T15, rung: "trainee" },
      },
      { kind: "next", label: "Welding / fabrication", next: "welding-fab" },
      trade("Press shop", "T10", { levelKey: LEVEL.T15, rung: "trainee" }),
      trade("Moulding", "T29", { levelKey: LEVEL.T29, rung: "trainee" }),
      { kind: "next", label: "Foundry / forging", next: "helper-foundry" },
      trade("Assembly", "T15", { levelKey: LEVEL.T15, rung: "trainee" }),
      { kind: "next", label: "Store / dispatch", next: "helper-store" },
      trade("Maintenance", "T13", { levelKey: LEVEL.T13, rung: "trainee" }),
    ],
  },
  {
    id: "helper-foundry",
    phrases: [],
    prompt: "Foundry me ya forging me helper hain?",
    chips: [
      trade("Foundry / casting", "T24", { levelKey: LEVEL.T15, rung: "trainee" }),
      trade("Forging", "T26", { levelKey: LEVEL.T15, rung: "trainee" }),
    ],
  },
  {
    id: "helper-store",
    phrases: [],
    prompt: "Store me ya dispatch me helper hain?",
    chips: [
      trade("Store", "T53", { levelKey: LEVEL.T53, rung: "trainee" }),
      trade("Dispatch", "T55", { levelKey: LEVEL.T55, rung: "trainee" }),
    ],
  },
  {
    id: "engineer",
    phrases: ["engineer hoon", "diploma engineer", "b.tech hoon", "btech hoon", "get", "det"],
    prompt: "Aap kaunse department me kaam karte hain?",
    chips: [
      trade("Production", "T46"),
      trade("Quality", "T37"),
      trade("Maintenance", "T43"),
      trade("Process / ME / IE", "T47"),
      trade("NPD / development", "T48"),
      trade("PPC / planning", "T52"),
      trade("Purchase", "T54"),
      trade("Design", "T58"),
      trade("Service", "T44"),
      trade("Safety", "T49"),
      trade("Project / site", "T50"),
      trade("Sales", "T51"),
    ],
  },
  {
    id: "supervisor",
    phrases: ["supervisor", "in-charge", "incharge", "shift in-charge", "shift incharge"],
    prompt: "Aap kaunsa department sambhalte hain?",
    chips: [
      { kind: "next", label: "Ek machine", next: "machine", level: { levelKey: LEVEL.T45, rung: "supervisor" } },
      trade("A whole line or several trades", "T45"),
      trade("Stores", "T53"),
      { kind: "next", label: "Quality", next: "supervisor-quality" },
      { kind: "next", label: "Maintenance", next: "supervisor-maintenance" },
    ],
  },
  {
    id: "supervisor-quality",
    phrases: [],
    prompt: "Quality me inspector hain ya engineer?",
    chips: [trade("Line ya final inspection", "T16"), trade("Quality engineer", "T37")],
  },
  {
    id: "supervisor-maintenance",
    phrases: [],
    prompt: "Maintenance me technician hain ya engineer?",
    chips: [trade("Maintenance technician", "T13"), trade("Maintenance engineer", "T43")],
  },
  {
    id: "quality",
    phrases: ["quality", "qc", "checking ka kaam", "quality ka kaam"],
    prompt: "Quality me aap kya karte hain?",
    chips: [
      trade("Line ya final inspection", "T16"),
      trade("CMM", "T33"),
      trade("NDT (UT, RT, MPT, DPT)", "T34"),
      trade("Calibration / standards room", "T35"),
      trade("Lab testing (spectro, hardness, UTM)", "T36"),
      trade("PPAP, audit, customer complaint", "T37"),
    ],
  },
  {
    id: "maintenance",
    phrases: ["maintenance", "maintenance ka kaam"],
    prompt: "Maintenance me aap kya dekhte hain?",
    chips: [
      trade("Mechanical", "T13"),
      trade("Electrical", "T14"),
      trade("PLC / automation", "T38"),
      trade("Instruments", "T40"),
      trade("AC / chiller", "T41"),
      trade("Boiler / compressor / DG / ETP", "T42"),
      trade("Planning aur team (engineer)", "T43"),
    ],
  },
  {
    id: "designer",
    phrases: ["designer", "design ka kaam", "cad"],
    prompt: "Aap kaunsa software chalate hain?",
    chips: [
      trade("Sirf AutoCAD 2D", "T05"),
      trade("SolidWorks / CATIA / NX / Creo", "T58"),
      trade("ANSYS / HyperMesh", "T59"),
      trade("PDMS / E3D / SP3D / Plant 3D", "T60"),
      trade("ArtCAM / Aspire", "T21"),
      trade("Mastercam / PowerMill", "T04"),
    ],
  },
  {
    id: "programmer",
    phrases: ["programmer"],
    prompt: "Aap kis cheez ka program banate hain?",
    chips: [
      trade("CAM software se CNC program", "T04"),
      { kind: "next", label: "Machine par hi program", next: "programmer-machine" },
      trade("PLC", "T38"),
      trade("Robot", "T39"),
      trade("CMM", "T33"),
      trade("Laser / bending nesting", "T09"),
    ],
  },
  {
    id: "programmer-machine",
    phrases: [],
    prompt: "Kaunsi machine par program banate hain?",
    chips: [
      trade("Turning / lathe", "T01", { levelKey: LEVEL.T01, rung: "programmer" }),
      trade("VMC / HMC", "T02", { levelKey: LEVEL.T02, rung: "programmer" }),
    ],
  },
  {
    id: "moulding",
    phrases: ["moulding", "moulding ka kaam"],
    prompt: "Kaunsi moulding karte hain?",
    chips: [
      trade("Plastic injection", "T29"),
      trade("Blow", "T30"),
      trade("Rubber", "T32"),
      trade("Sand moulding (foundry)", "T24"),
      trade("Mould banata hoon (tool room)", "T07"),
    ],
  },
  {
    id: "die",
    phrases: ["die ka kaam", "mould ka kaam"],
    prompt: "Die ya mould banate hain, ya us par production karte hain?",
    chips: [
      trade("Banata / repair karta hoon", "T07"),
      trade("Design karta hoon", "T58"),
      trade("Press par production", "T10"),
      trade("Moulding machine par", "T29"),
      trade("Die casting machine par", "T25"),
      trade("Forging", "T26"),
    ],
  },
  {
    id: "welding-fab",
    phrases: ["welding aur fabrication", "fabrication aur welding"],
    prompt: "Zyada kaam welding ka hai ya marking, cutting aur fit-up ka?",
    chips: [
      trade("Welding", "T08"),
      trade("Marking, cutting, fit-up", "T22"),
      trade("Patli sheet, laser, bending", "T09"),
    ],
  },
  {
    id: "fitter",
    phrases: ["fitter", "fitting ka kaam"],
    prompt: "Aap kahaan fitting karte hain?",
    chips: [
      trade("Assembly, maintenance ya pipe fitting", "T12"),
      trade("Line par ek hi station", "T15"),
      trade("Structure / plate fit-up", "T22"),
    ],
  },
  {
    id: "electrician",
    phrases: ["electrician", "electrician hoon"],
    prompt: "Aap kaunsa electrical kaam karte hain?",
    chips: [
      trade("Factory wiring, motor, panel", "T14"),
      trade("PLC program bhi", "T38"),
      trade("Instrument", "T40"),
      trade("AC / chiller", "T41"),
    ],
  },
  {
    id: "store",
    phrases: ["store", "godown", "warehouse", "store me kaam"],
    prompt: "Store me aapka kaam kya hai?",
    chips: [
      trade("Material receive, issue, entry", "T53"),
      trade("Packing aur dispatch", "T55"),
      trade("Forklift", "T56"),
    ],
  },
  {
    id: "driver",
    phrases: ["driver", "forklift", "crane", "gaadi chalata hoon"],
    prompt: "Aap kaunsi gaadi ya crane chalate hain?",
    chips: [
      trade("Forklift / reach truck / stacker", "T56"),
      trade("EOT / overhead / hydra crane", "T57"),
      { kind: "outOfScope", label: "Truck ya tempo" },
    ],
  },
  {
    id: "lab",
    phrases: ["lab", "testing", "lab testing", "lab me kaam"],
    prompt: "Lab me kaunsi testing karte hain?",
    chips: [
      trade("Spectro, hardness, UTM, microstructure", "T36"),
      trade("Calibration", "T35"),
      trade("NDT", "T34"),
      trade("CMM", "T33"),
    ],
  },
  {
    id: "installation",
    phrases: [
      "installation engineer",
      "commissioning engineer",
      "installation engineer hoon",
      "commissioning engineer hoon",
    ],
    prompt: "Machine service karte hain ya plant erection?",
    chips: [trade("Machine service", "T44"), trade("Plant erection", "T50")],
  },
];

export const ROUTING_ENTRY_BY_ID: ReadonlyMap<string, RoutingEntry> = new Map(
  ROUTING_TABLE.map((e) => [e.id, e]),
);
