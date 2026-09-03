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
          mazak: "Mazak",
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
        },
      },
      {
        from: "material_worked",
        rank: 61,
        maxValues: 4,
        label: "Materials",
        kind: "chips",
        // EN8 AND EN31 ARE SEPARATE CHIPS HERE. The ratified sheet prints "EN8  EN31" as two
        // values inside a four-value cap, and compressing them the way the turner's map does
        // would silently spend one chip on two materials and print a fifth where four fit.
        //
        // DICTIONARY ORDER IS THE SHEET'S ORDER. Values render in the order this object lists
        // them (there is no usage data to rank by, and inventing one would be inventing a fact
        // about the worker), so the alloys lead — which is what the ratified sample prints.
        values: {
          en_eight: "EN8",
          en_thirty_one: "EN31",
          mild_steel: "MS",
          stainless: "Stainless steel",
          aluminium: "Aluminium",
          cast_iron: "Cast iron",
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
          rotary_table: "Rotary table / indexer",
          angle_plate: "Angle plate",
          magnetic_chuck: "Magnetic chuck",
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
          "0.002": "±0.002 mm or finer",
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
function printableValues(spec: TradeRowSpec, attributes: WorkerAttributeValues): string[] {
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

export function buildTradeCapabilityRows(
  packId: string | null | undefined,
  attributes: WorkerAttributeValues,
): TradeCapabilityRows {
  const map = tradeResumeMapFor(packId);
  const chipRows: ResumeListRow[] = [];
  const tickRows: ResumeListRow[] = [];
  const factRows: ResumeFactRow[] = [];
  const headlineTools: string[] = [];
  const headlineAxes: string[] = [];
  if (!map)
    return { sectionTitle: null, headlineTools, headlineAxes, chipRows, tickRows, factRows };

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
    .filter((e) => printableValues(e.spec, attributes).length > 0)
    .sort((a, b) => a.spec.rank - b.spec.rank)
    .slice(0, CAPABILITY_ROW_BUDGET)
    .sort((a, b) => a.i - b.i)
    .map((e) => e.spec);

  for (const spec of affordable) {
    const values = printableValues(spec, attributes);
    if (values.length === 0) continue;

    // R10 §2.5 rule 3 — the configuration rides the first chip, never its own row.
    const configured = spec.configFrom
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
  return {
    sectionTitle: empty ? null : map.section_title,
    headlineTools,
    headlineAxes,
    chipRows,
    tickRows,
    factRows,
  };
}
