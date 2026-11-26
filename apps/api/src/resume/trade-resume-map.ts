/**
 * How a ROLE PACK's answers become RESUME ROWS.
 *
 * THE PROBLEM THIS SOLVES. A role pack captures its trade in the worker's own Hinglish — a chip
 * reads "Khraad ya conventional lathe" because that is what a turner in Faridabad calls it, and
 * the chip label is the answer of record verbatim. A resume read by a hiring supervisor needs
 * "Conventional lathe". Those are two different vocabularies for one fact, and something has to
 * hold the correspondence. Neither end can: the pack must stay in the worker's language, and the
 * template must stay layout-only.
 *
 * DETERMINISTIC, STATIC, REVIEWED — NO LLM, exactly like {@link ./trade-content}, and under the
 * same two rules:
 *   1. NOTHING here asserts a fact about a worker. This file is a dictionary; the only values that
 *      reach a resume are the ones that worker actually selected.
 *   2. A value with no entry is DROPPED, never printed raw. A slug like `cnc_lathe` on a printed
 *      sheet, or the literal "Pata nahi" from a none-of-above chip, is worse than an absent row.
 *
 * WHY IT IS KEYED BY PACK. This is the per-role half of "adding a role is data, not code": a new
 * role pack brings its own section map, and nothing in the renderer, the template or the engine
 * changes. Adding the second role means adding one entry here and one pack JSON.
 *
 * ROW ORDER IS THE LOCKED DESIGN'S ORDER, not the pack's ask order. The interview asks what keeps
 * a worker answering; the sheet shows what a supervisor scans for. They are different sequences
 * and both are deliberate.
 */
import type { ResumeFactRow, ResumeListRow } from "./resume-renderer.service";
import { TRADE_LEVEL_PACKS, tradeLevelLabelFor } from "@badabhai/taxonomy";

/** Which block of the sheet a row belongs to, and how its values are drawn. */
export type TradeRowKind = "chips" | "ticks" | "fact";

export interface TradeRowSpec {
  /** The pack `question_key` / attribute key this row reads. */
  readonly from: string;
  /** The English label printed on the sheet. */
  readonly label: string;
  readonly kind: TradeRowKind;
  /**
   * Slug → printed English. A value missing from this table is DROPPED.
   *
   * That is the safety property, not an oversight: `is_none_of_above` chips all carry the value
   * `unknown`, so "Pata nahi" and "Inme se koi nahi" resolve to nothing and simply do not appear.
   * A resume must never print a worker's non-answer as if it were an answer.
   */
  readonly values?: Readonly<Record<string, string>>;
  /** `fact` rows only: how several selected values are joined. Default " · ". */
  readonly join?: string;
  /**
   * A SECOND attribute whose selected values are appended to EACH of this row's chips, with a
   * middot — "VMC · 3-axis" (R10 §2.5, rule 3).
   *
   * WHY THE SHEET DOES THIS AT ALL. The ratified sample prints `VMC · 3-axis`, `VMC · 4-axis`,
   * `SPM` — the configuration is a property OF the machine, not a separate capability, and giving
   * it its own row would spend one of the section's slots restating what the machine chip implies.
   * Appending costs no row.
   *
   * ONE CONFIG PER CHIP, NOT A CROSS PRODUCT. Two machines and two configurations would otherwise
   * produce four chips, three of which the worker never claimed. The values are appended to the
   * FIRST chip only and the rest print bare, which is what the sample shows: the config qualifies
   * the machine it was asked about.
   *
   * ABSENT IS THE ORDINARY CASE, and `qp_vmc_milling` is the case it was built for. The turner's
   * pack has no configuration question — axes are a milling fact — so for a year this seam fired
   * for no shipped map at all. R13 §3.1 is the first time it does, and it is the reason the
   * milling entry could be authored as DATA: without it, "VMC · 3-axis" would have been a change
   * to the renderer.
   */
  readonly configFrom?: string;
  /** Slug → printed English for `configFrom`'s values. Same drop-the-unknown rule as `values`. */
  readonly configValues?: Readonly<Record<string, string>>;
  /**
   * Does this row's CONFIGURATION also earn the Verdict Line's fourth segment? (R16 §1.)
   *
   * OPT-IN PER ROW, AND DELIBERATELY NOT "any row with a `configFrom`". `configFrom` is a general
   * seam — it appends a qualifier to the first chip, and the next pack to use it might qualify a
   * lathe with a bar feeder or a sub-spindle. Deriving the headline's axis segment from every
   * configuration would make each of those print as an "axis", which is the `MEASURING_TOOLS`
   * mistake exactly: a claim about the world resting on the single pack that happened to exist
   * when it was written. One flag, set by the map that means it.
   */
  readonly configInHeadline?: boolean;
  /**
   * Most values this row may print. Quoted from the design guideline §4.3, not invented:
   * machines max 4, controllers max 3, materials max 4.
   *
   * The guideline says "most-used first" for machines. WE DO NOT HAVE USAGE DATA, so the order is
   * the dictionary's and the cap takes the first N of that — deterministic and reviewable. Ranking
   * a worker's machines by a number nobody measured would be inventing a fact about him, which is
   * the one thing this file may never do.
   */
  readonly maxValues?: number;
  /**
   * Survival rank when the section is over budget — LOWER SURVIVES.
   *
   * THE TENS DIGIT IS THE GUIDELINE'S §5.1 RANK; the units digit only breaks ties inside it, so
   * a reader can check any row against the document rather than against a number someone chose.
   *   2x — §5.1 rank 2, machines and controllers: "the literal vocabulary of the job
   *        advertisement, highest-signal attribute in the wedge".
   *   4x — §5.1 rank 4, setting / programming / drawing: "separates a button-presser from a man
   *        who can set the job. This is the whole spread in CNC hiring".
   *   5x — §5.1 rank 5, measuring instruments.
   *   6x — §4.3 wedge attributes below the §5.1 list.
   *   7x — volunteered depth the guideline never names.
   *   8x — §4.3 `sector_tag`: "display only. Never a matching input — locked". Drops first.
   *
   * TURNING CONFIGURATION SITS AT 2x, NOT WITH THE OPTIONAL FIELDS. Live tooling, a bar feeder,
   * a sub-spindle and a Y-axis are a statement about what the MACHINE can do, which is what §5.1
   * rank 2 covers, and it moves the pay band. An earlier ordering dropped it before materials;
   * that was a layout judgement standing in for trade truth. Workholding moved to 4x for the
   * same reason — chucks, collets and steady rests are setting capability.
   *
   * THIS ORDER IS FLAGGED FOR RVM REDLINE (see ASSUMPTIONS.md). It is trade truth, not layout
   * preference, and the shop floor may reorder it; nothing else has to change when it does.
   *
   * THIS IS NOT DISPLAY ORDER. Field order on the page is fixed by §7.1 ("may never vary") and is
   * the array order below, which matches the ratified sheet. Rank only decides what is dropped
   * when there is not enough page; whatever survives still renders in the locked order.
   */
  readonly rank: number;
  /**
   * Feed this row's values into the Verdict Line's third segment.
   *
   * PER-TRADE, AND THAT IS WHY IT IS DATA. The ratified turner sheet leads with CONTROLLERS
   * ("Fanuc, Siemens, Mitsubishi") because that is the literal vocabulary of a CNC job
   * advertisement; a welder's leads with processes and a mechanic's with vehicle classes.
   * Hard-coding "the controllers row" would be right for one trade in three.
   */
  readonly inHeadline?: boolean;
}

/**
 * How many capability rows one A4 page holds.
 *
 * MEASURED FROM THE RATIFIED CORPUS, not chosen — and RE-MEASURED ACROSS ALL TWENTY-ONE PAGES,
 * which is why it is 10 and not 9. The first measurement had three sheets to read (the VMC
 * turner's 9 rows in this section, the welder's 9, the car mechanic's 6) and "nine is the
 * observed ceiling" was true of them. It is FALSE of `BadaBhai_21_Role_Resumes.pdf`.
 *
 * THE COUNT, PAGE BY PAGE — rows between the capability heading and "AVAILABILITY & TERMS", with
 * a wrapped continuation folded into the row it belongs to (`pdftotext -layout`):
 *
 *     10  p2 grinding · p3 machining centre · p4 turning        <- the ceiling, three pages
 *      9  p1 CAM · p16 welder · p18 injection moulding · p21 rubber moulding
 *      8  p7 p9 p10 p11 p12 p13 p14 p15 p17 p19 p20
 *      7  p5 CAD draughtsman · p6 assembly · p8 fitter
 *
 * Nothing in the corpus exceeds ten. Read against what this constant actually gates — rows a pack
 * can PRODUCE, so net of the rows the parity test records as capture gaps — grinding is the sole
 * binding persona at ten askable rows; turning and milling fall to nine (`Turning capacity` and
 * `Table & travel` are unaskable), CAM is nine and the CAD fresher seven. Both readings give 10.
 *
 * THE COST OF THE STALE NUMBER WAS A ROW A HUMAN HAD SIGNED OFF. The grinder answers ten mapped
 * rows and the ratified page prints all ten; a budget of nine shed the worst-ranked of them
 * (`sector_worked`, rank 71) and the sheet lost it silently, with no error. Every other shipped
 * role's ratified persona answers at most nine rows, so nothing else moves.
 *
 * IT HAS TO EXIST BECAUSE A PACK CAN OUT-PRODUCE THE PAGE. `qp_cnc_turning` alone defines 14
 * capability rows, and a worker who answers everything fills all of them — which rendered a
 * two-page PDF. This constant is the coarse pre-emptive cap that stops a pack out-producing the
 * layout, and it is still measured from what a human ratified rather than from what fits.
 *
 * IT IS NOT THE ONE-PAGE RULE ITSELF, and that is why raising it is safe. The page is settled in
 * LINES by `SHEET_LINE_BUDGET` + `degradeToFit` (resume-degradation.ts) — the dimension a page is
 * actually measured in, and the one that prices a row by how far it wraps.
 *
 * ONE PAGE IS THE TARGET, NO LONGER AN ABSOLUTE (owner ruling, 2026-09-03). Raising this to ten
 * puts the grinder's sheet at 41.19 lines against a budget of 41, and under the ruling that sheet
 * SPILLS rather than shedding the sector row back off again: the ladder compresses as hard as it
 * can and then reports `overflows` instead of buying the page with ratified content. An earlier
 * version of this comment ended "never a second page"; that sentence is what the ruling reversed,
 * and the reversal is narrow — a sheet that can be compressed onto one page still must be.
 *
 * ── THIS CONSTANT IS NOW THE ONLY THING LEFT THAT SHEDS A RATIFIED ROW ─────────────────
 *
 * READ THE RULING'S SCOPE BEFORE TRUSTING ITS HEADLINE. "Never shed a ratified row" is true of
 * `degradeToFit`, which no longer runs a step that deletes one. It is NOT true of the rank slice
 * below (`.slice(0, CAPABILITY_ROW_BUDGET)` in `buildTradeCapabilityRows`), which runs BEFORE the
 * ladder ever sees the sheet and is a hard truncation with no ladder, no trace and no
 * `overflows` flag.
 *
 * MEASURED, AND IT STILL COSTS A ROW ALL TWENTY-ONE PAGES PRINT. Every ratified page ends its
 * capability block with a sector row (twenty "Sector worked", p5 "Sector studied"), and
 * `sector_worked` is ranked 81 — last — in both the turner and the miller maps. So a turner who
 * answers all fourteen of his pack's questions and a miller who answers all thirteen both lose
 * it: `yadav-parity.emit.test.ts` and `trade-resume-map.test.ts` assert that loss as today's
 * shipped outcome rather than hiding it. Raising this to ten bought back `tolerance_band` (rank
 * 62) and did not reach rank 81.
 *
 * WHY IT IS NOT FIXED HERE. Raising the budget further would put rows on a sheet no human has
 * ratified at that density, and re-ranking `sector_worked` to save it would be exactly the
 * substitution of layout preference for trade truth the turner map's own rank comment warns
 * against — §4.3 calls the sector "display only, never a matching input", which is WHY it ranks
 * last. Both are pack/ranking rulings (the open Q2 redline), not renderer changes.
 */
export const CAPABILITY_ROW_BUDGET = 10;

export interface TradeResumeMap {
  readonly pack_id: string;
  /**
   * The FIRST section's heading on the sheet — per-trade, and therefore data.
   *
   * A turner's sheet says "Machines, controllers & capability"; a welder's says "Processes,
   * positions & capability"; a car mechanic's says "Vehicles, systems & tools". Every other
   * heading is a literal in the template because the guideline's zone map fixes them; this one
   * names the trade's own vocabulary and would be wrong for two roles out of three if it were
   * hard-coded. It lives beside the rows it titles so a new role is still one entry in one file.
   */
  readonly section_title: string;
  /**
   * TIERED PROFILING — the first section's heading when a tier leaves out a whole group the
   * full heading names. "Machines, controllers & capability" prints as "Machines & controllers"
   * on an Easy sheet, because Easy asks none of the capability rows (the approved Easy targets
   * in `docs/profiling-tiers/`). A tier with no entry prints `section_title`, which is why Medium
   * — which keeps capability rows — has none, and Hard never reads this at all.
   *
   * HERE, BESIDE `section_title`, AND NOT IN THE TEMPLATE, because the fabrication gate accepts
   * only headings this map declares: a heading is data a reviewer signs off, not layout.
   */
  readonly tier_section_titles?: Readonly<Partial<Record<"easy" | "medium", string>>>;
  readonly capability: readonly TradeRowSpec[];
}

/**
 * The TURNER's instruments.
 *
 * IT WAS CALLED "shared by every machining-family pack: the instruments do not change by role",
 * AND THAT WAS WRONG THE FIRST TIME A SECOND ROLE WAS AUTHORED. The ratified milling sheet prints
 * a SNAP GAUGE, which a turner does not use; a turner's plug / ring gauge checks a bore he just
 * bored. Same attribute name, different instruments, and the reuse only looked safe while there
 * was one entry to compare it against.
 *
 * SCOPE UNCHANGED BY THIS FILE. `qp_machining` sharing this mapping is Q14, which is with RVM;
 * milling authoring its own dictionary neither answers that question nor pre-empts it.
 */
const TURNING_MEASURING_TOOLS: Readonly<Record<string, string>> = {
  vernier: "Vernier",
  micrometer: "Micrometer",
  bore_gauge: "Bore dial gauge",
  height_gauge: "Height gauge",
  plug_gauge: "Plug / ring gauge",
  dial_indicator: "Dial indicator",
};

export const TRADE_RESUME_MAPS: readonly TradeResumeMap[] = [
  {
    pack_id: "qp_cnc_turning",
    section_title: "Machines, controllers & capability",
    tier_section_titles: { easy: "Machines & controllers" },
    capability: [
      {
        from: "turning_machine",
        rank: 21,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          cnc_lathe: "CNC lathe / turning centre",
          conventional_lathe: "Conventional lathe",
          vtl: "VTL",
          sliding_head: "Sliding head (Swiss)",
          // E1 — slot-2 machine options added to qp_cnc_turning@4. Values print
          // verbatim; keys are the stored value_text.
          turn_mill: "Turn-mill",
          // Track A #1 (@6): live_tool and c_axis machine chips merged away —
          // the turn_mill chip now reads "Turn-mill / live tool" and C-axis
          // lives on the advanced_capability row. Their old machine answers
          // drop off the sheet (recorded cost of the sheet-1 machine set).
          twin_spindle: "Twin spindle",
          spm: "SPM",
          // Track A #1 (@6): the CNC + conventional combo chip.
          both_types: "CNC + conventional",
        },
      },
      {
        from: "controller_brand",
        rank: 22,
        inHeadline: true,
        maxValues: 3,
        label: "Controllers",
        kind: "chips",
        values: {
          fanuc: "Fanuc",
          siemens: "Siemens",
          mitsubishi: "Mitsubishi",
          haas: "Haas",
          // Track A #1 (@6): Mazatrol is its own chip value (was the E2
          // Mazak synonym; that value no longer exists on the pack, so the
          // old "Mazak" answers drop off the sheet — recorded cost of a
          // week-lived value).
          mazatrol: "Mazatrol",
          fagor: "Fagor",
          syntec: "Syntec",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          mild_steel: "MS",
          alloy_steel: "EN8 / EN31",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          brass: "Brass",
          cast_iron: "Cast iron",
          // Track A #1 (@6) — Advanced Q10 per sheet 1.
          titanium: "Titanium / Inconel",
          plastic: "Plastics",
        },
      },
      {
        from: "turning_operation",
        rank: 63,
        label: "Operations",
        kind: "ticks",
        values: {
          facing_od: "Facing / OD turning",
          boring: "Boring / ID turning",
          threading: "Threading",
          grooving: "Grooving / parting",
          drilling: "Drilling / tapping",
          knurling: "Knurling / taper",
          // Track A #1 (@6) — Advanced Q9 per sheet 1.
          hard_turning: "Hard turning",
        },
      },
      {
        from: "workholding",
        rank: 42,
        label: "Workholding",
        kind: "ticks",
        values: {
          three_jaw: "3-jaw chuck",
          four_jaw: "4-jaw chuck",
          collet: "Collet",
          soft_jaw: "Soft jaws",
          tailstock: "Tailstock / centre",
          steady_rest: "Steady rest",
        },
      },
      {
        from: "setting_operation",
        rank: 41,
        label: "Setting",
        kind: "ticks",
        values: {
          tool_offset: "Tool offset",
          work_offset: "Work offset",
          nose_radius: "Tool nose radius compensation",
          jaw_change: "Chuck / jaw change",
          tailstock_set: "Tailstock setting",
          first_piece: "First-piece setup",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: TURNING_MEASURING_TOOLS,
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          spc: "SPC charts",
          rejection: "Rejection analysis",
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          tool_wear: "Tool wear / breakage",
          chatter: "Chatter and vibration",
          size_variation: "Size variation",
          surface_finish: "Surface finish",
          alarm: "Alarm clearing",
        },
      },
      {
        from: "programming_level",
        rank: 43,
        label: "Programming",
        kind: "fact",
        values: {
          // `offset_only` is deliberately NOT "no programming": editing offsets is a real, paid
          // skill on a shop floor, and stating it plainly is more useful to both sides than an
          // absent row that reads as a gap.
          offset_only: "Edits tool offsets",
          edit_program: "Edits programs (G-code / M-code)",
          write_program: "Writes programs (G-code / M-code)",
          cam: "Programs via CAM software",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` has no entry ON PURPOSE. "Cannot read drawings" is a true answer that belongs in
        // matching data, not on the worker's own marketing document — the row simply does not
        // appear, exactly as it would for a worker who was never asked.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        values: {
          "0.10": "±0.10 mm",
          "0.05": "±0.05 mm",
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm or finer",
          // Track A #1 (@6) — Advanced Q11 per sheet 1. @6 retitled the 0.01
          // chip ("0.01 mm ya usse kam"), so the finer row now reads past it.
          "0.005": "±0.005 mm / H7",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automotive components",
          general_engg: "General engineering / job shop",
          pump_valve: "Pumps and valves",
          oil_gas: "Oil and gas",
          defence: "Defence / aerospace",
          agri: "Agricultural equipment",
          // Track A #1 (@6) — Advanced Q12 per sheet 1.
          two_wheeler: "Two-wheeler",
          bearings: "Bearings",
          fasteners: "Fasteners",
        },
      },
      {
        from: "advanced_capability",
        rank: 23,
        label: "Machine capability",
        kind: "fact",
        join: " · ",
        values: {
          live_tooling: "Live tooling",
          bar_feeder: "Bar feeder",
          sub_spindle: "Sub-spindle",
          c_axis: "C-axis",
          y_axis: "Y-axis",
        },
      },
    ],
  },
  {
    /**
     * MILLING — the second entry, and the audit of whether Q8's "trade variation is a data
     * change" is true in practice (R13 §3).
     *
     * WHY MILLING AND NOT SOMETHING EASIER. The ratified BadaBhai sheet IS a VMC sheet, so parity
     * for this pack is measurable against a document rather than against a judgement. Every row
     * below exists because the sample prints it, in the order the sample prints it.
     *
     * WHAT IT SHARES WITH THE TURNER, AND WHY THE VALUES STILL DIFFER. Ten attribute NAMES are
     * common to both packs — and three of them carry different vocabulary here:
     *   · `material_worked` splits EN8 and EN31 into separate chips, because the sample prints
     *     "EN8  EN31" as two; the turner's map compresses them to one chip, "EN8 / EN31".
     *   · `measuring_tools` carries a SNAP GAUGE and not a plug / ring gauge. A plug gauge checks
     *     a bore a turner just bored; a snap gauge checks an outside dimension a miller just cut.
     *   · `setting_operation` is tool LENGTH compensation and fixture setting, where the turner's
     *     is nose radius and tailstock.
     * None of that is expressible while a dictionary is keyed by attribute name alone, which is
     * what R12 §2 fixed. Had this entry been written first, a miller's answers would have been
     * read through a turner's vocabulary and nothing would have said so.
     *
     * ROW COUNT AND THE Q2 REDLINE. Thirteen rows are defined and `CAPABILITY_ROW_BUDGET` is 10,
     * so three drop by rank. The ten that survive are NOT the ten the ratified sheet prints —
     * the sheet shows `Sector worked` and this map's rank order keeps `Workholding` instead. That
     * is a one-row divergence, it is measured rather than asserted (see the map's own test), and
     * it is evidence for Q2 rather than something to fix by inventing a rank. The tens digit is
     * the guideline's §5.1 rank, and bending it to make a page fit is exactly the substitution of
     * layout preference for trade truth that the turner's rank comment warns against.
     *
     * RE-MEASURING THE BUDGET TO TEN DID NOT CLOSE THIS. It bought back `Operations` (rank 63)
     * and stopped there; `sector_worked` is rank 81, last of the thirteen, so the divergence this
     * paragraph records survives the raise unchanged. See `CAPABILITY_ROW_BUDGET`'s own comment,
     * which now names this slice as the last place a ratified row is still shed.
     */
    pack_id: "qp_vmc_milling",
    section_title: "Machines, controllers & capability",
    tier_section_titles: { easy: "Machines & controllers" },
    capability: [
      {
        from: "milling_machine",
        rank: 21,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        // THE FIRST USE OF `configFrom` BY ANY SHIPPED MAP. The sample prints "VMC · 3-axis",
        // "VMC · 4-axis", "SPM" — the axis count is a property OF the machine, and giving it a
        // row of its own would spend one of the section's slots restating what the machine chip
        // already implies. R10 built this seam for exactly this entry.
        configFrom: "axis_capability",
        // R16 §1 — and it is the ratified sheet's own headline: "… · Fanuc, Siemens,
        // Mitsubishi · 3 & 4-axis". The axis count is the one configuration a machining
        // employer scans for, which is why this row opts in and the seam does not assume.
        configInHeadline: true,
        configValues: {
          three_axis: "3-axis",
          four_axis: "4-axis",
          five_axis: "5-axis",
        },
        values: {
          vmc: "VMC",
          // Track A #2 (@6): the sheet-2 machine variants.
          fourth_axis: "VMC + 4th axis",
          five_axis: "5-axis",
          drill_tap: "Drill-tap centre",
          double_column: "Double-column",
          hmc: "HMC",
          conventional_mill: "Conventional milling machine",
          bed_mill: "Bed / knee mill",
          spm: "SPM",
        },
      },
      {
        from: "controller_brand",
        rank: 22,
        inHeadline: true,
        maxValues: 3,
        label: "Controllers",
        kind: "chips",
        values: {
          fanuc: "Fanuc",
          siemens: "Siemens",
          mitsubishi: "Mitsubishi",
          haas: "Haas",
          // A MILLING CONTROLLER THE TURNER'S MAP DOES NOT CARRY. Heidenhain is ubiquitous on
          // machining centres and effectively absent from lathes.
          heidenhain: "Heidenhain",
          // Track A #2 (@6): sheet-2 controller set.
          fagor: "Fagor",
          syntec: "Syntec",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // UNIFIED TO THE TURNER SET (CEO Launch Plan Pack v1, Track A #2, sheet 2:
        // "Material chips (as Turner)"). The EN8/EN31 split the ratified sheet
        // printed is retired: the old en_eight/en_thirty_one answers drop off
        // the sheet (recorded cost, same class as Turner's mazatrol value).
        //
        // DICTIONARY ORDER IS THE SHEET'S ORDER. Values render in the order this object lists
        // them (there is no usage data to rank by, and inventing one would be inventing a fact
        // about the worker), so the alloys lead — which is what the ratified sample prints.
        values: {
          mild_steel: "MS",
          alloy_steel: "EN8 / EN31",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          brass: "Brass",
          cast_iron: "Cast iron",
          // Track A #2 (@6) — Advanced Q11 per sheet 2.
          titanium: "Titanium / Inconel",
          plastic: "Plastics",
        },
      },
      {
        from: "setting_operation",
        rank: 41,
        label: "Setting",
        kind: "ticks",
        values: {
          tool_offset: "Tool offset",
          work_offset: "Work offset",
          tool_length: "Tool length compensation",
          fixture_setting: "Fixture setting",
          first_piece: "First-piece setup",
          tool_change: "Tool change / loading",
        },
      },
      {
        from: "workholding",
        rank: 42,
        label: "Workholding",
        kind: "ticks",
        values: {
          machine_vice: "Machine vice",
          fixture: "Fixture",
          clamp_kit: "Clamps / T-bolts",
          // Track A #2 (@6): sheet-2 chip reads "Rotary table / 4th axis".
          rotary_table: "Rotary table / 4th axis",
          angle_plate: "Angle plate",
          magnetic_chuck: "Magnetic chuck",
          // Track A #2 (@6): sheet-2 workholding.
          vacuum: "Vacuum",
          pallet: "Pallet",
        },
      },
      {
        from: "programming_level",
        rank: 43,
        label: "Programming",
        kind: "fact",
        values: {
          // Same judgement as the turner's, and for the same reason: editing offsets is a real,
          // paid skill, and stating it plainly beats an absent row that reads as a gap.
          offset_only: "Edits tool offsets",
          edit_program: "Edits programs (G-code / M-code)",
          write_program: "Writes programs (G-code / M-code)",
          cam: "Programs via CAM software",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` has no entry ON PURPOSE, exactly as on the turner's map. "Cannot read drawings"
        // is a true answer that belongs in matching data, not on the worker's own document.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier",
          micrometer: "Micrometer",
          bore_gauge: "Bore dial gauge",
          height_gauge: "Height gauge",
          snap_gauge: "Snap gauge",
          dial_indicator: "Dial indicator",
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        values: {
          "0.10": "±0.10 mm",
          "0.05": "±0.05 mm",
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm or finer",
          // Track A #2 (@6) — Advanced Q11 per sheet 2.
          "0.005": "±0.005 mm / H7",
        },
      },
      {
        from: "milling_operation",
        rank: 63,
        label: "Operations",
        kind: "ticks",
        values: {
          face_milling: "Face milling",
          slot_milling: "Slot / groove milling",
          drilling_tapping: "Drilling / tapping",
          boring_op: "Boring",
          pocket_milling: "Pocket milling",
          contour_milling: "Contour / profile milling",
          // Track A #2 (@6) — Advanced Q9 per sheet 2.
          thread_mill: "Thread mill",
          three_d_surface: "3D surface",
          engraving: "Engraving",
        },
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          spc: "SPC charts",
          rejection: "Rejection analysis",
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          tool_wear: "Tool wear / breakage",
          chatter: "Chatter and vibration",
          size_variation: "Size variation",
          surface_finish: "Surface finish",
          alarm: "Alarm clearing",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automotive components",
          general_engg: "General engineering / job shop",
          die_mould: "Die and mould",
          defence: "Defence / aerospace",
          pump_valve: "Pumps and valves",
          agri: "Agricultural equipment",
          // Track A #2 (@6) — Advanced Q12 per sheet 2.
          spm_parts: "SPM / machine parts",
          electronics: "Electronics / EMS",
        },
      },
    ],
  },
  {
    /**
     * CNC GRINDING — Batch 1's first NEW pack, and the third shipped map.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Sanjay Kamble, CNC Grinding Operator — Setter), row
     * for row and in the sheet's own order. Its ten rows are Machines, Controllers, Materials,
     * Setting, Measuring instruments, Wheels dressed, Drawings, Tolerance held, Surface finish
     * held and Sector worked. Every one has a question behind it; none was invented to fill a gap.
     *
     * WHAT IT SHARES WITH MILLING, AND WHERE THE VOCABULARY STILL DIVERGES. Ten attribute NAMES
     * are common to the machining packs, and this map re-keys three of them because a grinder's
     * answers are not a miller's:
     *   · `material_worked` leads with EN31 and case-hardened steel — the bearing-race and
     *     gear stock a grinder actually finishes — where milling leads with EN8 and MS.
     *   · `measuring_tools` carries a SURFACE ROUGHNESS TESTER and SLIP GAUGES, neither of which
     *     appears on a milling sheet, and drops the height gauge that does.
     *   · `tolerance_band` is a FINER LADDER. Milling tops out at "0.01 mm or finer"; this sheet
     *     prints ±0.005 mm as an ordinary claim, so the bands run to 0.002. Sharing milling's
     *     dictionary would have compressed a grinder's headline skill into its coarsest bucket.
     *
     * TWO ROWS THE OTHER MACHINING MAPS DO NOT HAVE. `Surface finish held` and `Wheels dressed`
     * are what a grinding employer scans for — the sheet prints "Ra 0.4 µm" and "Aluminium oxide
     * and CBN · single-point diamond dressing" — and neither has any meaning on a lathe or a
     * machining centre.
     *
     * ROW COUNT AND THE BUDGET. Eleven rows are defined and `CAPABILITY_ROW_BUDGET` is 10, so a
     * worker who answers everything loses one by rank. The ratified persona answers TEN and keeps
     * all ten — which he did not while the budget was 9, and `Sector worked` (rank 71, the
     * worst-ranked row he answers) was the row the page printed and the sheet did not. The tens
     * digit is the guideline's §5.1 rank; it is not bent to make the page fit, for the same reason
     * the milling map records.
     *
     * THE ELEVENTH ROW IS `Dressing`, AND NO RATIFIED PAGE PRINTS IT — see the open question on
     * that row's own entry below.
     */
    pack_id: "qp_cnc_grinding",
    section_title: "Machines, wheels & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "grinding_machine",
        rank: 21,
        // THE HEADLINE IS THE GRINDER, NOT THE CONTROL, and this flag was on `controller_brand`
        // until the parity suite first drove this role end to end. Two reasons, and neither is
        // layout preference:
        //   · THE RATIFIED PAGE. "CNC Grinding Operator — Setter · 8 yrs · CNC cylindrical
        //     grinder, Surface grinder, Centreless grinder" — `toolsPhrase` caps at three, so
        //     this row's four values produce that headline character for character.
        //   · THE TRADE. A grinding advertisement is written in grinder types; `controller_brand`
        //     in this pack offers "Pata nahi ya conventional machine", so a grinder may honestly
        //     have no controller at all, and pinning the sheet's highest-ranked scan element to a
        //     row he can legitimately not answer is what `headlineToolsOrFallback` then has to
        //     paper over. The turner's map leads with controllers because a CNC lathe
        //     advertisement does; copying that answer here was copying the turner, not reading
        //     the grinding page.
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          cylindrical: "CNC cylindrical grinder",
          surface: "Surface grinder",
          centreless: "Centreless grinder",
          internal: "Internal grinder",
          tool_cutter: "Tool and cutter grinder",
          // Phase 2 #2 (@6): the sheet-15 machine chips.
          thread_gear: "Thread / gear grinder",
          double_disc: "Double disc grinder",
        },
      },
      {
        from: "controller_brand",
        rank: 22,
        maxValues: 3,
        label: "Controllers",
        kind: "chips",
        values: {
          fanuc: "Fanuc",
          siemens: "Siemens",
          mitsubishi: "Mitsubishi",
          // A GRINDING CONTROL THE OTHER MACHINING MAPS DO NOT CARRY. Studer is the reference
          // cylindrical-grinder make and effectively absent from lathes and machining centres.
          studer: "Studer",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // DICTIONARY ORDER IS THE SHEET'S ORDER, as on the milling map: values render in the
        // order this object lists them, and the sheet leads with the bearing and gear stock.
        values: {
          en_thirty_one: "EN31",
          case_hardened: "Case-hardened steel",
          hchcr: "HCHCr",
          cast_iron: "Cast iron",
          stainless: "Stainless steel",
          carbide: "Carbide",
        },
      },
      {
        from: "setting_work",
        rank: 41,
        label: "Setting",
        kind: "ticks",
        values: {
          wheel_mounting: "Wheel mounting & balancing",
          diamond_dressing: "Diamond dressing",
          workhead_alignment: "Work-head alignment",
          steady_rest: "Steady rest setting",
          coolant_setting: "Coolant setting",
          magnetic_chuck: "Magnetic chuck setup",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          micrometer: "Micrometer",
          bore_gauge: "Bore dial gauge",
          slip_gauge: "Slip gauges",
          dial_indicator: "Dial gauge",
          roughness_tester: "Surface roughness tester",
          vernier: "Vernier",
        },
      },
      {
        from: "wheel_type",
        rank: 43,
        maxValues: 3,
        // A FACT ROW, NOT PILLS — read off the page rather than inferred, and it is what puts this
        // row SIXTH instead of fourth. `bb_trade.v1.html` emits all chip rows, then all tick rows,
        // then all fact rows, so a row's KIND decides its band and only its declared position
        // decides where it sits inside that band. As `chips` this printed straight after
        // Materials; the ratified page prints it after Measuring instruments, which is where the
        // first fact row lands (3 chip rows + 2 tick rows).
        //
        // THE EVIDENCE IS TYPOGRAPHIC. On these pages a chip or tick row separates its values with
        // whitespace — "Machines CNC cylindrical grinder Surface grinder Centreless grinder",
        // "Controllers Fanuc Siemens" — and a fact row separates them with a literal middot.
        // "Wheels dressed Aluminium oxide and CBN · single-point diamond dressing" carries the
        // middot, alongside Drawings / Tolerance held / Surface finish held / Sector worked, which
        // are facts on every machining page.
        label: "Wheels dressed",
        kind: "fact",
        values: {
          aluminium_oxide: "Aluminium oxide",
          silicon_carbide: "Silicon carbide",
          cbn: "CBN",
          diamond: "Diamond",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` has no entry ON PURPOSE, exactly as on the turner's and miller's maps. "Cannot
        // read drawings" is a true answer that belongs in matching data, not on the worker's own
        // document.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        // KEYED BY THE STORED VALUE, not the option key — the pack's `value_text` is the numeric
        // string. Keying this by `point_zero_zero_five` would render nothing at all, silently,
        // for every grinder who answered.
        values: {
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm",
          "0.005": "±0.005 mm",
          // Phase 2 #2 (@6): 0.002 is a band of its own now that a micron chip
          // sits below it. A @5 "0.002 or finer" answer prints as ±0.002 mm —
          // understated, never overstated.
          "0.002": "±0.002 mm",
          "0.001": "±0.001 mm (micron) or finer",
        },
      },
      {
        from: "surface_finish",
        rank: 63,
        label: "Surface finish held",
        kind: "fact",
        values: {
          "1.6": "Ra 1.6 µm",
          "0.8": "Ra 0.8 µm",
          "0.4": "Ra 0.4 µm",
          "0.2": "Ra 0.2 µm or finer",
        },
      },
      {
        from: "dressing_method",
        rank: 64,
        // ═══ OPEN QUESTION FOR RVM — DO NOT RESOLVE THIS BY EDITING THE MAP ═══
        //
        // NO RATIFIED PAGE PRINTS A "Dressing" ROW. The grinding sheet's ten rows are Machines,
        // Controllers, Materials, Setting, Measuring instruments, Wheels dressed, Drawings,
        // Tolerance held, Surface finish held and Sector worked. What the page does print is the
        // dressing METHOD inside the Wheels-dressed cell: "Aluminium oxide and CBN · single-point
        // diamond dressing".
        //
        // SO ONE OF TWO THINGS IS TRUE, and only the owner can say which:
        //   (a) `dressing_method` belongs INSIDE rank 43's cell, as a trailing clause. That needs
        //       a seam this file does not have — `configFrom` appends to the FIRST CHIP, and there
        //       is no equivalent for a fact row's trailing clause — and "single-point diamond
        //       dressing" is prose built from the label plus a word the pack never says, which is
        //       a §8 question and not a formatting one.
        //   (b) it is a real eleventh row that the ratified persona simply did not answer, in
        //       which case the page is silent about it rather than against it.
        //
        // NEITHER IS GUESSED HERE. Until it is ruled, `role-sheet-parity.render.test.ts` leaves
        // grinding's value assertion RED on this one cell, which is the honest state.
        label: "Dressing",
        kind: "ticks",
        values: {
          single_point: "Single-point diamond",
          rotary_dresser: "Rotary dresser",
          form_dressing: "Form dressing",
          auto_dressing: "Auto dressing cycle",
        },
      },
      {
        from: "sector_worked",
        rank: 71,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // THE PAGE READS "Bearings and transmission components" AND THIS ROW READS
        // "Bearings · Transmission components" — a recorded divergence, on the same ruling the CAM
        // sheet's sector row already carries. The ratified pages' sector cells are hand-set prose
        // ("Enclosures, panels and general fabrication", "Plastics tooling for auto and consumer
        // goods", "Automotive tier-1 supply" — none of which is an option in any pack), so no
        // closed-vocabulary dictionary reproduces them and §8 permits nothing else. A
        // `join: " and "` here would give this file a third separator for one kind of row and
        // still not match, because it would also have to lower-case the second label.
        values: {
          bearings: "Bearings",
          transmission: "Transmission components",
          automotive: "Automotive",
          die_mould: "Die and mould",
          general_engg: "General engineering / job shop",
        },
      },
    ],
  },
  {
    /**
     * THE CAM PROGRAMMER's SHEET — the first map in this file for a role that stands at no
     * machine, and the shape shows it.
     *
     * ITS RANK-2 ROW IS SOFTWARE, NOT A MACHINE. §5.1 rank 2 is "the literal vocabulary of the job
     * advertisement, highest-signal attribute in the wedge", and for a part programmer that
     * vocabulary is Mastercam and PowerMill — a programming advertisement names the seat, not the
     * spindle. So `cam_software` carries `inHeadline`, and the ratified sheet's headline
     * ("CAM Programmer — Programmer · 7 yrs · Mastercam, PowerMill, SolidCAM") is what
     * `toolsPhrase`'s three-value cap produces from this row's four.
     *
     * NINE ROWS INSIDE A BUDGET OF TEN, and the nine are the pack's design rather than a
     * coincidence: `qp_cam_programming` asks exactly the nine questions the ratified sheet
     * prints, plus its mode split and its tier gate. The budget cannot bind here at all — the map
     * defines fewer rows than the page holds — so `rank` decides no outcome today. It is authored
     * anyway, because the day an ELEVENTH row is added is the day it would otherwise be chosen by
     * whoever is editing.
     *
     * THIS USED TO READ "NINE AGAINST A BUDGET OF NINE", which was a true coincidence while the
     * budget was measured from three sheets and a false one after it was re-measured to ten
     * against all twenty-one. The property that survives is the one asserted in the test: nothing
     * is shed, stated as "inside the budget" rather than "equal to it".
     *
     * TWO ANSWERS ARE CAPTURED AND DELIBERATELY NOT PRINTED. `programming_mode` (CAM seat vs
     * at-machine MDI) is real matching data and the pack's own disambiguator, but the ratified
     * sheet has no row for it and §8 forbids inventing one. `simulation_work: "none"` is the
     * `drawing_reading: "none"` precedent exactly: a negative claim does not belong on a worker's
     * own marketing document.
     */
    pack_id: "qp_cam_programming",
    section_title: "Software, machines programmed & capability",
    tier_section_titles: { easy: "Software & machines programmed" },
    capability: [
      {
        from: "cam_software",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "CAM software",
        kind: "chips",
        values: {
          mastercam: "Mastercam",
          powermill: "PowerMill",
          solidcam: "SolidCAM",
          edgecam: "EdgeCAM",
          // Track A #3 (@4): sheet-3 software set.
          nx_cam: "NX CAM",
          fusion: "Fusion 360",
          hypermill: "hyperMILL",
          cimatron: "Cimatron",
          worknc: "WorkNC",
          esprit: "ESPRIT",
          manual_gcode: "Manual G-code",
        },
      },
      {
        from: "machine_programmed",
        rank: 22,
        maxValues: 4,
        // "for" IS PART OF THE LABEL, and the page is unambiguous about it: "Machines programmed
        // for VMC · 3-axis …". It cannot belong to the value — no chip in any pack or dictionary
        // begins "for " — and without it "Machines programmed" reads as a past-participle list
        // rather than as the relation the row states. Shipped truncated; the page was not.
        label: "Machines programmed for",
        kind: "chips",
        // THE DIGITS LIVE ONLY HERE. `slugKey` refuses a digit in an `option_key`, so the pack
        // spells the axis count out (`vmc_three_axis`) and the printed English restores it —
        // which is the whole reason this dictionary is a separate file from the pack.
        //
        // AND THE MIDDOT IS PRINTED CONTENT, NOT A SEPARATOR. The ratified page reads "VMC ·
        // 3-axis  VMC · 4-axis  5-axis trunnion  Turn-mill": chips on these pages are separated by
        // whitespace (the row above, "CAM software Mastercam PowerMill SolidCAM EdgeCAM", carries
        // no middot at all), and the middot sits INSIDE the machine chip, qualifying it with its
        // axis count. That is the identical construction `appendConfiguration` emits on the
        // milling sheet ("Machines VMC · 3-axis VMC · 4-axis …"), and the platform was printing
        // one fact — a 3-axis VMC — two different ways on two shipped sheets. This pack asks no
        // separate axis question, so the qualifier has to live in the label.
        values: {
          vmc_three_axis: "VMC · 3-axis",
          vmc_four_axis: "VMC · 4-axis",
          five_axis_trunnion: "5-axis trunnion",
          turn_mill: "Turn-mill",
          // Track A #3 (@4): sheet-3 machine set.
          cnc_turning: "CNC Turning",
          wirecut_edm: "Wire-cut / EDM",
          router: "Router",
        },
      },
      {
        from: "controller_brand",
        rank: 23,
        maxValues: 3,
        // "to", FOR THE SAME REASON AS "for" ON THE ROW ABOVE: the page reads "Controllers posted
        // to Fanuc Heidenhain Siemens", no controller label begins "to ", and the comment below
        // already argues that the fact on this sheet is which controller the program is posted
        // FOR — while the shipped label dropped the preposition that says so.
        label: "Controllers posted to",
        kind: "chips",
        // THE SAME ATTRIBUTE KEY AND THE SAME THREE SLUGS AS THE TURNING, MILLING AND GRINDING
        // MAPS — one vocabulary, so a matcher searching for Fanuc finds an operator and the man
        // who posts his programs under one key. Only the ROW LABEL differs, because on this sheet
        // the fact is which controller the program is posted for.
        values: {
          fanuc: "Fanuc",
          heidenhain: "Heidenhain",
          siemens: "Siemens",
          // Track A #3 (@4): sheet-3 posts set (Advanced Q9).
          mitsubishi: "Mitsubishi",
          haas: "Haas",
          mazatrol: "Mazatrol",
        },
      },
      {
        from: "programming_work",
        rank: 41,
        label: "Programming work",
        kind: "ticks",
        values: {
          two_d_three_d_toolpath: "2D & 3D toolpath",
          multi_axis_toolpath: "Multi-axis toolpath",
          tool_library: "Tool library management",
          cycle_time: "Cycle-time optimisation",
          strategy_selection: "Machining strategy selection",
          tryout_support: "Shop-floor tryout support",
        },
      },
      {
        // Track A #3 (@4): sheet rows 'Part types' (Advanced Q10) and 'Extra
        // work' (Advanced Q11). Ranked 72/73 — below every shipped row — so a
        // worker who answers everything sheds the new rows first and every
        // pre-@4 sheet renders byte-identically.
        from: "part_types",
        rank: 72,
        label: "Part types",
        kind: "ticks",
        values: {
          die_mould_core: "Die-mould / core-cavity",
          precision: "Precision components",
          aerospace: "Aerospace",
          automotive: "Automotive",
          spm_fixture: "SPM / fixtures",
          electrode: "Electrodes",
          prototype: "Prototypes",
        },
      },
      {
        from: "extra_work",
        rank: 73,
        label: "Extra work",
        kind: "ticks",
        values: {
          tool_select: "Tool selection",
          cycle_opt: "Cycle-time optimisation",
          post_edit: "Post editing",
          prove_out: "Prove-out on machine",
          fixture_design: "Fixture design",
          quoting: "Quoting / estimation",
        },
      },
      {
        from: "cad_model_handling",
        rank: 42,
        label: "CAD model handling",
        kind: "ticks",
        values: {
          step_iges_import: "STEP / IGES import",
          parasolid_import: "Parasolid import",
          model_repair: "Model repair",
          fixture_modelling: "Fixture modelling",
        },
      },
      {
        from: "post_processor_work",
        rank: 43,
        label: "Post-processors",
        kind: "fact",
        // A BAND, PRINTED AS THE CAPABILITY SENTENCE IT IS. The reference sheet reads "Edits and
        // tests post-processors · Fanuc and Heidenhain" (a MIDDOT — this comment quoted an em dash
        // and the page has never printed one); the controller half of that sentence is
        // the Controllers row's fact and is NOT re-composed here. Joining two rows' answers into
        // one printed clause would assert a pairing the worker never stated — which controller he
        // has posted for — and that is the fabrication §8 forbids.
        values: {
          use_only: "Uses supplied post-processors",
          edit_post: "Edits post-processors",
          edit_and_test: "Edits and tests post-processors",
          write_post: "Writes new post-processors",
        },
      },
      {
        from: "simulation_work",
        rank: 44,
        label: "Simulation",
        kind: "fact",
        // `none` HAS NO ENTRY ON PURPOSE, the `drawing_reading: "none"` precedent. "Does not
        // simulate" is real matching data and is stored; it is not something a worker's own
        // document should say about him.
        values: {
          in_cam_check: "In-CAM collision check before release",
          vericut: "Vericut verification before release",
          both_checks: "Vericut and in-CAM collision check before release",
        },
      },
      {
        from: "drawing_reading",
        rank: 45,
        label: "Drawings",
        kind: "fact",
        // Same two labels as the turning, milling and grinding maps, and `none` unlabelled for the
        // same reason it is unlabelled on all three.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "sector_worked",
        rank: 71,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // `tool_room` IS NEW TO THIS SECTOR DICTIONARY and the reference sheet is why: it prints
        // "Auto components and tool room". No machining map carries it, because a turner answers
        // the sector he cut parts FOR; a programmer answers the shop he programmed IN.
        values: {
          automotive: "Auto components",
          tool_room: "Tool room",
          die_mould: "Die and mould",
          general_engg: "General engineering / job shop",
          defence: "Defence / aerospace",
        },
      },
    ],
  },
  {
    /**
     * THE CAD DRAUGHTSMAN's SHEET — the only map in this file written for a FRESHER first.
     *
     * WHY THAT CHANGES THE RANKING AND NOT JUST THE ROWS. `qp_cad_drafting` asks all six of the
     * ratified sheet's capability rows at tier 0, ungated, so a student answers exactly the six
     * rows below plus `sector_studied` — seven, against a budget of ten — and his sheet is the
     * ratified page (Pooja Chaudhary) with nothing shed. An eight-year designer answers eleven and
     * loses two. The ranking therefore has to be right at the TOP for the fresher and right at the
     * BOTTOM for the senior, which is what the two sector keys and the two 6x rows below settle.
     *
     * TWELVE ROWS, ELEVEN REACHABLE BY ANY ONE WORKER. `sector_studied` (`lte 1`) and
     * `sector_drawn` (`gte 2`) are mutually exclusive by their gates, so no sheet ever prints
     * both — they are two rows because a student who has drawn nothing for money must not be
     * asked, or shown, what he has "worked".
     *
     * ONE ANSWER IS CAPTURED AND DELIBERATELY NOT PRINTED: `drawing_check_work: "check_none"`
     * ("only looks at his own drawings"). It is stored as ITSELF rather than collapsed into the
     * `unknown` escape — that would have been data loss dressed up as a decision — and it simply
     * carries no label here, so §5b rule 1 drops it. `drawing_type: "tracing"` by contrast DOES
     * print: tracing and updating existing drawings is the Tracer's actual trade (NCO 3118.0800),
     * the bottom rung of this ladder rather than the absence of one. `cad_training_source` is
     * likewise unmapped, and it PRINTS ON NO ROW OF THE SHEET AT ALL — it is captured for
     * matching only. The fresher block's heading is NOT chosen from it: `buildFresherRows` reads
     * `TRAINING_LABEL[packId]`, keyed by pack, and this role's descriptor sets the constant
     * `fresher.trainingLabel: "CAD training"`. That constant was chosen precisely BECAUSE the
     * answer is not printed — one heading has to be true of all five chips at once, and an ITI
     * heading would over-claim for the private-institute and self-taught student.
     */
    pack_id: "qp_cad_drafting",
    section_title: "Software, drawing work & capability",
    tier_section_titles: { easy: "Software" },
    capability: [
      {
        from: "cad_software",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Software",
        kind: "chips",
        // THE HEADLINE's THIRD SEGMENT COMES FROM HERE — "CAD Designer / Draughtsman —
        // Draughtsman · Fresher · AutoCAD, SolidWorks, Fusion 360" — because for a desk trade the
        // package IS the advertised vocabulary, exactly as the controller is for a turner.
        // `toolsPhrase` caps the headline at three; the row itself prints up to four.
        values: {
          autocad: "AutoCAD",
          solidworks: "SolidWorks",
          fusion: "Fusion 360",
          creo: "Creo / Pro-E",
          catia: "CATIA",
          // Track A #5 (@2): sheet-5 software set.
          autocad_mech: "AutoCAD Mechanical",
          draftsight: "DraftSight",
          zwcad: "ZWCAD",
          bricscad: "BricsCAD",
        },
      },
      {
        from: "drawing_subject",
        rank: 23,
        maxValues: 4,
        label: "Drawing subject",
        kind: "chips",
        // Track A #5 (@2): sheet-5 Q7. What the drawings are OF — distinct from
        // the industry rows, which name where the worker learned or worked.
        values: {
          machine_parts: "Machine parts",
          sheetmetal_fab: "Sheet metal / fabrication",
          structural: "Structural",
          conveyor_spm: "Conveyor / SPM",
          elec_panel: "Electrical / panel",
          piping: "Piping",
          civil_arch: "Civil / architecture",
        },
      },
      {
        from: "cad_modules",
        rank: 22,
        maxValues: 4,
        label: "Modules",
        kind: "chips",
        values: {
          two_d_drafting: "2D drafting",
          three_d_modelling: "3D modelling",
          assembly_module: "Assembly",
          sheet_metal: "Sheet-metal module",
          surface_module: "Surface modelling",
        },
      },
      {
        from: "drawing_work",
        rank: 41,
        label: "Drawing work",
        kind: "ticks",
        values: {
          part_modelling: "Part modelling",
          assembly_mating: "Assembly mating",
          views_sections: "Drawing views & sections",
          flat_pattern: "Sheet-metal flat pattern",
          dimensioning: "Dimensioning",
          revision_control: "Revision control",
        },
      },
      {
        from: "drawing_standards",
        rank: 42,
        label: "Standards & detailing",
        kind: "ticks",
        values: {
          gdt_symbols: "GD&T symbols",
          iso_standard: "ISO drawing standard",
          title_block: "Title block & BOM",
          tolerance_stack: "Tolerance stack basics",
          projection_angle: "First & third angle projection",
        },
      },
      {
        from: "drawing_type",
        rank: 43,
        label: "Drawing type",
        kind: "fact",
        values: {
          two_d_only: "Prepares 2D production drawings",
          model_to_drawing: "Prepares 2D production drawings from 3D models",
          model_and_drawing: "Models in 3D and prepares production drawings",
          tracing: "Traces and updates existing drawings",
        },
      },
      {
        from: "output_produced",
        rank: 44,
        label: "Output produced",
        kind: "fact",
        // A RECORDED DIVERGENCE FROM THE PAGE, WHICH READS "Part and assembly drawings · BOM · DXF
        // for laser cutting". The page folds two chips into one English phrase; a `fact` row joins
        // whole dictionary labels, so no separator reproduces it. The alternative — a compound
        // label "Part and assembly drawings" — would print a claim the worker never made every
        // time he taps only one of the two, and `output_produced` is a multi_select whose
        // `part_drawing` and `assembly_drawing` options are independent. Pinned, not fixed.
        values: {
          part_drawing: "Part drawings",
          assembly_drawing: "Assembly drawings",
          bom: "BOM",
          dxf_cutting: "DXF for laser cutting",
          fabrication_drawing: "Fabrication / welding drawings",
        },
      },
      {
        from: "design_work",
        rank: 45,
        label: "Design work",
        kind: "ticks",
        // THE TOP OF THIS ROLE's LADDER, and §5.1 rank 4's own words are why it sits with the
        // drawing rows rather than below them: it "separates a button-presser from a man who can
        // set the job". Material selection and bend allowance are what make a draughtsman a
        // design engineer.
        values: {
          material_selection: "Material selection",
          standard_parts: "Standard part selection — bearings, fasteners",
          bend_allowance: "Sheet-metal bend allowance",
          fixture_design: "Jig & fixture design",
          cost_weight: "Weight / cost estimation",
        },
      },
      {
        from: "design_input_source",
        rank: 46,
        label: "Design input",
        kind: "fact",
        // EVERY LABEL IN THIS FILE IS PRONOUN-FREE, and this row is where that stopped being an
        // accident. `own_design` read "Designs it himself" — the only gendered string among the
        // printed labels of all five maps, on the one role whose ratified reference sheet is a
        // woman's and whose supply the taxonomy calls RVM's core student profile. No question in
        // any pack captures sex, so the English asserted a fact the worker never stated (§8),
        // while the source chip — "Khud design karta hoon" — carries no third-person claim at all.
        values: {
          hand_sketch: "Works from hand sketches",
          sample_part: "Measures a sample part and draws it",
          senior_model: "Works from a senior's 3D model or drawing",
          own_design: "Designs it independently",
        },
      },
      {
        from: "drawing_from_model",
        rank: 47,
        label: "3D to 2D",
        kind: "fact",
        // Track A #5 (@2): sheet-5 Q11. `no` ("Nahi") has no entry ON PURPOSE —
        // the drawing_reading:"none" precedent: a negative claim belongs in
        // matching data, not on the worker's own document.
        values: {
          yes: "Draws 2D from 3D models",
        },
      },
      {
        from: "drawing_check_work",
        rank: 61,
        label: "Drawing checking",
        kind: "fact",
        // `check_none` HAS NO LABEL — see the entry header. Checking another man's drawing is the
        // clearest seniority signal this trade has, which is why it outranks the instruments below
        // it even though §5.1 ranks measuring instruments 5th: that ranking was written for the
        // machining wedge, where an operator's gauges are how the job is judged. In a drawing
        // office they are an occasional tool. Trade truth, flagged for RVM redline like every
        // other ordering in this file.
        values: {
          check_regular: "Checks other draughtsmen's drawings",
          check_sometimes: "Checks other draughtsmen's drawings occasionally",
        },
      },
      {
        from: "measuring_tools",
        rank: 62,
        label: "Measuring instruments",
        kind: "ticks",
        // ITS OWN DICTIONARY, not the turner's. `TURNING_MEASURING_TOOLS` carries a plug / ring
        // gauge and a bore dial gauge, which check a bore the man just cut; a draughtsman reaches
        // for a rule and a vernier to reverse-engineer a sample part. Same attribute key, and the
        // reuse would have looked safe — which is the mistake the milling map records.
        values: {
          vernier: "Vernier",
          micrometer: "Micrometer",
          height_gauge: "Height gauge",
          steel_rule: "Steel rule & measuring tape",
          dial_indicator: "Dial indicator",
        },
      },
      {
        from: "sector_studied",
        rank: 71,
        maxValues: 3,
        label: "Sector studied",
        kind: "fact",
        // "STUDIED", NOT "WORKED", AND THE ROW EXISTS TWICE FOR THAT ONE WORD. The ratified
        // fresher sheet prints "Sector studied  General engineering · course projects" (label and
        // value, no dash between them — this comment used to quote an em dash the page does not
        // print), and printing "worked" over a student's course projects would state employment
        // she has not had. The pack asks the two with different wording behind exclusive gates;
        // this map keeps them two rows so neither label can reach the wrong worker.
        //
        // THE PAGE LOWER-CASES "course projects" AND THIS ROW DOES NOT — a recorded divergence.
        // The ratified pages sentence-case the CONTINUATION of a cell the designer wrote as prose
        // (the turner's "Automotive components · job shop", the grinder's "single-point diamond
        // dressing"); they do NOT lower-case cells built from labels, which keep their capitals
        // ("Preferred locations … · Willing to relocate", "Shift General shift · Permanent"). A
        // dictionary entry here is a LABEL and is capitalised because it is one; down-casing a
        // joined label by its position would also down-case a proper noun the moment a sector
        // dictionary grows one.
        values: {
          general_engg: "General engineering",
          auto_parts: "Automotive / auto parts",
          sheet_metal_fab: "Sheet metal and fabrication",
          civil_building: "Civil / building drawing",
          course_project: "Course projects",
        },
      },
      {
        from: "sector_drawn",
        rank: 72,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 puts the sector tag at the bottom of the survival order — "display only. Never a
        // matching input — locked" — so for an eleven-row senior this is one of the two that
        // sheds, along with the instruments. The fresher never reaches that budget, so his
        // `sector_studied` row above always prints.
        values: {
          general_engg: "General engineering / job shop",
          auto_parts: "Automotive / auto parts",
          sheet_metal_fab: "Sheet metal and fabrication",
          tool_room: "Tool room, die and mould",
          machine_building: "Machine / SPM building",
        },
      },
    ],
  },

  // ══ TRACK A #4 — 3D CAD DESIGNER (CEO Launch Plan Pack v1, sheet 4) ═══════
  //
  // THE FIRST MAP WITH NO RATIFIED PAGE: sheet 4 of the CEO pack is the spec,
  // and the headline example on it ("3D CAD Designer · Senior Designer ·
  // 5 years · SolidWorks + Creo · Sheet metal & SPM · Noida · 15 days") is the
  // parity reference until a practising designer ratifies the wording. Every
  // row below exists because sheet 4 names it, and every `values` key is the
  // option's STORED `value_text`.
  //
  // RANKED LIKE A MACHINING MAP: software first (the hire is for the seat),
  // then the work area, then depth, tolerance and industry. Nine rows against
  // the budget of ten, so nothing sheds.
  {
    pack_id: "qp_cad_design_3d",
    section_title: "Design, software & capability",
    tier_section_titles: { easy: "Design & software" },
    capability: [
      {
        from: "design_software",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "3D software",
        kind: "chips",
        values: {
          solidworks: "SolidWorks",
          creo: "Creo",
          nx: "NX",
          catia: "CATIA",
          inventor: "Inventor",
          fusion: "Fusion 360",
          solid_edge: "Solid Edge",
          // @2 additions — new-form values appended after history.
          autocad: "AutoCAD (2D)",
        },
      },
      {
        from: "design_work_area",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Work area",
        kind: "chips",
        values: {
          machine_spm: "Machine / SPM",
          sheet_metal: "Sheet metal",
          plastic_parts: "Plastic parts",
          fixture_jig: "Fixture / jig",
          mould_die: "Mould / die / tooling",
          auto_parts: "Automotive parts",
          // @2 additions — new-form values appended after history.
          product_design: "Product / component design",
          spm_machine: "SPM & machine design",
          plastic_part: "Plastic part design",
          jig_fixture: "Jig & fixture design",
          press_tool: "Press tool / die design",
          mould_design: "Mould design (injection / die-casting)",
          biw_fixture: "BIW & welding fixture design",
          reverse_engg: "Reverse engineering",
        },
      },
      {
        from: "design_depth",
        rank: 41,
        label: "Depth in software",
        kind: "ticks",
        values: {
          part: "Part modelling",
          assembly: "Assembly modelling",
          sheet_metal_work: "Sheet metal",
          weldment: "Weldment",
          surfacing: "Surfacing",
          two_d_model: "2D drawing from model",
          // @2 additions — new-form values appended after history.
          part_modelling: "Part modelling",
          assembly_module: "Assembly",
          drafting: "Drafting / detailing",
          sheet_metal: "Sheet metal",
          surface_module: "Surfacing",
          mould_tools: "Mould tools (core-cavity)",
          simulation: "Simulation / motion study",
        },
      },
      {
        from: "design_daily_work",
        // Rank 4x: the daily design tasks are this desk trade's setting
        // capability. Step 5 (@2).
        rank: 43,
        label: "Daily design work",
        kind: "ticks",
        values: {
          concept_layout: "Concept / layout",
          modelling: "3D part and assembly modelling",
          detailing: "2D manufacturing drawing, detailing",
          bom: "BOM",
          design_calculation: "Design calculation",
          part_selection: "Material and standard part selection",
          ecn: "ECN and drawing revision",
          shop_followup: "Shop floor / vendor trial follow-up",
          customer_review: "Customer design review",
        },
      },
      {
        from: "design_work_input",
        // 6x wedge attribute: what the design starts from. Step 5 (@2).
        rank: 62,
        label: "Design input",
        kind: "chips",
        values: {
          customer_data: "Customer 3D model / drawing",
          own_concept: "Own concept from requirement",
          sample_part: "Model from sample part",
          scan_data: "3D scan data, STL / point cloud",
          senior_concept: "Senior's concept / layout",
        },
      },

      {
        from: "design_tolerance",
        rank: 42,
        label: "Tolerance / GD&T",
        kind: "fact",
        // `none` has no entry ON PURPOSE — the drawing_reading precedent on
        // every other map. "Does not do tolerance work" is matching data, not
        // a line on the worker's own document.
        values: {
          basic: "Basic ±",
          gdt: "GD&T symbols",
          stackup: "Tolerance stack-up",
          // @2 additions — new-form values appended after history.
          gdt_apply: "Applies GD&T symbols",
          fits_selection: "Fit & tolerance selection (H7/g6)",
          datum_scheme: "Datum scheme",
          tolerance_stack: "Tolerance stack-up",
          finish_weld_symbols: "Surface finish & weld symbols",
          gdt_standard: "ASME Y14.5 / ISO standard",
        },
      },
      {
        from: "design_process_knowledge",
        // 6x wedge attribute: DFM vocabulary. Step 5 (@2).
        rank: 61,
        maxValues: 4,
        label: "Process knowledge",
        kind: "chips",
        values: {
          machining: "Machining (turning / milling)",
          sheet_metal: "Sheet metal (bending, laser, press)",
          fabrication: "Welding and fabrication",
          injection_moulding: "Plastic injection moulding",
          casting: "Casting (die / sand)",
          forging: "Forging",
          three_d_printing: "3D printing / prototype",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "design_tool_work",
        // Rank 4x: tool-design tasks are setting capability. Step 5 (@2).
        rank: 45,
        label: "Tool design work",
        kind: "ticks",
        values: {
          strip_layout: "Progressive die strip layout",
          core_cavity: "Core-cavity extraction and parting line",
          slider_lifter: "Slider, lifter and ejection design",
          runner_cooling: "Runner, gate and cooling layout",
          mould_base: "Mould base and standard part selection",
          fixture_locating: "Fixture locating and clamping (3-2-1)",
          clamp_selection: "Pneumatic / hydraulic clamp selection",
          tonnage_calculation: "Press tonnage and spring calculation",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "design_machine_elements",
        // Rank 4x: selecting elements is setting capability; the values are
        // component vocabulary, hence chips. Step 5 (@2).
        rank: 46,
        label: "Machine elements",
        kind: "chips",
        values: {
          bearing_lm_guide: "Bearing and LM guide",
          ball_screw_servo: "Ball screw and servo motor sizing",
          drives: "Gearbox, belt and chain drive",
          pneumatics: "Pneumatic cylinder and valve",
          hydraulics: "Hydraulic cylinder and power pack",
          shafts_couplings: "Shaft, key and coupling",
          structure_frame: "Fabricated frame / structure",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "design_pdm_plm",
        // 6x wedge attribute: system vocabulary. Step 5 (@2).
        rank: 63,
        label: "PDM / PLM",
        kind: "chips",
        values: {
          teamcenter: "Teamcenter",
          windchill: "Windchill",
          solidworks_pdm: "SolidWorks PDM / EPDM",
          vault: "Autodesk Vault",
          enovia: "ENOVIA",
          sap: "SAP (BOM / ECN entry)",
          // `unknown` ("Koi nahi, folder me file rakhte hain") has no entry.
        },
      },

      {
        from: "design_industry",
        rank: 71,
        label: "Industry",
        kind: "fact",
        join: ", ",
        values: {
          auto_ancil: "Auto / ancillary",
          spm_ind: "SPM / machine",
          elec_panel: "Electrical / panel",
          consumer: "Consumer products",
          aero_def: "Aerospace / defence",
          medical: "Medical",
          // @2 additions — new-form values appended after history.
          automotive: "Automotive / auto parts",
          two_wheeler: "Two-wheeler",
          spm_parts: "SPM & machine building",
          die_mould: "Tool room, die & mould",
          appliances: "Home appliances",
          general_engg: "General engineering & fabrication",
          agri: "Tractor & agri equipment",
          defence: "Defence / aerospace",
        },
      },
      {
        from: "design_validation",
        // 6x wedge attribute. Step 5 (@2).
        rank: 64,
        label: "Design validation",
        kind: "ticks",
        values: {
          basic_fea: "Basic FEA (SolidWorks Simulation / ANSYS)",
          stack_up_study: "Tolerance stack-up study",
          dfmea: "DFMEA",
          prototype_test: "Prototype testing",
          clash_check: "Interference / clash check",
          design_checklist: "Design review checklist",
          simulation_report: "Mould flow / forming report",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "design_project_ownership",
        // 6x wedge attribute: lead-level ownership. Step 5 (@2).
        rank: 65,
        label: "Project ownership",
        kind: "chips",
        values: {
          customer_discussion: "Customer technical discussion",
          cost_estimate: "Costing / weight estimate",
          vendor_followup: "Vendor and tool room follow-up",
          drawing_check: "Junior's drawing check",
          change_management: "ECN and change management",
          vave: "VAVE / cost reduction",
          apqp_docs: "APQP and PPAP design documents",
          design_standards: "Design standards / templates",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },

  // ══ BATCH 2, PART ONE ═══════════════════════════════════════════════════════════════
  //
  // Four roles, and the reason it is four and not eleven is REACH rather than effort:
  // reachability was measured for all eleven Batch 2 roles through the production chain
  // before any pack was authored, and seven of them cannot be reached by binding at all.
  // See `_families.jsonl` and `question-pack-reachability.test.ts` for the measurements.
  //
  // Every row below was read off that role's page in the ratified reference set, not
  // invented, and every `values` key is the option's STORED `value_text`. The chip
  // vocabulary is drafted and NOT yet corrected by a practising worker in any of the four
  // trades — see docs/registers/trade-content-ratification.md.
  {
    /**
     * THE CONVENTIONAL MACHINIST's SHEET — the manual half of the machine shop, and the first
     * machining map in this file with NO CONTROLLERS ROW.
     *
     * ITS RANK-2 ROW IS THE MACHINE, AND THERE IS NOTHING ELSE IT COULD BE. The turner's map
     * leads with `controller_brand` because a CNC lathe advertisement is written in Fanuc and
     * Siemens; this trade has no control to name, so §5.1 rank 2 — "the literal vocabulary of the
     * job advertisement" — is the machine list itself. The ratified page proves it character for
     * character: "Conventional Machinist — Skilled · 12 yrs · Centre lathe, Vertical milling,
     * Radial drill" is `toolsPhrase`'s three-value cap applied to this row's four.
     *
     * EIGHT ROWS, WHICH IS THE PAGE'S OWN COUNT rather than a budget decision. Ram Naresh Gupta's
     * sheet prints Machines, Materials, Operations, Measuring instruments, Drawings, Turning
     * capacity, Tolerance held and Sector worked, and `qp_conventional_machining` asks exactly one
     * question per row. Two rows below ten leaves the section room the other machining maps do not
     * have, and no row is ever shed — `rank` decides nothing here today and is authored anyway,
     * because the day a ninth row is proposed is the day it would otherwise be ranked by whoever
     * is editing.
     *
     * FOUR ANSWERS ARE CAPTURED AND DELIBERATELY NOT PRINTED. `machining_level` is the ladder rung
     * ("Helper / Operator / Skilled") and belongs to the HEADLINE, not to a capability row — the
     * page renders it as part of the role title, and giving it a row as well would print the same
     * word twice on a sheet with one page. `setting_operation`, `tool_grinding` and
     * `advanced_work` are real matching data with no row on the ratified page, and §8 forbids
     * inventing one for them; grinding's `dressing_method` is the recorded precedent for how much
     * trouble the opposite choice causes.
     *
     * TURNING CAPACITY SITS AT RANK 23, WITH THE MACHINES. It is a statement about what the
     * machine can do — the same judgement the turner's map makes for `advanced_capability` — and
     * on this trade it moves the pay band: a man who has turned 600 mm on a heavy lathe is hired
     * for jobs a 200 mm bench lathe cannot hold. It is a FACT row all the same, because the page
     * prints it with the middot separator every fact cell on these sheets uses.
     */
    pack_id: "qp_conventional_machining",
    // Sentence case — the template uppercases. A conventional machinist's sheet says
    // "operations" where the turner's says "controllers": his spread is what he can DO by hand,
    // not what electronics he can drive.
    section_title: "Machines, operations & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "machining_machine",
        rank: 21,
        inHeadline: true,
        // Guideline §4.3: machines max 4. The page prints exactly four (Centre lathe, Vertical
        // milling, Radial drill, Boring machine) and the dictionary's order is what the cap takes
        // the first four of — "most-used first" is not a fact we measured, so it is not claimed.
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          centre_lathe: "Lathe (manual)",
          vertical_milling: "Milling (manual)",
          radial_drill: "Drilling / radial drill",
          // Track B #4 (@2): sheet-9 machine set.
          surface_grinder: "Surface grinder",
          cylindrical_grinder: "Cylindrical grinder",
          boring_machine: "Boring",
          shaper_planer: "Shaper / planer",
          slotter: "Slotter",
          hacksaw_bandsaw: "Hacksaw / bandsaw",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // DICTIONARY ORDER IS THE TURNER SET, as on the milling map (Track A #2
        // unified materials to Turner; EN8/EN31 split retired — old `en_eight`
        // answers drop, recorded cost). Values render in the order listed here.
        values: {
          mild_steel: "MS",
          alloy_steel: "EN8, EN31 alloy steel",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          brass: "Brass",
          cast_iron: "Cast iron",
          titanium: "Titanium / Inconel",
          plastic: "Plastics",
        },
      },
      {
        from: "machining_operation",
        rank: 63,
        label: "Operations",
        kind: "ticks",
        // EIGHT VALUES, AND THE PACK CARRIES EIGHT CHIPS TO MATCH. This is the one row in the
        // corpus where the ratified page sets the chip count rather than the other way round: a
        // seven-chip question cannot reproduce a row the sheet prints eight ticks in, and the
        // ampersand pairs ("Turning & facing", "Drilling & reaming") are the page's own
        // groupings, not ours to re-split.
        // Track B #4 (@2): sheet-9 operation words. The CEO sheet splits the
        // page's ampersand pairs (Turning/Facing) into their own chips, so the
        // map mirrors the pack — the page's grouping comment below is
        // superseded for this trade, recorded here rather than deleted.
        values: {
          turning_facing: "Turning",
          facing_op: "Facing",
          screw_cutting: "Threading",
          taper_op: "Taper",
          boring: "Boring",
          keyway: "Keyway",
          gear_cutting: "Gear cutting",
          milling_slotting: "Slotting",
          grinding_op: "Grinding",
          knurling: "Knurling",
          drilling_reaming: "Drilling & reaming",
          tapping: "Tapping",
          marking_scribing: "Marking & scribing",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        // `dial_indicator` PRINTS AS "Dial gauge", exactly as on the grinding map. The pack's slug
        // is the corpus-wide one and the page's word is the shop floor's; this file is where those
        // two disagree without either having to move.
        values: {
          vernier: "Vernier",
          micrometer: "Micrometer",
          height_gauge: "Height gauge",
          dial_indicator: "Dial gauge",
          bore_gauge: "Bore gauge",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` has no entry ON PURPOSE, exactly as on the turner's, miller's and grinder's maps.
        // "Cannot read drawings" is a true answer that belongs in matching data, not on the
        // worker's own marketing document.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "turning_capacity",
        rank: 23,
        label: "Turning capacity",
        kind: "fact",
        // KEYED BY THE STORED VALUE, not the option key. The pack's `value_text` is `four_hundred`
        // and its `option_key` is `upto_four_hundred`; keying this by the option key would render
        // nothing at all, silently, for every machinist who answered — which has already shipped
        // twice in this file's history.
        values: {
          two_hundred: "Up to 200 mm dia, 1000 mm bed",
          four_hundred: "Up to 400 mm dia, 1500 mm bed",
          six_hundred: "Up to 600 mm dia, 2000 mm bed",
          over_six_hundred: "Over 600 mm dia — heavy lathe",
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        // The stored value is the numeric string, as on every other machining map.
        values: {
          "0.1": "±0.1 mm",
          "0.05": "±0.05 mm",
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm or finer",
          // Track B #4 (@2): sheet-9 tolerance chips (as Turner).
          "0.005": "±0.005 mm / H7",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // THE PAGE'S CELL READS "Job shop — repair and spares" AND SO DOES THIS DICTIONARY ENTRY.
        // The grinding and CAM maps had to record a divergence here because their pages' sector
        // cells are hand-set prose no closed vocabulary reproduces; this one does not, because the
        // page's phrase IS one sector and can therefore be one printed value. Nothing about that
        // makes the general problem solved — the other pages' cells are still prose — it just does
        // not bite this role.
        values: {
          job_shop_repair: "Job shop — repair and spares",
          automotive: "Automotive parts",
          general_engg: "General engineering",
          pump_valve: "Pumps and valves",
          agri: "Agricultural equipment",
          textile_mill: "Textile mill spares",
        },
      },
      {
        from: "machining_work_type",
        // What KIND of shop work, distinct from the industry rows above.
        // Track B #4 (@2): sheet-9 Q11.
        rank: 64,
        label: "Work type",
        kind: "fact",
        values: {
          batch_production: "Production batch",
          job_work: "Job work",
          tool_room: "Tool room",
          repair_maintenance: "Repair / maintenance",
          forge_cast_finish: "Forging / casting finishing",
        },
      },
    ],
  },
  {
    /**
     * THE TOOL & DIE MAKER's SHEET — read off the ratified page (Prakash Rathod, "Tool & Die
     * Maker — Tool Maker · 9 yrs · Press tools, Progressive dies, Jigs & fixtures"), row for row.
     *
     * ITS RANK-2 ROW IS WHAT THE SHOP BUILDS, NOT WHAT IT STANDS AT. §5.1 rank 2 is "the literal
     * vocabulary of the job advertisement, highest-signal attribute in the wedge", and a tool-room
     * vacancy is written in tooling — "press tool maker", "progressive die maker" — never in
     * machines. So `tooling_made` carries `inHeadline`, and `toolsPhrase`'s three-value cap
     * applied to this row's four printed values reproduces the ratified headline character for
     * character.
     *
     * THE MACHINE ROW COULD NOT CARRY IT, and that is a fact about this trade rather than a
     * layout preference. "Surface grinder · Wire-cut EDM · Sinker EDM · Milling" is three-quarters
     * another machining role's daily equipment — `tool-die-maker.role.ts` says so in as many words
     * — so a headline built from it would read as CNC Grinding's. The turner and the miller lead
     * with controllers because a CNC advertisement does; copying either here would be copying
     * another sheet instead of reading this one.
     *
     * EIGHT ROWS AGAINST A BUDGET OF TEN. Nothing sheds for any worker, so `rank` decides no
     * outcome today; it is authored anyway, because the day a ninth row is proposed is the day it
     * would otherwise be chosen by whoever is editing.
     *
     * THE THREE `maxValues` ARE THE GUIDELINE's §4.3 CAPS AND ALSO REPRODUCE THE PAGE. Each of
     * the three chip rows offers five values in its dictionary and the ratified page prints four
     * of each — Tooling made stops at "Check gauges", Machines at "Milling", Tool steels at "MS
     * die sets" — so the cap and the page agree without either being bent to the other.
     *
     * FIVE PACK ANSWERS ARE CAPTURED AND DELIBERATELY NOT PRINTED: `edm_work`,
     * `die_design_work`, `die_troubleshooting`, `heat_treatment_work` and `press_tonnage`. All
     * five are real matching data on `worker_attributes`, and the ratified page has no row for any
     * of them. Inventing one is what §5b forbids; this is the `programming_mode` precedent from
     * the CAM map exactly. `toolroom_level` is captured and not printed HERE for a different
     * reason — it is the headline's level rung ("— Tool Maker"), which is a header slot and not a
     * capability row.
     */
    pack_id: "qp_tool_die_making",
    section_title: "Tooling, machines & capability",
    tier_section_titles: { easy: "Tooling & machines" },
    capability: [
      {
        from: "tooling_made",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Tooling made",
        kind: "chips",
        // DICTIONARY ORDER IS THE SHEET's ORDER — values render in the order this object lists
        // them. Phase 2 #1 (@2): sheet-13 tool set leads (the page's five follow in place);
        // `maxValues: 4` holds back the rest, which is also what the page does.
        values: {
          press_tool: "Press tools / stamping dies",
          plastic_injection: "Plastic injection moulds",
          die_casting: "Die-casting dies",
          jig_fixture: "Jigs & fixtures",
          check_gauge: "Gauges",
          forging_die: "Forging dies",
          rubber_mould: "Rubber moulds",
          progressive_die: "Progressive dies",
          metal_mould: "Moulds (metal)",
        },
      },
      {
        from: "toolroom_machine",
        rank: 22,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        // Phase 2 #1 (@2): sheet-13 machine words; the new chips follow the
        // page's five in dictionary order.
        values: {
          surface_grinder: "Surface grinder",
          vmc: "VMC",
          wire_cut: "Wire-cut",
          edm: "EDM",
          sinker_edm: "Sinker EDM",
          lathe: "Lathe",
          milling: "Milling",
          jig_boring: "Jig boring",
          polishing_lapping: "Polishing / lapping",
        },
      },
      {
        from: "tool_steel",
        rank: 61,
        maxValues: 4,
        label: "Tool steels",
        kind: "chips",
        // THE PACK ASKS "tool steel", NOT "material worked", and the row label follows the pack
        // rather than the other machining maps. For a tool maker the tool steel IS the workpiece,
        // and "OHNS" is an answer a turner would never give — which is the whole reason this is a
        // separate question key instead of a reused `material_worked`.
        values: {
          ohns: "OHNS",
          hchcr_dtwo: "HCHCr / D2",
          h_thirteen: "H13",
          p_twenty: "P20",
          en_thirty_one: "EN31",
          ms_die_set: "MS die sets",
          hss: "HSS",
        },
      },
      {
        from: "toolroom_work",
        rank: 41,
        label: "Tool-room work",
        kind: "ticks",
        values: {
          die_assembly: "Die fitting & assembly",
          spotting: "Spotting / blue matching",
          tryout_correction: "Tryout",
          die_maintenance: "Die maintenance / repair",
          regrind: "Sharpening",
          polishing: "Polishing",
          clearance_setting: "Punch & die clearance setting",
          benchwork: "Benchwork & scraping",
          shut_height: "Shut-height setting",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          slip_gauge: "Slip gauges",
          height_gauge: "Height gauge",
          micrometer: "Micrometer",
          sine_bar: "Sine bar",
          profile_projector: "Profile projector",
          dial_gauge: "Dial gauge",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` has no entry ON PURPOSE, exactly as on the turner's, miller's and grinder's maps.
        // "Cannot read drawings" is a true answer that belongs in matching data, not on the
        // worker's own document.
        values: {
          basic_drawing: "Reads 2D tooling drawings",
          gdt: "Reads 2D tooling drawings and GD&T",
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        // KEYED BY THE STORED VALUE, not the option key — the pack's `value_text` is the numeric
        // string. Keying this by `point_zero_one` would render nothing at all, silently, for
        // every tool maker who answered.
        //
        // THE CLAUSE "on die clearance" IS THE RATIFIED CELL, not decoration. The page prints
        // "±0.01 mm on die clearance", and a bare "±0.01 mm" on a tool-room sheet is ambiguous
        // between the clearance and the ground size, which are different claims about the work.
        values: {
          "0.05": "±0.05 mm on die clearance",
          "0.02": "±0.02 mm on die clearance",
          "0.01": "±0.01 mm on die clearance",
          "0.005": "±0.005 mm on die clearance",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 ranks the sector "display only. Never a matching input — locked", which is why it
        // sits last and drops first. The ratified cell reads "Sheet-metal press tooling" and this
        // dictionary's first entry is that string exactly, so a worker who taps only that chip
        // reproduces the page.
        values: {
          sheet_metal_press: "Sheet-metal press tooling",
          automotive: "Automotive",
          electrical_parts: "Electrical & electronics",
          white_goods: "White goods",
          general_engg: "General engineering / job shop",
        },
      },
      {
        from: "tool_training_institute",
        rank: 63,
        label: "Training institute",
        kind: "fact",
        // Phase 2 #1 (@2): sheet-13 Q12 institutes. A credential row like the
        // electrician's Licence — `none` ("Kahin nahi") has no entry, same rule.
        values: {
          iti_tool_die: "ITI (Tool & Die Maker)",
          nttf: "NTTF",
          cttc: "CTTC",
          igtr: "IGTR",
          cipet: "CIPET",
          diploma: "Diploma",
        },
      },
    ],
  },
  {
    pack_id: "qp_welding_trade",
    // A WELDER'S FIRST SECTION IS NOT A MACHINIST'S. The turner's sheet says "Machines,
    // controllers & capability" because a lathe advertisement is written in machines and
    // controls; a welding advertisement is written in PROCESSES and POSITIONS ("MIG welder,
    // 3G, structural fab"), and the heading has to name what the reader is scanning for.
    // Sentence case — the template uppercases.
    section_title: "Processes, positions & capability",
    tier_section_titles: { easy: "Processes & equipment" },
    capability: [
      {
        from: "welding_process",
        // §5.1 rank 2 — "the literal vocabulary of the job advertisement". For this trade that
        // is the PROCESS, not the machine: a shop advertises for a MIG welder or a TIG welder
        // and only then asks which set he has stood at. Equipment takes 22 for the same reason
        // the turner's controllers do — it is the hardware behind the advertised word.
        rank: 21,
        // THE HEADLINE IS THE PROCESS LIST. `toolsPhrase` caps the Verdict Line at three, so a
        // welder who runs MIG, TIG and arc reads "Welder — Skilled · 8 yrs · MIG / CO2, TIG / Argon,
        // Arc / stick". Putting the flag on `welding_equipment` instead
        // would lead the sheet with an inverter set, which no advertisement is written in, and
        // would go empty for a site welder who answered "Inme se koi nahi" to the equipment
        // chip — pinning the sheet's highest-ranked scan element to a row he can legitimately
        // not answer is what `headlineToolsOrFallback` then has to paper over.
        inHeadline: true,
        // §4.3's "machines max 4" applied to this trade's machine-equivalent row. The pack
        // offers eight processes; a man who genuinely runs all eight prints the first four in
        // DICTIONARY order and the headline still shows three.
        maxValues: 4,
        label: "Processes",
        kind: "chips",
        // KEYED BY THE OPTION'S `value_text`, NEVER ITS `option_key`. They are equal for most
        // rows here by construction, and that is a convenience, not a licence: `drawing_reading`
        // and `plate_thickness` below are keyed by values that differ from their keys, and a row
        // keyed the wrong way renders NOTHING, silently, for every worker who answered it.
        // Track B #3 (@2): sheet-8 process set — the kept chips relabeled to the
        // sheet's words, robotic/gas-brazing/submerged added as their own claims.
        values: {
          mig_mag: "MIG / CO2",
          tig: "TIG / Argon",
          arc: "Arc / stick",
          spot: "Spot welding",
          robotic: "Robotic welding",
          gas_cutting: "Gas cutting",
          gas_brazing: "Gas / brazing",
          submerged_arc: "Submerged arc",
        },
      },
      {
        from: "welding_equipment",
        rank: 22,
        /**
         * FOUR, NOT THE CONTROLLER ROW'S THREE — the cap follows the PAGE, not the row's position.
         *
         * THIS SHIPPED AS 3 AND WAS A DEFECT, found by driving a welder end to end. The reasoning
         * was "§4.3's controllers max 3 applied to the hardware row", which reads plausibly and is
         * wrong here: `welding_equipment` offers exactly FOUR options and the ratified page prints
         * all four — "Inverter arc set · CO2 / MIG machine · TIG set · Oxy-acetylene cutting set".
         * A cap of three silently dropped the last one, so a welder who tapped every chip he owns
         * still printed as a man with no cutting torch, on the row a fabrication shop scans to see
         * whether he can cut as well as weld.
         *
         * The painter's `coating_equipment` in this same file already settles the identical
         * tension the other way and for the same reason. A controllers cap of three comes from a
         * page that prints three controllers; it is not a rule about hardware rows.
         */
        maxValues: 4,
        label: "Equipment",
        kind: "chips",
        values: {
          inverter_arc: "Inverter arc set",
          co_two_mig: "CO2 / MIG machine",
          tig_machine: "TIG set",
          gas_cutting_set: "Oxy-acetylene cutting set",
        },
      },
      {
        from: "electrode_type",
        // 4x — the consumable is SETTING capability, not a possession. Choosing E7018 over
        // E6013 for a root run is the judgement that separates a welder from a man holding a
        // holder, which is what §5.1 rank 4 covers. Same reading the grinding map applies to its
        // wheel row.
        rank: 43,
        label: "Electrodes / wire",
        kind: "chips",
        // THE PRINTED ENGLISH CARRIES THE DIGITS THE KEY MAY NOT. `option_key` and `value_text`
        // are `^[a-z_]+$` — `e_six_zero_one_three` — because `slugKey` refuses a digit at
        // runtime and one such key makes the whole pack unparseable. The sheet still says E6013,
        // because that is the only thing a fabrication supervisor reads.
        values: {
          e_six_zero_one_three: "E6013",
          e_seven_zero_one_eight: "E7018",
          er_seventy_s_six: "ER70S-6",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        // §4.3 — materials max 4, quoted, not chosen.
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // DICTIONARY ORDER IS THE SHEET'S ORDER: mild steel leads because it is what structural
        // fabrication is made of, and the exotic stock follows.
        values: {
          mild_steel: "MS",
          stainless: "SS",
          aluminium: "Aluminium",
          // Track B #3 (@2): sheet-8 material set.
          alloy_steel: "Alloy steel",
          cast_iron: "Cast iron",
          copper_brass: "Copper / brass",
        },
      },
      {
        from: "welding_position",
        // 4x, WITH THE SETTING ROWS AND NOT WITH THE WEDGE ATTRIBUTES. Position is the whole
        // spread in welding hiring the way programming is in CNC hiring: a flat-only welder and
        // a 4G overhead welder are two different pay bands doing two different jobs, and the
        // ratified page prints the ticks for exactly that reason. Ranking it 6x would drop it
        // before materials on a crowded sheet, which would be a layout judgement standing in for
        // trade truth.
        rank: 41,
        label: "Positions",
        kind: "ticks",
        // THE DASH IS THE PAGE'S, AND IT BELONGS IN THE VALUE. The ratified page prints
        // "1G — flat · 2G — horizontal · 3G — vertical": the code and its gloss are one cell, and
        // this dictionary is exactly the seam where the worker's shop-floor chip ("1G flat")
        // becomes the sheet's English. The painter's map already settles it the same way, keeping
        // the page's dash inside "Liquid spray — HVLP" rather than dropping it at render.
        values: {
          flat: "1G — flat",
          horizontal: "2G — horizontal",
          vertical: "3G — vertical",
          overhead: "4G — overhead",
          // Track B #3 (@2): sheet-8 pipe position.
          pipe_six_g: "6G — pipe",
        },
      },
      {
        from: "inspection_work",
        // 5x — §5.1 rank 5, the measuring-instruments slot. A welder's instruments are a weld
        // gauge and the tests he has been present for; "witness" is deliberate and is what the
        // chip says in Hinglish ("DPT ke samay"), because standing at a radiography test is not
        // the same claim as being a certified NDT inspector and the sheet must not blur them.
        rank: 51,
        label: "Inspection",
        kind: "ticks",
        values: {
          visual: "Visual inspection",
          weld_gauge: "Fillet / weld gauge",
          dye_penetrant: "Dye-penetrant (DPT) witness",
          xray_ut: "X-ray / UT witness",
        },
      },
      {
        from: "plate_thickness",
        rank: 62,
        label: "Plate thickness",
        kind: "fact",
        // KEYED BY THE STORED VALUE, and BANDED rather than a free number. The worker taps a
        // ceiling in his own words ("25 mm tak"); the sheet prints the band from the trade's
        // floor, which is what the ratified page carries. `answer_type: "number"` was never an
        // option — it has no Flutter widget, and a low-literacy worker typing millimetres is a
        // worker who abandons.
        values: {
          upto_three: "Up to 3 mm plate",
          upto_twelve: "3 mm - 12 mm plate",
          upto_twentyfive: "3 mm - 25 mm plate",
          over_twentyfive: "25 mm plate and above",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO ENTRY ON PURPOSE, exactly as on the turner's, miller's and grinder's
        // maps. "Cannot read drawings" is real matching data and it is captured; a worker's own
        // marketing document is not where a negative claim about him belongs.
        values: {
          basic_drawing: "Reads 2D drawings",
          weld_symbol: "Reads 2D drawings and weld symbols",
        },
      },
      {
        from: "welder_certificate",
        rank: 63,
        label: "Certificate",
        kind: "fact",
        // `none` ("Nahi hai") HAS NO ENTRY ON PURPOSE — the drawing row's
        // ruling: a negative claim belongs in matching data, not on the sheet.
        // Track B #3 (@2): sheet-8 Q11.
        values: {
          cert_ibr: "IBR / ASME / third-party certificate",
          iti_welder: "ITI Welder",
          company_test: "Company test passed",
        },
      },
      {
        from: "sector_worked",
        // 8x — §4.3 `sector_tag`: "display only. Never a matching input — locked". It drops
        // first when the page runs out, which is the same rank the turner's and miller's maps
        // give it.
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        // A RECORDED DIVERGENCE, on the ruling the grinding and CAM maps already carry. The
        // ratified page reads "Structural fabrication — general engineering" and this row will
        // print "Structural fabrication · General engineering": the reference sector cells are
        // hand-set prose, no closed-vocabulary dictionary reproduces them, and §8 permits
        // nothing else. A per-row `join` would give this file a second separator for one kind of
        // row and is not worth the divergence it hides.
        values: {
          structural: "Structural fabrication",
          general_engg: "General engineering",
          automotive: "Automotive",
          pipeline: "Pipeline / pressure vessel",
          sheet_fab: "Sheet metal fabrication",
        },
      },
      // TEN ROWS, AND THE PACK ASKS EIGHTEEN NON-FRESHER QUESTIONS. `welder_level` prints in the
      // HEADLINE ("Welder — Skilled"), not in this section, so it has no row here by
      // design. `joint_type`, `machine_setting`, `weld_defect` and `fabrication_work` have no row
      // because NO RATIFIED WELDER PAGE PRINTS ONE — they are matching data in
      // `worker_attributes`, and inventing a tenth and eleventh row for them would be this file
      // asserting a layout the shop floor never approved. If the owner rules that one of them
      // belongs on the sheet, it is a row added here and nothing else changes.
    ],
  },
  {
    /**
     * THE PAINTER / POWDER COATING SHEET.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Shyam Lal Meena, Painter / Powder Coating — Skilled),
     * row for row. Its capability block has EIGHT rows and this map has eight `from`s, in the
     * page's own order: Processes, Equipment, Coatings applied, Surface preparation, Checks
     * performed, Film thickness held, Booth type, Sector worked. Nothing here is invented, and
     * nothing the page prints is missing.
     *
     * THE ORDER IS ALSO THE TEMPLATE'S BANDS, which is why it can be both. `bb_trade.v1.html`
     * emits all chip rows, then all tick rows, then all fact rows; the page prints three chip rows,
     * two tick rows and three fact rows in exactly that sequence, so the array order and the
     * band order agree with no tension to resolve.
     *
     * EIGHT ROWS AGAINST A `CAPABILITY_ROW_BUDGET` OF 10, so this trade never reaches the rank
     * slice — every row a worker answers survives, including the sector row that turning and
     * milling both lose. The ranks below still matter (they are trade truth, and the budget is
     * measured rather than fixed), but no shipped persona is currently shed by them.
     *
     * `coating_level` IS DELIBERATELY ABSENT. The rung — Helper / Operator / Skilled — prints in
     * the HEADLINE ("Painter / Powder Coating — Skilled"), not in the capability block, and the
     * ratified page carries no capability row for it. Mapping it here would invent a ninth row.
     */
    pack_id: "qp_powder_coating",
    section_title: "Processes, equipment & capability",
    tier_section_titles: { easy: "Processes & equipment" },
    capability: [
      {
        from: "coating_process",
        rank: 21,
        /**
         * THE HEADLINE IS THE PROCESS, and unlike the machining roles there is nothing to argue
         * about. The ratified page reads "Painter / Powder Coating — Skilled · 8 yrs · Powder
         * coating, Liquid spray -- HVLP, Electrostatic spray": those three strings ARE this row's
         * first three values in dictionary order, and `toolsPhrase` caps the headline at three, so
         * the segment reproduces character for character.
         *
         * A COATING ADVERTISEMENT IS WRITTEN IN PROCESSES. "Powder coating operator", "spray
         * painter", "HVLP" — never in booth makes, which is what `coating_equipment` holds. The
         * turner's map leads with controllers because a CNC lathe advertisement does; this trade's
         * equivalent of that sentence is the process list.
         */
        inHeadline: true,
        // §4.3 caps the machines-equivalent row at 4, and the ratified page prints exactly four
        // processes. A cap of 3 here would silently drop "Touch-up" off a page a human signed off.
        maxValues: 4,
        label: "Processes",
        kind: "chips",
        values: {
          powder_coating: "Powder coating",
          // THE PAGE'S OWN PUNCTUATION. It prints "Liquid spray -- HVLP" with the gun type set off
          // by a dash rather than in brackets, and this row is where that string is authored.
          liquid_hvlp: "Liquid spray — HVLP",
          electrostatic: "Electrostatic spray",
          touch_up: "Touch-up",
          // Phase 2 #4 (@2): the sheet-20 processes, plating included.
          ced_ecoat: "CED / E-coat",
          electroplating: "Electroplating",
          anodising: "Anodising",
          phosphating_pt: "Phosphating / pre-treatment",
          sandblasting: "Sandblasting / shot blasting",
        },
      },
      {
        from: "coating_equipment",
        rank: 22,
        /**
         * FOUR, NOT THE CONTROLLER ROW'S THREE. §4.3's "controllers max 3" is a cap on a row whose
         * ratified pages print at most three; this row's ratified page prints FOUR — "Powder booth
         * & gun Spray booth Curing oven Pretreatment line" — so borrowing the controller number
         * because this is the second 2x row would drop the pretreatment line off the sheet. The
         * cap follows the page, not the row's position.
         */
        maxValues: 4,
        label: "Equipment",
        kind: "chips",
        values: {
          powder_booth: "Powder booth & gun",
          spray_booth: "Spray booth",
          curing_oven: "Curing oven",
          pretreatment_line: "Pretreatment line",
        },
      },
      {
        from: "coating_material",
        rank: 61,
        // §4.3 materials cap. The page prints four coatings and the dictionary lists four.
        maxValues: 4,
        label: "Coatings applied",
        kind: "chips",
        // DICTIONARY ORDER IS THE SHEET'S ORDER: values render in the order this object lists
        // them, and the page leads with the two powders before the wet paint and the primer.
        values: {
          epoxy_powder: "Epoxy powder",
          polyester_powder: "Polyester powder",
          pu_paint: "PU paint",
          primer_sealer: "Primer & sealer",
        },
      },
      {
        from: "surface_prep",
        rank: 41,
        /**
         * §5.1 RANK 4 — "separates a button-presser from a man who can set the job". In this trade
         * the spread is not programming, it is PREPARATION: adhesion and salt-spray life are won
         * or lost at the degreasing tank and the masking bench, and a coater who only pulls the
         * trigger is a different hire from one who runs the pretreatment line.
         */
        label: "Surface preparation",
        kind: "ticks",
        values: {
          degreasing: "Degreasing",
          phosphating: "Phosphating",
          shot_blasting: "Shot blasting",
          sanding: "Sanding",
          masking: "Masking",
          hanging_jigging: "Hanging & jigging",
          oven_setting: "Oven schedule setting",
        },
      },
      {
        from: "coating_checks",
        rank: 51,
        // §5.1 rank 5, the measuring row. A DFT gauge and a cross-hatch kit are this trade's
        // micrometer and its dial indicator.
        label: "Checks performed",
        kind: "ticks",
        values: {
          dft_gauge: "DFT gauge",
          gloss_meter: "Gloss meter",
          cross_hatch: "Cross-hatch adhesion test",
          bend_test: "Bend test",
          salt_spray: "Salt-spray sample submission",
        },
      },
      {
        from: "film_thickness",
        rank: 62,
        label: "Film thickness held",
        kind: "fact",
        /**
         * KEYED BY THE STORED VALUE, not the option key — the pack's `value_text` is the band
         * string. Keying this by `sixty_to_eighty` would render NOTHING AT ALL, silently, for
         * every coater who answered, which is the failure this file has already shipped twice.
         *
         * THE BANDS ARE THE ANSWER, NOT A NUMBER THE WORKER TYPED. The page prints "60 - 80
         * microns dry film thickness"; the pack asks it as four chips because `answer_type:
         * "number"` has no Flutter widget and a low-literacy worker should be tapping. The row
         * prints "DFT" where the page spells out "dry film thickness" — the abbreviation is what
         * the shop floor and the job advertisement both use, and it costs the sheet three words.
         */
        values: {
          under_60: "Under 60 microns DFT",
          "60_80": "60 - 80 microns DFT",
          "80_100": "80 - 100 microns DFT",
          over_100: "Over 100 microns DFT",
        },
      },
      {
        from: "booth_type",
        rank: 71,
        /**
         * 7x — VOLUNTEERED DEPTH THE GUIDELINE NEVER NAMES. §5.1 has no rung for it and §4.3 does
         * not list it among the wedge attributes, but every ratified coating page prints it,
         * because batch and conveyorised are two different working lives: a conveyor line sets the
         * pace and the oven schedule for you, a batch booth does not.
         *
         * ITS "BOTH" CHIP CARRIES THE PAGE'S OWN SENTENCE. The ratified cell reads "Batch powder
         * booth and conveyorised line", which is one value here rather than two joined — so the
         * default " · " separator never has to reproduce an "and" it does not have.
         */
        label: "Booth type",
        kind: "fact",
        values: {
          batch_booth: "Batch powder booth",
          conveyorised: "Conveyorised line",
          both_booth: "Batch powder booth and conveyorised line",
          // Phase 2 #4 (@2) — Medium Q7 per sheet 20.
          robotic_line: "Robotic line",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        /**
         * §4.3 `sector_tag`: "display only. Never a matching input — locked". It ranks last on
         * every machining map for that reason and it ranks last here; with eight rows against a
         * budget of ten it is not actually shed, which is the only difference.
         *
         * A RECORDED DIVERGENCE, on the ruling the CAM and grinding sheets already carry. The page
         * reads "Auto components and white goods" and this row will read "Auto components · White
         * goods". The ratified sector cells are hand-set prose across all twenty-one pages, so no
         * closed-vocabulary dictionary reproduces them; a `join: " and "` for this one row would
         * give the file a third separator for one kind of row, which is the change that was
         * declined on grinding and is declined again here rather than re-argued per trade.
         */
        values: {
          auto_components: "Auto components",
          white_goods: "White goods",
          furniture_steel: "Steel furniture",
          fabrication: "Fabrication & structures",
          general_job: "General job work",
        },
      },
    ],
  },
  {
    /**
     * THE SHEET METAL SHEET — Batch 2 part two's first.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Jaswinder Singh, Sheet Metal Worker — Skilled), row
     * for row. Its capability block has EIGHT rows and this map has eight `from`s, in the page's
     * own order: Machines, Materials, Operations, Measuring instruments, Sheet thickness,
     * Drawings, Nesting software, Sector worked. That order is also the template's bands — three
     * chip rows, one tick row, four fact rows — so array order and band order agree.
     *
     * TWO ROWS DIVERGE FROM THE PAGE AND ONE CELL IS HALF-CAPTURED, each noted on its row below
     * rather than papered over: "Nesting software" and "Sector worked" are hand-set prose on the
     * page, and "Sheet thickness" carries a brake length ("3200 mm brake") that no question in the
     * pack stores. This pack has no case in role-sheet-parity.render.test.ts yet, so nothing
     * renders the persona end to end against page 14 — the map-vs-pack cross-checks in
     * trade-resume-map.test.ts are what guard it.
     */
    pack_id: "qp_sheet_metal_fab",
    // A SHEET METAL ADVERTISEMENT IS WRITTEN IN MACHINES AND MATERIALS — "fibre laser operator,
    // MS/SS sheet, press brake" — so the heading is the page's own, not the welder's processes.
    section_title: "Machines, materials & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "sheet_metal_machine",
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page leads "Fibre laser cutting, CNC press brake,
        // Turret punch" — the literal vocabulary of the job ad, §5.1 rank 2.
        inHeadline: true,
        // §4.3 machines max 4, and the page prints exactly four.
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        // Track B #5 (@2): sheet-10 machine words; the page's longer labels
        // give way to the sheet's chips.
        values: {
          fibre_laser: "Fibre laser",
          co_two_laser: "CO2 laser",
          cnc_press_brake: "Press brake (CNC)",
          manual_press_brake: "Press brake (manual)",
          turret_punch: "Turret punch / CNC punch",
          shearing: "Shearing",
          plasma_cutting: "Plasma / waterjet",
          hand_fab: "Hand fabrication only",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        // §4.3 materials max 4; the page prints four.
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // Track B #5 (@2): sheet-10 short material words.
        values: {
          ms_sheet: "MS",
          stainless: "SS",
          gi_sheet: "GI",
          aluminium: "Aluminium",
        },
      },
      {
        from: "sheet_operation",
        // §5.1 rank 4: development and bending are what separate a man who feeds a shear from one
        // who can make the part from a drawing.
        rank: 41,
        // NO CAP. The page prints SEVEN operations, and a cap would drop a value the ratified
        // sheet shows — the welder's `Equipment` defect, avoided rather than repeated.
        label: "Operations",
        kind: "chips",
        values: {
          development_layout: "Development & layout",
          bending: "Bending & bump forming",
          notching: "Notching",
          punching: "Punching",
          rolling: "Rolling",
          spot_welding: "Spot welding",
          deburring: "Deburring & finishing",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier",
          steel_rule_tape: "Steel rule & tape",
          protractor: "Protractor / angle gauge",
          thickness_gauge: "Thickness gauge",
          try_square: "Try square",
        },
      },
      {
        from: "sheet_thickness",
        rank: 62,
        label: "Sheet thickness",
        kind: "fact",
        // BANDED, on the welder's plate ruling: a band prints as the page prints it. The page's
        // "· 3200 mm brake" is a machine capacity with no question behind it — a capture gap.
        // Track B #5 (@2): re-banded to the sheet-10 bands; old bands drop, recorded cost.
        values: {
          below_one: "Up to 1 mm sheet",
          one_to_three: "1 - 3 mm sheet",
          three_to_six: "3 - 6 mm sheet",
          above_six: "6 mm sheet and above",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs.
        values: {
          basic_drawing: "Reads 2D drawings",
          flat_pattern: "Reads 2D fabrication drawings and flat patterns",
        },
      },
      {
        from: "nesting_software",
        // §5.1 rank 4 — programming the machine is setting capability.
        rank: 43,
        label: "Nesting software",
        kind: "fact",
        // A RECORDED DIVERGENCE: the page reads "Basic nesting on machine software · imports DXF",
        // with a down-cased second clause no closed dictionary may produce (§8); this row reads
        // "Program load & run · Imports DXF".
        // Track B #5 (@2): expanded to the sheet-10 depth set.
        values: {
          nesting_brand: "SigmaNEST / Lantek / Cypcut",
          basic_nesting: "Program load & run",
          dxf_import: "Imports DXF",
          param_setting: "Parameter setting",
          tooling_change: "Tooling change",
          bend_program: "Bend sequence",
          blank_development: "Blank development",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. A RECORDED DIVERGENCE on the ruling every
        // shipped sector row carries: the page's "Enclosures, panels and general fabrication" is
        // hand-set prose, and this row reads "Enclosures & panels · General fabrication".
        values: {
          enclosures_panels: "Enclosures & panels",
          general_fab: "General fabrication",
          hvac_ducting: "HVAC ducting",
          automotive: "Automotive parts",
          kitchen_equipment: "Kitchen equipment & furniture",
        },
      },
      {
        from: "sheet_metal_product",
        rank: 80,
        label: "Product",
        kind: "fact",
        // Track B #5 (@2): sheet-10 Q7. What the product IS, distinct from
        // the industry rows, which name where the worker learned or worked.
        values: {
          panels_enclosures: "Panels / enclosures",
          auto_parts: "Auto parts",
          ducting_hvac: "Ducting / HVAC",
          furniture: "Furniture",
          structural_brackets: "Structural / brackets",
          kitchen_ss: "Kitchen / SS products",
        },
      },
      {
        from: "sheet_metal_extra",
        rank: 64,
        label: "Extra work",
        kind: "fact",
        // Track B #5 (@2): sheet-10 Q11. Drawing reading is covered by its
        // own row, so it is not repeated here.
        values: {
          welding: "Welding",
          grinding_finish: "Grinding / finishing",
          assembly: "Assembly",
          powdercoat_prep: "Powder-coat prep",
        },
      },
    ],
  },
  {
    /**
     * THE INDUSTRIAL ELECTRICIAN SHEET — Batch 2 part two.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Balwant Singh, Industrial Electrician — Senior, page
     * 9), row for row. Its capability block has EIGHT rows and this map has eight `from`s, in the
     * page's own order: Work type, Equipment, Panel & motor work, Instruments, Voltage worked on,
     * Drawings, Licence, Sector worked. That order is also the template's bands — three chip rows,
     * one tick row, four fact rows — so array order and band order agree.
     *
     * ONE CELL IS HALF-CAPTURED, noted on its row rather than papered over: "Licence" prints the
     * licence TYPE, and the page's "· Uttar Pradesh, valid to 2028" is an issuing state and an
     * expiry year that no question in the pack stores. Every other cell reproduces the page's text
     * from a closed dictionary. This pack has no case in role-sheet-parity.render.test.ts yet, so
     * nothing renders the persona end to end against page 9 — the map-vs-pack cross-checks in
     * trade-resume-map.test.ts are what guard it.
     *
     * `electrician_level` IS DELIBERATELY ABSENT. The rung prints in the HEADLINE ("Industrial
     * Electrician — Senior"), not in this block. The tier-2 items (`control_circuit`,
     * `motor_fault`, `electrical_safety`) have no row because the ratified page has none; they are
     * matching data in `worker_attributes`, the welder's ruling.
     */
    pack_id: "qp_industrial_electrician",
    // AN ELECTRICIAN'S ADVERTISEMENT IS WRITTEN IN WORK AND EQUIPMENT — "panel wiring electrician,
    // MCC / VFD" — so the heading is the page's own.
    section_title: "Electrical work, equipment & capability",
    tier_section_titles: { easy: "Equipment" },
    capability: [
      {
        from: "electrical_work_type",
        // §5.1 rank 2 beside the equipment: "panel wiring" is itself the job-ad phrase (it is the
        // tranche alias that reaches this pack). 22, not 21, because the HEADLINE is the equipment.
        rank: 22,
        // NO CAP. §4.3 caps machines, controllers and materials; this is none of them, and the pack
        // offers one value the page does not print ("Lighting & power wiring"), which follows the
        // page's four in dictionary order.
        label: "Work type",
        kind: "chips",
        values: {
          panel_wiring: "Panel wiring / control panel",
          motor_drive: "Motor & drive work",
          // Track B #2 (@2): sheet-7 work set.
          factory_maintenance: "Factory maintenance",
          ht_lt_substation: "HT / LT substation",
          solar: "Solar",
          generator_dg: "Generator / DG",
          cable_laying: "Cable laying",
          earthing: "Earthing",
          lighting_power: "Building wiring",
        },
      },
      {
        from: "electrical_equipment",
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page reads "MCC & PCC panels, VFD / AC drives, DOL &
        // star-delta starters" — this row's first three values in dictionary order, and
        // `toolsPhrase` caps the headline at three, so the segment reproduces character for
        // character.
        inHeadline: true,
        // §4.3 machines max 4, and the page prints exactly four. "DG sets" is the pack's fifth
        // option and the one a worker who ticks everything loses — dictionary order, not usage.
        maxValues: 4,
        label: "Equipment",
        kind: "chips",
        values: {
          mcc_pcc: "MCC & PCC panels",
          vfd_drive: "VFD / AC drives",
          starter: "DOL & star-delta starters",
          induction_motor: "Induction motors",
          dg_set: "DG sets",
          // Track B #2 (@2): sheet-7 equipment set.
          contactor_relay: "Contactors & relays",
          sensors: "Sensors",
          plc_panel_wiring: "PLC panel (wiring only)",
          transformer: "Transformers",
          ups_battery: "UPS / batteries",
        },
      },
      {
        from: "panel_motor_work",
        // §5.1 rank 4: drive parameter setting and fault finding are what separate a man who pulls
        // cable from one who can bring a line back after a trip.
        rank: 41,
        // NO CAP. The page prints SIX, and a cap would drop a value the ratified sheet shows.
        label: "Panel & motor work",
        kind: "chips",
        values: {
          panel_assembly: "Panel assembly & wiring",
          drive_parameter: "Drive parameter setting",
          fault_finding: "Fault finding",
          motor_rewind: "Motor rewind coordination",
          cable_termination: "Cable termination & glanding",
          earth_pit_testing: "Earth pit testing",
        },
      },
      {
        from: "measuring_tools",
        // §5.1 rank 5, the measuring row. Keyed by the SHARED attribute name on purpose — the
        // label is this page's "Instruments", and the dictionary is this trade's own meters.
        rank: 51,
        label: "Instruments",
        kind: "ticks",
        values: {
          multimeter: "Multimeter",
          clamp_meter: "Clamp meter",
          megger: "Megger",
          tong_tester: "Tong tester",
          phase_sequence: "Phase sequence meter",
          // Track B #2 (@2): sheet-7 fault-finding set.
          thermal_camera: "Thermal camera",
        },
      },
      {
        from: "electrical_voltage",
        // 6x, the plate-thickness reading: the voltage band is a capacity the job is scoped by.
        rank: 62,
        label: "Voltage worked on",
        kind: "fact",
        // A MULTI-SELECT, SO THE DEFAULT " · " JOIN REPRODUCES THE PAGE: "LT up to 415 V · HT
        // switchyard exposure under supervision" is two values, not one sentence. "under
        // supervision" is the chip's "senior ke saath" — the sheet must not turn exposure into an
        // HT authorisation the worker never claimed.
        values: {
          lt_three_phase: "LT up to 415 V",
          ht_supervised: "HT switchyard exposure under supervision",
          ht_independent: "HT operation & maintenance",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs.
        values: {
          schematic: "Reads electrical schematics",
          schematic_ga: "Reads electrical schematics and panel GA drawings",
        },
      },
      {
        from: "electrical_licence",
        // 6x — a statutory credential the guideline's §5.1 list does not name. Eight rows against
        // a `CAPABILITY_ROW_BUDGET` of ten, so no rank here is ever shed today; flagged for the
        // RVM redline with the rest of the ordering.
        rank: 63,
        label: "Licence",
        kind: "fact",
        // A CAPTURE GAP, recorded rather than hidden: the page reads "Electrician licence · Uttar
        // Pradesh, valid to 2028", and the issuing state and expiry year have no question behind
        // them, so this row prints "Electrician licence" alone. `none` ("Nahi hai") has no label —
        // the same no-negative-claims rule as `drawing_reading`.
        values: {
          electrician_licence: "Electrician licence",
          supervisor_licence: "Electrical supervisor licence",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. The page's single value "Manufacturing
        // plant electrical" is authored here verbatim, so this sector row, unlike most shipped
        // ones, reproduces its page exactly for the ratified persona.
        values: {
          manufacturing_plant: "Manufacturing plant electrical",
          panel_builder: "Panel manufacturing",
          process_plant: "Process plant — chemical, pharma, food",
          building_services: "Commercial building services",
          power_substation: "Power plant & substation",
        },
      },
    ],
  },
  {
    /**
     * THE PRESS SHEET — Batch 2 part two's second.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Rakesh Kumar Paswan, Press / Machine Operator —
     * Setter, page 12), row for row. Its capability block has EIGHT rows and this map has eight
     * `from`s, in the page's own order: Machines, Materials, Setting work, Safety systems used,
     * Tonnage worked, Stroke rate, Drawings, Sector worked. That order is also the template's
     * bands — three chip rows, one tick row, four fact rows — so array order and band order agree.
     *
     * TWO CELLS ARE NOT REPRODUCED VERBATIM, each noted on its row below rather than papered over:
     * "Tonnage worked" prints a range whose lower bound no question stores, and "Stroke rate"
     * carries a trailing "on progressive tooling" this map has no seam to append. The page shows NO
     * moulding anywhere, so owner ruling R4-a (metal forming only) removed nothing from it. This
     * pack has no case in role-sheet-parity.render.test.ts yet, so nothing renders the persona end
     * to end against page 12 — the map-vs-pack cross-checks in trade-resume-map.test.ts are what
     * guard it.
     */
    pack_id: "qp_press_operation",
    // THE PAGE'S OWN HEADING. A press advertisement is written in machines and tonnage — "power
    // press operator, 100 T, progressive die" — so tonnage sits in the title, not only in a row.
    section_title: "Machines, tonnage & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "press_machine",
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page leads "Mechanical power press, Hydraulic press,
        // Pneumatic press" — the guideline's three-tool headline cap takes the first three of the
        // four this row prints, in dictionary order, which is the page's order.
        inHeadline: true,
        // §4.3 machines max 4, and the page prints exactly four.
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        // "Press brake" IS PRINTED BECAUSE THE PAGE PRINTS IT. It is the sheet metal worker's
        // machine term in the router and not this role's; a resume row routes nobody.
        values: {
          mechanical_power_press: "Mechanical power press",
          hydraulic_press: "Hydraulic press",
          pneumatic_press: "Pneumatic press",
          press_brake: "Press brake",
          fly_press: "Fly press / hand press",
          // Phase 2 #3 (@2): the sheet-18 press types.
          servo_press: "Servo press",
          progressive_line: "Progressive line with coil feeder",
          transfer_press: "Transfer press",
          tandem_line: "Tandem line",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        // §4.3 materials max 4; the page prints four.
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          ms_sheet: "MS sheet",
          gi_sheet: "GI sheet",
          aluminium: "Aluminium sheet",
          spring_steel: "Spring steel strip",
        },
      },
      {
        from: "press_setting",
        // §5.1 rank 4: die setting is what separates a man who feeds a press from the setter who
        // hands it over — the Operator/Setter line on this role's ladder.
        rank: 41,
        // NO CAP. The page prints SIX setting values, and a cap would drop one the ratified sheet
        // shows — the sheet metal map's Operations ruling.
        label: "Setting work",
        kind: "chips",
        values: {
          die_change: "Die change",
          die_setting: "Die setting & alignment",
          shut_height: "Shut-height setting",
          feeder_setting: "Feeder setting",
          strip_layout_check: "Strip layout check",
          first_piece: "First-piece approval",
          // Phase 2 #3 (@2) — Advanced Q11 per sheet 18.
          coil_handling: "Coil handling / decoiler",
        },
      },
      {
        from: "press_safety",
        // §5.1 NAMES NO SAFETY ROW. It takes rank 5's band because it is this sheet's tick row —
        // the place measuring instruments hold on every machining sheet — flagged for the same RVM
        // redline as the rest of this ordering.
        rank: 51,
        label: "Safety systems used",
        kind: "ticks",
        values: {
          two_hand_control: "Two-hand control",
          light_curtain: "Light curtain",
          guard_interlock: "Guard interlock",
          emergency_stop: "Emergency stop check",
          lockout_tagout: "Lockout-tagout",
          // Phase 2 #3 (@2) — Advanced Q10 per sheet 18.
          ppe: "PPE",
        },
      },
      {
        from: "press_tonnage",
        // §5.1 rank 2, beside the machines: tonnage is a statement about what the MACHINE can do,
        // the reasoning that puts turning configuration at 2x, and the page's heading names it.
        rank: 22,
        label: "Tonnage worked",
        kind: "fact",
        // A RECORDED DIVERGENCE: the page reads "30 T - 250 T presses", a range whose LOWER bound
        // no question stores — the pack asks the largest press run, banded on the welder's plate
        // ruling. Printing "30 T -" would be a number nobody stated (§8), so the persona's row
        // reads "Up to 250 T presses".
        values: {
          // Phase 2 #3 (@2): re-banded to sheet 18's four bands. @1's 30 T,
          // 250 T and over-250 T answers drop off the row (recorded cost, the
          // sheet-metal thickness precedent); "Up to 100 T" keeps its value.
          upto_hundred: "Up to 100 T presses",
          hundred_to_twofifty: "100–250 T presses",
          twofifty_to_sixthirty: "250–630 T presses",
          over_sixthirty: "Over 630 T presses",
        },
      },
      {
        from: "press_stroke_rate",
        rank: 63,
        label: "Stroke rate",
        kind: "fact",
        // A RECORDED DIVERGENCE: the page reads "Up to 60 strokes per minute on progressive
        // tooling". The die type IS captured (`press_die_type`, tier 2), but `configFrom` appends
        // to a first chip with a middot and there is no seam for a fact row's trailing clause —
        // the grinding map's `dressing_method` question, left open there for the same reason. This
        // row reads "Up to 60 strokes per minute".
        values: {
          upto_twenty: "Up to 20 strokes per minute",
          upto_sixty: "Up to 60 strokes per minute",
          over_sixty: "Over 60 strokes per minute",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs.
        values: {
          basic_drawing: "Reads 2D component drawings",
          strip_layout: "Reads 2D component drawings and strip layouts",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. The page's cell is a single value,
        // "Sheet-metal pressed components", and it is an option here, so this persona's row
        // reproduces the page exactly; a worker who picks several prints them " · "-joined.
        values: {
          pressed_components: "Sheet-metal pressed components",
          automotive: "Automotive pressings",
          electrical_parts: "Electrical & switchgear parts",
          appliances: "Home appliance parts",
          utensils: "Utensils & kitchenware",
        },
      },
    ],
  },
  {
    /**
     * THE ASSEMBLY LINE SHEET — Batch 2 part two's second.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Deepak Jadhav, Assembly Line Worker — Skilled, page
     * 6), row for row. Its capability block has SEVEN rows and this map has seven `from`s, in the
     * page's own order: Assembly stage, Products assembled, Tools used, Shop-floor practice, Line
     * rate worked to, Drawings, Sector worked. That order is also the template's bands — three
     * chip rows, one tick row, three fact rows — so array order and band order agree.
     *
     * CHIPS OR TICKS IS A READING, NOT A MEASUREMENT. The extracted page text carries no chip or
     * tick glyph for any row, so the kinds follow the band order the template enforces (every
     * chip row above every tick row) and what each row IS: stages, products and tools are the
     * vocabulary of a job advertisement, like the welder's processes; shop-floor practice is a
     * checklist of disciplines, like his positions and inspection.
     *
     * ONE ROW DIVERGES FROM THE PAGE, noted on the row below rather than papered over: "Line rate
     * worked to" is hand-set prose around one figure. This pack has no case in
     * role-sheet-parity.render.test.ts yet, so nothing renders the persona end to end against
     * page 6 — the map-vs-pack cross-checks in trade-resume-map.test.ts are what guard it.
     */
    pack_id: "qp_assembly_line",
    // AN ASSEMBLY ADVERTISEMENT IS WRITTEN IN STAGES, PRODUCTS AND TOOLS — "final line operator,
    // engine sub-assembly, DC nut runner" — so the heading is the page's own.
    section_title: "Assembly work, tools & capability",
    tier_section_titles: { easy: "Assembly work & tools" },
    capability: [
      {
        from: "assembly_stage",
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page leads "Sub-assembly, Final assembly, End-of-line
        // testing" — the stage is what a line vacancy is advertised by, §5.1 rank 2.
        inHeadline: true,
        // NO CAP. The page prints three and the pack offers five; the guideline quotes no number
        // for stages, and the headline caps its own segment at three.
        label: "Assembly stage",
        kind: "chips",
        values: {
          sub_assembly: "Sub-assembly",
          final_assembly: "Final assembly",
          end_of_line: "End-of-line testing",
          line_feeding: "Line feeding & kitting",
          rework: "Rework & repair",
        },
      },
      {
        from: "assembly_line_product",
        rank: 22,
        label: "Products assembled",
        kind: "chips",
        // The page's four, in its order; the pack's fifth chip (door, dashboard and trim) prints
        // after them. Track B #6 (@2): sheet-11 segment chips lead, the v1
        // vehicle-detail chips follow as history.
        values: {
          auto_two_wheeler: "Auto / 2-wheeler",
          engine_gearbox_axle: "Engine / gearbox / axle",
          elec_switchgear: "Electrical / switchgear",
          appliances: "Appliances",
          electronics_ems: "Electronics / EMS",
          machines_spm: "Machines / SPM",
          pumps_motors: "Pumps / motors",
          ev_battery: "EV / battery pack",
          engine_sub_assembly: "Engine sub-assembly",
          transmission: "Transmission assembly",
          seat_assembly: "Seat assembly",
          wiring_harness: "Wiring harness routing",
          door_trim: "Door & trim assembly",
        },
      },
      {
        from: "assembly_tool",
        rank: 23,
        // NO CAP. The page prints SIX tools, and §4.3's "machines max 4" would drop two values
        // the ratified sheet shows — the welder's `Equipment` defect, avoided rather than repeated.
        label: "Tools used",
        kind: "chips",
        // Track B #6 (@2): sheet-11 tool words; the kept history chips follow.
        values: {
          dc_nut_runner: "DC nut runner",
          torque_wrench: "Torque wrench",
          pneumatic_gun: "Pneumatic tools",
          hand_tools: "Hand tools",
          press_jig: "Press / jig fixtures",
          soldering_crimping: "Soldering / crimping",
          test_bench: "Test bench",
          poka_yoke: "Poka-yoke fixture",
          leak_test_rig: "Leak test rig",
          go_no_go_gauge: "Go / no-go gauge",
        },
      },
      {
        from: "assembly_practice",
        // §4.3 wedge depth below the §5.1 list — the disciplines a plant screens a line hand on,
        // but not what the vacancy is advertised by.
        rank: 61,
        label: "Shop-floor practice",
        kind: "ticks",
        values: {
          sop_adherence: "SOP adherence",
          kanban_pull: "Kanban pull",
          five_s: "5S",
          kaizen: "Kaizen suggestions",
          line_balancing: "Line balancing support",
          first_off_check: "First-off checking",
        },
      },
      {
        from: "assembly_takt_time",
        rank: 62,
        label: "Line rate worked to",
        kind: "fact",
        // A RECORDED DIVERGENCE. The page reads "Worked to 90-second takt on final line": one
        // figure and a stage, hand-set. BANDED, on the welder's plate ruling — a free number has
        // no closed dictionary to print through — and the stage is already the first row. So the
        // page's worker prints "Worked to 60-120 second takt", the band that holds 90 seconds.
        values: {
          under_one_minute: "Worked to under 60-second takt",
          one_to_two_minutes: "Worked to 60-120 second takt",
          two_to_five_minutes: "Worked to 2-5 minute takt",
          over_five_minutes: "Worked to takt over 5 minutes",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs.
        values: {
          work_instruction: "Reads work instructions",
          assembly_drawing: "Reads assembly drawings and work instructions",
        },
      },
      {
        from: "assembly_skill",
        rank: 42,
        label: "Assembly skills",
        kind: "ticks",
        // Track B #6 (@2): sheet-11 Q9. Drawing reading is covered by its own
        // row, so it is not repeated here.
        values: {
          testing_inspection: "Testing & inspection",
          troubleshoot_rework: "Troubleshooting / rework",
          line_changeover: "Line changeover",
          kaizen_five_s: "Kaizen / 5S",
          training_others: "Training others",
        },
      },
      {
        from: "company_type",
        rank: 82,
        label: "Company type",
        kind: "fact",
        // Track B #6 (@2): sheet-11 Q10. Whose line it is, distinct from the
        // product rows, which name what the line makes.
        values: {
          oem: "OEM",
          tier_one: "Tier-1",
          tier_two_three: "Tier-2 / 3",
          contract: "Contract (thekedar)",
          own_workshop: "Own workshop",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. The page's "Passenger vehicle assembly"
        // is reproduced verbatim by the first entry.
        values: {
          passenger_vehicle: "Passenger vehicle assembly",
          two_wheeler: "Two-wheeler assembly",
          commercial_vehicle: "Commercial vehicle & tractor assembly",
          auto_components: "Auto component assembly",
          appliances: "Appliance & electronics assembly",
        },
      },
    ],
  },
  {
    /**
     * THE FITTER SHEET — Batch 2 part two's second.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Suresh Pawar, Fitter — Senior Fitter, page 8), row
     * for row. Its capability block has SEVEN rows and this map has seven `from`s, in the page's
     * own order: Fitting type, Equipment worked on, Bench & assembly work, Tools & instruments,
     * Drawings, Alignment held, Sector worked. That order is also the template's bands — three
     * chip rows, one tick row, three fact rows — so array order and band order agree.
     *
     * ONE ROW DIVERGES FROM THE PAGE, noted on the row rather than papered over: "Sector worked"
     * is hand-set prose on the page. The chip/tick split between "Bench & assembly work" and
     * "Tools & instruments" is read off the layout's parallel with the sheet metal page
     * (Operations / Measuring instruments), because the extracted text cannot show a tick. This
     * pack has no case in role-sheet-parity.render.test.ts yet, so nothing renders the persona
     * end to end against page 8 — the map-vs-pack cross-checks in trade-resume-map.test.ts are
     * what guard it.
     *
     * `fitter_level` IS DELIBERATELY ABSENT — the rung prints in the headline ("Fitter — Senior
     * Fitter"), not in this block. So are the four depth answers (`fitter_hydraulic_work`,
     * `fitter_overhaul`, `fitter_erection`, `fitter_fault_finding`): no ratified fitter page prints
     * a row for them, and they are matching data in `worker_attributes`.
     */
    pack_id: "qp_fitter",
    // A FITTER IS HIRED ON WHAT HE HAS FITTED — "maintenance fitter, gearbox and pump overhaul" —
    // so the heading is the page's own, not a machinist's machines.
    section_title: "Fitting work, equipment & capability",
    tier_section_titles: { easy: "Equipment" },
    capability: [
      {
        from: "fitter_work_type",
        // §5.1 rank 2: "maintenance fitter" and "assembly fitter" are the literal words of the job
        // advertisement — the fitter's equivalent of a turner's controllers.
        rank: 21,
        label: "Fitting type",
        kind: "chips",
        // DICTIONARY ORDER IS THE PAGE'S: the page prints the first three in this order.
        // `bench_fitting` is the pack's fourth chip — the bound "Fitter, Bench" worker's own — and
        // sits last so the ratified persona renders exactly as printed.
        values: {
          assembly_fitting: "Mechanical assembly",
          maintenance_fitting: "Maintenance fitting",
          // Track B #1 (@2): sheet-6 work set.
          pipe_fitting: "Pipe fitting",
          structural_fitting: "Structural fitting",
          die_press_fitting: "Die / press fitting",
          erection_commissioning: "Machine erection / commissioning",
          bench_fitting: "Bench fitting",
        },
      },
      {
        from: "fitter_equipment",
        rank: 22,
        // THE HEADLINE'S THIRD SEGMENT: the page leads "Gearboxes, Centrifugal pumps, Conveyors" —
        // this row's first three values in dictionary order, and `toolsPhrase` caps at three, so
        // the segment reproduces character for character.
        inHeadline: true,
        // §4.3 machines max 4, and the page prints exactly four.
        maxValues: 4,
        label: "Equipment worked on",
        kind: "chips",
        // PLURAL, AS THE PAGE PRINTS THEM. The chip is the worker's singular ("Gearbox"); the sheet
        // says what he has worked on.
        values: {
          gearbox: "Gearboxes",
          centrifugal_pump: "Centrifugal pumps",
          conveyor: "Conveyors",
          hydraulic_power_pack: "Hydraulic power packs",
          compressor: "Compressors",
          blower_fan: "Blowers & fans",
        },
      },
      {
        from: "fitting_work",
        // §5.1 rank 4: bearing fitting and coupling alignment are what separate a helper who
        // holds the spanner from a fitter who can be left with the machine.
        rank: 41,
        // NO CAP. The page prints SEVEN values, and a cap would drop one the ratified sheet shows —
        // the welder's `Equipment` defect, avoided rather than repeated.
        label: "Bench & assembly work",
        kind: "chips",
        values: {
          marking_scribing: "Marking & scribing",
          filing_scraping: "Filing & scraping",
          drilling_tapping: "Drilling & tapping",
          bearing_fitting: "Bearing fitting",
          coupling_alignment: "Coupling alignment",
          belt_chain: "Belt & chain tensioning",
          seal_gland: "Seal & gland replacement",
        },
      },
      {
        from: "measuring_tools",
        // §5.1 rank 5, the instruments slot. The page puts three fitting TOOLS (torque wrench,
        // hydraulic puller, laser alignment kit) in the same row as its four instruments, under
        // its own label, and this row prints them the same way.
        rank: 51,
        label: "Tools & instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier",
          micrometer: "Micrometer",
          dial_gauge: "Dial gauge",
          feeler_gauge: "Feeler gauge",
          torque_wrench: "Torque wrench",
          hydraulic_puller: "Hydraulic puller",
          laser_alignment: "Laser alignment kit",
          // Track B #1 (@2): sheet-6 instrument set.
          height_gauge: "Height gauge",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs.
        values: {
          basic_drawing: "Reads 2D drawings",
          assembly_drawing: "Reads 2D assembly drawings",
          hydraulic_circuit: "Reads 2D assembly drawings and hydraulic circuits",
        },
      },
      {
        from: "fitting_alignment",
        // 6x, the tolerance slot the turner's `tolerance_band` holds: a precision claim, not a
        // skill.
        rank: 62,
        label: "Alignment held",
        kind: "fact",
        // BANDED, on the welder's plate ruling: the worker taps a band ("0.05 mm tak") and the
        // sheet prints the page's sentence. `none` ("Alignment nahi karta") has no label, on the
        // drawing row's ruling.
        values: {
          point_one: "Coupling alignment to 0.1 mm",
          point_zero_five: "Coupling alignment to 0.05 mm",
          point_zero_two: "Coupling alignment to 0.02 mm",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. A RECORDED DIVERGENCE on the ruling every
        // shipped sector row carries: the page's "Auto components · plant maintenance" is
        // hand-set, with a down-cased second value no closed dictionary may produce (§8), and
        // this row reads "Auto components · Plant maintenance".
        values: {
          auto_components: "Auto components",
          // Track B #1 (@2): sheet-6 industry set.
          spm_machine_building: "SPM / machine building",
          fabrication: "Fabrication",
          pumps_compressors: "Pumps / compressors",
          plant_maintenance: "Plant maintenance",
          steel_cement: "Power / steel plants",
          process_plant: "Chemical & process plants",
          general_engg: "General engineering",
        },
      },
    ],
  },
  {
    /**
     * THE QUALITY INSPECTOR SHEET — Batch 2 part two.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Anjali Verma, Quality Inspector / QC — QC Engineer,
     * page 13), row for row. Its capability block has EIGHT rows and this map has eight `from`s,
     * in the page's own order: Instruments, Standards, Materials inspected, Inspection stage,
     * Documentation, Drawings, Least count worked to, Sector worked. That order is also the
     * template's bands — three chip rows, two tick rows, three fact rows — so array order and band
     * order agree.
     *
     * NO ROW DIVERGES FROM THE PAGE for its own persona: every cell she prints is a value in the
     * dictionaries below, in the page's wording, including the two fact rows the sheet metal map
     * could only approximate — "Reads 2D drawings and GD&T · datum and true position" is one
     * option's label, and "Works to 0.001 mm least count" one band's. The rows print MORE than the
     * page only where the pack offers a value the page does not show (a second standard, a junior
     * inspector's vernier and micrometer, other sectors), never a different wording of one it does.
     * This pack has no case in role-sheet-parity.render.test.ts yet, so nothing renders the persona
     * end to end against page 13 — the map-vs-pack cross-checks in trade-resume-map.test.ts and
     * role-corpus-parity.guard.test.ts are what guard it.
     *
     * `inspection_level` IS DELIBERATELY ABSENT — the rung ("— QC Engineer") rides the headline
     * through `role_label`, the welder's and the powder coater's ruling. `inspection_cmm_work`,
     * `inspection_rejection_work` and `inspection_audit_work` are real matching data with no row on
     * the ratified page, and inventing one is what §5b forbids.
     */
    pack_id: "qp_quality_inspection",
    // AN INSPECTION ADVERTISEMENT IS WRITTEN IN INSTRUMENTS AND STANDARDS — "CMM inspector, IATF
    // plant, PPAP" — so the heading is the page's own, not a machinist's machines.
    section_title: "Instruments, standards & capability",
    tier_section_titles: { easy: "Instruments" },
    capability: [
      {
        from: "measuring_tools",
        // §5.1 RANK 2, NOT THE MACHINING MAPS' 5x. For a turner the instruments are what he checks
        // his own job with; for this trade they ARE the machines — "CMM operator" is the literal
        // vocabulary of the job advertisement, which is exactly what rank 2 covers.
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page leads "CMM, Profile projector, Height gauge" —
        // `toolsPhrase`'s three-value cap over this row's dictionary order.
        inHeadline: true,
        // §4.3 machines max 4, and the page prints exactly four. A worker who taps all five keeps
        // the page's four; "Vernier & micrometer" is the junior inspector's row, and it prints in
        // full for the man who holds only those.
        maxValues: 4,
        label: "Instruments",
        kind: "chips",
        // Track B #7 (@2): sheet-12 instrument set; the kept history chips
        // follow in dictionary order.
        values: {
          cmm: "CMM",
          profile_projector: "Profile projector",
          height_gauge: "Height gauge",
          vernier: "Vernier",
          micrometer: "Micrometer",
          bore_gauge: "Bore gauge",
          thread_gauge: "Thread / plug / ring gauge",
          roughness_tester: "Surface roughness tester",
          hardness_tester: "Hardness tester",
          multimeter_hipot: "Multimeter / hipot",
          vernier_micrometer: "Vernier & micrometer",
        },
      },
      {
        from: "inspection_standard",
        // §4.3 wedge attribute — named in the advertisement, but it is the plant's certification
        // rather than a capability of the man, so it ranks below the materials he has checked.
        rank: 63,
        label: "Standards",
        kind: "chips",
        values: {
          iatf: "IATF 16949",
          iso_nine_thousand_one: "ISO 9001",
          as_nine_one_hundred: "AS9100",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        // §4.3 materials max 4; the page prints three.
        maxValues: 4,
        label: "Materials inspected",
        kind: "chips",
        values: {
          machined_steel: "Machined parts",
          sheetmetal_welding: "Sheet metal / welding",
          plastics: "Plastics",
          castings_forgings: "Castings / forgings",
          elec_electronics: "Electrical / electronics",
          assembly_product: "Assembly",
          die_cast: "Aluminium die-cast",
          pressings: "Sheet-metal pressings",
          welded_fabrication: "Welded fabrications",
        },
      },
      {
        from: "inspection_stage",
        // §5.1 rank 4: layout inspection and gauge R&R are what separate a patrol checker from an
        // inspector who can sign a part off.
        rank: 41,
        // NO CAP. The page prints FIVE stages, and a cap would drop a value the ratified sheet
        // shows — the welder's `Equipment` defect, avoided rather than repeated.
        label: "Inspection stage",
        kind: "ticks",
        values: {
          incoming: "Incoming inspection",
          in_process_patrol: "In-process",
          line_patrol: "Line / patrol",
          final_inspection: "Final inspection",
          lab_testing: "Lab / testing",
          welding_inspection: "Welding inspection",
          electrical_testing: "Electrical testing",
          layout_inspection: "Layout inspection",
          gauge_rr: "Gauge R&R support",
        },
      },
      {
        from: "inspection_documentation",
        // §5.1 rank 4 as well — PPAP, the control plan and the 8D are the QC engineer's rung.
        rank: 42,
        // NO CAP, for the same reason: the page prints SIX documents.
        label: "Documentation",
        kind: "ticks",
        values: {
          ppap: "PPAP documents",
          control_plan: "Control plan",
          inspection_report: "Inspection report",
          eight_d_capa: "8D / CAPA",
          spc_chart: "SPC charts",
          // Track B #7 (@2): the sheet-12 systems the v1 rows did not name.
          fmea: "FMEA",
          msa: "MSA",
          calibration_register: "Calibration register",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs. The GD&T
        // chip names datum and true position in its own label, so printing them is not a claim
        // the worker did not tap.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T · datum and true position",
          // Track B #7 (@2): sheet-12 tolerance-stack chip.
          tolerance_stack: "Reads tolerance stacks",
        },
      },
      {
        from: "inspection_least_count",
        // Beside `tolerance_band` (62 on every machining map): the finest figure the man works to.
        rank: 62,
        label: "Least count worked to",
        kind: "fact",
        // BANDED, on the welder's plate ruling: a band prints as the page prints it.
        values: {
          point_zero_two: "Works to 0.02 mm least count",
          point_zero_one: "Works to 0.01 mm least count",
          point_zero_zero_one: "Works to 0.001 mm least count",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. The page's "Automotive tier-1 supply" is a
        // dictionary value here, not hand-set prose, so this row reproduces it exactly.
        values: {
          auto_tier_one: "Automotive tier-1 supply",
          auto_oem: "Automotive OEM",
          general_engg: "General engineering",
          pump_valve: "Pumps & valves",
          defence: "Defence / aerospace",
        },
      },
    ],
  },
  {
    /**
     * THE MAINTENANCE SHEET — Batch 2 part two's last.
     *
     * READ OFF THE RATIFIED REFERENCE SHEET (Arif Khan, Maintenance Technician — Senior Technician,
     * page 10), row for row. Its capability block has EIGHT rows and this map has eight `from`s, in
     * the page's own order: Disciplines, Equipment maintained, Maintenance type, Instruments &
     * tools, Drawings, Response worked to, Documentation, Sector worked. That order is also the
     * template's bands — three chip rows, one tick row, four fact rows — so array order and band
     * order agree.
     *
     * ONE CELL IS NOT REPRODUCED VERBATIM, noted on its row: the page's Documentation row is prose.
     * This pack has no case in role-sheet-parity.render.test.ts yet, so nothing renders the persona
     * end to end against page 10 — the map-vs-pack cross-checks in trade-resume-map.test.ts are
     * what guard it.
     */
    pack_id: "qp_maintenance_tech",
    // THE PAGE'S OWN HEADING. A maintenance advertisement is written in disciplines and the
    // machines kept running — "maintenance technician, hydraulic & pneumatic, CNC and press".
    section_title: "Disciplines, equipment & capability",
    tier_section_titles: { easy: "Disciplines & equipment" },
    capability: [
      {
        from: "maintenance_discipline",
        rank: 21,
        // THE HEADLINE'S THIRD SEGMENT: the page's header reads "Mechanical, Hydraulic, Pneumatic"
        // — the first three of the four this row prints, in the page's order, under the
        // guideline's three-tool headline cap.
        inHeadline: true,
        // The page prints four disciplines, and four is the trade: mechanical, hydraulic,
        // pneumatic and basic electrical.
        maxValues: 4,
        label: "Disciplines",
        kind: "chips",
        values: {
          mechanical: "Mechanical",
          hydraulic: "Hydraulic",
          pneumatic: "Pneumatic",
          basic_electrical: "Basic electrical",
          // Phase 2 #5 (@2) — Medium Q7 per sheet 21.
          lubrication: "Lubrication",
          welding_repair: "Welding / fabrication for repair",
        },
      },
      {
        from: "maintenance_equipment",
        // §5.1 rank 2: the machines a technician keeps running are what the job ad names.
        rank: 22,
        // §4.3 machines max 4, and the page prints exactly four.
        maxValues: 4,
        label: "Equipment maintained",
        kind: "chips",
        values: {
          cnc_machines: "CNC machines",
          power_presses: "Power presses",
          air_compressors: "Air compressors",
          conveyors: "Conveyors",
          hydraulic_power_packs: "Hydraulic power packs",
          pumps_blowers: "Pumps & blowers",
          // Phase 2 #5 (@2) — Medium Q6 per sheet 21.
          conventional_machines: "Conventional machines",
          imm_machines: "Injection moulding machines",
          boilers: "Boilers",
          packaging_machines: "Packaging machines",
        },
      },
      {
        from: "maintenance_type",
        // §5.1 rank 4: preventive against breakdown is what separates the technician who owns a PM
        // schedule from the helper who is called when a machine stops — this role's ladder.
        rank: 41,
        // NO CAP. The page prints SIX values, and a cap would drop one the ratified sheet shows —
        // the sheet metal map's Operations ruling.
        label: "Maintenance type",
        kind: "chips",
        values: {
          preventive: "Preventive maintenance",
          breakdown: "Breakdown attending",
          condition_monitoring: "Condition monitoring",
          spare_planning: "Spare planning",
          lubrication_schedule: "Lubrication schedule",
          shutdown_overhaul: "Shutdown overhaul",
          // Phase 2 #5 (@2) — Advanced Q10 per sheet 21.
          tpm: "TPM / autonomous maintenance",
        },
      },
      {
        from: "measuring_tools",
        // The tick row — where measuring instruments sit on every machining sheet.
        rank: 51,
        label: "Instruments & tools",
        kind: "ticks",
        values: {
          multimeter: "Multimeter",
          megger: "Megger",
          vibration_pen: "Vibration pen",
          hydraulic_test_kit: "Hydraulic test kit",
          alignment_kit: "Alignment kit",
          infrared_thermometer: "Infrared thermometer",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` HAS NO LABEL, deliberately — the welder's ruling: "cannot read drawings" is real
        // matching data, but a worker's own sheet is not where a negative claim belongs. The
        // persona's answer prints the page's cell verbatim.
        values: {
          machine_layout: "Reads machine layout drawings",
          circuit_drawing: "Reads hydraulic, pneumatic and machine layout drawings",
        },
      },
      {
        from: "maintenance_response",
        rank: 62,
        label: "Response worked to",
        kind: "fact",
        // Banded, the welder's plate ruling; the persona's band prints the page's cell verbatim.
        values: {
          within_fifteen: "Attended breakdowns within a 15-minute response window",
          within_thirty: "Attended breakdowns within a 30-minute response window",
          within_hour: "Attended breakdowns within an hour",
          within_shift: "Attended breakdowns within the same shift",
        },
      },
      {
        from: "maintenance_documentation",
        rank: 63,
        label: "Documentation",
        kind: "fact",
        // A RECORDED DIVERGENCE: the page's cell is prose, "Maintains PM checklists, breakdown log
        // and MTTR record". The pack asks WHICH records the worker keeps, and a fact row prints its
        // values " · "-joined, so the persona's row reads "PM checklists · Breakdown log · MTTR
        // record" — the same three records, without the sentence around them.
        values: {
          pm_checklist: "PM checklists",
          breakdown_log: "Breakdown log",
          mttr_record: "MTTR record",
          history_card: "Machine history card",
          spare_register: "Spare register",
          // Phase 2 #5 (@2) — Advanced Q10 per sheet 21.
          cmms: "CMMS / SAP PM",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        // §4.3 `sector_tag`, display only — ranks last. The page's cell is "Automotive plant
        // maintenance", authored here as the automotive value, so the persona's row reproduces it.
        values: {
          automotive_plant: "Automotive plant maintenance",
          auto_components: "Auto components",
          steel_cement: "Steel & cement plant",
          process_plant: "Chemical & process plant",
          food_pharma: "Food & pharma plant",
          general_engg: "General engineering",
        },
      },
    ],
  },
  // ══ PHASE 2 #6 — PLC / AUTOMATION TECHNICIAN (CEO Launch Plan Pack v1, sheet 14) ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE, like the 3D map: sheet 14 is the spec and its
  // headline ("PLC/Automation Technician · Senior · 6 years · Siemens TIA + Delta · HMI &
  // servo · SPM commissioning · Noida · 30 days") is the parity reference until a practising
  // technician ratifies the wording. Every `values` key is the option's STORED `value_text`;
  // the escape chips carry "unknown" and are never labelled.
  //
  // RANKED FOR THE SEAT: the PLC brands lead (the hire is for the platform), then the work
  // done, then HMI/SCADA, field devices and industry. Five rows against the budget of ten.
  {
    pack_id: "qp_plc_automation",
    section_title: "Automation, PLC & capability",
    tier_section_titles: { easy: "Automation & PLC" },
    capability: [
      {
        from: "plc_brand",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "PLC",
        kind: "chips",
        values: {
          siemens: "Siemens TIA / S7",
          allen_bradley: "Allen-Bradley",
          mitsubishi: "Mitsubishi",
          delta: "Delta",
          omron: "Omron",
          schneider: "Schneider",
          fuji: "Fuji",
          keyence: "Keyence",
        },
      },
      {
        from: "plc_software",
        // Rank 2x: programming software is the literal job-ad vocabulary beside
        // the PLC brand (the T38 headline names it). Step 5 (@2).
        rank: 23,
        maxValues: 4,
        label: "Programming software",
        kind: "chips",
        values: {
          tia_portal: "TIA Portal",
          simatic_manager: "SIMATIC Manager / Step 7",
          rslogix_studio: "RSLogix / Studio 5000",
          gx_works: "GX Works / GX Developer",
          wplsoft_ispsoft: "WPLSoft / ISPSoft",
          cx_programmer: "CX-Programmer / Sysmac Studio",
          somachine: "SoMachine / EcoStruxure",
          codesys: "Codesys",
          // `unknown` ("Pata nahi") has no entry — a non-answer prints nothing.
        },
      },

      {
        from: "plc_work",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Work done",
        kind: "chips",
        values: {
          panel_wiring: "Panel wiring",
          io_troubleshooting: "I/O & sensor troubleshooting",
          program_editing: "Program editing",
          program_writing: "New program writing",
          hmi_scada: "HMI / SCADA",
          vfd_servo: "VFD / servo",
          robot_teaching: "Robot teaching",
          commissioning: "Commissioning",
          // @2 additions — new-form values appended after history.
          online_monitoring: "Online monitoring for faults",
          io_checking: "I/O checking & sensor replacement",
          program_edit: "Small program changes (timer / interlock)",
          program_write: "New program writing",
          hmi_design: "HMI screen design",
          program_backup: "Program backup",
        },
      },
      {
        from: "plc_hmi_brand",
        rank: 41,
        label: "HMI / SCADA",
        kind: "chips",
        values: {
          wincc: "WinCC",
          factorytalk: "FactoryTalk",
          weintek: "Weintek",
          delta_hmi: "Delta HMI",
          mitsubishi_got: "Mitsubishi GOT",
          // @2 additions — new-form values appended after history.
          wonderware: "Wonderware InTouch",
          delta_dop: "Delta DOP HMI",
        },
      },
      {
        from: "plc_drive_servo",
        // Rank 2x: drive makes are hardware vocabulary, the controllers reading.
        // Step 5 (@2).
        rank: 24,
        maxValues: 4,
        label: "Drives & servo",
        kind: "chips",
        values: {
          siemens_drive: "Siemens Sinamics / Micromaster",
          abb_drive: "ABB drive",
          danfoss: "Danfoss",
          powerflex: "Allen-Bradley PowerFlex",
          delta_drive: "Delta VFD / servo",
          mitsubishi_drive: "Mitsubishi VFD / servo",
          yaskawa: "Yaskawa",
          altivar: "Schneider Altivar",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },

      {
        from: "plc_field_devices",
        rank: 42,
        label: "Field devices",
        kind: "ticks",
        values: {
          sensors: "Sensors",
          pneumatics: "Pneumatics",
          vision: "Vision system",
          safety_relays: "Safety relays / light curtains",
          encoders: "Encoders",
          // @2 additions — new-form values appended after history.
          proximity_sensor: "Proximity & photo sensors",
          encoder: "Encoder",
          analog_transmitter: "4–20 mA transmitter",
          temperature_sensor: "RTD / thermocouple",
          load_cell: "Load cell",
          safety_devices: "Safety relays / light curtains",
          vision_camera: "Vision camera / barcode scanner",
        },
      },
      {
        from: "plc_drawing_reading",
        // Rank 4x, the drawings reading: single-select ladder, `none` omitted
        // per the welder's ruling. Step 5 (@2).
        rank: 44,
        label: "Drawings",
        kind: "fact",
        values: {
          // `none` ("Nahi padh pata") has no entry ON PURPOSE — matching data,
          // not a line on the worker's own document.
          read_drawing: "Reads electrical drawings and finds wiring faults",
          modify_drawing: "Corrects electrical drawings",
          make_drawing: "Makes new drawings in EPLAN / AutoCAD Electrical",
        },
      },
      {
        from: "plc_programming_scope",
        // Rank 4x: what the worker builds in software separates the editor from
        // the programmer. Step 5 (@2).
        rank: 43,
        label: "Programming scope",
        kind: "ticks",
        values: {
          ladder: "Ladder logic",
          fbd: "FBD / function block",
          structured_text: "SCL / structured text",
          analog_scaling: "Analog scaling",
          pid_loop: "PID loop",
          motion_control: "Servo positioning / motion",
          high_speed_counter: "High speed counter",
          recipe_logging: "Recipe and data logging",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },
      {
        from: "plc_network",
        // 6x wedge attribute: connectivity knowledge below the §5.1 list.
        // Step 5 (@2).
        rank: 61,
        label: "Networks",
        kind: "chips",
        values: {
          profinet: "Profinet",
          profibus: "Profibus",
          modbus: "Modbus RTU / TCP",
          ethernet_ip: "EtherNet/IP",
          ethercat: "EtherCAT",
          cc_link: "CC-Link",
          devicenet: "DeviceNet",
          // `unknown` ("Pata nahi") has no entry — a non-answer prints nothing.
        },
      },
      {
        from: "plc_machine_type",
        // The sector row's sibling: what KIND of line the automation sits on.
        // Multi-select, so the sector reading (fact + join). Step 5 (@2).
        rank: 62,
        maxValues: 3,
        label: "Machine types",
        kind: "fact",
        join: ", ",
        values: {
          spm: "SPM, special purpose machine",
          assembly_conveyor: "Assembly line and conveyor",
          packaging: "Packaging / filling machine",
          process_plant: "Process plant, batching and dosing",
          robot_cell: "Robot cell",
          press_weld_line: "Press / welding line",
          plastic_machine: "Injection moulding / extrusion machine",
          furnace_utility: "Furnace, boiler / compressor",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "plc_commissioning_work",
        // Rank 4x: commissioning solo is setting capability. Step 5 (@2).
        rank: 45,
        label: "Commissioning work",
        kind: "ticks",
        values: {
          io_check: "I/O checking and loop test",
          drive_parameter: "Drive parameter setting",
          servo_tuning: "Servo tuning and homing",
          machine_trial: "Machine trial and cycle time setting",
          customer_training: "Customer operator training",
          fat_sat: "FAT / SAT documentation",
          solo_site: "Solo commissioning at customer site",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },

      {
        from: "sector_worked",
        rank: 71,
        maxValues: 3,
        label: "Industry",
        kind: "fact",
        join: ", ",
        values: {
          spm_builder: "SPM / machine builder",
          auto_line: "Auto line",
          packaging: "Packaging",
          pharma: "Pharma",
          food: "Food",
          plastics: "Plastics",
          steel: "Steel",
          // @2 additions — new-form values appended after history.
          automotive: "Automobile / auto parts",
          fmcg: "FMCG / food / beverage",
          chemical: "Chemical",
          steel_plant: "Steel / metal plant",
          machine_builder: "SPM / machine builder",
          system_integrator: "System integrator / panel builder",
        },
      },
      {
        from: "troubleshooting",
        // Rank 7x, the machining-map precedent (turner/miller 72).
        // Step 5 (@2).
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          plc_fault: "PLC fault / CPU stop",
          io_card: "Input / output card fault",
          network_fault: "Communication / network fault",
          drive_fault: "Drive trip and alarm",
          servo_alarm: "Servo alarm",
          hmi_fault: "HMI hang / communication failure",
          backup_restore: "Program download and backup restore",
          sensor_wiring: "Sensor / wiring fault",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },
      {
        from: "plc_advanced_system",
        // 7x volunteered depth the guideline never names. Step 5 (@2).
        rank: 73,
        label: "Advanced systems",
        kind: "ticks",
        values: {
          dcs: "DCS",
          safety_plc: "Safety PLC",
          vision_system: "Vision system (Cognex / Keyence)",
          robot_interface: "PLC interfacing with robot",
          robot_programming: "Robot teaching / programming",
          multi_axis_motion: "Multi-axis motion controller",
          iiot_mes: "IIoT, OEE data / MES connection",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "plc_project_role",
        // 6x wedge attribute: lead-level ownership. Step 5 (@2).
        rank: 63,
        label: "Project role",
        kind: "chips",
        values: {
          io_list_bom: "I/O list and BOM",
          panel_design: "Panel design and drawing",
          vendor_handling: "Vendor / panel builder coordination",
          customer_fat: "Customer dealing and FAT",
          junior_training: "Training juniors",
          spares_backup_record: "Spares and program backup record",
          pm_schedule: "PM schedule",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },
    ],
  },
  // ══ PHASE 2 #7 — EDM / WIRE-CUT OPERATOR (CEO Launch Plan Pack v1, sheet 16) ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet 16's headline ("Wire-cut/EDM Operator ·
  // Setter-Programmer · 6 years · Sodick + Electronica · Taper & 4-axis · Faridabad · 15 days")
  // is the parity reference. Machines and brands lead (the hire is for the machine), then the
  // work, the program source and the tolerance held. Every `values` key is the STORED value.
  {
    pack_id: "qp_edm_wirecut",
    section_title: "EDM, machines & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "edm_machine",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          wire_cut: "Wire-cut EDM",
          sinker_edm: "Sinker EDM",
          hole_drill: "Hole drill EDM",
          small_hole: "Small-hole EDM",
          // @2 additions — new-form values appended after history.
          wirecut: "CNC wire-cut (brass wire)",
          moly_wirecut: "Molybdenum / reusable wire-cut",
          znc_sinker: "ZNC die-sinking EDM",
          cnc_sinker: "CNC die-sinking EDM",
          edm_drill: "EDM drill / super drill",
        },
      },
      {
        from: "edm_brand",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Brands",
        kind: "chips",
        values: {
          electronica: "Electronica",
          sodick: "Sodick",
          mitsubishi: "Mitsubishi",
          makino: "Makino",
          agie_charmilles: "Agie / Charmilles",
          fanuc_robocut: "Fanuc Robocut",
          // @2 additions — new-form values appended after history.
          ratnaparkhi: "Ratnaparkhi",
          sparkonix: "Sparkonix",
        },
      },
      {
        from: "edm_work_type",
        rank: 41,
        label: "Work",
        kind: "chips",
        values: {
          taper_cutting: "Taper cutting",
          four_axis: "4-axis cutting",
          electrode_making: "Electrode making",
          carbide: "Carbide cutting",
          wire_threading: "Wire threading & setting",
          // @2 additions — new-form values appended after history.
          profile_cut: "Straight profile cutting (punch, die, insert)",
          taper_cut: "Taper cutting",
          skim_cut: "Skim cut / multi-pass finishing",
          four_axis_cut: "Top-bottom different shape (4-axis)",
          cavity_sparking: "Cavity sparking (die-sinking)",
          rib_slot: "Rib, slot & corner sparking",
          start_hole: "Start hole / small-hole drilling",
          tap_removal: "Broken tap / drill removal",
        },
      },
      {
        from: "edm_job_type",
        rank: 43,
        maxValues: 4,
        label: "Job types",
        kind: "chips",
        values: {
          press_tool_parts: "Press-tool punches & dies",
          mould_inserts: "Plastic mould cores, cavities & inserts",
          extrusion_die: "Extrusion dies",
          carbide_die: "Carbide dies & punches",
          casting_forging_die: "Die-casting / forging dies",
          gear_keyway: "Gear, spline & keyway cutting",
          jig_gauge: "Jigs, fixtures & gauges",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          die_steel: "Hardened die steel (D2, HCHCr, OHNS)",
          hot_die_steel: "Hot die steel (H13, H11)",
          mould_steel: "Mould steel (P20)",
          carbide: "Carbide",
          mild_steel: "MS / mild steel",
          alloy_steel: "EN-series alloy steel",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          brass: "Copper / brass",
        },
      },
      {
        from: "edm_wire_electrode",
        rank: 63,
        maxValues: 4,
        label: "Wire & electrodes",
        kind: "chips",
        values: {
          brass_wire: "Brass wire 0.25 mm",
          coated_wire: "Zinc-coated wire",
          fine_wire: "Fine wire (0.20 mm or thinner)",
          moly_wire: "Molybdenum wire",
          copper_electrode: "Copper electrodes",
          graphite_electrode: "Graphite electrodes",
          copper_tungsten: "Copper-tungsten electrodes",
          tube_electrode: "Brass / copper tube (EDM drill)",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier caliper",
          micrometer: "Micrometer",
          dial_indicator: "Dial indicator",
          height_gauge: "Height gauge",
          pin_gauge: "Pin gauge",
          slip_gauge: "Slip gauge",
          profile_projector: "Profile projector",
          bore_gauge: "Bore dial gauge",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — same rule as every
        // other map: not reading drawings belongs in matching data, not on the sheet.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "edm_setting_work",
        rank: 45,
        label: "Setting",
        kind: "ticks",
        values: {
          clamping_dialling: "Job clamping & dialling",
          wire_alignment: "Wire vertical alignment",
          edge_centre_find: "Edge & centre find",
          wire_threading: "Wire threading (auto / manual)",
          electrode_setting: "Electrode centring & depth setting",
          flushing_setting: "Flushing nozzle & pressure setting",
          guide_contact_change: "Wire guide & power contact change",
          first_piece: "First-piece setup",
        },
      },
      {
        from: "edm_parameter_work",
        rank: 46,
        label: "Cutting parameters",
        kind: "ticks",
        // `unknown` ("Parameter koi aur set karta hai") has no entry, same rule.
        values: {
          tech_table: "Technology-table condition selection",
          pulse_on_off: "Pulse on / off time",
          peak_current: "Peak current (IP)",
          servo_voltage: "Servo / gap voltage",
          wire_tension_feed: "Wire tension & feed",
          wire_offset: "Wire offset (skim cut)",
          spark_gap: "Electrode undersize / spark-gap calculation",
        },
      },

      {
        from: "edm_program_source",
        rank: 42,
        label: "Programs",
        kind: "fact",
        values: {
          on_machine: "Programs on the machine",
          from_cam: "Programs from CAM",
          from_drawing: "Runs programs made from drawings",
          // @2 additions — new-form values appended after history.
          load_run: "Loads & runs programs",
          edit_program: "Edits offsets, taper & conditions",
          machine_cam: "Programs profiles on the machine",
          cam: "Programs from CAM software",
        },
      },
      {
        from: "edm_tolerance",
        rank: 62,
        label: "Tolerance held",
        kind: "fact",
        values: {
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm",
          "0.005": "±0.005 mm",
          "0.002": "±0.002 mm (micron) or finer",
          // @2 additions — new-form values appended after history.
          "0.10": "±0.10 mm",
          "0.05": "±0.05 mm",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          die_mould: "Tool room, die & mould",
          automotive: "Automotive / auto parts",
          general_engg: "General engineering, job shop",
          defence: "Defence / aerospace",
          electronics: "Electronics / connectors",
          medical: "Medical / surgical parts",
          fasteners: "Fastener dies",
        },
      },
      {
        from: "edm_cam_software",
        rank: 47,
        maxValues: 3,
        label: "CAM software",
        kind: "chips",
        // `unknown` ("Koi aur software") has no entry, same rule.
        values: {
          elcam: "ELCAM",
          heart_nc: "Heart NC (Sodick)",
          onboard_cam: "On-board CAM",
          autocad_dxf: "AutoCAD (DXF)",
          mastercam_wire: "Mastercam Wire",
          autocut: "AutoCut (reusable-wire machine)",
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          wire_break: "Frequent wire breakage",
          size_variation: "Size / taper variation",
          surface_finish: "Lines & marks on surface",
          short_circuit: "Short circuit / arcing",
          electrode_wear: "Rapid electrode wear",
          poor_flushing: "Poor flushing, slow cutting",
          filter_resin: "Filter, resin & dielectric change",
        },
      },
    ],
  },
  // ══ PHASE 2 #9 — INJECTION-MOULDING OPERATOR / SETTER (CEO Launch Plan Pack v1, sheet 22) ══
  //
  // A NEW PACK WITH NO RATIFIED PAGE: sheet 22's headline ("Injection-Moulding Setter · Setter ·
  // 5 years · Ferromatik + Haitian 100–300 t · PP/ABS · Bawal · 15 days") is the parity
  // reference. Machine brands and tonnage lead (the hire is for the machine), then the materials,
  // the process work and the defects the worker corrects. Every `values` key is the STORED value;
  // the negative claims (`unknown`, `none`) have no entry, so they print nothing.
  {
    pack_id: "qp_injection_moulding",
    section_title: "Moulding, machines & capability",
    tier_section_titles: { easy: "Machines" },
    capability: [
      {
        from: "moulding_machine_brand",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          ferromatik_milacron: "Ferromatik / Milacron",
          windsor: "Windsor",
          jsw: "JSW",
          toshiba: "Toshiba",
          haitian: "Haitian",
          engel: "Engel",
          arburg: "Arburg",
          larsen_toubro: "L&T",
          // @2 additions — new-form values appended after history.
          milacron: "Ferromatik Milacron",
          shibaura: "Toshiba / Shibaura (formerly L&T)",
          electronica: "Electronica",
        },
      },
      {
        from: "moulding_tonnage",
        // Beside the machines, as the press shop's tonnage: what the MACHINE can do. The pack
        // asks the largest machine run, so the row reads "Up to", never a lower bound.
        rank: 22,
        inHeadline: true,
        label: "Tonnage worked",
        kind: "fact",
        values: {
          upto_hundred: "Up to 100 T machines",
          hundred_to_threehundred: "100–300 T machines",
          threehundred_to_eighthundred: "300–800 T machines",
          over_eighthundred: "Over 800 T machines",
          // @2 additions — new-form values appended after history.
          "100": "Up to 100 T machines",
          "250": "100–250 T machines",
          "450": "250–450 T machines",
          "850": "450–850 T machines",
          "1300": "850–1300 T machines",
          "2000": "Over 1300 T machines",
        },
      },
      {
        from: "imm_machine_type",
        rank: 24,
        maxValues: 4,
        label: "Machine types",
        kind: "chips",
        // `unknown` ("Pata nahi") has no entry, same rule.
        values: {
          hydraulic: "Hydraulic",
          servo_hybrid: "Servo / hybrid",
          all_electric: "All-electric",
          vertical: "Vertical moulding",
          two_shot: "Two-shot / two-colour",
        },
      },
      {
        from: "imm_daily_work",
        rank: 43,
        label: "Daily work",
        kind: "ticks",
        values: {
          part_removal: "Part removal & runner / gate cutting",
          trimming: "Flash trimming & finishing",
          visual_packing: "Visual checking & packing",
          material_loading: "Hopper material loading",
          mould_cleaning: "Mould spray & cleaning",
          regrind: "Scrap grinding & regrind mixing",
          production_report: "Production reports",
        },
      },

      {
        from: "moulding_material",
        rank: 23,
        inHeadline: true,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          pp: "PP",
          abs: "ABS",
          nylon: "PA / Nylon",
          pc: "PC",
          pvc: "PVC",
          pom: "POM / Acetal",
          glass_filled: "Glass-filled grades",
          // @2 additions — new-form values appended after history.
          hdpe: "HDPE",
          tpe: "TPE / TPU",
        },
      },
      {
        from: "imm_auxiliary",
        rank: 46,
        maxValues: 4,
        label: "Auxiliary equipment",
        kind: "chips",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          dryer: "Hopper dryer / dehumidifier",
          mtc: "MTC (mould temperature controller)",
          chiller: "Chiller",
          hot_runner_controller: "Hot runner controller",
          robot: "Robot / sprue picker",
          auto_loader: "Auto loader",
          grinder: "Scrap grinder",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          vernier: "Vernier caliper",
          micrometer: "Micrometer",
          height_gauge: "Height gauge",
          plug_gauge: "Pin / plug gauge",
          checking_fixture: "Checking fixture / Go-No-Go gauge",
          weighing_scale: "Weighing scale (part weight)",
          limit_sample: "Limit-sample visual check",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE, same rule as every map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },

      {
        from: "moulding_process_work",
        rank: 41,
        label: "Work",
        kind: "chips",
        values: {
          mould_change: "Mould change",
          parameter_setting: "Parameter setting",
          hot_runner: "Hot runner",
          robot_pick_place: "Robot / pick-and-place",
          mtc_dryer: "MTC & dryer",
          two_shot: "Two-shot moulding",
          // @2 additions — new-form values appended after history.
          mould_loading: "Mould loading / unloading (crane)",
          clamping: "Mould clamping & height setting",
          cooling_connection: "Water line & MTC connection",
          hot_runner_connection: "Hot-runner connection",
          ejector_core: "Ejector stroke & core-pull setting",
          nozzle_centring: "Nozzle centring",
          purging: "Material / colour change & purging",
          robot_setting: "Robot / sprue-picker setting",
          first_piece: "First-piece approval",
        },
      },
      {
        from: "imm_parameter_setting",
        rank: 45,
        label: "Parameters",
        kind: "ticks",
        // `unknown` ("Koi nahi, parameter lock rehte hain") has no entry, same rule.
        values: {
          barrel_temperature: "Barrel temperature",
          injection_speed_pressure: "Injection speed & pressure",
          holding: "Holding pressure & time",
          cooling_time: "Cooling time",
          back_pressure: "Back pressure & screw RPM",
          shot_size: "Shot size & cushion",
          clamp_force: "Clamping tonnage",
          mould_temperature: "Mould temperature",
        },
      },
      {
        from: "imm_special_process",
        rank: 47,
        maxValues: 4,
        label: "Special processes",
        kind: "chips",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          insert_moulding: "Insert moulding",
          two_shot: "Two-shot / two-colour",
          gas_assist: "Gas-assist moulding",
          hot_runner_mould: "Hot runner / valve-gate moulds",
          multi_cavity: "Multi-cavity (16+ cavities)",
          thin_wall: "Thin-wall packaging",
          iml: "IML (in-mould labelling)",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          automotive: "Automobile parts",
          two_wheeler: "Two-wheeler parts",
          appliances: "Home appliances",
          electrical_fittings: "Electrical switches & fittings",
          electronics: "Electronics",
          packaging: "Packaging, caps & closures",
          pharma: "Medical / pharma",
          household: "Household & furniture",
        },
      },

      {
        from: "moulding_defects",
        rank: 42,
        label: "Defects corrected",
        kind: "chips",
        values: {
          short_shot: "Short shot",
          flash: "Flash",
          sink_mark: "Sink mark",
          warpage: "Warpage",
          silver_streak: "Silver streaks",
          // @2 additions — new-form values appended after history.
          weld_line: "Weld line",
          burn_mark: "Burn mark",
          black_spot: "Black spot",
        },
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        // `unknown` ("Koi nahi") has no entry, same rule.
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          spc: "SPC charts",
          rejection: "Rejection analysis",
        },
      },
      {
        from: "imm_process_control",
        rank: 72,
        label: "Process control",
        kind: "ticks",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          mould_trial: "New-mould trials",
          process_sheet: "Process parameter sheets",
          cycle_time_reduction: "Cycle-time reduction",
          changeover_loss: "Material / colour-change loss control",
          regrind_control: "Regrind ratio control",
          mould_pm: "Mould PM plans",
          operator_training: "Operator training",
        },
      },

      {
        from: "moulding_training_institute",
        rank: 63,
        label: "Training institute",
        kind: "fact",
        // Sheet-22 Q12, the ITI/CIPET block. A credential row like the tool room's — `none`
        // ("Kahin nahi") has no entry, same rule.
        values: {
          iti_plastic_processing: "ITI (Plastic Processing Operator)",
          cipet: "CIPET",
          diploma: "Diploma",
        },
      },
    ],
  },
  // ══ PHASE 2 #8 — HEAT-TREATMENT TECHNICIAN (CEO Launch Plan Pack v1, sheet 17) ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet 17's headline ("Heat-Treatment Technician · Skilled ·
  // 6 years · Sealed quench + induction · Case hardening · Ballabgarh · 15 days") is the parity
  // reference. The furnaces lead (labelled Equipment, so they print on the Machines line), then
  // the processes, the testing done and the materials. Every `values` key is the STORED value.
  {
    pack_id: "qp_heat_treatment",
    section_title: "Heat treatment, processes & capability",
    tier_section_titles: { easy: "Equipment" },
    capability: [
      {
        from: "heat_furnace",
        rank: 21,
        inHeadline: true,
        maxValues: 3,
        label: "Equipment",
        kind: "chips",
        values: {
          sealed_quench: "Sealed quench",
          pit_furnace: "Pit furnace",
          continuous_furnace: "Continuous furnace",
          induction_machine: "Induction",
          vacuum_furnace: "Vacuum furnace",
          box_furnace: "Box furnace",
          // @2 additions — new-form values appended after history.
          mesh_belt: "Continuous mesh-belt furnace",
          rotary_furnace: "Rotary furnace",
          salt_bath: "Salt bath",
        },
      },
      {
        from: "ht_furnace_make",
        rank: 23,
        maxValues: 4,
        label: "Furnace makes",
        kind: "chips",
        // `unknown` ("Local make ya pata nahi") has no entry, same rule.
        values: {
          aichelin: "Aichelin Unitherm",
          hightemp: "Hightemp",
          fluidtherm: "Fluidtherm",
          ipsen: "Ipsen",
          therelek: "Therelek",
          wesman: "Wesman",
          seco_warwick: "Seco/Warwick",
        },
      },
      {
        from: "ht_daily_work",
        rank: 43,
        label: "Daily work",
        kind: "ticks",
        values: {
          charge_loading: "Charge loading (fixtures / baskets)",
          cycle_running: "Furnace cycle running",
          quenching: "Quenching",
          tempering: "Tempering",
          shot_blasting: "Shot blasting",
          straightening: "Straightening",
          hardness_check: "Hardness checking",
          log_sheet: "Log sheets & charts",
        },
      },
      {
        from: "ht_quench_media",
        rank: 63,
        maxValues: 4,
        label: "Quenching media",
        kind: "chips",
        // `unknown` ("Pata nahi") has no entry, same rule.
        values: {
          oil: "Oil",
          water: "Water / brine",
          polymer: "Polymer",
          salt: "Salt bath",
          gas_quench: "Gas / nitrogen quench (vacuum)",
          press_quench: "Press quench",
        },
      },

      {
        from: "heat_process",
        rank: 22,
        inHeadline: true,
        maxValues: 3,
        label: "Processes",
        kind: "chips",
        values: {
          hardening_tempering: "Hardening & tempering",
          case_carburising: "Case hardening",
          nitriding: "Nitriding",
          induction_hardening: "Induction hardening",
          annealing_normalising: "Annealing & normalising",
          vacuum_heat_treatment: "Vacuum heat treatment",
          salt_bath: "Salt bath",
          // @2 additions — new-form values appended after history.
          carburising: "Case carburising",
          carbonitriding: "Carbonitriding",
          annealing: "Annealing",
          normalising: "Normalising",
          stress_relieving: "Stress relieving",
          austempering: "Austempering",
        },
      },
      {
        from: "heat_testing",
        rank: 41,
        label: "Testing",
        kind: "chips",
        values: {
          rockwell: "Rockwell (HRC)",
          brinell: "Brinell",
          vickers: "Vickers",
          micro_structure: "Micro-structure",
          case_depth: "Case depth",
          // @2 additions — new-form values appended after history.
          microstructure: "Microstructure check",
          file_test: "File hardness check",
          mpi: "MPI crack check",
        },
      },
      {
        from: "heat_material",
        rank: 42,
        label: "Materials",
        kind: "chips",
        values: {
          en_series: "EN8 / EN19 / EN24",
          alloy_steel: "Alloy steel",
          tool_steel: "Tool steel",
          stainless_steel: "Stainless steel",
          // @2 additions — new-form values appended after history.
          case_hardening_steel: "20MnCr5 / SAE 8620 / EN353",
          bearing_steel: "EN31 bearing steel",
          spring_steel: "Spring steel (EN47)",
          stainless: "Stainless steel",
          cast_iron: "SG / cast iron",
          aluminium: "Aluminium (T6)",
        },
      },
      {
        from: "ht_part",
        rank: 44,
        maxValues: 4,
        label: "Parts",
        kind: "chips",
        // `unknown` ("Koi aur part") has no entry, same rule.
        values: {
          gears_shafts: "Gears & shafts",
          bearing_parts: "Bearing races & rollers",
          fasteners: "Bolts, nuts & fasteners",
          dies_tools: "Dies, moulds & tools",
          springs: "Springs & leaf springs",
          forgings: "Forgings, crankshafts & connecting rods",
          small_parts: "Pins, bushes, sprockets & small parts",
        },
      },
      {
        from: "ht_cycle_setting",
        rank: 45,
        label: "Cycle setting",
        kind: "ticks",
        // `unknown` ("Sirf set cycle chalata hoon") has no entry, same rule.
        values: {
          temp_soak: "Temperature & soaking time",
          carbon_potential_set: "Carbon potential setting",
          quench_setting: "Quench oil temperature & agitation",
          tempering_setting: "Tempering temperature",
          recipe_plc: "PLC / SCADA recipes",
          induction_setting: "Induction power, coil & scan speed",
        },
      },
      {
        from: "ht_atmosphere",
        rank: 46,
        label: "Furnace atmosphere",
        kind: "ticks",
        // `unknown` ("Atmosphere ka kaam nahi") has no entry, same rule.
        values: {
          endo_gas: "Endo gas generators",
          enrichment: "LPG / propane enrichment",
          methanol_nitrogen: "Methanol & nitrogen",
          ammonia: "Ammonia",
          carbon_potential: "Oxygen probe / carbon potential",
          dew_point: "Dew-point check",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          automotive: "Automobile",
          two_wheeler: "Two-wheeler",
          bearings: "Bearings",
          fasteners: "Fasteners",
          die_mould: "Tool room, die & mould",
          agri: "Tractors & agriculture",
          defence: "Defence / aerospace",
          general_engg: "General engineering, job work",
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        // `unknown` ("Koi nahi") has no entry, same rule.
        values: {
          hardness_variation: "Hardness variation",
          case_depth_variation: "Case-depth variation",
          distortion: "Distortion / bend",
          quench_crack: "Quench cracks",
          soft_spot: "Soft spots",
          decarb: "Decarb / scaling",
        },
      },
      {
        from: "ht_quality_system",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        // `unknown` ("Inme se koi nahi") has no entry, same rule.
        values: {
          cqi_nine: "CQI-9 audits",
          tus: "TUS (temperature uniformity survey)",
          sat: "SAT (thermocouple checks)",
          traceability: "Furnace charts & batch traceability",
          customer_audit: "Customer audits",
        },
      },
      {
        from: "ht_furnace_upkeep",
        rank: 47,
        label: "Furnace upkeep",
        kind: "ticks",
        // `unknown` ("Maintenance wale karte hain") has no entry, same rule.
        values: {
          burn_out: "Furnace burn-out",
          probe_change: "Thermocouple / oxygen probe change",
          quench_oil_check: "Quench oil level & testing",
          burner_check: "Burner / heater / radiant-tube check",
          fixture_check: "Fixture & tray crack check",
        },
      },
    ],
  },
  // ══ PHASE 2 #10 — PRODUCTION SUPERVISOR (CEO Launch Plan Pack v1, sheet 23) ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet 23's headline ("Production Supervisor · Supervisor
  // · 10 years · Machine shop · 30 people / 18 CNC · Faridabad · 30 days") is the parity
  // reference. The area and the size of the charge lead (people, then machines), then what he
  // runs and the trade he came up through. No row is a Machines line: the machines here are a
  // COUNT under his charge, not machines he operates. Every `values` key is the STORED value;
  // the negative claims (`unknown`, `none`) have no entry, so they print nothing.
  {
    pack_id: "qp_production_supervisor",
    section_title: "Supervision, team & systems",
    tier_section_titles: { easy: "Supervision" },
    capability: [
      {
        from: "supervision_area",
        rank: 21,
        inHeadline: true,
        maxValues: 3,
        label: "Areas supervised",
        kind: "chips",
        values: {
          machine_shop: "Machine shop",
          assembly: "Assembly",
          press_sheet_metal: "Press / sheet metal",
          fabrication_welding: "Fabrication / welding",
          moulding: "Moulding",
          paint_shop: "Paint shop",
          packaging: "Packaging",
          // @2 additions — new-form values appended after history.
          press_shop: "Press shop",
          weld_shop: "Weld shop",
          casting_forging: "Casting / forging shop",
          packing: "Packing & dispatch",
        },
      },
      {
        from: "supervision_team_size",
        rank: 22,
        inHeadline: true,
        label: "Team size",
        kind: "fact",
        values: {
          below_five: "Under 5 people",
          five_to_fifteen: "5–15 people",
          fifteen_to_fifty: "15–50 people",
          above_fifty: "50+ people",
          // @2 additions — new-form values appended after history.
          "10": "Up to 10 people",
          "25": "11–25 people",
          "50": "26–50 people",
          "100": "51–100 people",
          "150": "Over 100 people",
        },
      },
      {
        from: "supervision_machines",
        rank: 23,
        inHeadline: true,
        label: "Machines under charge",
        kind: "fact",
        values: {
          upto_five: "Up to 5 machines",
          five_to_twenty: "5–20 machines",
          twenty_to_fifty: "20–50 machines",
          above_fifty: "50+ machines",
        },
      },
      {
        from: "supervision_systems",
        rank: 41,
        label: "Responsibilities",
        kind: "chips",
        values: {
          production_planning: "Daily production planning",
          manpower_shift: "Manpower & shift planning",
          quality_ppm: "Quality (rejection, PPM)",
          five_s_kaizen: "5S / kaizen / TPM",
          erp_sap: "ERP / SAP entries",
          safety: "Safety",
        },
      },
      {
        from: "supervision_trade_background",
        rank: 42,
        label: "Trade background",
        kind: "chips",
        values: {
          cnc_vmc: "CNC / VMC operator",
          conventional_machinist: "Conventional machinist",
          fitter: "Fitter",
          welder: "Welder",
          electrician: "Electrician",
          assembly: "Assembly",
          press_sheet_metal: "Press / sheet metal",
          moulding: "Moulding",
          quality: "QC / quality",
          // @2 additions — new-form values appended after history.
          cnc_machining: "CNC / VMC operator or setter",
          welding_fab: "Welding / fabrication",
          fitter_assembly: "Fitter / assembly",
          moulding_casting: "Moulding / die casting",
          quality_inspection: "Quality inspector",
          direct_engineer: "Direct supervisor (diploma / B.Tech)",
        },
      },
      {
        from: "prodsup_daily_work",
        // Rank 4x: the daily responsibility list. Step 5 (@2).
        rank: 43,
        label: "Daily work",
        kind: "chips",
        values: {
          manpower_deployment: "Manpower deployment on machines",
          hourly_monitoring: "Hourly output check",
          shift_report: "Shift report",
          tool_consumable_issue: "Tool and consumable issue",
          changeover: "Changeover",
          rejection_rework: "Rejection and rework segregation",
          attendance_overtime: "Attendance and overtime",
          shift_handover: "Shift handover",
        },
      },
      {
        from: "prodsup_production_entry",
        // 6x wedge attribute: the systems the entries land in. Step 5 (@2).
        rank: 61,
        label: "Production entry",
        kind: "chips",
        values: {
          sap: "SAP",
          other_erp: "Company ERP",
          excel: "MS Excel",
          paper_format: "Register / printed format",
          hourly_board: "Hourly production board",
          // `unknown` ("Entry main nahi karta") has no entry — a non-answer
          // prints nothing.
        },
      },
      {
        from: "prodsup_labour_type",
        // 6x wedge attribute, single-select fact. Step 5 (@2).
        rank: 62,
        label: "Labour type",
        kind: "fact",
        values: {
          company_roll: "Company-roll workers",
          contract_labour: "Contract labour",
          mixed: "Company-roll and contract (mixed)",
        },
      },
      {
        from: "drawing_reading",
        // Rank 44; `none` omitted per the welder's ruling. Step 5 (@2).
        rank: 44,
        label: "Drawings",
        kind: "fact",
        values: {
          // `none` ("Nahi padh pata") has no entry ON PURPOSE — matching data,
          // not a line on the worker's own document.
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "prodsup_safety_five_s",
        // §5.1 names no safety row; rank 5x band. Step 5 (@2).
        rank: 51,
        label: "5S & safety",
        kind: "ticks",
        values: {
          five_s_audit: "5S audit and red tag",
          toolbox_talk: "Toolbox talk",
          ppe_check: "PPE check",
          incident_report: "Near-miss / accident report",
          machine_guard_check: "Machine guard and safety sensor check",
          mock_drill: "Mock drill",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prodsup_changeover_work",
        // Rank 4x: changeover ownership is setting capability. Single-select
        // fact. Step 5 (@2).
        rank: 45,
        label: "Changeover role",
        kind: "fact",
        values: {
          // `calls_setter` ("Setter ko bulata hoon, khud nahi karta") has no
          // entry ON PURPOSE — a negative claim about the worker's own sheet.
          assists_setter: "Assists setter in changeover",
          does_setting: "Does setting, takes first piece",
          // `no_changeover` ("Meri line me changeover nahi hota") has no entry —
          // a no-* non-answer prints nothing.
        },
      },

      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automotive components",
          general_engg: "General engineering / job shop",
          electrical_parts: "Electrical / electronics parts",
          white_goods: "White goods",
          plastics: "Plastics",
          packaging: "Packaging",
          // @2 additions — new-form values appended after history.
          two_wheeler: "Two-wheeler parts",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractor & agri equipment",
          construction_equipment: "Construction equipment",
          fmcg: "FMCG products",
        },
      },
      {
        from: "quality_work",
        // Rank 71, the machining-map precedent. Step 5 (@2).
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece approval",
          in_process: "Patrol / in-process checking",
          spc: "SPC charts",
          rejection: "Red bin and rejection analysis",
          // `unknown` ("Koi nahi") has no entry — a non-answer prints nothing.
        },
      },
      {
        from: "prodsup_line_data",
        // 6x wedge attribute: the numbers the line is run on. Step 5 (@2).
        rank: 63,
        label: "Line data",
        kind: "ticks",
        values: {
          oee: "OEE",
          output_vs_target: "Target vs actual output",
          rejection_ppm: "Rejection PPM / percentage",
          downtime: "Downtime and breakdown hours",
          productivity: "Per-man output (productivity)",
          rework_count: "Rework count",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prodsup_improvement_work",
        // 6x wedge attribute. Step 5 (@2).
        rank: 64,
        label: "Improvement work",
        kind: "ticks",
        values: {
          kaizen: "Kaizen",
          qc_circle: "QC circle",
          jishu_hozen: "TPM Jishu Hozen (JH)",
          poka_yoke: "Poka-yoke",
          why_why: "Why-why analysis",
          smed: "Changeover time reduction (SMED)",
          one_point_lesson: "One point lesson (OPL)",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prodsup_people_work",
        // 6x wedge attribute. Step 5 (@2).
        rank: 65,
        label: "People work",
        kind: "ticks",
        values: {
          skill_matrix: "Skill matrix",
          ojt_training: "OJT for new operators",
          shift_roster: "Shift roster and weekly off",
          leave_overtime_approval: "Leave and overtime approval",
          discipline: "Discipline / warning letter case",
          union_handling: "Union / works committee dealing",
          contractor_attendance: "Contractor attendance verification",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        // Rank 72, the machining-map precedent. Step 5 (@2).
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          material_shortage: "Re-plans on material shortage",
          absenteeism: "Adjusts for absenteeism",
          breakdown_reroute: "Re-routes load on breakdown",
          quality_hold: "Sorting and rework on quality hold",
          tool_die_failure: "Handles tool / die failure",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prodsup_audit_exposure",
        // 7x volunteered depth the guideline never names. Step 5 (@2).
        rank: 73,
        label: "Audits faced",
        kind: "ticks",
        values: {
          iatf: "IATF 16949 audit",
          iso_qms: "ISO 9001 audit",
          customer_audit: "Customer audit (Maruti, Hero, Honda)",
          layered_audit: "Layered process audit (LPA)",
          five_s_tpm_audit: "5S / TPM audit",
          // `unknown` ("Koi audit nahi") has no entry — a non-answer prints
          // nothing.
        },
      },
    ],
  },
  // ══ PHASE 2 #11 — FOUNDRY / FORGING OPERATOR (CEO Launch Plan Pack v1, sheet 19) ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet 19's headline ("Foundry/Forging Operator · Skilled ·
  // 7 years · HPDC + sand · Aluminium · Naroda · 15 days") is the parity reference. The processes
  // lead, then the metals; the equipment is labelled Equipment so it prints on the Machines line.
  // Every `values` key is the STORED value.
  {
    pack_id: "qp_foundry_forging",
    section_title: "Foundry / forging, processes & capability",
    tier_section_titles: { easy: "Processes" },
    capability: [
      {
        from: "foundry_process",
        rank: 21,
        inHeadline: true,
        maxValues: 3,
        label: "Processes",
        kind: "chips",
        values: {
          sand_moulding: "Sand moulding",
          shell_moulding: "Shell moulding",
          die_casting: "Die casting (HPDC/GDC)",
          investment_casting: "Investment casting",
          hammer_forging: "Hammer forging",
          press_forging: "Press forging",
          upset_forging: "Upset forging",
          melting: "Melting",
          fettling: "Fettling",
          core_making: "Core making",
        },
      },
      {
        from: "foundry_material",
        rank: 22,
        inHeadline: true,
        maxValues: 3,
        label: "Metals",
        kind: "chips",
        values: {
          cast_iron: "Cast iron",
          sg_iron: "SG iron",
          aluminium: "Aluminium",
          steel: "Steel",
          brass_bronze: "Brass / bronze",
          alloy_steel_forging: "Alloy steel forging",
        },
      },
      {
        from: "foundry_equipment",
        rank: 41,
        label: "Equipment",
        kind: "chips",
        values: {
          induction_furnace: "Induction furnace",
          cupola: "Cupola",
          hpdc_machine: "HPDC machine",
          forging_hammer: "Forging hammer",
          forging_press: "Forging press",
        },
      },
      {
        from: "foundry_testing",
        rank: 42,
        label: "Testing",
        kind: "chips",
        values: {
          spectro: "Spectro (chemistry)",
          hardness: "Hardness testing",
          dimensional: "Dimensional check",
        },
      },
    ],
  },
  // ══ CEO PACK V2, T24 — FOUNDRY / CASTING OPERATOR (#3012): FULL MAP ══
  //
  // Sheet T24's headline ("Foundry / Casting Operator · {level} · {experience} · {foundry_section} ·
  // {foundry_process} · {material_worked} · {city}") is the parity reference. Section, process and
  // metal lead (the hire is for the line and the metal), then the equipment, the work and the
  // defects the worker corrects. Every `values` key is the STORED value.
  //
  // HISTORY ROWS. `foundry_process` (rank 21, label "Processes") and `foundry_testing` (rank 42,
  // label "Testing") keep EVERY value the old `qp_foundry_forging` form stored under them, with the
  // English the old map already printed, so a worker profiled on the old form still prints the
  // same chips after the new form takes over (see the #3009 carry-over test). The old form's
  // forging values (hammer_forging, press_forging, upset_forging, die_casting, melting, fettling,
  // core_making) never occur on the new form but MUST stay: dropping one sheds a stored answer
  // silently. The new form's own chips (green_sand, no_bake, co_two_sand, centrifugal; ce_meter,
  // wedge_test, sand_moisture, sand_strength, mould_hardness) are appended after them.
  {
    pack_id: "qp_foundry_casting",
    section_title: "Foundry, processes & capability",
    tier_section_titles: { easy: "Foundry & processes" },
    capability: [
      {
        from: "foundry_section",
        rank: 22,
        inHeadline: true,
        label: "Sections",
        kind: "chips",
        values: {
          moulding: "Moulding",
          core_making: "Core shop",
          melting: "Melting / furnace",
          pouring: "Pouring",
          sand_plant: "Sand plant",
          knock_out: "Knock-out",
          fettling: "Fettling & grinding",
          shot_blasting: "Shot blasting",
          wax_shell_room: "Wax / shell room",
        },
      },
      {
        from: "foundry_process",
        rank: 21,
        inHeadline: true,
        maxValues: 3,
        label: "Processes",
        kind: "chips",
        values: {
          // History values first, in the old form's order with the old English, so a stored
          // answer prints identically after the split.
          sand_moulding: "Sand moulding",
          shell_moulding: "Shell moulding",
          die_casting: "Die casting (HPDC/GDC)",
          investment_casting: "Investment casting",
          hammer_forging: "Hammer forging",
          press_forging: "Press forging",
          upset_forging: "Upset forging",
          melting: "Melting",
          fettling: "Fettling",
          core_making: "Core making",
          // The new form's own processes (#3012).
          green_sand: "Green sand",
          no_bake: "No-bake / furan sand",
          co_two_sand: "CO2 sand",
          centrifugal: "Centrifugal casting",
          // `unknown` ("Pata nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "foundry_moulding_method",
        rank: 41,
        label: "Moulding",
        kind: "chips",
        values: {
          hand_moulding: "Hand moulding (floor / bench)",
          jolt_squeeze: "Jolt-squeeze machine",
          arpa: "ARPA machine",
          disa: "DISA flaskless line",
          high_pressure_line: "High-pressure moulding line",
          shell_machine: "Shell moulding machine",
          continuous_mixer: "Continuous sand mixer",
          // `unknown` ("Mould nahi banata") has no entry, so it prints nothing.
        },
      },
      {
        from: "foundry_furnace",
        rank: 43,
        label: "Furnaces",
        kind: "chips",
        values: {
          induction: "Induction furnace",
          cupola: "Cupola",
          arc_furnace: "Arc furnace",
          crucible_furnace: "Oil / gas-fired crucible furnace",
          rotary_furnace: "Rotary furnace",
          // `unknown` ("Furnace par kaam nahi kiya") has no entry, so it prints nothing.
        },
      },
      {
        from: "foundry_core_process",
        rank: 45,
        label: "Core processes",
        kind: "chips",
        values: {
          cold_box: "Cold box",
          shell_core: "Shell core",
          co_two_core: "CO2 core",
          oil_sand_core: "Oil-sand core",
          no_bake_core: "No-bake core",
          // `unknown` ("Core nahi banata") has no entry, so it prints nothing.
        },
      },
      {
        from: "material_worked",
        rank: 23,
        inHeadline: true,
        maxValues: 4,
        label: "Metals",
        kind: "chips",
        values: {
          cast_iron: "Grey cast iron (CI)",
          sg_iron: "SG / ductile iron",
          carbon_steel: "Carbon steel (WCB)",
          alloy_steel: "Alloy / manganese steel",
          stainless: "Stainless steel (CF8)",
          aluminium: "Aluminium (LM6 / LM25)",
          brass: "Brass / bronze / gunmetal",
        },
      },
      {
        from: "foundry_casting_product",
        rank: 63,
        label: "Castings",
        kind: "chips",
        values: {
          brake_flywheel: "Brake drums / discs / flywheels",
          engine_block: "Engine blocks / cylinder heads",
          housing: "Gearbox / axle / tractor housings",
          pump_valve_body: "Pump & valve bodies",
          motor_body: "Motor bodies & end covers",
          municipal_casting: "Manhole covers & pipe fittings",
          heavy_casting: "Machine beds & heavy castings",
          investment_parts: "Small precision parts (investment)",
          // `unknown` ("Koi aur casting") has no entry, so it prints nothing.
        },
      },
      {
        from: "foundry_casting_weight",
        rank: 62,
        label: "Casting weight",
        kind: "fact",
        // KEYED BY THE STORED VALUE, not the option key — the pack's `value_text` is the numeric
        // string. Keying this by `upto_five` would render nothing at all, silently.
        values: {
          "5": "Up to 5 kg",
          "50": "5–50 kg",
          "500": "50–500 kg",
          "2000": "500 kg–2 T",
          "5000": "Over 2 T",
          // `unknown` ("Pata nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — same rule as every machining map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "foundry_melt_work",
        rank: 46,
        label: "Melting & pouring",
        kind: "ticks",
        values: {
          charge_mix: "Charge-mix preparation",
          tapping: "Deslagging & tapping",
          temperature_check: "Temperature check (pyrometer)",
          inoculation: "Inoculation",
          mg_treatment: "Mg treatment (SG iron)",
          ladle_pouring: "Ladle pouring",
          lining: "Furnace lining / patching",
          // `unknown` ("Melting pouring nahi karta") has no entry, so it prints nothing.
        },
      },
      {
        from: "foundry_testing",
        rank: 42,
        label: "Testing",
        kind: "chips",
        values: {
          // History values first, with the old English.
          spectro: "Spectro (chemistry)",
          hardness: "Hardness testing",
          dimensional: "Dimensional check",
          // The new form's own tests (#3012).
          ce_meter: "CE meter",
          wedge_test: "Wedge / chill test",
          sand_moisture: "Sand moisture & compactability",
          sand_strength: "Permeability & GCS",
          mould_hardness: "Mould hardness",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile",
          two_wheeler: "Two-wheeler",
          agri: "Tractor & agriculture",
          pump_valve: "Pumps & valves",
          railways: "Railways",
          construction_equipment: "Construction equipment",
          oil_gas: "Oil & gas",
          general_engg: "General engineering",
          // `unknown` ("Inme se koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          blow_hole: "Blowholes / gas porosity",
          shrinkage: "Shrinkage",
          cold_shut: "Cold shut / misrun",
          sand_inclusion: "Sand inclusion",
          mismatch: "Mismatch / shift",
          slag_inclusion: "Slag inclusion",
          chill: "Hard spots / chill",
          crack: "Crack / hot tear",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          heat_record: "Heat-wise records",
          rejection: "Rejection analysis",
          gating_change: "Gating & riser correction",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T25 — DIE CASTING OPERATOR (PDC / GDC) (#3012): NEW MAP ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet T25's headline ("Die Casting Operator (PDC / GDC) ·
  // {level} · {experience} · {diecast_process} · {diecast_machine_brand} · {diecast_tonnage} ·
  // {city}") is the parity reference. Process, machine brand and tonnage lead (the hire is for
  // the machine), then the daily work, the alloys and the parts; setting, parameters and die care
  // sit with quality and troubleshooting at the back. Every `values` key is the STORED value; the
  // negative claims (`unknown`, `none`) have no entry, so they print nothing.
  {
    pack_id: "qp_die_casting",
    section_title: "Die casting, machines & capability",
    tier_section_titles: { easy: "Die casting & machines" },
    capability: [
      {
        from: "diecast_process",
        rank: 21,
        inHeadline: true,
        label: "Processes",
        kind: "chips",
        values: {
          hpdc_cold: "HPDC cold chamber",
          hpdc_hot: "HPDC hot chamber",
          lpdc: "LPDC / low pressure",
          gdc: "GDC / gravity die casting",
          // `unknown` ("Koi aur process") has no entry, so it prints nothing.
        },
      },
      {
        from: "diecast_machine_brand",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          toshiba: "Toshiba",
          buhler: "Buhler",
          zitai: "Zitai",
          lk: "LK",
          hmt: "HMT",
          ube: "Ube",
          frech: "Frech",
          // `unknown` ("Koi aur ya pata nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "diecast_tonnage",
        // Beside the machines, as the press shop's tonnage: what the MACHINE can do. The pack
        // asks the largest machine run, so the row reads "Up to", never a lower bound — same
        // ruling as the injection-moulding tonnage row.
        rank: 23,
        inHeadline: true,
        label: "Tonnage worked",
        kind: "fact",
        // KEYED BY THE STORED VALUE — the pack's `value_text` is the numeric string.
        values: {
          "150": "Up to 150 T machines",
          "400": "150–400 T machines",
          "800": "400–800 T machines",
          "1600": "800–1600 T machines",
          "2500": "Over 1600 T machines",
          // `unknown` ("Pata nahi ya GDC hai") has no entry, so it prints nothing.
        },
      },
      {
        from: "diecast_daily_work",
        rank: 41,
        label: "Work",
        kind: "ticks",
        values: {
          manual_ladle: "Manual ladling",
          auto_cell: "Auto-ladle / robot cell",
          die_spray: "Die spraying",
          extraction: "Casting extraction",
          degating: "Degating",
          trimming: "Trimming press operation",
          fettling: "Fettling & deburring",
          visual_check: "Visual check",
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Alloys",
        kind: "chips",
        values: {
          adc_twelve: "ADC12",
          lm_six: "LM6",
          lm_twentyfour: "LM24",
          lm_twentyfive: "LM25 / A356",
          zinc: "Zinc (Zamak)",
          magnesium: "Magnesium",
          aluminium: "Aluminium",
        },
      },
      {
        from: "diecast_part",
        rank: 63,
        label: "Parts",
        kind: "chips",
        values: {
          engine_covers: "Crankcase / clutch / magneto covers",
          gearbox_housing: "Gearbox / transmission housings",
          cylinder_head: "Cylinder heads / blocks",
          alloy_wheel: "Alloy wheels",
          motor_housing: "Motor bodies & end covers",
          led_housing: "LED housings & heat sinks",
          fan_parts: "Fan parts",
          zinc_hardware: "Zinc small parts / locks / hardware",
          // `unknown` ("Koi aur part") has no entry, so it prints nothing.
        },
      },
      {
        from: "diecast_melting_work",
        rank: 42,
        label: "Melting & metal",
        kind: "ticks",
        values: {
          furnace_charging: "Furnace charging (melting / holding)",
          degassing: "Degassing",
          fluxing: "Fluxing & dross removal",
          metal_temperature: "Metal temperature check",
          density_index: "Density index test",
          spectro_sample: "Spectro sample",
          // `unknown` ("Furnace ka kaam nahi karta") has no entry, so it prints nothing.
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier caliper",
          micrometer: "Micrometer",
          height_gauge: "Height gauge",
          plug_gauge: "Plug / thread gauge",
          checking_fixture: "Checking fixture",
          leak_tester: "Leak test machine",
          // `unknown` ("Inme se koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — same rule as every machining map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "diecast_setting_work",
        rank: 43,
        label: "Setting",
        kind: "ticks",
        values: {
          die_loading: "Die loading & clamping",
          die_height: "Die height & tie-bar setting",
          ejector_core: "Ejector & core-pull setting",
          plunger_tip: "Shot sleeve & plunger tip replacement",
          cooling_line: "Die cooling lines",
          die_preheat: "Die preheating",
          trim_die: "Trim die fitting",
        },
      },
      {
        from: "diecast_parameter",
        rank: 45,
        label: "Parameters set",
        kind: "ticks",
        values: {
          shot_speed: "Slow & fast shot speeds",
          changeover: "Fast-shot changeover position",
          intensification: "Intensification pressure",
          biscuit: "Biscuit thickness",
          die_temperature: "Die temperature",
          cooling_time: "Cooling / solidification time",
          spray_setting: "Spray time & dilution",
          vacuum: "Vacuum",
          // `unknown` ("Parameter nahi badalta") has no entry, so it prints nothing.
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          two_wheeler: "Two-wheeler",
          automotive: "Cars & commercial vehicles",
          appliances: "Fans & home appliances",
          electronics: "LED lighting & electronics",
          hardware: "Hardware / locks / fittings",
          general_engg: "General engineering",
          // `unknown` ("Inme se koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          porosity: "Porosity",
          cold_shut: "Cold shut / flow marks",
          flash: "Flash",
          soldering: "Die soldering",
          blister: "Blisters",
          crack: "Cracks",
          non_fill: "Non-filling",
          leakage: "Leak-test leakage",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "diecast_die_care",
        rank: 73,
        label: "Die care",
        kind: "ticks",
        values: {
          die_polish: "Die polishing & soldering removal",
          pin_change: "Ejector / core pin replacement",
          die_coat: "Die coating (GDC)",
          die_life_record: "Shot count & die life records",
          die_pm: "Die PM checklist",
          // `unknown` ("Tool room wale karte hain") has no entry, so it prints nothing.
        },
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          spc: "SPC charts",
          rejection: "Rejection analysis",
          xray_check: "X-ray / cut-section inspection",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T26 — FORGING OPERATOR (#3012): NEW MAP ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet T26's headline ("Forging Operator · {level} ·
  // {experience} · {forging_machine} · {forging_type} · {forging_part} · {city}") is the parity
  // reference. Machine and forging type lead (the hire is for the hammer or press), then the
  // parts; heating, daily work and capacity sit in the middle, setting and die care with quality
  // at the back. Every `values` key is the STORED value; the negative claims (`unknown`, `none`,
  // `no_heating`) have no entry, so they print nothing.
  {
    pack_id: "qp_forging",
    section_title: "Forging, machines & capability",
    tier_section_titles: { easy: "Forging & machines" },
    capability: [
      {
        from: "forging_machine",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          drop_hammer: "Drop hammer",
          power_hammer: "Pneumatic / power hammer",
          screw_press: "Friction screw press",
          forging_press: "Mechanical forging press",
          hydraulic_press: "Hydraulic press",
          upsetter: "Upsetter",
          ring_rolling_mill: "Ring rolling machine",
          bolt_former: "Bolt former / header",
          // `unknown` ("Koi aur machine") has no entry, so it prints nothing.
        },
      },
      {
        from: "forging_type",
        rank: 22,
        inHeadline: true,
        label: "Forging types",
        kind: "chips",
        values: {
          hot_closed_die: "Hot forging, closed die",
          open_die: "Open-die forging",
          upset_forging: "Upset forging",
          ring_rolling: "Ring rolling",
          warm_forging: "Warm forging",
          cold_forging: "Cold forging / heading",
        },
      },
      {
        from: "forging_heating",
        rank: 41,
        label: "Heating",
        kind: "chips",
        values: {
          induction_heater: "Induction billet heater",
          oil_fired: "Oil-fired furnace",
          gas_fired: "Gas-fired furnace",
          // `no_heating` ("Cold forging hai, heating nahi") is a negative claim and has no
          // entry; `unknown` ("Pata nahi") has none either. Both print nothing.
        },
      },
      {
        from: "forging_daily_work",
        rank: 42,
        label: "Work",
        kind: "ticks",
        values: {
          billet_cutting: "Billet cutting",
          billet_heating: "Furnace / heater charging",
          forger: "Manual forging with tongs",
          machine_driving: "Hammer / press operation",
          trimming: "Trimming & piercing",
          coining: "Coining / sizing",
          die_lubrication: "Die lubricant spray",
          shot_blasting: "Shot blasting & grinding",
        },
      },
      {
        from: "forging_capacity",
        rank: 62,
        label: "Capacity worked",
        kind: "fact",
        values: {
          hammer_small: "Hammers up to 1 T",
          hammer_medium: "Hammers 1–3 T",
          hammer_heavy: "Hammers over 3 T",
          press_small: "Presses up to 1000 T",
          press_medium: "Presses 1000–2500 T",
          press_heavy: "Presses over 2500 T",
          // `unknown` ("Pata nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          mild_steel: "MS / low-carbon steel",
          alloy_steel: "EN8 / EN19 / EN24",
          case_hardening_steel: "20MnCr5 / SAE 8620",
          micro_alloy: "Micro-alloy steel",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          brass: "Brass",
        },
      },
      {
        from: "forging_part",
        rank: 63,
        inHeadline: true,
        label: "Parts",
        kind: "chips",
        values: {
          crankshaft: "Crankshafts",
          connecting_rod: "Connecting rods",
          gear_blank: "Gear blanks / bearing races / rings",
          flange: "Flanges & pipe fittings",
          axle_shaft: "Axles / spindles / shafts",
          hub_knuckle: "Hubs / knuckles / yokes",
          fasteners: "Bolts / nuts / fasteners",
          hand_tools: "Hand tools (spanners, pliers)",
          // `unknown` ("Koi aur part") has no entry, so it prints nothing.
        },
      },
      {
        from: "forging_cold_heading",
        rank: 43,
        label: "Cold heading",
        kind: "chips",
        values: {
          header: "Header (1-die-2-blow)",
          multi_station: "Multi-station bolt former",
          nut_former: "Nut former",
          thread_rolling: "Thread rolling machine",
          cold_press: "Cold forging press",
          // `unknown` ("Cold forging nahi kiya") has no entry, so it prints nothing.
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier caliper",
          steel_rule: "Steel rule",
          snap_gauge: "Snap gauge",
          template_gauge: "Template / profile gauges",
          height_gauge: "Height gauge",
          pyrometer: "Temperature check (pyrometer)",
          // `unknown` ("Inme se koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — same rule as every machining map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "forging_setting_work",
        rank: 45,
        label: "Setting",
        kind: "ticks",
        values: {
          die_clamping: "Die fitting & clamping",
          die_matching: "Top-bottom die matching",
          die_preheat: "Die preheating",
          shut_height: "Press shut-height setting",
          trim_die: "Trimming die fitting",
          ejector: "Ejector / knock-out setting",
          heater_setting: "Billet heater temperature setting",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile",
          two_wheeler: "Two-wheeler",
          agri: "Tractor & agriculture",
          bearings: "Bearings",
          fasteners: "Fasteners",
          oil_gas: "Oil & gas / flanges",
          railways: "Railways",
          defence: "Defence",
          // `unknown` ("Inme se koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "troubleshooting",
        rank: 72,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          lap: "Lap / fold",
          underfill: "Underfill",
          mismatch: "Mismatch",
          scale_pit: "Scale pits",
          crack: "Cracks",
          overheating: "Overheating / burning",
          bend: "Bend / warpage",
          sticking: "Sticking in die",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "forging_die_care",
        rank: 73,
        label: "Die care",
        kind: "ticks",
        values: {
          preheat_control: "Die preheat control",
          lubrication_control: "Lubrication & cooling control",
          die_polish: "Die polishing",
          wear_check: "Die wear & crack inspection",
          die_life_record: "Die life records",
          resink: "Die re-sinking / weld repair",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
      {
        from: "quality_work",
        rank: 71,
        label: "Quality",
        kind: "ticks",
        values: {
          first_piece_check: "First-piece inspection",
          in_process: "In-process checking",
          rejection: "Rejection analysis",
          crack_detection: "MPI crack inspection",
          // `unknown` ("Koi nahi") has no entry, so it prints nothing.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T21 — CNC ROUTER / ENGRAVING OPERATOR (#3012): NEW MAP ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet T21's headline ("CNC Router / Engraving Operator ·
  // {level} · {experience} · {router_machine_type} · {router_software} · {city}") is the parity
  // reference. Machines and router software lead (the hire is for the machine and the seat),
  // then the controller, the work, the bed size, materials, products, tooling, measuring,
  // drawings, setting, design work, design source, troubleshooting, and the display-only sector
  // tag last. Every `values` key is the STORED value_text; `unknown` escape chips and the `none`
  // drawing answer carry no entry, so non-answers print nothing. `router_design_source` maps ALL
  // its values: a single fact whose every option is a positive claim.
  //
  // No rows read `iti_workshop_machines` or `trade_test_status`: the fresher block owns those
  // keys (`buildFresherRows`), and mapping them here would print a fresher's training twice.
  {
    pack_id: "qp_cnc_router",
    section_title: "Machines, software & capability",
    tier_section_titles: { easy: "Machines & software" },
    capability: [
      {
        from: "router_machine_type",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          wood_router: "Wood CNC router · 3-axis",
          atc_router: "ATC router / nesting machine",
          multi_head: "Multi-head router",
          rotary_axis: "4-axis / rotary router",
          stone_router: "Stone / marble CNC router",
          metal_engraver: "Metal / die engraving machine",
          jewellery_cnc: "Jewellery CNC",
          laser_engraver: "Laser engraver / cutter",
          // `unknown` ("Koi aur machine") has no entry: a non-answer prints nothing.
        },
      },
      {
        from: "router_software",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Software",
        kind: "chips",
        values: {
          artcam: "ArtCAM",
          aspire_vcarve: "Aspire / VCarve",
          type_three: "Type3",
          jdpaint: "JDPaint",
          alphacam: "Alphacam",
          coreldraw: "CorelDRAW",
          autocad: "AutoCAD",
          rdworks: "RDWorks (laser)",
          // `unknown` ("Software nahi chalata, sirf machine") has no entry.
        },
      },
      {
        from: "controller_brand",
        rank: 23,
        maxValues: 3,
        label: "Controllers",
        kind: "chips",
        values: {
          dsp_handle: "DSP handle (RichAuto)",
          ncstudio: "NCStudio",
          mach_three: "Mach3",
          syntec: "Syntec",
          ruida: "Ruida (laser)",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "router_work_type",
        rank: 41,
        label: "Work done",
        kind: "ticks",
        values: {
          two_d_cutting: "2D cutting and profiles",
          jali_cutting: "Jali cutting (MDF, ACP, acrylic)",
          v_grooving: "V-groove / ACP grooving",
          relief_carving: "2.5D relief carving",
          three_d_carving: "3D carving (idols, pillars, panels)",
          letter_engraving: "Letter and logo engraving",
          nesting_panels: "Nesting — panel cutting and drilling",
          die_engraving: "Die / mould engraving",
          laser_engraving: "Laser engraving / marking",
        },
      },
      {
        from: "router_bed_size",
        rank: 45,
        label: "Bed size",
        kind: "fact",
        values: {
          "6090": "Small bed (6090)",
          "1325": "4 × 8 ft bed (1325)",
          "1530": "5 × 10 ft bed (1530)",
          "2030": "2030 bed or larger",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        values: {
          mdf_board: "MDF / HDF / particle board",
          wood: "Plywood and solid wood",
          acrylic: "Acrylic",
          acp: "ACP sheet",
          pvc_wpc: "PVC / WPC board",
          stone: "Marble, granite and stone",
          aluminium: "Aluminium",
          brass: "Brass / copper",
          alloy_steel: "Die / mould steel",
        },
      },
      {
        from: "router_product",
        rank: 63,
        label: "Products",
        kind: "ticks",
        values: {
          doors: "Doors and door-skin designs",
          modular_furniture: "Modular furniture / kitchen panels",
          mandir_jali: "Temples, jali and wall panels",
          signage: "Signage, letters and nameplates",
          acp_cladding: "ACP cladding / elevation",
          stone_carving: "Idols, pillars and stone carving",
          footwear_mould: "Footwear / sole moulds",
          embossing_die: "Embossing, coin and jewellery dies",
        },
      },
      {
        from: "router_tooling",
        rank: 46,
        label: "Tooling",
        kind: "ticks",
        values: {
          straight_bit: "Straight / flat end bits",
          ball_nose: "Ball-nose bits",
          v_bit: "V-bits / engraving bits",
          spiral_bit: "Spiral / compression bits",
          tapered_ball_nose: "Tapered ball-nose (3D carving)",
          diamond_tool: "Diamond tools (stone)",
          boring_head: "Drill / boring head (nesting)",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          steel_rule: "Measuring tape and steel rule",
          vernier: "Vernier caliper",
          try_square: "Try square / right angle",
          tool_setter: "Z setter / tool sensor",
          micrometer: "Micrometer",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry: a negative claim does not belong on the
        // worker's own marketing document (the turning/milling/grinding precedent).
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "router_setting_work",
        rank: 42,
        label: "Setting",
        kind: "ticks",
        values: {
          job_clamping: "Sheet clamping (vacuum bed, clamps, screws)",
          bit_change: "Bit fitting and collet change",
          origin_zero: "X-Y origin and Z-zero setting",
          feed_rpm: "Feed and spindle RPM setting",
          file_loading: "File loading (pen drive, DSP, NCStudio)",
          breakpoint_resume: "Breakpoint resume after interruption",
          tool_length: "ATC tool-length setting",
          sheet_layout: "Sheet layout",
        },
      },
      {
        from: "router_design_work",
        rank: 43,
        label: "Design work",
        kind: "ticks",
        values: {
          toolpath_from_file: "Toolpath from ready files",
          vector_tracing: "Photo-to-vector tracing",
          two_d_toolpath: "2D toolpath (profile, pocket, V-carve)",
          relief_modelling: "3D relief modelling",
          three_d_toolpath: "3D roughing and finishing toolpath",
          nesting: "Nesting",
          import_scale: "STL / relief import and resizing",
          rotary_toolpath: "Rotary (4-axis) toolpath",
          // `unknown` ("Software nahi chalata") has no entry.
        },
      },
      {
        from: "router_design_source",
        rank: 64,
        label: "Design source",
        kind: "fact",
        // All four values mapped: a single fact whose every option is a positive claim.
        values: {
          customer_file: "Works from customer files",
          library_edit: "Edits library designs",
          from_photo: "Designs from photos / samples",
          own_design: "Designs from scratch",
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          furniture: "Furniture and modular kitchens",
          doors_plywood: "Door / plywood factories",
          signage: "Signage and advertising",
          interior_acp: "Interior / ACP fabrication",
          stone_temple: "Temple, marble and stone carving",
          die_mould: "Dies and moulds (footwear, embossing)",
          jewellery: "Jewellery",
          handicraft: "Handicraft / gift items",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 71,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          tool_breakage: "Frequent bit breakage",
          edge_burn_chipping: "Edge burning / chipping",
          size_variation: "Size / depth variation",
          step_loss: "Step loss / design shift",
          surface_finish: "Carving lines / poor finish",
          sheet_shifting: "Weak vacuum / sheet shifting",
          alarm: "Limit / driver alarms",
          spindle_heating: "Spindle heating / noise",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T33 — CMM OPERATOR / PROGRAMMER (#3012): NEW MAP ══
  //
  // A NEW TRADE WITH NO RATIFIED PAGE: sheet T33's headline ("CMM Operator / Programmer ·
  // {level} · {experience} · {cmm_make} · {cmm_software} · {city}") is the parity reference.
  // The make and the software lead (the hire is for the seat: a Zeiss/Calypso room), then the
  // machine types, the daily work, drawings, parts, probes, programming level, alignments, GD&T,
  // tolerance, reports, quality-system work, troubleshooting, and the display-only sector tag last.
  // Every `values` key is the STORED value_text; `unknown` escapes and the `none` drawing answer
  // carry no entry. `cmm_programming_level` maps ALL its values, including `run_only`: running
  // supplied programs is a positive claim about what the worker does.
  //
  // No rows read `iti_workshop_machines` or `trade_test_status`: the fresher block owns those
  // keys (`buildFresherRows`), and mapping them here would print a fresher's training twice.
  {
    pack_id: "qp_cmm",
    section_title: "Machines, software & capability",
    tier_section_titles: { easy: "Machines & software" },
    capability: [
      {
        from: "cmm_machine_type",
        rank: 21,
        maxValues: 4,
        label: "Machines",
        kind: "chips",
        values: {
          bridge_cmm: "Bridge CMM",
          gantry_cmm: "Gantry CMM (large parts)",
          horizontal_arm: "Horizontal-arm CMM",
          portable_arm: "Portable arm (Faro / Romer)",
          vmm: "VMM / vision measuring machine",
          three_d_scanner: "3D scanner",
          profile_projector: "Profile projector",
          contour_tester: "Contour / roughness tester",
          // `unknown` ("Koi aur machine") has no entry.
        },
      },
      {
        from: "cmm_software",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "CMM software",
        kind: "chips",
        values: {
          calypso: "Calypso (Zeiss)",
          pc_dmis: "PC-DMIS (Hexagon)",
          mcosmos: "MCOSMOS / GEOPAK (Mitutoyo)",
          arco_cad: "ARCO CAD (Accurate)",
          quartis: "Metrosoft / Quartis (Wenzel)",
          polyworks: "PolyWorks",
          faro_cam: "Faro CAM2",
          gom_inspect: "GOM Inspect",
          // `unknown` ("Koi aur software") has no entry.
        },
      },
      {
        from: "cmm_make",
        rank: 23,
        inHeadline: true,
        maxValues: 3,
        label: "CMM makes",
        kind: "chips",
        values: {
          zeiss: "Zeiss",
          hexagon: "Hexagon (DEA / Brown & Sharpe)",
          mitutoyo: "Mitutoyo",
          accurate: "Accurate",
          wenzel: "Wenzel",
          faro: "Faro",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "cmm_daily_work",
        rank: 41,
        label: "Daily work",
        kind: "ticks",
        values: {
          run_program: "Runs programs and checks parts",
          part_clamping: "Part clamping on fixtures",
          probe_calibration: "Probe calibration (qualification)",
          alignment: "Alignment setup",
          manual_measurement: "Joystick manual measurement",
          report_output: "Report generation",
          new_program: "New program creation",
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry, same precedent as every machining map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "cmm_part_type",
        rank: 63,
        label: "Part types",
        kind: "ticks",
        values: {
          machined_parts: "Machined parts (shafts, housings)",
          castings: "Castings and die-casting parts",
          forgings: "Forgings",
          sheet_metal: "Sheet metal / BIW panels",
          plastic_parts: "Plastic moulded parts",
          die_mould: "Dies, moulds and electrodes",
          fixtures_gauges: "Jigs, fixtures and gauges",
        },
      },
      {
        from: "cmm_probe_system",
        rank: 42,
        label: "Probes & sensors",
        kind: "ticks",
        values: {
          touch_trigger: "Touch-trigger probe (TP20 / TP200)",
          scanning_probe: "Scanning probe (SP25 / VAST)",
          motorised_head: "Motorised head (PH10)",
          star_probe: "Star probe and extensions",
          laser_sensor: "Laser / optical sensor",
          vision_sensor: "Vision / camera sensor",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "cmm_alignment_method",
        rank: 45,
        label: "Alignment methods",
        kind: "ticks",
        values: {
          three_two_one: "3-2-1 (plane, line, point)",
          datum_alignment: "Datum A, B, C alignment",
          best_fit: "Best fit",
          rps: "RPS alignment",
          cad_alignment: "CAD-model alignment",
          iterative: "Iterative alignment",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "cmm_gdt_evaluation",
        rank: 46,
        label: "GD&T evaluated",
        kind: "ticks",
        values: {
          flatness: "Flatness and straightness",
          roundness: "Circularity and cylindricity",
          position: "True position",
          orientation: "Perpendicularity, parallelism, angularity",
          runout: "Concentricity and runout",
          profile: "Profile of surface / line",
          symmetry: "Symmetry",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "tolerance_band",
        rank: 62,
        label: "Tolerance checked",
        kind: "fact",
        values: {
          "0.10": "±0.10 mm",
          "0.05": "±0.05 mm",
          "0.02": "±0.02 mm",
          "0.01": "±0.01 mm",
          "0.005": "±0.005 mm or finer",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "cmm_programming_level",
        rank: 43,
        label: "Programming",
        kind: "fact",
        // All four values mapped: even `run_only` is a positive claim about the work done.
        values: {
          run_only: "Runs supplied programs",
          edit_program: "Edits programs",
          program_from_drawing: "Programs from drawings",
          program_from_cad: "Programs from CAD models",
        },
      },
      {
        from: "cmm_report_type",
        rank: 71,
        label: "Reports prepared",
        kind: "ticks",
        values: {
          layout_inspection: "Layout inspection reports",
          ppap_dimensional: "PPAP dimensional reports",
          first_article: "First-article / sample inspection reports",
          colour_map: "Colour-map (CAD comparison) reports",
          cpk_data: "Cp / Cpk study data",
          fixture_gauge_report: "Fixture and gauge inspection reports",
          reverse_engineering: "Scan data for reverse engineering",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 81,
        maxValues: 3,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile parts",
          two_wheeler: "Two-wheeler parts",
          die_mould: "Dies, moulds and tool rooms",
          defence: "Defence / aerospace",
          general_engg: "General engineering / job shops",
          pump_valve: "Pumps and valves",
          bearings: "Bearings",
          electronics: "Electronics / EMS",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "cmm_quality_system",
        rank: 72,
        label: "Quality system work",
        kind: "ticks",
        values: {
          msa_grr: "MSA / gauge R&R studies",
          machine_calibration: "CMM calibration and verification",
          customer_audit: "Customer audits in CMM room",
          iatf_records: "IATF 16949 records",
          operator_training: "Operator training",
          fixture_planning: "Fixture planning for new parts",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 73,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          probe_calibration_fail: "Probe calibration failure",
          repeatability: "Non-repeat readings",
          collision: "Probe collision",
          temperature_effect: "Temperature-related variation",
          alignment_error: "Wrong alignment",
          air_alarm: "Air-pressure / air-bearing alarms",
          correlation_issue: "CMM vs gauge correlation",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T37 — QUALITY ENGINEER (QA / QC / SQA) (#3012): DESK-TRADE MAP ══
  //
  // A NEW DESK TRADE WITH NO RATIFIED PAGE: sheet T37's headline ("Quality Engineer · {level} ·
  // {experience} · {qe_function} · {qe_core_tools} · {city}") is the parity reference. For a desk
  // trade the function and the core tools are the advertised vocabulary (the CAM map's software
  // precedent), so `inHeadline` sits on those two rows.
  //
  // Two questions are captured and printed nowhere: `qe_training_exposure` is fresher-owned
  // matching data (the fresher block's heading comes from the role descriptor's `trainingLabel`,
  // not from a printed row — the CAD map's `cad_training_source` precedent), and
  // `qe_qualification_branch` is education (Zone 5 owns it — no shipped map prints it).
  {
    pack_id: "qp_quality_engineer",
    section_title: "Tools, standards & responsibility",
    tier_section_titles: { easy: "Functions & tools" },
    capability: [
      {
        from: "qe_function",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Quality functions",
        kind: "chips",
        values: {
          in_process: "In-process / line quality",
          final_pdi: "Final inspection / PDI",
          incoming: "Incoming / receiving quality",
          supplier_quality: "Supplier quality (SQA)",
          customer_quality: "Customer quality",
          qms: "QMS / MR",
          npd_quality: "NPD quality",
          standards_room: "Standards room / lab",
          warranty: "Warranty / field quality",
        },
      },
      {
        from: "qe_core_tools",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Core tools",
        kind: "chips",
        values: {
          ppap: "PPAP",
          apqp: "APQP",
          pfmea: "PFMEA",
          control_plan: "Control plan",
          msa: "MSA",
          spc: "SPC",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "qe_problem_solving",
        rank: 23,
        maxValues: 4,
        label: "Problem-solving tools",
        kind: "chips",
        values: {
          eight_d: "8D reports",
          why_why: "Why-why analysis",
          fishbone: "Fishbone diagrams",
          seven_qc_tools: "7 QC tools",
          capa: "CAPA",
          qc_story: "QC story",
          poka_yoke: "Poka-yoke",
          six_sigma: "Six Sigma (DMAIC)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "qe_software",
        rank: 24,
        maxValues: 4,
        label: "Software & systems",
        kind: "chips",
        values: {
          excel: "MS Excel (pivot, charts)",
          powerpoint: "PowerPoint",
          sap_qm: "SAP QM",
          other_erp: "Other ERP",
          minitab: "Minitab",
          customer_portal: "Customer supplier portals",
          cad_viewer: "AutoCAD / drawing viewer",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "drawing_reading",
        rank: 44,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry, same precedent as every shop map.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "measuring_tools",
        rank: 51,
        label: "Measuring instruments",
        kind: "ticks",
        values: {
          vernier: "Vernier caliper",
          micrometer: "Micrometer",
          bore_gauge: "Bore dial gauge",
          height_gauge: "Height gauge",
          plug_gauge: "Plug / ring gauges",
          dial_indicator: "Dial indicator",
          profile_projector: "Profile projector",
          roughness_tester: "Roughness tester",
          hardness_tester: "Hardness tester",
        },
      },
      {
        from: "qe_process_area",
        rank: 63,
        label: "Process areas",
        kind: "ticks",
        values: {
          machining: "Machining",
          press_shop: "Sheet metal / press shop",
          welding: "Welding and fabrication",
          casting: "Casting / die casting",
          forging: "Forging",
          plastic_moulding: "Plastic moulding",
          assembly: "Assembly lines",
          special_process: "Paint, plating / heat treatment",
          electronics: "Electrical / electronics",
        },
      },
      {
        from: "qe_documents",
        rank: 41,
        label: "Documents prepared",
        kind: "ticks",
        values: {
          inspection_standard: "Inspection standards / check sheets",
          work_instruction: "Work instructions / SOPs",
          rejection_report: "Daily rejection and PPM reports",
          ppap_file: "PPAP files (with PSW)",
          quality_alert: "Quality alerts / one-point lessons",
          deviation_note: "Deviation / concession notes",
          four_m_change: "4M change records",
          quality_mis: "Monthly quality MIS",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "qe_standards",
        rank: 42,
        maxValues: 4,
        label: "Standards",
        kind: "chips",
        values: {
          iatf: "IATF 16949",
          iso_qms: "ISO 9001",
          ems_ohsms: "ISO 14001 / ISO 45001",
          vda: "VDA 6.3",
          cqi: "CQI special processes (CQI-9, CQI-11, CQI-12)",
          as_aerospace: "AS 9100 (aerospace)",
          bis: "BIS / ISI marking",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "qe_audit_work",
        rank: 43,
        label: "Audit work",
        kind: "ticks",
        values: {
          internal_auditor: "Certified internal auditor",
          process_audit: "Process audits",
          product_audit: "Product audits",
          layered_audit: "Layered process audits (LPA)",
          supplier_audit: "Supplier audits",
          customer_audit: "Customer audit handling",
          certification_audit: "Certification-body audit handling",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "qe_customer_handled",
        rank: 81,
        label: "Customers handled",
        kind: "fact",
        join: ", ",
        values: {
          maruti: "Maruti Suzuki",
          hero: "Hero MotoCorp",
          honda: "Honda (HMSI / Honda Cars)",
          tata: "Tata Motors",
          mahindra: "Mahindra",
          bajaj_tvs: "Bajaj / TVS",
          hyundai_kia: "Hyundai / Kia",
          jcb: "JCB",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "qe_supplier_work",
        rank: 71,
        label: "Supplier quality work",
        kind: "ticks",
        values: {
          supplier_ppap: "Supplier PPAP approval",
          supplier_plant_audit: "Supplier plant audits",
          supplier_capa: "8D on incoming rejection",
          supplier_rating: "Supplier rating / scorecards",
          vendor_assessment: "New vendor assessment",
          supplier_improvement: "Improvement at supplier end",
          // `unknown` ("Supplier ka kaam nahi kiya") has no entry.
        },
      },
      {
        from: "qe_targets_owned",
        rank: 72,
        label: "Targets owned",
        kind: "ticks",
        values: {
          customer_ppm: "Customer PPM",
          inhouse_rejection: "In-house rejection and rework",
          copq: "COPQ",
          customer_complaints: "Customer complaints",
          supplier_ppm: "Supplier PPM",
          warranty_return: "Warranty returns",
          first_time_right: "First-time-right (FTR)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "qe_improvement_work",
        rank: 73,
        label: "Improvement work",
        kind: "ticks",
        values: {
          kaizen: "Kaizen",
          poka_yoke: "Poka-yoke implementation",
          quality_circle: "Quality circles",
          six_sigma: "Six Sigma projects (Green / Black Belt)",
          five_s: "5S",
          rejection_reduction: "Rejection-reduction projects",
          tpm_qm: "TPM (QM pillar)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T43 — MAINTENANCE ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T43's headline
  // (`Maintenance Engineer · {level} · {experience} · {me_function} · {me_machine_type} ·
  // {me_record_system} · {city}`) is the parity reference. Function, machine family and record
  // system lead (the hire is for the plant he can hold), then the daily work, the technical areas
  // and the senior rows. Every `values` key is the STORED value; `unknown` escape chips and the
  // `none`-class negatives have no entry, so they print nothing.
  {
    pack_id: "qp_maintenance_engineer",
    section_title: "Functions, machines & responsibility",
    tier_section_titles: { easy: "Functions & machines" },
    capability: [
      {
        from: "me_function",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Functions",
        kind: "chips",
        values: {
          mechanical: "Mechanical maintenance",
          electrical: "Electrical maintenance",
          electronics_automation: "Electronics, PLC & automation",
          utility: "Utility (boiler, compressor, DG, HVAC)",
          tooling_maintenance: "Tool room, die & mould maintenance",
          planning: "PM planning & spares",
          projects: "Projects & new installation",
          facility: "Building & facility maintenance",
        },
      },
      {
        from: "me_machine_type",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Machines maintained",
        kind: "chips",
        values: {
          cnc_machines: "CNC / VMC, machine shop",
          presses: "Mechanical / hydraulic press",
          moulding_diecasting: "Injection moulding / die casting",
          furnace_forging: "Furnace, heat treatment / forging",
          conveyor_assembly: "Conveyor, assembly line & SPM",
          robot_weld_line: "Robot & welding line",
          paint_plating: "Paint shop / plating line",
          process_equipment: "Process equipment (reactor, pump, centrifuge)",
          packaging_line: "Packaging / filling line",
        },
      },
      {
        from: "me_daily_work",
        rank: 31,
        label: "Daily work",
        kind: "ticks",
        values: {
          breakdown_attend: "Breakdown attendance",
          pm_schedule: "PM scheduling & follow-up",
          spares_indent: "Spares indent / PR",
          daily_mis: "Shift report / daily MIS",
          work_allocation: "Work allocation to technicians",
          vendor_coordination: "Contractor / AMC vendor coordination",
          history_card: "Machine history cards",
          work_permit_loto: "Work permit & LOTO",
        },
      },
      {
        from: "me_record_system",
        rank: 71,
        inHeadline: true,
        maxValues: 4,
        label: "Records on",
        kind: "chips",
        values: {
          sap_pm: "SAP PM",
          maximo: "IBM Maximo",
          other_erp_cmms: "In-house ERP / CMMS",
          excel: "MS Excel",
          manual_register: "Registers & history cards",
          // `unknown` ("Koi record nahi rakhta") has no entry ON PURPOSE — a non-answer
          // must not print as an answer.
        },
      },
      {
        from: "me_technical_area",
        rank: 32,
        label: "Systems handled",
        kind: "ticks",
        values: {
          hydraulics: "Hydraulics",
          pneumatics: "Pneumatics",
          mechanical_drives: "Gearbox, bearing & alignment",
          motors_mcc: "Motors, starters & MCC panels",
          drives: "VFD & servo drives",
          plc_fault_finding: "PLC fault finding",
          cnc_machine_elements: "CNC spindle, ball screw & axes",
          utilities: "Boilers, compressors & chillers",
          power_distribution: "HT / LT, transformers & DG",
        },
      },
      {
        from: "me_drawing_reading",
        rank: 33,
        label: "Drawings read",
        kind: "ticks",
        values: {
          mechanical_drawing: "Machine assembly / part drawings",
          hydraulic_circuit: "Hydraulic circuits",
          pneumatic_circuit: "Pneumatic circuits",
          electrical_drawing: "Electrical wiring & control drawings",
          plc_ladder: "PLC ladder",
          p_and_id: "P&ID / utility layouts",
          // `unknown` ("Koi nahi") has no entry — the drawing_reading: "none" precedent.
        },
      },
      {
        from: "me_breakdown_analysis",
        rank: 41,
        label: "Breakdown analysis",
        kind: "ticks",
        values: {
          breakdown_report: "Breakdown reports",
          why_why: "Why-why analysis",
          rca_fishbone: "RCA / fishbone",
          mtbf_mttr: "MTBF / MTTR trending",
          pareto: "Breakdown Pareto",
          capa_horizontal: "CAPA & horizontal deployment",
          opl: "One-point lessons (OPL)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "me_machines_handled",
        rank: 42,
        label: "Machines under charge",
        kind: "fact",
        // KEYED BY THE STORED VALUE, not the option key — the pack's `value_text` is the
        // numeric string. Same construction as the machining tolerance-band rows.
        values: {
          "25": "Up to 25 machines",
          "100": "25–100 machines",
          "300": "100–300 machines",
          "500": "Over 300 machines",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "me_spares_vendor",
        rank: 43,
        label: "Spares & vendors",
        kind: "ticks",
        values: {
          critical_spares: "Critical spares & min-max levels",
          quotation_comparison: "Vendor quotations & technical comparison",
          amc_contracts: "AMCs (compressor, DG, chiller, CNC)",
          repair_reconditioning: "Spare repair / reconditioning",
          spare_localisation: "Import spare localisation",
          bill_certification: "Contractor bill certification",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "me_statutory_audit",
        rank: 44,
        label: "Statutory & audits",
        kind: "ticks",
        values: {
          ibr_boiler: "Boiler IBR inspection",
          pressure_vessel: "Pressure vessel & air receiver testing",
          lifting_tackle: "Crane, hoist & lifting-tackle testing",
          electrical_inspection: "Electrical inspector & earth-pit testing",
          pollution_board: "Pollution board, ETP, stack & DG",
          fire_system: "Fire hydrants & extinguishers",
          iatf_iso_audit: "IATF / ISO audit documentation",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 72,
        label: "Plants worked in",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automotive",
          general_engg: "General engineering / fabrication",
          casting_forging: "Forging, casting / foundry",
          plastics: "Plastics / rubber moulding",
          fmcg: "FMCG / food",
          pharma: "Pharma",
          chemical: "Chemical / process plant",
          steel_plant: "Steel / metal plant",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "me_tpm_improvement",
        rank: 34,
        label: "TPM & improvement",
        kind: "ticks",
        values: {
          jishu_hozen: "Jishu Hozen (JH)",
          planned_maintenance: "Planned maintenance pillar",
          kobetsu_kaizen: "Kobetsu Kaizen",
          kaizen_poka_yoke: "Kaizen / poka-yoke",
          five_s: "5S",
          oee_improvement: "OEE improvement",
          energy_saving: "Energy saving projects",
          predictive_maintenance: "Predictive maintenance (vibration, thermography, oil analysis)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "me_shutdown_projects",
        rank: 35,
        label: "Shutdowns & projects",
        kind: "ticks",
        values: {
          annual_shutdown: "Annual shutdowns",
          overhaul_retrofit: "Machine overhauling / retrofitting",
          installation_commissioning: "New machine installation & commissioning",
          machine_shifting: "Machine shifting / layout changes",
          utility_expansion: "Utility expansion (compressor, DG, transformer)",
          capex_proposal: "Capex proposals",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
      {
        from: "me_department_targets",
        rank: 36,
        label: "Targets owned",
        kind: "ticks",
        values: {
          downtime: "Breakdown & downtime",
          mtbf_mttr: "MTBF / MTTR",
          maintenance_budget: "Maintenance cost & budget",
          spares_inventory: "Spares inventory",
          energy_consumption: "Power & energy cost",
          pm_adherence: "PM adherence",
          safety: "Safety (zero accident)",
          // `unknown` ("Koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T46 — PRODUCTION ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T46's headline
  // (`Production Engineer · {level} · {experience} · {prod_shop_type} · {prod_erp_system} · {city}`)
  // is the parity reference. Shop and system lead (the hire is for the line he can run), then
  // the daily work, the documents and the senior rows. Every `values` key is the STORED value;
  // `unknown` escape chips and the `none` negative have no entry, so they print nothing.
  {
    pack_id: "qp_production_engineer",
    section_title: "Shops, systems & responsibility",
    tier_section_titles: { easy: "Shops & systems" },
    capability: [
      {
        from: "prod_shop_type",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Shops",
        kind: "chips",
        values: {
          machine_shop: "Machine shop (CNC / VMC)",
          press_shop: "Press shop",
          weld_shop: "Weld shop",
          assembly: "Assembly line",
          moulding: "Injection moulding",
          casting: "Casting / die casting",
          forging: "Forging",
          paint_shop: "Paint shop / surface treatment",
          // `unknown` ("Koi aur shop") has no entry ON PURPOSE.
        },
      },
      {
        from: "prod_daily_work",
        rank: 31,
        label: "Daily work",
        kind: "ticks",
        values: {
          plan_vs_actual: "Daily plan vs actual",
          manpower_planning: "Manpower & shift planning",
          rejection_control: "Rejection & rework control",
          downtime_followup: "Downtime / breakdown follow-up",
          cross_dept_coordination: "Coordination with PPC, quality & maintenance",
          production_mis: "Production MIS / daily reports",
          line_balancing: "Line balancing",
          changeover_planning: "Changeover planning",
        },
      },
      {
        from: "prod_erp_system",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Systems",
        kind: "chips",
        values: {
          sap_pp: "SAP PP",
          sap_business_one: "SAP Business One",
          oracle: "Oracle ERP",
          ms_dynamics: "Microsoft Dynamics / Navision",
          infor_baan: "Infor LN / BaaN",
          other_erp: "In-house ERP",
          excel: "MS Excel (pivot, VLOOKUP)",
          // `unknown` ("Koi system nahi") has no entry ON PURPOSE.
        },
      },
      {
        from: "prod_manpower_handled",
        rank: 41,
        label: "Workmen handled",
        kind: "fact",
        // KEYED BY THE STORED VALUE — the pack's `value_text` is the numeric string ("25",
        // "50", "100", "250", "500"), never the option key.
        values: {
          "25": "Up to 25 workmen",
          "50": "26–50 workmen",
          "100": "51–100 workmen",
          "250": "101–250 workmen",
          "500": "Over 250 workmen",
        },
      },
      {
        from: "prod_documents_owned",
        rank: 32,
        label: "Documents owned",
        kind: "ticks",
        values: {
          dpr: "Daily production report (DPR)",
          hourly_sheet: "Hourly monitoring sheets",
          oee_sheet: "OEE sheets",
          rejection_report: "Rejection & rework reports",
          skill_matrix: "Skill matrix",
          work_instruction: "Work instructions, SOPs & OPLs",
          four_m_change: "4M change records",
          handover_register: "Shift handover registers",
        },
      },
      {
        from: "drawing_reading",
        rank: 43,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — the turner-map precedent: a true
        // negative belongs in matching data, not on the worker's own marketing document.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "sector_worked",
        rank: 71,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automotive",
          two_wheeler: "Two-wheeler",
          general_engg: "General engineering",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractors & agri equipment",
          construction_equipment: "Construction equipment",
          defence: "Defence / aerospace",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_customer_served",
        rank: 72,
        maxValues: 4,
        label: "Customers served",
        kind: "chips",
        values: {
          maruti: "Maruti Suzuki",
          hero: "Hero MotoCorp",
          honda: "Honda (HMSI / Honda Cars)",
          tata: "Tata Motors",
          mahindra: "Mahindra",
          bajaj_tvs: "Bajaj / TVS",
          jcb: "JCB",
          export: "Export customers",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_metrics_tracked",
        rank: 33,
        label: "Metrics tracked",
        kind: "ticks",
        values: {
          oee: "OEE",
          schedule_adherence: "Schedule adherence (plan vs actual)",
          rejection_ppm: "Rejection PPM / percentage",
          downtime: "Downtime hours",
          productivity: "Per-man output (productivity)",
          rework: "Rework percentage",
          scrap_yield: "Scrap & yield",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_improvement_work",
        rank: 34,
        label: "Improvement work",
        kind: "ticks",
        values: {
          kaizen: "Kaizen",
          five_s: "5S",
          tpm: "TPM (JH / Kobetsu Kaizen)",
          smed: "SMED / changeover reduction",
          cycle_time_reduction: "Cycle-time reduction",
          poka_yoke: "Poka-yoke",
          qc_circle: "QC circles",
          lean_six_sigma: "Lean / Six Sigma projects",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_quality_system",
        rank: 35,
        label: "Quality system",
        kind: "ticks",
        values: {
          iatf_audit: "IATF 16949 audits (own area)",
          customer_audit: "Customer audits (Maruti, Hero, Honda...)",
          eight_d_capa: "8D / CAPA",
          why_why: "Why-why analysis",
          control_plan: "Control-plan-based line running",
          layered_audit: "Layered process audits",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 36,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          material_shortage: "Material shortage replanning",
          breakdown_reroute: "Breakdown load re-routing",
          absenteeism: "Rebalancing for absenteeism",
          quality_hold: "Quality-hold sorting & rework",
          tool_die_failure: "Tool / die failure handling",
          schedule_change: "Sudden customer schedule changes",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_cost_work",
        rank: 37,
        label: "Cost work",
        kind: "ticks",
        values: {
          cost_per_piece: "Cost per piece",
          consumable_budget: "Tool & consumable budgets",
          overtime_control: "Overtime control",
          copq: "Scrap & rejection cost (COPQ)",
          energy_cost: "Power / energy per piece",
          contract_manpower_cost: "Contract manpower bills",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "prod_people_work",
        rank: 38,
        label: "People work",
        kind: "ticks",
        values: {
          skill_matrix: "Skill matrix & training plans",
          shift_roster: "Shift rosters",
          supervisor_review: "Supervisor & line-leader reviews",
          leave_overtime_approval: "Leave & overtime approvals",
          discipline_ir: "Discipline / IR cases",
          union_handling: "Union / works-committee dealings",
          contractor_handling: "Contractor manpower handling",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T47 — PROCESS / MANUFACTURING ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T47's headline
  // (`Process / Manufacturing Engineer · {level} · {experience} · {proc_function} ·
  // {proc_process_type} · {city}`) is the parity reference. Function and process lead (the hire
  // is for the method he owns), then the documents he writes, the software he runs and the senior
  // rows. Every `values` key is the STORED value; `unknown` escape chips and the `none` negative
  // have no entry.
  {
    pack_id: "qp_process_engineer",
    section_title: "Processes, systems & responsibility",
    tier_section_titles: { easy: "Processes & systems" },
    capability: [
      {
        from: "proc_function",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Functions",
        kind: "chips",
        values: {
          process_planning: "Process planning & routing",
          industrial_engg: "Industrial engineering (time study, manpower)",
          tooling_fixture: "Tooling & jigs-fixtures",
          new_line_setup: "New line / machine setup",
          tool_optimisation: "Cutting-tool & parameter optimisation",
          layout_capacity: "Layout & capacity planning",
          lca_poka_yoke: "Low-cost automation & poka-yoke",
          cost_reduction_vave: "Cost reduction / VAVE",
        },
      },
      {
        from: "proc_process_type",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Processes",
        kind: "chips",
        values: {
          machining: "Machining (CNC / VMC / HMC)",
          press_sheet_metal: "Press & sheet metal",
          welding: "Welding (MIG, spot, robot)",
          assembly: "Assembly",
          moulding: "Injection moulding",
          casting: "Casting / die casting",
          forging: "Forging",
          surface_heat_treatment: "Painting, plating / heat treatment",
          // `unknown` ("Koi aur process") has no entry ON PURPOSE.
        },
      },
      {
        from: "proc_documents_owned",
        rank: 31,
        label: "Documents owned",
        kind: "ticks",
        values: {
          pfd: "Process flow diagrams (PFD)",
          pfmea: "PFMEA",
          control_plan: "Control plans",
          process_sheet: "Process / operation sheets",
          sop_work_instruction: "SOPs / work instructions",
          tooling_list: "Tooling lists / tool layouts",
          layout_drawing: "Plant layout drawings",
          capacity_sheet: "Capacity sheets",
        },
      },
      {
        from: "proc_software",
        rank: 41,
        maxValues: 4,
        label: "Software",
        kind: "chips",
        values: {
          autocad: "AutoCAD",
          solidworks: "SolidWorks",
          catia_nx: "CATIA / NX",
          creo: "Creo",
          sap_pp: "SAP PP (routing, BOM)",
          excel: "MS Excel (pivot, VLOOKUP)",
          minitab: "Minitab",
          ms_project: "MS Project",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "drawing_reading",
        rank: 43,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — the turner-map precedent.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "proc_six_sigma_belt",
        rank: 44,
        label: "Six Sigma",
        kind: "fact",
        values: {
          black_belt: "Six Sigma Black Belt",
          green_belt: "Six Sigma Green Belt",
          yellow_belt: "Six Sigma Yellow Belt",
          project_only: "Six Sigma project (no certificate)",
          // `none` ("Koi belt nahi") has no entry — same rule as `drawing_reading: "none"`.
        },
      },
      {
        from: "proc_time_study",
        rank: 32,
        label: "Time study & capacity",
        kind: "ticks",
        values: {
          stopwatch_study: "Stopwatch cycle-time study",
          takt_time: "Takt time",
          line_balancing: "Line balancing (Yamazumi)",
          manpower_calc: "Manpower calculation",
          most_mtm: "MOST / MTM standard time",
          capacity_calc: "Machine capacity calculation",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "proc_tooling_work",
        rank: 33,
        label: "Tooling & fixtures",
        kind: "ticks",
        values: {
          fixture_concept: "Jig-fixture concept design",
          fixture_development: "Fixture development via tool room / vendors",
          tool_selection: "Insert, drill & tap grade selection",
          tool_life_trial: "Tool-life trials",
          parameter_optimisation: "Speed & feed optimisation",
          gauge_planning: "Gauge & checking-fixture planning",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 71,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile parts",
          two_wheeler: "Two-wheeler",
          general_engg: "General engineering",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractors & agri equipment",
          construction_equipment: "Construction equipment",
          defence: "Defence / aerospace",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "proc_new_line_work",
        rank: 34,
        label: "New line work",
        kind: "ticks",
        values: {
          machine_spec: "Machine specifications",
          machine_buyoff: "Vendor machine buy-offs",
          installation: "Installation & commissioning",
          capability_trial: "Machine capability (Cm, Cmk) trials",
          layout_design: "Layouts",
          capex_proposal: "Capex proposals & ROI",
          line_shifting: "Line shifting",
          // `unknown` ("Abhi tak nahi kiya") has no entry.
        },
      },
      {
        from: "proc_improvement_work",
        rank: 35,
        label: "Improvement work",
        kind: "ticks",
        values: {
          kaizen: "Kaizen",
          poka_yoke: "Poka-yoke",
          low_cost_automation: "Low-cost automation",
          vave: "VAVE / cost reduction",
          smed: "SMED",
          cycle_time_reduction: "Cycle-time reduction",
          lean_vsm: "Lean (VSM)",
          six_sigma_project: "Six Sigma (DMAIC) projects",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "proc_quality_system",
        rank: 36,
        label: "Quality system",
        kind: "ticks",
        values: {
          apqp_ppap: "APQP & PPAP documentation",
          process_capability: "Process capability (Cp, Cpk) studies",
          msa: "MSA / gauge R&R",
          four_m_change: "4M change management",
          iatf_audit: "IATF 16949 audits",
          customer_audit: "Customer audits (Maruti, Hero, Honda...)",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 37,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          cycle_time_high: "High cycle time",
          tool_life_low: "Premature tool wear / breakage",
          low_cpk: "Low Cpk / size variation",
          fixture_issue: "Fixture seating issues",
          bottleneck: "Bottleneck stations",
          high_rejection: "Rising rejection",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T48 — NPD / DEVELOPMENT ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T48's headline
  // (`NPD / Development Engineer · {level} · {experience} · {npd_part_process} ·
  // {npd_customer_served} · {city}`) is the parity reference. NOTE THE HEADLINE OMITS
  // `npd_function` — the part family and the customer lead, not the work list — so `inHeadline`
  // sits on the part-process chips and the customer fact, and `npd_function` ranks 21 WITHOUT it.
  // Every `values` key is the STORED value; `unknown` escape chips and the `none` negatives have
  // no entry.
  {
    pack_id: "qp_npd_engineer",
    section_title: "Parts, development & responsibility",
    tier_section_titles: { easy: "Parts & development" },
    capability: [
      {
        from: "npd_function",
        rank: 21,
        maxValues: 4,
        label: "Development work",
        kind: "chips",
        values: {
          rfq_costing: "RFQ feasibility & costing",
          apqp_timing: "APQP timing-plan follow-up",
          tooling_development: "Tooling, die / mould development",
          gauge_fixture_development: "Gauge & fixture development",
          sample_prototype: "Sample / prototype development",
          ppap_submission: "PPAP documentation & submission",
          customer_communication: "Customer technical coordination",
          testing_validation: "Testing & validation",
          vendor_part_development: "BOP / vendor part development",
        },
      },
      {
        from: "npd_part_process",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Parts developed",
        kind: "chips",
        values: {
          machined: "Machined parts",
          sheet_metal: "Sheet-metal / press parts",
          plastic: "Plastic moulded parts",
          casting: "Casting / die-casting parts",
          forging: "Forged parts",
          rubber: "Rubber parts",
          weld_assembly: "Welded / fabricated assemblies",
          electrical: "Electrical parts / wiring harness",
          // `unknown` ("Koi aur part") has no entry ON PURPOSE.
        },
      },
      {
        from: "npd_documents_owned",
        rank: 31,
        label: "Documents owned",
        kind: "ticks",
        values: {
          apqp_plan: "APQP timing plans",
          feasibility_report: "Feasibility reports (TFC)",
          fmea: "DFMEA / PFMEA",
          control_plan: "Control plans",
          psw: "PSWs (part submission warrants)",
          ecn: "ECNs / drawing-change records",
          bom: "BOMs",
          cost_sheet: "Cost sheets / quotations",
        },
      },
      {
        from: "npd_software",
        rank: 41,
        maxValues: 4,
        label: "Software",
        kind: "chips",
        values: {
          autocad: "AutoCAD",
          solidworks: "SolidWorks",
          catia: "CATIA",
          nx: "NX / Unigraphics",
          creo: "Creo",
          sap: "SAP (BOM, material master)",
          excel: "MS Excel",
          ms_project: "MS Project",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "drawing_reading",
        rank: 43,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — the turner-map precedent.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "npd_customer_served",
        rank: 71,
        inHeadline: true,
        label: "Customers served",
        kind: "fact",
        join: ", ",
        values: {
          maruti: "Maruti Suzuki",
          hero: "Hero MotoCorp",
          honda: "Honda (HMSI / Honda Cars)",
          tata: "Tata Motors",
          mahindra: "Mahindra",
          bajaj_tvs: "Bajaj / TVS",
          jcb: "JCB",
          export: "Export customers",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 72,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobiles (cars, commercial vehicles)",
          two_wheeler: "Two-wheeler",
          general_engg: "General engineering",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractors & agri equipment",
          construction_equipment: "Construction equipment",
          defence: "Defence / aerospace",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "npd_projects_handled",
        rank: 42,
        label: "New parts a year",
        kind: "fact",
        // KEYED BY THE STORED VALUE — the pack's `value_text` is the numeric string ("5",
        // "15", "30", "50"), never the option key.
        values: {
          "5": "Up to 5 new parts a year",
          "15": "6–15 new parts a year",
          "30": "16–30 new parts a year",
          "50": "Over 30 new parts a year",
        },
      },
      {
        from: "npd_trial_work",
        rank: 32,
        label: "Tooling trials",
        kind: "ticks",
        values: {
          tool_trial: "T0 / T1 trials",
          trial_report: "Trial reports & correction lists",
          layout_inspection: "Sample layout inspection",
          tool_correction: "Tool-room / vendor corrections",
          pilot_lot: "Pilot lots",
          production_handover: "Handover to production",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "npd_costing_work",
        rank: 44,
        label: "Costing",
        kind: "fact",
        values: {
          // `none` ("Costing nahi karta") has no entry — the drawing_reading: "none" precedent.
          rm_cost: "RM weight & cost working",
          full_cost_sheet: "Full cost sheets (RM, process, tooling)",
          price_negotiation: "Customer price negotiation",
        },
      },
      {
        from: "npd_tooling_source",
        rank: 33,
        label: "Tooling sourced from",
        kind: "chips",
        values: {
          inhouse_tool_room: "In-house tool room",
          local_vendor: "Local tool-room vendors",
          import_tooling: "Imported tooling (China, Taiwan, Korea)",
          customer_supplied: "Customer-supplied tools",
          // `unknown` ("Tooling ka kaam main nahi dekhta") has no entry.
        },
      },
      {
        from: "npd_ppap_work",
        rank: 34,
        label: "PPAP work",
        kind: "ticks",
        values: {
          dimensional_report: "Dimensional layout reports",
          test_reports: "Material & performance test reports",
          msa: "MSA / gauge R&R",
          process_capability: "Initial process capability (Cp, Cpk)",
          pfmea_control_plan: "PFD, PFMEA & control plans",
          psw_approval: "Customer PSW approvals",
          imds: "IMDS entries",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "npd_validation_tests",
        rank: 35,
        label: "Validation tests",
        kind: "ticks",
        values: {
          endurance: "Endurance / durability tests",
          salt_spray: "Salt-spray tests",
          leak_test: "Leak tests",
          cmm_dimensional: "CMM dimensional checks",
          material_test: "Hardness & material tests",
          fitment_trial: "Customer fitment trials",
          vibration: "Vibration tests",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 36,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          dimension_out: "Trial dimension-outs",
          tooling_delay: "Tooling delays",
          ecn_change: "Customer drawing changes (ECN)",
          sample_rejection: "Sample rejections",
          cost_overrun: "Cost overruns",
          vendor_part_failure: "Vendor part failures",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T52 — PPC / PRODUCTION PLANNING ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T52's headline
  // (`PPC / Production Planning Engineer · {level} · {experience} · {ppc_function} · {ppc_erp_system}
  // · {city}`) is the parity reference. Function and ERP lead (the hire is for the plan he can
  // own), then Excel, the plans he writes and the senior rows. Every `values` key is the STORED
  // value; `unknown` escape chips and the `followup_only` non-plan have no entry.
  {
    pack_id: "qp_ppc",
    section_title: "Planning, systems & responsibility",
    tier_section_titles: { easy: "Planning & systems" },
    capability: [
      {
        from: "ppc_function",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Planning functions",
        kind: "chips",
        values: {
          production_planning: "Production planning & scheduling",
          material_planning: "Material planning (RM / BOP)",
          dispatch_planning: "Dispatch planning",
          jobwork_planning: "Job-work / subcontract planning",
          inventory_control: "Inventory & WIP control",
          customer_schedule: "Customer schedule follow-up",
          mis_reporting: "PPC MIS & reporting",
        },
      },
      {
        from: "ppc_erp_system",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "ERP / systems",
        kind: "chips",
        values: {
          sap_pp: "SAP PP",
          sap_mm: "SAP MM",
          oracle: "Oracle ERP",
          ms_dynamics: "Microsoft Dynamics / Navision",
          infor_baan: "Infor LN / BaaN",
          tally: "Tally",
          inhouse_erp: "In-house ERP",
          excel_only: "Excel only",
          // `unknown` ("Koi aur ERP") has no entry ON PURPOSE.
        },
      },
      {
        from: "ppc_excel_skill",
        rank: 31,
        label: "Excel skills",
        kind: "ticks",
        values: {
          vlookup: "VLOOKUP / XLOOKUP",
          pivot_table: "Pivot tables",
          sumif_formula: "SUMIF / COUNTIF formulas",
          dashboard: "Charts & dashboards",
          macro_vba: "Macros / VBA",
          power_bi: "Power BI / Power Query",
          data_entry: "Data entry",
        },
      },
      {
        from: "ppc_plan_type",
        rank: 32,
        label: "Plans made",
        kind: "ticks",
        values: {
          monthly_plan: "Monthly production plans",
          weekly_plan: "Weekly plans",
          daily_plan: "Daily / shift plans",
          machine_loading: "Machine loading plans",
          procurement_plan: "RM / BOP procurement plans",
          dispatch_plan: "Dispatch plans",
          // `followup_only` ("Plan nahi banata, follow-up karta hoon") has no entry — a
          // stated non-plan is the drawing_reading: "none" precedent exactly.
        },
      },
      {
        from: "ppc_documents",
        rank: 33,
        label: "Documents owned",
        kind: "ticks",
        values: {
          plan_vs_actual: "Plan vs actual reports",
          daily_production_report: "Daily production reports (DPR)",
          shortage_list: "Shortage lists",
          stock_statement: "WIP / stock statements",
          dispatch_schedule: "Dispatch schedules",
          job_card: "Job cards / route cards",
          production_order: "Production orders (SAP / ERP)",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "ppc_plant_type",
        rank: 61,
        maxValues: 4,
        label: "Plants planned for",
        kind: "chips",
        values: {
          machine_shop: "Machine shop",
          press_shop: "Press shop / sheet metal",
          weld_shop: "Weld shop / fabrication",
          assembly: "Assembly line",
          moulding: "Plastic moulding",
          casting_forging: "Casting / forging",
          surface_treatment: "Paint, plating / heat treatment",
          // `unknown` ("Koi aur plant") has no entry.
        },
      },
      {
        from: "ppc_customer_schedule",
        rank: 41,
        label: "Schedule sources",
        kind: "ticks",
        values: {
          oem_portal: "OEM portals (Maruti, Hero, Honda...)",
          email_schedule: "Email monthly schedules",
          daily_calloff: "Daily call-offs / JIT schedules",
          po_based: "Make-to-order (PO-based)",
          sales_team: "Sales / marketing team schedules",
        },
      },
      {
        from: "ppc_material_planning",
        rank: 34,
        label: "Material planning",
        kind: "ticks",
        values: {
          mrp_run: "MRP runs",
          bom_requirement: "BOM-based requirements",
          purchase_requisition: "PRs / indents",
          vendor_followup: "Vendor RM / BOP follow-up",
          jobwork_stock: "Job-work vendor stock & challans",
          shortage_alert: "Advance shortage alerts",
          // `unknown` ("Yeh kaam nahi karta") has no entry.
        },
      },
      {
        from: "ppc_capacity_planning",
        rank: 35,
        label: "Capacity planning",
        kind: "ticks",
        values: {
          capacity_calculation: "Machine capacity calculation",
          cycle_time_loading: "Cycle-time-based loading",
          manpower_planning: "Manpower requirement planning",
          overtime_plan: "Overtime / extra-shift plans",
          bottleneck: "Bottleneck identification",
          tooling_availability: "Tool / die availability checks",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "ppc_inventory_control",
        rank: 36,
        label: "Inventory control",
        kind: "ticks",
        values: {
          wip_tracking: "WIP tracking",
          min_max: "Min-max / safety-stock levels",
          kanban: "Kanban",
          fifo: "FIFO",
          abc_analysis: "ABC analysis",
          stock_verification: "Physical stock verification",
          non_moving: "Non-moving stock reports",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 71,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile parts",
          two_wheeler: "Two-wheeler parts",
          general_engg: "General engineering",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractors / agri parts",
          fasteners: "Fasteners",
          fmcg: "FMCG / packaging",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 37,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          material_shortage: "Material shortages",
          breakdown_replan: "Breakdown replanning",
          schedule_change: "Urgent customer schedule changes",
          vendor_delay: "Late vendor supplies",
          rejection_shortage: "Rejection-driven shortages",
          manpower_shortage: "Manpower shortages",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "ppc_kpi_reporting",
        rank: 38,
        label: "KPIs reported",
        kind: "ticks",
        values: {
          plan_adherence: "Plan adherence",
          on_time_delivery: "On-time delivery (OTD)",
          inventory_turns: "Inventory days / turns",
          line_stoppage: "Customer line stoppages",
          premium_freight: "Premium freight",
          capacity_utilisation: "Capacity utilisation / OEE",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "ppc_improvement_work",
        rank: 39,
        label: "Improvement work",
        kind: "ticks",
        values: {
          kaizen: "Kaizen",
          five_s: "5S",
          inventory_reduction: "Inventory reduction projects",
          kanban_implementation: "Kanban / pull systems",
          lean_vsm: "Lean / VSM",
          erp_implementation: "SAP / ERP implementation",
          iatf_audit: "IATF 16949 audits (PPC)",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
  // ══ CEO PACK V2, T54 — PURCHASE / VENDOR DEVELOPMENT ENGINEER (#3012): DESK-TRADE MAP ══
  //
  // NO RATIFIED PAGE: sheet T54's headline
  // (`Purchase / Vendor Development Engineer · {level} · {experience} · {purchase_function} ·
  // {purchase_category} · {city}`) is the parity reference. Function and bought category lead
  // (the hire is for what he buys), then the documents, the costing and vendor work, and the
  // senior rows. Every `values` key is the STORED value; `unknown` escape chips and the `none`
  // negative have no entry.
  {
    pack_id: "qp_purchase",
    section_title: "Purchase work, categories & responsibility",
    tier_section_titles: { easy: "Purchase work & categories" },
    capability: [
      {
        from: "purchase_function",
        rank: 21,
        inHeadline: true,
        maxValues: 4,
        label: "Purchase functions",
        kind: "chips",
        values: {
          po_followup: "POs & follow-up",
          rfq_negotiation: "RFQs & rate negotiation",
          vendor_development: "New vendor search & development",
          npd_sourcing: "NPD sourcing / new-part development",
          jobwork_outsourcing: "Job-work / outsourcing",
          import_purchase: "Import purchase",
          capex_purchase: "Capex / machine purchase",
          payment_followup: "Vendor bill & payment follow-up",
        },
      },
      {
        from: "purchase_category",
        rank: 22,
        inHeadline: true,
        maxValues: 4,
        label: "Categories bought",
        kind: "chips",
        values: {
          raw_material: "Raw material (steel, aluminium, plastic granules)",
          casting_forging: "Castings & forgings",
          machined_parts: "Machined parts",
          sheet_metal: "Sheet-metal parts",
          plastic_rubber: "Plastic & rubber parts",
          bought_out: "Bought-outs, hardware & bearings",
          tooling: "Tooling, dies & fixtures",
          consumables: "Consumables, packing & MRO",
          electrical_parts: "Electrical / electronic parts",
        },
      },
      {
        from: "purchase_erp_system",
        rank: 71,
        maxValues: 4,
        label: "ERP / systems",
        kind: "chips",
        values: {
          sap_mm: "SAP MM",
          oracle: "Oracle ERP",
          ms_dynamics: "Microsoft Dynamics / Navision",
          infor_baan: "Infor LN / BaaN",
          tally: "Tally",
          inhouse_erp: "In-house ERP",
          excel_only: "Excel & email",
          // `unknown` ("Koi aur ERP") has no entry ON PURPOSE.
        },
      },
      {
        from: "purchase_documents",
        rank: 31,
        label: "Documents owned",
        kind: "ticks",
        values: {
          rfq: "RFQs / enquiries",
          comparative_statement: "Comparative statements",
          purchase_order: "Purchase orders",
          delivery_schedule: "Delivery schedules",
          rate_contract: "Rate contracts",
          jobwork_order: "Job-work orders",
          vendor_registration: "Vendor registration forms",
          debit_note: "Debit notes",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "drawing_reading",
        rank: 43,
        label: "Drawings",
        kind: "fact",
        // `none` ("Nahi padh pata") has no entry ON PURPOSE — the turner-map precedent.
        values: {
          basic_drawing: "Reads 2D drawings",
          gdt: "Reads 2D drawings and GD&T",
        },
      },
      {
        from: "purchase_vendor_count",
        rank: 42,
        label: "Vendors handled",
        kind: "fact",
        values: {
          below_ten: "Under 10 vendors",
          ten_to_thirty: "10–30 vendors",
          thirty_to_seventy_five: "30–75 vendors",
          above_seventy_five: "Over 75 vendors",
        },
      },
      {
        from: "purchase_costing",
        rank: 32,
        label: "Costing work",
        kind: "ticks",
        values: {
          rm_costing: "RM rate & weight costing",
          process_costing: "Machine-hour-rate process costing",
          should_cost: "Should-cost / zero-based costing",
          cost_breakup: "Vendor cost break-ups",
          price_revision: "RM-linked price revisions",
          tooling_cost: "Tooling cost & amortisation",
          quotation_compare: "Three-quote comparison",
          // No `unknown` chip on this question — every option is a positive claim.
        },
      },
      {
        from: "purchase_vendor_development",
        rank: 33,
        label: "Vendor development",
        kind: "ticks",
        values: {
          vendor_search: "New vendor search",
          vendor_assessment: "Vendor plant visits & assessment",
          sample_development: "Sample development & trials",
          supplier_ppap: "Supplier PPAPs",
          vendor_rating: "Vendor ratings",
          vendor_audit: "Vendor audits",
          tooling_development: "Tooling / gauges at vendors",
          // `unknown` ("Yeh kaam nahi karta") has no entry.
        },
      },
      {
        from: "purchase_commercial_terms",
        rank: 34,
        label: "Commercial terms",
        kind: "ticks",
        values: {
          payment_terms: "Payment terms",
          msme_payment: "MSME 45-day payments",
          gst_basics: "GST, HSN & input credit",
          freight_terms: "Freight & delivery terms",
          rate_contract: "Rate contracts / AMCs",
          bill_passing: "Bill passing follow-up with accounts",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "purchase_import_work",
        rank: 35,
        label: "Import work",
        kind: "ticks",
        values: {
          incoterms: "Incoterms (FOB, CIF, EXW)",
          lc_remittance: "LC / advance remittance",
          cha_coordination: "CHA / forwarder coordination",
          bill_of_entry: "Bills of entry & customs clearance",
          duty_calculation: "HS codes & duty working",
          // `unknown` ("Import nahi kiya") has no entry.
        },
      },
      {
        from: "purchase_annual_value",
        rank: 44,
        label: "Annual purchase value",
        kind: "fact",
        values: {
          below_one_crore: "Under ₹1 crore a year",
          one_to_ten_crore: "₹1–10 crore a year",
          ten_to_fifty_crore: "₹10–50 crore a year",
          above_fifty_crore: "Over ₹50 crore a year",
          // `unknown` ("Pata nahi") has no entry.
        },
      },
      {
        from: "sector_worked",
        rank: 72,
        label: "Sector worked",
        kind: "fact",
        join: ", ",
        values: {
          automotive: "Automobile parts",
          two_wheeler: "Two-wheeler parts",
          general_engg: "General engineering",
          spm_parts: "SPM / machine building",
          appliances: "Home appliances",
          electronics: "Electronics / EMS",
          agri: "Tractors / agri parts",
          pump_valve: "Pumps & valves",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "troubleshooting",
        rank: 36,
        label: "Troubleshooting",
        kind: "ticks",
        values: {
          late_delivery: "Late vendor deliveries",
          incoming_rejection: "Incoming rejections",
          price_increase: "Vendor price-hike demands",
          capacity_shortage: "Vendor capacity shortfalls",
          payment_hold: "Payment-hold supply stops",
          alternate_source: "Alternate-source development",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
      {
        from: "purchase_improvement_work",
        rank: 37,
        label: "Improvement work",
        kind: "ticks",
        values: {
          cost_reduction: "Cost reduction / VAVE",
          localisation: "Localisation (import substitution)",
          vendor_consolidation: "Vendor consolidation",
          vmi_kanban: "VMI / kanban supplies",
          iatf_audit: "IATF 16949 / ISO audits (purchase)",
          erp_implementation: "SAP / ERP implementation",
          // `unknown` ("Inme se koi nahi") has no entry.
        },
      },
    ],
  },
];

export function tradeResumeMapFor(packId: string | null | undefined): TradeResumeMap | undefined {
  return packId ? TRADE_RESUME_MAPS.find((m) => m.pack_id === packId) : undefined;
}

/** The shape a worker's captured attributes arrive in. */
export type WorkerAttributeValues = Readonly<Record<string, unknown>>;

/**
 * Normalise one captured attribute to the list of slugs it selected.
 *
 * A `multi_select` lands as a string array and a `single_select` as a bare string, because
 * `answer-capture.ts` wraps only the former — so both shapes are real and both arrive here.
 */
function slugsOf(raw: unknown): string[] {
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return [];
}

/**
 * The Verdict Line's fourth-segment values contributed by ONE row (R16 §1).
 *
 * EXPORTED AND PURE BECAUSE THE OPT-IN IS OTHERWISE UNTESTABLE. `qp_vmc_milling` is the only
 * shipped map that uses `configFrom` at all, so deleting the `configInHeadline` check changes no
 * output and every test stays green — mutation-verified, and it survived. That is the
 * `MEASURING_TOOLS` shape exactly: a rule that cannot be contradicted by the data that exists.
 * A synthetic spec can contradict it, so the rule is checked here rather than believed.
 *
 * ITERATED DICTIONARY-FIRST, like `values` in the builder and for the same reason: reading the
 * worker's answer order prints "4 & 3-axis" for a man who tapped the four-axis chip first, and
 * `axesPhrase` compresses it just as happily — so the sheet looks deliberate while being
 * backwards.
 */
export function headlineAxesFor(spec: TradeRowSpec, attributes: WorkerAttributeValues): string[] {
  if (!spec.configInHeadline || !spec.configFrom) return [];
  const chosen = new Set(slugsOf(attributes[spec.configFrom]));
  return Object.entries(spec.configValues ?? {})
    .filter(([slug]) => chosen.has(slug))
    .map(([, label]) => label);
}

export interface TradeCapabilityRows {
  /**
   * The first section's heading, or null when no map matched.
   *
   * NULL RATHER THAN A GENERIC FALLBACK. If the pack is unknown there are no rows either, so the
   * section collapses entirely — a heading with nothing under it is the exact failure the
   * data-driven rows exist to prevent, and inventing "Capability" here would resurrect it.
   */
  readonly sectionTitle: string | null;
  /**
   * The values for the Verdict Line's third segment, from the row flagged `inHeadline`.
   *
   * EMPTY WHEN THE ROW WAS DROPPED OR NEVER ANSWERED, and the caller falls back rather than
   * printing a headline with a hole in it.
   */
  readonly headlineTools: string[];
  /**
   * The Verdict Line's FOURTH segment, from rows flagged `configInHeadline` (R16 §1).
   *
   * SEPARATE FROM `headlineTools` BECAUSE THE SEGMENTS ARE SEPARATE. `buildVerdictLine` composes
   * "role · years · tools · axes", and `axesPhrase` compresses a shared suffix — "3-axis" and
   * "4-axis" become "3 & 4-axis" — which only works on values that are axes. Folding them into
   * `headlineTools` would print "Fanuc, Siemens, 3-axis" and lose the compression.
   *
   * EMPTY FOR EVERY PACK THAT ASKS NO CONFIGURATION, including the turner's, and the segment then
   * collapses with its separator.
   */
  readonly headlineAxes: string[];
  /**
   * The Verdict Line's LAST segment (Middle Way P5) — the worker's rung on this trade's
   * ladder ("Setter", "Senior Programmer"), from the pack's level answer.
   *
   * NULL WHEN THE WORKER STATED NO RUNG, and the segment collapses with its separator
   * exactly like every absent segment here. Read off the stored answer through the C6
   * crosswalk, never off a pack chip: the headline and the persisted `trade_level`
   * are two renderings of one fact and cannot disagree.
   */
  readonly headlineLevel: string | null;
  readonly chipRows: ResumeListRow[];
  readonly tickRows: ResumeListRow[];
  readonly factRows: ResumeFactRow[];
}

/**
 * Build the capability rows for one worker. PURE — no I/O, no clock, no DI.
 *
 * A ROW APPEARS ONLY IF IT HAS VALUES. That is the whole reason rows are data rather than fixed
 * template slots: "does this row exist" is decided here, where it is one testable line, instead of
 * by a CSS `:empty` rule that has to behave identically in WeasyPrint.
 *
 * Values are emitted in the MAP's order, not the worker's selection order, so two turners with the
 * same skills produce the same sheet and a diff between two renders means something changed.
 */
/**
 * "VMC" + ["3-axis", "4-axis"] -> ["VMC · 3-axis", "VMC · 4-axis", ...rest].
 *
 * THE FIRST CHIP ONLY, and the rest pass through untouched. A cross product would manufacture
 * combinations the worker never claimed — "SPM · 4-axis" for a man who runs a 4-axis VMC and a
 * separate SPM — which is the fabrication this file's second rule forbids by name.
 */
export function appendConfiguration(
  values: readonly string[],
  configSlugs: readonly string[],
  dictionary: Readonly<Record<string, string>>,
): string[] {
  // DICTIONARY ORDER, NOT THE WORKER'S ANSWER ORDER (R16 §1).
  //
  // This read the worker's stored slug order, so a man who tapped four-axis before three-axis
  // got the chips "VMC · 4-axis", "VMC · 3-axis". That was survivable while the labels only
  // appeared here — but the Verdict Line's axis segment now reads the SAME dictionary and is
  // ordered by it, so the two would have printed one fact two ways on one page: chips
  // descending, headline compressed to "3 & 4-axis". Same rule as `values` in the builder, and
  // the same reason it is stated there: determinism is what makes a sheet diffable.
  const configs = Object.keys(dictionary)
    .filter((slug) => configSlugs.includes(slug))
    .map((slug) => dictionary[slug])
    .filter((v): v is string => Boolean(v));
  if (configs.length === 0 || values.length === 0) return [...values];
  const [first, ...rest] = values;
  return [...configs.map((c) => `${first} · ${c}`), ...rest];
}

/**
 * The English this row would actually print for these answers — [] when it would print nothing.
 *
 * ONE EXPRESSION, TWO CALLERS, AND THAT IS THE POINT. The budget filter and the row builder both
 * have to answer "does this row print?", and while they answered it differently — "was it
 * answered" for the budget, "does the dictionary know the value" for the build — a row could
 * spend a slot and then render empty. Deriving both from this function makes that shape
 * unrepresentable rather than merely fixed.
 *
 * Iterates the DICTIONARY, not the worker's answer, so the order is the map's and every slug with
 * no reviewed English label is dropped (every `unknown` from a none-of-above chip, an answer the
 * map deliberately leaves unlabelled under §8.3, and any value a later pack version adds before
 * this map catches up).
 */
function printableValues(
  spec: TradeRowSpec,
  attributes: WorkerAttributeValues,
  otherAnswers: OtherAnswerItems,
): string[] {
  // #2409 — THE WORKER'S OWN TYPED ANSWER, REVIEWED, REPLACES THE ROW. The form keeps one value
  // per question and a typed "Koi aur — khud likhein" answer clears the ticks, so the reviewed
  // names are the whole of his current answer — a stale attribute row for the same question is
  // not. Capped like any other row; an empty list from a settled review prints nothing.
  const own = otherAnswers[spec.from];
  if (own !== undefined) return own.slice(0, spec.maxValues ?? Number.MAX_SAFE_INTEGER);
  const selected = new Set(slugsOf(attributes[spec.from]));
  if (selected.size === 0) return [];
  return (
    Object.entries(spec.values ?? {})
      .filter(([slug]) => selected.has(slug))
      .map(([, label]) => label)
      // §4.3 states the caps per row (machines 4, controllers 3, materials 4). Applied AFTER the
      // dictionary filter, so a capped row shows the first N values the worker actually selected
      // rather than the first N the dictionary happens to list.
      .slice(0, spec.maxValues ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * A worker's reviewed "Koi aur — khud likhein" answers, by question key: the cleaned names the
 * review let print (#2409). WORKER'S OWN COPY ONLY — the caller passes nothing on a payer render.
 */
export type OtherAnswerItems = Readonly<Record<string, readonly string[]>>;

export function buildTradeCapabilityRows(
  packId: string | null | undefined,
  attributes: WorkerAttributeValues,
  otherAnswers: OtherAnswerItems = {},
): TradeCapabilityRows {
  const map = tradeResumeMapFor(packId);
  const chipRows: ResumeListRow[] = [];
  const tickRows: ResumeListRow[] = [];
  const factRows: ResumeFactRow[] = [];
  const headlineTools: string[] = [];
  const headlineAxes: string[] = [];
  if (!map)
    return {
      sectionTitle: null,
      headlineTools,
      headlineAxes,
      headlineLevel: null,
      chipRows,
      tickRows,
      factRows,
    };

  // THE BUDGET IS APPLIED BEFORE ANYTHING IS BUILT, and the two orderings are kept apart on
  // purpose. Which rows SURVIVE is decided by `rank` (§5.1 decisiveness); the order they RENDER in
  // is the array's, because §7.1 makes field order invariant across skins and roles. Sorting the
  // output by rank would silently reorder the locked sheet, so the survivors are re-sorted back to
  // their declared positions.
  //
  // A ROW SPENDS A SLOT ONLY IF IT CAN PRINT. This used to filter on "did he answer this
  // question", and the dictionary filter ran afterwards — so an answer with no reviewed label
  // (`drawing_check_work: "check_none"`, `simulation_work: "none"`, any bare `unknown`) occupied
  // one of the section's slots and then rendered nothing, pushing a LOWER-ranked row that did have
  // values off the sheet to pay for it. Measured on the CAD draughtsman: a senior answering
  // everything printed EIGHT rows against the budget with ten printable rows queueing. The
  // budget is a cap on what the page can hold, and a row that prints nothing occupies none of it.
  const affordable = map.capability
    // The declared position is captured BEFORE filtering — after it, a callback index is the
    // position in the filtered list, which would restore the survivors in the wrong order.
    .map((spec, i) => ({ spec, i }))
    .filter((e) => printableValues(e.spec, attributes, otherAnswers).length > 0)
    .sort((a, b) => a.spec.rank - b.spec.rank)
    .slice(0, CAPABILITY_ROW_BUDGET)
    .sort((a, b) => a.i - b.i)
    .map((e) => e.spec);

  for (const spec of affordable) {
    const values = printableValues(spec, attributes, otherAnswers);
    if (values.length === 0) continue;

    // R10 §2.5 rule 3 — the configuration rides the first chip, never its own row. NOT onto a
    // typed name: "Batliboi lathe · 4-axis" would pair two answers the worker never joined.
    const configured =
      spec.configFrom && otherAnswers[spec.from] === undefined
        ? appendConfiguration(values, slugsOf(attributes[spec.configFrom]), spec.configValues ?? {})
        : values;

    if (spec.inHeadline) headlineTools.push(...configured);
    // R16 §1 — the axis labels themselves, not the "VMC · 3-axis" chip they also ride on.
    headlineAxes.push(...headlineAxesFor(spec, attributes));

    // `key`/`rank` ride along for the degradation ladder (resume-degradation.ts), which needs to
    // shed the least decisive row first and must not re-derive the map to find out which that is.
    // The renderer ignores both.
    const provenance = { key: spec.from, rank: spec.rank };
    if (spec.kind === "fact") {
      factRows.push({
        label: spec.label,
        value: configured.join(spec.join ?? " · "),
        ...provenance,
      });
    } else if (spec.kind === "chips") {
      chipRows.push({ label: spec.label, values: configured, ...provenance });
    } else {
      tickRows.push({ label: spec.label, values: configured, ...provenance });
    }
  }
  // The heading is suppressed when the trade produced no rows at all: the template collapses the
  // section on emptiness, and a title is not content.
  const empty = chipRows.length === 0 && tickRows.length === 0 && factRows.length === 0;
  // Middle Way P5 — the rung for the LAST headline segment, read off the stored level
  // answer through the C6 crosswalk (same closed vocabulary the persist writes, so the
  // sheet and `trade_level` cannot disagree). Null when the worker stated no rung.
  const levelEntry = packId == null ? undefined : TRADE_LEVEL_PACKS[packId];
  const headlineLevel =
    levelEntry === undefined
      ? null
      : tradeLevelLabelFor(packId as string, attributes[levelEntry.levelKey]);
  return {
    sectionTitle: empty ? null : map.section_title,
    headlineTools,
    headlineAxes,
    headlineLevel,
    chipRows,
    tickRows,
    factRows,
  };
}
