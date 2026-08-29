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
   * it its own row would spend one of nine slots restating what the machine chip already implies.
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
 * MEASURED FROM THE THREE RATIFIED SHEETS, not chosen: the VMC turner's sheet prints 9 rows in
 * this section, the welder's 9, the car mechanic's 6. Nine is the observed ceiling of the locked
 * design, so it is the budget.
 *
 * IT HAS TO EXIST BECAUSE A PACK CAN OUT-PRODUCE THE PAGE. `qp_cnc_turning` alone defines 14
 * capability rows, and a worker who answers everything fills all of them — which rendered a
 * two-page PDF, and "one page" is a product contract, not a target (§6.3). The guideline's answer
 * to overflow is truncation in the mapper, never shrinking type and never a second page.
 */
export const CAPABILITY_ROW_BUDGET = 9;

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
     * ROW COUNT AND THE Q2 REDLINE. Thirteen rows are defined and `CAPABILITY_ROW_BUDGET` is 9,
     * so four drop by rank. The nine that survive are NOT the nine the ratified sheet prints —
     * the sheet shows `Sector worked` and this map's rank order keeps `Workholding` instead. That
     * is a one-row divergence, it is measured rather than asserted (see the map's own test), and
     * it is evidence for Q2 rather than something to fix by inventing a rank. The tens digit is
     * the guideline's §5.1 rank, and bending it to make a page fit is exactly the substitution of
     * layout preference for trade truth that the turner's rank comment warns against.
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
        // row of its own would spend one of nine slots restating what the machine chip implies.
        // R10 built this seam for exactly this entry.
        configFrom: "axis_capability",
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
  const configs = configSlugs
    .map((slug) => dictionary[slug])
    .filter((v): v is string => Boolean(v));
  if (configs.length === 0 || values.length === 0) return [...values];
  const [first, ...rest] = values;
  return [...configs.map((c) => `${first} · ${c}`), ...rest];
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
  if (!map) return { sectionTitle: null, headlineTools, chipRows, tickRows, factRows };

  // THE BUDGET IS APPLIED BEFORE ANYTHING IS BUILT, and the two orderings are kept apart on
  // purpose. Which rows SURVIVE is decided by `rank` (§5.1 decisiveness); the order they RENDER in
  // is the array's, because §7.1 makes field order invariant across skins and roles. Sorting the
  // output by rank would silently reorder the locked sheet, so the survivors are re-sorted back to
  // their declared positions.
  const affordable = map.capability
    // The declared position is captured BEFORE filtering — after it, a callback index is the
    // position in the filtered list, which would restore the survivors in the wrong order.
    .map((spec, i) => ({ spec, i }))
    .filter((e) => slugsOf(attributes[e.spec.from]).length > 0)
    .sort((a, b) => a.spec.rank - b.spec.rank)
    .slice(0, CAPABILITY_ROW_BUDGET)
    .sort((a, b) => a.i - b.i)
    .map((e) => e.spec);

  for (const spec of affordable) {
    const selected = new Set(slugsOf(attributes[spec.from]));
    if (selected.size === 0) continue;
    // Iterate the DICTIONARY, not the worker's answer: this both fixes the order and drops any
    // slug with no reviewed English label (every `unknown` from a none-of-above chip, and any
    // value a later pack version adds before this map catches up).
    const values = Object.entries(spec.values ?? {})
      .filter(([slug]) => selected.has(slug))
      .map(([, label]) => label)
      // §4.3 states the caps per row (machines 4, controllers 3, materials 4). Applied AFTER the
      // dictionary filter, so a capped row shows the first N values the worker actually selected
      // rather than the first N the dictionary happens to list.
      .slice(0, spec.maxValues ?? Number.MAX_SAFE_INTEGER);
    if (values.length === 0) continue;

    // R10 §2.5 rule 3 — the configuration rides the first chip, never its own row.
    const configured = spec.configFrom
      ? appendConfiguration(values, slugsOf(attributes[spec.configFrom]), spec.configValues ?? {})
      : values;

    if (spec.inHeadline) headlineTools.push(...configured);

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
    chipRows,
    tickRows,
    factRows,
  };
}
