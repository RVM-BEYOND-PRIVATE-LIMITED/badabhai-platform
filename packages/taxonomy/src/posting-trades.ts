import type { TradeFormKindName } from "@badabhai/types";
import type { TradeLevel } from "./trade-levels";

/**
 * THE 16 TRADES THE JOB-POSTING FORM CATERS TODAY.
 *
 * The owner ruled (2026-11-03) that only these trades are postable right now. The five
 * polymer roles in `TRADE_FORM_KINDS_ALL` stay declared on the worker side — removing them
 * would be a breaking change — but they are deliberately absent from the posting picker and
 * from this catalogue: there is no posting question pack for them yet.
 *
 * THIS IS THE ONE DECLARATION between a posting's `role_kind`, the trade's worker question
 * pack, its base `mskill_*`, and the CEO launch-pack ladder. The API builds the posting form
 * from the packs themselves (so question text and chips can never drift), and this file
 * supplies the four things a pack does not carry: the pack id, the family id, the base match
 * skill and the display-only ladder.
 *
 * WHAT A LADDER IS, AND IS NOT. Posting a rung never changes `job_reach`; it is the
 * collar/function fact the payer states and the worker reads. The error to avoid is treating
 * a rung as a filter — a "Setter" posting must still reach every turner the match skills
 * reach. Since engine v1.1 (ADR-0061) the rung SORTS the applicant list of the 4 CNC trades
 * ("Level needed", sort never hide); that rung order lives in `level-needed.ts`, not here.
 *
 * ADDING A 17TH TRADE IS ONE ROW. No migration (the DB validates only the jsonb shape), no
 * second form, no new branch in either client: the API's posting-trades route reflects this
 * list and both forms render whatever it returns.
 */
export const POSTING_TRADE_KINDS = [
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

export type PostingTradeKind = (typeof POSTING_TRADE_KINDS)[number];

const POSTING_TRADE_KIND_SET: ReadonlySet<string> = new Set(POSTING_TRADE_KINDS);

/** Whether a value is one of the 16 postable trades. */
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
}

/**
 * The catalogue. Ladder data is copied from the CEO Launch Pack v1 trade sheets
 * (2026-11-02, reconciled) exactly as the job-posting reference lists it.
 */
export const POSTING_TRADES: readonly PostingTrade[] = [
  {
    roleKind: "cnc_turner",
    packId: "qp_cnc_turning",
    familyId: "fam_cnc_turning",
    matchSkillId: "mskill_cnc_turner",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "load/unload, deburr",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "vmc_milling",
    packId: "qp_vmc_milling",
    familyId: "fam_vmc_milling",
    matchSkillId: "mskill_vmc_operator",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "load/unload",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "cnc_grinding",
    packId: "qp_cnc_grinding",
    familyId: "fam_cnc_grinding",
    matchSkillId: "mskill_cnc_grinding_operator",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "load/unload",
        confirmed: false,
        priceTier: "lower",
      },
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
        rung: "junior_programmer",
        monthsFloor: "1-2",
        evidence: "assisted programming",
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
        rung: "senior_programmer",
        monthsFloor: "5+",
        evidence: "prove-out + optimisation",
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
        rung: "draughtsman",
        monthsFloor: "1+",
        evidence: "2D drafting",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "trainee_modeller",
        monthsFloor: "1-2",
        evidence: "3D assisting",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "cad_designer",
        monthsFloor: "2+",
        evidence: "2D ownership",
        confirmed: false,
        priceTier: "lower",
      },
      {
        rung: "senior_draughtsman",
        monthsFloor: "4+",
        evidence: "checked drawings",
        confirmed: true,
        priceTier: "higher",
      },
      {
        rung: "senior_designer",
        monthsFloor: "5+",
        evidence: "design ownership",
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
    ],
  },
  {
    roleKind: "conventional_machinist",
    packId: "qp_conventional_machining",
    familyId: "fam_conventional_machining",
    matchSkillId: "mskill_conventional_machinist",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "load/unload",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "tool_die_maker",
    packId: "qp_tool_die_making",
    familyId: "fam_tool_die_making",
    matchSkillId: "mskill_tool_die_maker",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "assist",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "welder",
    packId: "qp_welding_trade",
    familyId: "fam_welding_trade",
    matchSkillId: "mskill_welder",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "tack, grind, assist",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "sheet_metal_worker",
    packId: "qp_sheet_metal_fab",
    familyId: "fam_sheet_metal_fab",
    matchSkillId: "mskill_sheet_metal_worker",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "handle/stack",
        confirmed: false,
        priceTier: "lower",
      },
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
    ],
  },
  {
    roleKind: "press_operator",
    packId: "qp_press_operation",
    familyId: "fam_press_operation",
    matchSkillId: "mskill_press_operator",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "load/unload",
        confirmed: false,
        priceTier: "lower",
      },
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
        rung: "skilled",
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
    ],
  },
  {
    roleKind: "painter_coating",
    packId: "qp_powder_coating",
    familyId: "fam_powder_coating",
    matchSkillId: "mskill_painter_coater",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "mask/load",
        confirmed: false,
        priceTier: "lower",
      },
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
    ],
  },
  {
    roleKind: "fitter",
    packId: "qp_fitter",
    familyId: "fam_fitter",
    matchSkillId: "mskill_fitter",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "assist",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "maintenance_technician",
    packId: "qp_maintenance_tech",
    familyId: "fam_maintenance_tech",
    matchSkillId: "mskill_maintenance_technician",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "assist",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "industrial_electrician",
    packId: "qp_industrial_electrician",
    familyId: "fam_industrial_electrician",
    matchSkillId: "mskill_industrial_electrician",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "assist",
        confirmed: false,
        priceTier: "lower",
      },
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
  },
  {
    roleKind: "assembly_line_worker",
    packId: "qp_assembly_line",
    familyId: "fam_assembly_line",
    matchSkillId: "mskill_assembly_line_worker",
    ladder: [
      {
        rung: "helper",
        monthsFloor: "0-1",
        evidence: "line feeding",
        confirmed: false,
        priceTier: "lower",
      },
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
    ],
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
        rung: "lead",
        monthsFloor: "7+",
        evidence: "QC lead",
        confirmed: true,
        priceTier: "higher",
      },
    ],
  },
] as const;

const POSTING_TRADE_BY_KIND: ReadonlyMap<string, PostingTrade> = new Map(
  POSTING_TRADES.map((trade) => [trade.roleKind, trade]),
);

/** The posting trade for a role kind, or undefined for the five non-postable roles. */
export function postingTradeFor(roleKind: string | null | undefined): PostingTrade | undefined {
  return roleKind == null ? undefined : POSTING_TRADE_BY_KIND.get(roleKind);
}
