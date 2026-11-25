import type { TradeFormKindName } from "@badabhai/types";
import { TRADES_V2_RUNG_EVIDENCE } from "./posting-trades-v2-evidence";
import { TRADE_CATALOGUE, type TradeCatalogueEntry } from "./trade-catalogue";
import type { TradeLevel } from "./trade-levels";

/**
 * THE 60 TRADES A COMPANY MAY POST (CEO pack v2, ruled 23 Nov 2026; #3005).
 *
 * The owner ruled (2026-11-03) that 16 trades were postable; the CEO pack v2 makes all 60
 * postable. DECLARED IS NOT OFFERED: a trade is offered on the posting form and accepted by
 * posting validation only while its release switch is on (`trade_release.posting_enabled`,
 * #3002, read by the API's `PostingTradesService`). The 16 live trades are seeded on; the 44
 * new ones ship off and the owner switches each wave on (#3013).
 *
 * THIS IS THE ONE DECLARATION between a posting's `role_kind`, the trade's worker question
 * pack, its base `mskill_*`, and the CEO launch-pack ladder. The API builds the posting form
 * from the packs themselves (so question text and chips can never drift), and this file
 * supplies the five things a pack does not carry: the pack id, the family id, the base match
 * skill, the display-only ladder and the ordered question keys a posting may ask.
 *
 * WHAT A LADDER IS, AND IS NOT. Posting a rung never changes `job_reach`; it is the
 * collar/function fact the payer states and the worker reads. The error to avoid is treating
 * a rung as a filter — a "Setter" posting must still reach every turner the match skills
 * reach. Since engine v1.1 (ADR-0061) the rung SORTS the applicant list of the 4 CNC trades
 * ("Level needed", sort never hide); that rung order lives in `level-needed.ts`, not here.
 *
 * ADDING A TRADE IS ONE CATALOGUE ROW. No migration (the DB validates only the jsonb shape), no
 * second form, no new branch in either client: the API's posting-trades routes reflect this
 * list (filtered by the release switch) and both forms render whatever they return.
 */

/**
 * The 16 trades that were postable before trades v2 (owner ruling 2026-11-03). Still a list of
 * its own because three readers must keep exactly these: the migration-0198 seed of the
 * release switch, the matching scope (`posting-scope.ts`: related expansion of a live job must
 * not reach a trade nobody has switched on), and the old `GET /payer/posting-trades` route that
 * installed company apps read (#3006).
 */
export const LIVE_POSTING_TRADE_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
  "cad_draughtsman",
  "conventional_machinist",
  "tool_die_maker",
  "welder",
  "sheet_metal_worker",
  "press_operator",
  "painter_coating",
  "fitter",
  "maintenance_technician",
  "industrial_electrician",
  "assembly_line_worker",
  "quality_inspector",
] as const satisfies readonly TradeFormKindName[];

/**
 * The 44 trades the CEO pack v2 adds to the posting catalogue, in `TRADE_CATALOGUE` order
 * (Wave 1, 2, 3). Every one ships with its release switch off.
 */
export const TRADES_V2_POSTING_KINDS = [
  // Wave 1
  "edm_wirecut_operator",
  "cnc_router_operator",
  "foundry_operator",
  "die_casting_operator",
  "forging_operator",
  "heat_treatment_technician",
  "injection_moulding_operator",
  "cmm_operator",
  "quality_engineer",
  "plc_automation_technician",
  "maintenance_engineer",
  "production_supervisor",
  "production_engineer",
  "process_engineer",
  "npd_engineer",
  "ppc_engineer",
  "purchase_engineer",
  "cad_designer_3d",
  // Wave 2
  "gear_cutting_operator",
  "boring_machine_operator",
  "spm_finishing_operator",
  "fabricator",
  "tube_bending_operator",
  "plating_operator",
  "blow_moulding_operator",
  "plastic_extrusion_operator",
  "rubber_moulding_operator",
  "ndt_technician",
  "calibration_technician",
  "material_lab_technician",
  "robot_operator_programmer",
  "instrumentation_technician",
  "hvac_rac_technician",
  "utility_operator",
  "forklift_operator",
  "crane_operator",
  // Wave 3
  "service_engineer",
  "safety_officer",
  "project_site_engineer",
  "technical_sales_engineer",
  "store_keeper",
  "dispatch_logistics_executive",
  "cae_analyst",
  "piping_designer",
] as const satisfies readonly TradeFormKindName[];

/** Every postable trade: the 16 live ones first, then the 44 of trades v2. */
export const POSTING_TRADE_KINDS = [...LIVE_POSTING_TRADE_KINDS, ...TRADES_V2_POSTING_KINDS] as const;

export type PostingTradeKind = (typeof POSTING_TRADE_KINDS)[number];
export type LivePostingTradeKind = (typeof LIVE_POSTING_TRADE_KINDS)[number];

const POSTING_TRADE_KIND_SET: ReadonlySet<string> = new Set(POSTING_TRADE_KINDS);
const LIVE_POSTING_TRADE_KIND_SET: ReadonlySet<string> = new Set(LIVE_POSTING_TRADE_KINDS);

/** Whether a value is one of the 16 trades postable before trades v2. */
export function isLivePostingTradeKind(value: unknown): value is LivePostingTradeKind {
  return typeof value === "string" && LIVE_POSTING_TRADE_KIND_SET.has(value);
}

/**
 * Whether a value is one of the 60 declared postable trades. Declared only: whether a company
 * may post it NOW is the release switch's answer, which the API reads.
 */
export function isPostingTradeKind(value: unknown): value is PostingTradeKind {
  return typeof value === "string" && POSTING_TRADE_KIND_SET.has(value);
}

/** One rung of a trade's CEO launch-pack ladder. */
export interface PostingTradeLadderRung {
  /** The stored/closed `TradeLevel` key. */
  readonly rung: TradeLevel;
  /** The months floor as authored ("2+", "2-3+"). A band, never a promise. */
  readonly monthsFloor: string;
  /** The evidence gate that separates this rung from the one below it. */
  readonly evidence: string;
  /** True when this rung is one of the ladder's separating/confirmed rungs. */
  readonly confirmed: boolean;
  /** The ₹40 unlock hook tier the rung prices at. Display-only in V1. */
  readonly priceTier: "lower" | "higher";
}

/** One postable trade and everything the posting side needs that a pack cannot carry. */
export interface PostingTrade {
  readonly roleKind: PostingTradeKind;
  /** The worker question pack this trade's posting fields are built from. */
  readonly packId: string;
  /** The profiling family that owns that pack. */
  readonly familyId: string;
  /** The trade's own `mskill_*` — always part of a posting's match set. */
  readonly matchSkillId: string;
  /** Display-only ladder, lowest rung first. */
  readonly ladder: readonly PostingTradeLadderRung[];
  /**
   * Rung keys an older catalogue offered and the CEO sheets dropped (#2550). A posting that
   * stored one still loads and saves; the form never offers it again.
   */
  readonly legacyRungs: readonly TradeLevel[];
  /**
   * The ordered question keys a posting of this trade may ask (#3005), from
   * `TRADE_CATALOGUE.postingQuestionKeys`. Every select question of the sheet except the
   * experience question, the level question, each `…_confirm` and each question asked only at
   * zero experience. For the 16 live trades it is exactly what the retired key-ending filter
   * yielded from each active pack.
   */
  readonly postingQuestionKeys: readonly string[];
}

/**
 * The catalogue. RUNGS are the CEO Launch Plan Pack v1 sheet ladders, the same ladder the
 * worker answers (30 Oct ruling Q2; #2550): each trade's keys, order, confirmed rung and tier.
 * A separate "Helper" rung is not a sheet rung (§2: helper -> trainee), so it is a legacy key.
 * Months floors and evidence come from the 16-trade build reference (2026-11-03); a rung that
 * reference lacks (CAM lead; the supervisor of 2D, sheet metal, press, painter and assembly)
 * takes its evidence from the sheet and its months floor from the nearest analogue. Neither
 * field is displayed today.
 */
const LIVE_POSTING_TRADE_ROWS: readonly Omit<PostingTrade, "postingQuestionKeys">[] = [
  {
    roleKind: "cnc_turner",
    packId: "qp_cnc_turning",
    familyId: "fam_cnc_turning",
    matchSkillId: "mskill_cnc_turner",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI, helper signals",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "proven program, wear offset",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "setter",
        monthsFloor: "2+",
        evidence: "work/tool offsets, first piece",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "setter_programmer",
        monthsFloor: "2-3+",
        evidence: "edit at control",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "programmer",
        monthsFloor: "3-5+",
        evidence: "new program from drawing",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "7+",
        evidence: "5-20 machines + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "vmc_milling",
    packId: "qp_vmc_milling",
    familyId: "fam_vmc_milling",
    matchSkillId: "mskill_vmc_operator",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "proven program",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "setter",
        monthsFloor: "2+",
        evidence: "zero/G54, fixture",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "setter_programmer",
        monthsFloor: "2-3+",
        evidence: "edit at control",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "programmer",
        monthsFloor: "3-5+",
        evidence: "Mastercam/PowerMill/NX",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "7+",
        evidence: "line + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "cnc_grinding",
    packId: "qp_cnc_grinding",
    familyId: "fam_cnc_grinding",
    matchSkillId: "mskill_cnc_grinding_operator",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "proven cycle",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "setter",
        monthsFloor: "2+",
        evidence: "wheel dress, offsets",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "setter_programmer",
        monthsFloor: "2-3+",
        evidence: "edit at control",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "7+",
        evidence: "cell + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "cam_programmer",
    packId: "qp_cam_programming",
    familyId: "fam_cam_programming",
    matchSkillId: "mskill_cam_programmer",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "junior, proving out",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "programmer",
        monthsFloor: "2-3+",
        evidence: "independent G-code/CAM",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "5+",
        evidence: "prove-out + optimisation",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "lead",
        monthsFloor: "7+",
        evidence: "owns the CAM desk, trains programmers",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "7+",
        evidence: "desk + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["junior_programmer", "senior_programmer"],
  },
  {
    roleKind: "cad_draughtsman",
    packId: "qp_cad_drafting",
    familyId: "fam_cad_drafting",
    matchSkillId: "mskill_designer",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "fresher, ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "designer",
        monthsFloor: "1+",
        evidence: "2D drafting",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "senior_designer",
        monthsFloor: "4+",
        evidence: "checked drawings",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "lead",
        monthsFloor: "7+",
        evidence: "desk lead",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "drawing office head",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["draughtsman", "trainee_modeller", "cad_designer", "senior_draughtsman"],
  },
  {
    roleKind: "conventional_machinist",
    packId: "qp_conventional_machining",
    familyId: "fam_conventional_machining",
    matchSkillId: "mskill_conventional_machinist",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI workshop",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "centre lathe / mill",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "3+",
        evidence: "tool grinding, drawings",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "6+",
        evidence: "complex setups",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "shop + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "tool_die_maker",
    packId: "qp_tool_die_making",
    familyId: "fam_tool_die_making",
    matchSkillId: "mskill_tool_die_maker",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1-2",
        evidence: "grinder/mill/lathe in tool room",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "3+",
        evidence: "die assembly, tryout",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "6+",
        evidence: "complex dies",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "tool room lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "welder",
    packId: "qp_welding_trade",
    familyId: "fam_welding_trade",
    matchSkillId: "mskill_welder",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI welder",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "one process independently",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "2-3+",
        evidence: "multi-process + symbols",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "5+",
        evidence: "pipe/pressure, thin sheet",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "fab + people",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "sheet_metal_worker",
    packId: "qp_sheet_metal_fab",
    familyId: "fam_sheet_metal_fab",
    matchSkillId: "mskill_sheet_metal_worker",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI sheet metal",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "shear/punch/brake",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "3+",
        evidence: "layout, bending programs",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "6+",
        evidence: "complex fab",
        confirmed: true,
        priceTier: "higher",
      },
      // #2753 item 1 — the worker pack's @3 splits "Senior / Programmer", so the posting can ask
      // for a programmer apart from a senior operator. The 16-trade reference has no row for it:
      // the evidence is the sheet's own separating question, the months floor the senior's.
      {
        rung: "programmer",
        monthsFloor: "6+",
        evidence: "own nesting / press-brake programs",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "fabrication shop in-charge",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "press_operator",
    packId: "qp_press_operation",
    familyId: "fam_press_operation",
    matchSkillId: "mskill_press_operator",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "one press independently",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "setter",
        monthsFloor: "2-3+",
        evidence: "die setting, first piece",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "5+",
        evidence: "progressive/deep-drawing",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "press shop in-charge",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper", "skilled"],
  },
  {
    roleKind: "painter_coating",
    packId: "qp_powder_coating",
    familyId: "fam_powder_coating",
    matchSkillId: "mskill_painter_coater",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI painter",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "gun independently",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "2-3+",
        evidence: "DFT, curing, touch-up",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "5+",
        evidence: "shade + oven ownership",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "paint shop in-charge",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "fitter",
    packId: "qp_fitter",
    familyId: "fam_fitter",
    matchSkillId: "mskill_fitter",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI fitter",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "bench + assembly",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "3+",
        evidence: "preventive + breakdown",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "6+",
        evidence: "overhaul, bearings",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "maintenance lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "maintenance_technician",
    packId: "qp_maintenance_tech",
    familyId: "fam_maintenance_tech",
    matchSkillId: "mskill_maintenance_technician",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "technician",
        monthsFloor: "2+",
        evidence: "preventive + breakdown",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "senior_technician",
        monthsFloor: "5+",
        evidence: "condition monitoring, shutdowns",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "maintenance lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "industrial_electrician",
    packId: "qp_industrial_electrician",
    familyId: "fam_industrial_electrician",
    matchSkillId: "mskill_industrial_electrician",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI electrician",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "technician",
        monthsFloor: "2+",
        evidence: "panel + motor",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "senior_technician",
        monthsFloor: "5+",
        evidence: "drives, MCC/PCC, starters",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "electrical lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "assembly_line_worker",
    packId: "qp_assembly_line",
    familyId: "fam_assembly_line",
    matchSkillId: "mskill_assembly_line_worker",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "ITI / fresher",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "operator",
        monthsFloor: "1+",
        evidence: "one stage independently",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "skilled",
        monthsFloor: "2-3+",
        evidence: "rework, end-of-line",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior",
        monthsFloor: "5+",
        evidence: "line ownership",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "8+",
        evidence: "assembly in-charge / shift supervisor",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["helper"],
  },
  {
    roleKind: "quality_inspector",
    packId: "qp_quality_inspection",
    familyId: "fam_quality_inspection",
    matchSkillId: "mskill_quality_inspector",
    ladder: [
      {
        rung: "trainee",
        monthsFloor: "0-1",
        evidence: "fresher, gauges",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "inspector",
        monthsFloor: "1-2",
        evidence: "incoming/in-process/final",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "senior_inspector",
        monthsFloor: "3-4+",
        evidence: "layout, CMM assist",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "qc_engineer",
        monthsFloor: "4-5+",
        evidence: "PPAP, Gauge R&R, reports",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "supervisor",
        monthsFloor: "7+",
        evidence: "QC lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
    legacyRungs: ["lead"],
  },
] as const;

const CATALOGUE_BY_KIND: ReadonlyMap<string, TradeCatalogueEntry> = new Map(
  TRADE_CATALOGUE.map((entry) => [entry.roleKind, entry]),
);

function catalogueEntry(roleKind: string): TradeCatalogueEntry {
  const entry = CATALOGUE_BY_KIND.get(roleKind);
  if (entry === undefined) throw new Error(`posting trade ${roleKind} has no TRADE_CATALOGUE row`);
  return entry;
}

/**
 * The months floor a trades-v2 rung takes from the live ladders (not displayed, like the 16's
 * own). A rung the live ladders use takes the floor most of them give it; the four desk and
 * supply-chain rungs of #3000, which no live ladder has, take the floor of the live rung in the
 * same place on a ladder: engineer = designer, senior engineer = senior designer, executive =
 * operator, senior executive = senior.
 */
const RUNG_FLOOR_ANALOGUE: Readonly<Record<string, TradeLevel>> = {
  engineer: "designer",
  senior_engineer: "senior_designer",
  executive: "operator",
  senior_executive: "senior",
};

const LIVE_RUNG_FLOOR: ReadonlyMap<string, string> = (() => {
  const counts = new Map<string, Map<string, number>>();
  for (const trade of LIVE_POSTING_TRADE_ROWS) {
    for (const { rung, monthsFloor } of trade.ladder) {
      const byFloor = counts.get(rung) ?? new Map<string, number>();
      byFloor.set(monthsFloor, (byFloor.get(monthsFloor) ?? 0) + 1);
      counts.set(rung, byFloor);
    }
  }
  const out = new Map<string, string>();
  for (const [rung, byFloor] of counts) {
    // Most common floor; a tie goes to the floor seen first (catalogue order), deterministic.
    let best: [string, number] | null = null;
    for (const entry of byFloor) if (best === null || entry[1] > best[1]) best = entry;
    out.set(rung, best![0]);
  }
  return out;
})();

function monthsFloorFor(rung: string): string {
  const floor = LIVE_RUNG_FLOOR.get(RUNG_FLOOR_ANALOGUE[rung] ?? rung);
  if (floor === undefined) throw new Error(`no live months floor for rung ${rung}`);
  return floor;
}

/**
 * One trades-v2 posting trade, generated from its catalogue row: the sheet's ladder in sheet
 * order, `confirmed` from "Confirmed from" and `priceTier` from "Higher contact price from".
 */
function postingTradeFromCatalogue(roleKind: PostingTradeKind): PostingTrade {
  const entry = catalogueEntry(roleKind);
  const rungs = entry.ladder.map((rung) => rung.rung);
  const confirmedAt = rungs.indexOf(entry.confirmedFrom);
  const higherAt = rungs.indexOf(entry.higherPriceFrom);
  if (confirmedAt < 0 || higherAt < 0) {
    throw new Error(`${roleKind}: confirmedFrom/higherPriceFrom is not a ladder rung`);
  }
  const evidence = TRADES_V2_RUNG_EVIDENCE[roleKind] ?? {};
  return {
    roleKind,
    packId: entry.packId,
    familyId: entry.familyId,
    matchSkillId: entry.matchSkillId,
    ladder: rungs.map((rung, i) => ({
      rung: rung as TradeLevel,
      monthsFloor: monthsFloorFor(rung),
      evidence: evidence[rung] ?? entry.ladder[i]!.label,
      confirmed: i >= confirmedAt,
      priceTier: i >= higherAt ? "higher" : "lower",
    })),
    legacyRungs: [],
    postingQuestionKeys: entry.postingQuestionKeys,
  };
}

/**
 * The catalogue: the 16 live trades (hand-kept rows above, unchanged), then the 44 of trades
 * v2 generated from `TRADE_CATALOGUE`. Every trade's posting question keys come from the
 * catalogue.
 */
export const POSTING_TRADES: readonly PostingTrade[] = [
  ...LIVE_POSTING_TRADE_ROWS.map(
    (trade): PostingTrade => ({
      ...trade,
      postingQuestionKeys: catalogueEntry(trade.roleKind).postingQuestionKeys,
    }),
  ),
  ...TRADES_V2_POSTING_KINDS.map(postingTradeFromCatalogue),
];

const POSTING_TRADE_BY_KIND: ReadonlyMap<string, PostingTrade> = new Map(
  POSTING_TRADES.map((trade) => [trade.roleKind, trade]),
);

/** The posting trade for a role kind (one of the 60 declared), or undefined for any other role. */
export function postingTradeFor(roleKind: string | null | undefined): PostingTrade | undefined {
  return roleKind == null ? undefined : POSTING_TRADE_BY_KIND.get(roleKind);
}
