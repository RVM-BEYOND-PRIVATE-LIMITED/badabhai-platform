/**
 * The pack-answers → resume-rows dictionary.
 *
 * The properties worth pinning are the ones that would put something WRONG on a sheet a worker
 * hands to an employer, not the happy path: a raw slug, a non-answer printed as an answer, a claim
 * the worker never made, or a row order that changes between two renders of the same profile.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  headlineAxesFor,
  buildTradeCapabilityRows,
  CAPABILITY_ROW_BUDGET,
  TRADE_RESUME_MAPS,
  tradeResumeMapFor,
} from "./trade-resume-map";

interface Pack {
  items: { question_key: string; options?: { option_key: string; value_text?: string }[] }[];
}

function packJson(packId: string): Pack {
  return JSON.parse(
    readFileSync(
      join(__dirname, `../../../../packages/db/data/question-packs/packs/${packId}.json`),
      "utf8",
    ),
  ) as Pack;
}

const map = tradeResumeMapFor("qp_cnc_turning");

/**
 * The STRUCTURAL properties, run over every shipped map (R13 §3.1).
 *
 * Parametrised the day the second entry landed, and that is the point of the seam: a third trade
 * inherits these three checks by existing, with no new test file and no new assertion. They were
 * turner-only for one packet because there was one map, which is exactly how a check quietly
 * becomes specific to its first subject.
 */
describe.each(TRADE_RESUME_MAPS.map((m) => m.pack_id))("trade resume map — %s", (packId) => {
  const entry = tradeResumeMapFor(packId)!;
  const pack = packJson(packId);

  it("EVERY row reads a question_key that actually exists in the pack", () => {
    // The defect this catches: a renamed or mistyped `from` yields a row that can never appear,
    // and nothing else in the system would ever say so.
    const keys = new Set(pack.items.map((i) => i.question_key));
    for (const spec of entry.capability) {
      expect(keys.has(spec.from), `no pack question "${spec.from}"`).toBe(true);
      if (spec.configFrom !== undefined) {
        expect(keys.has(spec.configFrom), `no pack question "${spec.configFrom}"`).toBe(true);
      }
    }
  });

  it("EVERY dictionary slug is a real option value in the pack", () => {
    // The reverse direction: a label keyed on a slug the pack never emits is dead weight that
    // reads, in review, as coverage it does not have.
    const byKey = new Map(pack.items.map((i) => [i.question_key, i]));
    const realOptions = (key: string) =>
      new Set((byKey.get(key)?.options ?? []).map((o) => o.value_text));
    for (const spec of entry.capability) {
      const real = realOptions(spec.from);
      for (const slug of Object.keys(spec.values ?? {})) {
        expect(real.has(slug), `${spec.from}: "${slug}" is not an option value`).toBe(true);
      }
      if (spec.configFrom !== undefined) {
        const configReal = realOptions(spec.configFrom);
        for (const slug of Object.keys(spec.configValues ?? {})) {
          expect(configReal.has(slug), `${spec.configFrom}: "${slug}" is not an option`).toBe(true);
        }
      }
    }
  });

  it("never gives `unknown` a label, on any row or any config", () => {
    // Every escape chip in every pack carries `value_text: "unknown"`. Printing "Pata nahi" onto
    // a resume would turn a worker's non-answer into a stated fact.
    for (const spec of entry.capability) {
      expect(Object.keys(spec.values ?? {})).not.toContain("unknown");
      expect(Object.keys(spec.configValues ?? {})).not.toContain("unknown");
    }
  });
});

describe("trade resume map — qp_cnc_turning", () => {
  it("exists alongside every other shipped map, and only real pack ids resolve", () => {
    // PINNED BY VALUE, IN DECLARATION ORDER. A map that vanished would empty one trade's whole
    // capability section with nothing else failing, so "which maps exist" is asserted rather than
    // counted. Batch 1 closed with the two desk trades: part programming and the drawing office.
    expect(map).toBeDefined();
    expect(TRADE_RESUME_MAPS.map((m) => m.pack_id)).toEqual([
      "qp_cnc_turning",
      "qp_vmc_milling",
      "qp_cnc_grinding",
      "qp_cam_programming",
      "qp_cad_drafting",
      "qp_conventional_machining",
      "qp_tool_die_making",
      "qp_welding_trade",
      "qp_powder_coating",
    ]);
    // `qp_welding` IS THE GENERIC ISCO-UNIT PACK AND STILL HAS NO MAP — and this row is now doing
    // real work rather than naming an arbitrary absent pack. Batch 2 added `qp_welding_trade`
    // BESIDE it, on the guide's rule that a role pack never replaces the family pack. If the two
    // ids were ever conflated, this assertion is what fails.
    expect(tradeResumeMapFor("qp_welding")).toBeUndefined();
    expect(tradeResumeMapFor(null)).toBeUndefined();
  });

  it("NEVER prints a none-of-above answer — `unknown` has no label anywhere", () => {
    // Every escape chip in the pack carries `value_text: "unknown"`. Printing "Pata nahi" or
    // "Inme se koi nahi" onto a resume would turn a worker's non-answer into a stated fact.
    for (const spec of map?.capability ?? []) {
      expect(Object.keys(spec.values ?? {})).not.toContain("unknown");
    }
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      turning_machine: ["unknown"],
      controller_brand: ["unknown"],
      tolerance_band: "unknown",
    });
    expect(rows.chipRows).toEqual([]);
    expect(rows.factRows).toEqual([]);
  });

  it("does not claim a worker reads drawings when they said they cannot", () => {
    // `no_drawing` is a true answer with no English label, so the row is absent rather than
    // printing a negative claim on the worker's own marketing document.
    const rows = buildTradeCapabilityRows("qp_cnc_turning", { drawing_reading: "none" });
    expect(rows.factRows).toEqual([]);
    const yes = buildTradeCapabilityRows("qp_cnc_turning", { drawing_reading: "gdt" });
    expect(yes.factRows).toEqual([
      { label: "Drawings", value: "Reads 2D drawings and GD&T", key: "drawing_reading", rank: 44 },
    ]);
  });

  it("emits no row at all for an attribute the worker never answered", () => {
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {});
    expect(rows.chipRows).toEqual([]);
    expect(rows.tickRows).toEqual([]);
    expect(rows.factRows).toEqual([]);
  });

  it("handles BOTH captured shapes — a bare string and an array", () => {
    // `answer-capture.ts` wraps a multi_select and leaves a single_select bare, so both arrive.
    const bare = buildTradeCapabilityRows("qp_cnc_turning", { tolerance_band: "0.02" });
    expect(bare.factRows).toEqual([
      { label: "Tolerance held", value: "±0.02 mm", key: "tolerance_band", rank: 62 },
    ]);
    const arr = buildTradeCapabilityRows("qp_cnc_turning", { turning_machine: ["cnc_lathe"] });
    expect(arr.chipRows).toEqual([
      {
        label: "Machines",
        values: ["CNC lathe / turning centre"],
        key: "turning_machine",
        rank: 21,
      },
    ]);
  });

  it("orders values by the DICTIONARY, so the same profile always renders identically", () => {
    const a = buildTradeCapabilityRows("qp_cnc_turning", {
      controller_brand: ["mazak", "fanuc", "siemens"],
    });
    const b = buildTradeCapabilityRows("qp_cnc_turning", {
      controller_brand: ["siemens", "mazak", "fanuc"],
    });
    expect(a.chipRows[0]?.values).toEqual(["Fanuc", "Siemens", "Mazak"]);
    expect(a).toEqual(b);
  });

  it("builds the full sheet for a realistic senior turner", () => {
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      turning_machine: ["cnc_lathe", "conventional_lathe"],
      controller_brand: ["fanuc", "siemens"],
      material_worked: ["mild_steel", "alloy_steel", "stainless"],
      turning_operation: ["facing_od", "boring", "threading"],
      workholding: ["three_jaw", "collet", "tailstock"],
      setting_operation: ["tool_offset", "work_offset", "first_piece"],
      measuring_tools: ["vernier", "micrometer", "bore_gauge"],
      programming_level: "edit_program",
      drawing_reading: "gdt",
      tolerance_band: "0.02",
      sector_worked: ["automotive", "general_engg"],
      advanced_capability: ["live_tooling", "bar_feeder"],
    });

    // THIS WORKER ANSWERS 12 CAPABILITY ROWS AND THE PAGE HOLDS 10. Before the budget existed this
    // rendered a two-page PDF, which breaks the one-page product contract (guideline §6.3). The
    // two lowest-ranked answered rows are dropped: Operations (63) and Sector worked (81 — §4.3
    // calls it "display only, never a matching input", so it goes first).
    //
    // TOLERANCE HELD (62) NOW SURVIVES, and that is the budget being re-measured rather than an
    // expectation edited to match output. At a budget of nine it fell one place below the cut and
    // this test recorded the loss; counting the capability rows on all twenty-one pages of
    // `BadaBhai_21_Role_Resumes.pdf` puts the ceiling at TEN — three pages reach it — and rank 62
    // is the turner's tenth. A turner holding ±0.02 mm now has a sheet that says so.
    //
    // THE ORDER CHANGED ON 2026-08-28 AND THE CHANGE IS TRADE TRUTH, NOT LAYOUT. Turning
    // configuration ("Machine capability": live tooling, bar feeder, sub-spindle, Y-axis) is a
    // statement about what the machine can do — §5.1 rank 2 — and it moves the pay band, so it
    // now survives where it used to drop. Workholding moved up with setting capability for the
    // same reason. Both displaced rows the earlier ordering had ranked on layout convenience.
    // Flagged for RVM redline in ASSUMPTIONS.md; nothing but these numbers changes if it moves.
    const kept = [
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ];
    // SPELLED OUT, NOT COMPARED TO THE CONSTANT. `toHaveLength(CAPABILITY_ROW_BUDGET)` reads like a
    // check but is nearly a tautology: raise the budget and it still fails, for the wrong reason,
    // and it would pass a build that truncated to the right COUNT of the wrong ROWS.
    expect(kept).toEqual([
      "Machines",
      "Controllers",
      "Materials",
      "Workholding",
      "Setting",
      "Measuring instruments",
      "Programming",
      "Drawings",
      "Tolerance held",
      "Machine capability",
    ]);
    expect(CAPABILITY_ROW_BUDGET).toBe(10);

    expect(rows.chipRows.map((r) => r.label)).toEqual(["Machines", "Controllers", "Materials"]);
    expect(rows.tickRows.map((r) => r.label)).toEqual([
      "Workholding",
      "Setting",
      "Measuring instruments",
    ]);
    expect(rows.factRows).toEqual([
      {
        label: "Programming",
        value: "Edits programs (G-code / M-code)",
        key: "programming_level",
        rank: 43,
      },
      { label: "Drawings", value: "Reads 2D drawings and GD&T", key: "drawing_reading", rank: 44 },
      { label: "Tolerance held", value: "±0.02 mm", key: "tolerance_band", rank: 62 },
      {
        label: "Machine capability",
        value: "Live tooling · Bar feeder",
        key: "advanced_capability",
        rank: 23,
      },
    ]);
    // Nothing anywhere is a raw slug.
    const printed = [
      ...rows.chipRows.flatMap((r) => r.values),
      ...rows.tickRows.flatMap((r) => r.values),
      ...rows.factRows.map((r) => r.value),
    ].join(" ");
    expect(printed).not.toMatch(/_/);
  });

  it("an unmapped pack yields nothing rather than throwing", () => {
    // Every other trade still renders its resume; it just has no capability block yet.
    expect(buildTradeCapabilityRows("qp_welding", { welding_process: ["mig"] })).toEqual({
      sectionTitle: null,
      headlineTools: [],
      headlineAxes: [],
      chipRows: [],
      tickRows: [],
      factRows: [],
    });
  });

  it("titles the first section from the TRADE, and never over an empty section", () => {
    // The heading is per-trade data — a welder's sheet says "Processes, positions & capability" —
    // so hard-coding it in the template would be wrong for most roles. The interesting case is the
    // second one: a title is not content, and a heading standing over nothing is precisely the
    // failure the data-driven rows exist to prevent.
    const real = buildTradeCapabilityRows("qp_cnc_turning", { turning_machine: ["cnc_lathe"] });
    expect(real.chipRows.length).toBeGreaterThan(0);
    expect(real.sectionTitle).toBe("Machines, controllers & capability");

    // Mapped pack, but every answer is a none-of-above `unknown` that the dictionary drops.
    const hollow = buildTradeCapabilityRows("qp_cnc_turning", { turning_machine: ["unknown"] });
    expect(hollow.chipRows).toEqual([]);
    expect(hollow.tickRows).toEqual([]);
    expect(hollow.factRows).toEqual([]);
    expect(hollow.sectionTitle, "a heading survived an empty section").toBeNull();
  });

  it("keeps the page's worth of rows by RANK, but renders them in DECLARED order", () => {
    // The two orderings are deliberately different and the difference is easy to lose. `rank`
    // (guideline §5.1 decisiveness) decides what SURVIVES a budget cut; the array order decides
    // what the page LOOKS like, and §7.1 makes field order invariant across roles and skins.
    // Sorting output by rank would silently rearrange the locked sheet.
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      // Answered in an order that is neither declared nor rank order.
      sector_worked: ["automotive"],
      turning_machine: ["cnc_lathe"],
      drawing_reading: "gdt",
      material_worked: ["mild_steel"],
      controller_brand: ["fanuc"],
    });
    const declared = tradeResumeMapFor("qp_cnc_turning")!.capability.map((c) => c.label);
    const kept = [
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ];
    // Under budget, so nothing is dropped — and "Sector worked" (rank 12) survives here precisely
    // because rank only matters when the page runs out.
    expect(kept).toHaveLength(5);
    expect(kept).toContain("Sector worked");
    // Every kept row sits in its declared position relative to the others.
    const positions = kept.map((l) => declared.indexOf(l));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("caps values per row at the numbers the guideline states", () => {
    // §4.3: machines max 4, controllers max 3, materials max 4. A worker who ticks everything
    // must not blow the row width — these are quoted numbers, not tuning.
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      turning_machine: ["cnc_lathe", "conventional_lathe", "vtl", "sliding_head", "spm"],
      controller_brand: ["fanuc", "siemens", "mitsubishi", "haas", "mazak"],
      material_worked: [
        "mild_steel",
        "alloy_steel",
        "stainless",
        "aluminium",
        "brass",
        "cast_iron",
      ],
    });
    const byLabel = new Map(rows.chipRows.map((r) => [r.label, r.values]));
    expect(byLabel.get("Machines")).toHaveLength(4);
    expect(byLabel.get("Controllers")).toHaveLength(3);
    expect(byLabel.get("Materials")).toHaveLength(4);
  });

  it("gives every row a rank, and no two rows in one map share one", () => {
    // A duplicate rank makes the budget cut depend on sort stability rather than on a decision,
    // so which of a worker's skills reaches his resume would vary with the engine.
    for (const map of TRADE_RESUME_MAPS) {
      const ranks = map.capability.map((c) => c.rank);
      expect(new Set(ranks).size, `${map.pack_id} has duplicate ranks`).toBe(ranks.length);
    }
  });

  it("gives every map a section title, so a new role cannot ship headless", () => {
    for (const map of TRADE_RESUME_MAPS) {
      expect(map.section_title, `${map.pack_id} has no section title`).toBeTruthy();
      // Sentence case, not caps: the template uppercases it, and a pre-shouted string would
      // double up as "MACHINES, CONTROLLERS &amp; CAPABILITY" is already what CSS produces.
      expect(map.section_title).not.toBe(map.section_title.toUpperCase());
    }
  });

  it("no VOCABULARY crosses a pack boundary without a stated reason (R14 §3.3)", () => {
    /**
     * THE CLASS THE `MEASURING_TOOLS` RENAME EXPOSED, not the instance.
     *
     * That constant's docstring read "shared by every machining-family pack: the instruments do
     * not change by role" — a claim about the WORLD, made on the evidence of ONE pack, and false
     * the first time a second role was authored: the ratified milling sheet prints a SNAP GAUGE,
     * and a turner's plug / ring gauge checks a bore he just bored. It was not a careless claim.
     * It was an UNCHALLENGEABLE one, and that is the property worth a guard: with a single map in
     * the file, no test, no review and no amount of care could have contradicted it.
     *
     * So the rule is not "never share a dictionary" — controllers really may not change by role,
     * and copying Fanuc/Siemens/Mitsubishi into every future map would be its own defect. The
     * rule is that sharing must be a DECISION, recorded here with the reason, at the moment a
     * second pack makes the claim testable for the first time.
     *
     * IDENTITY, NOT EQUALITY. Two maps that happen to list the same labels have each made their
     * own decision; one `values` object reachable from two packs is a single vocabulary asserted
     * to be role-independent. The second is the claim this catches.
     */
    /**
     * R16 §0 — a row here is a SUPPRESSION, so it carries the observable that would end it.
     *
     * The shape used to be `Record<string, string>`: a bare reason, which is prose, and prose
     * does not expire. The row this file's own rename replaced — `MEASURING_TOOLS` documented
     * as "shared by every machining-family pack: the instruments do not change by role" — was
     * true against one pack and false against the second, and nothing could say so. A reason
     * explains; a falsifier is checkable.
     */
    const SHARED_ON_PURPOSE: Readonly<
      Record<string, { readonly reason: string; readonly falsifiedBy: string }>
    > = {
      // Empty, and that is the finding: after the rename, nothing in this file claims to be
      // role-independent. A row added here must say WHICH two trades were compared, why the
      // vocabulary genuinely does not change between them, and what would make that false.
    };

    const owners = new Map<object, string[]>();
    for (const map of TRADE_RESUME_MAPS) {
      for (const row of map.capability) {
        for (const dictionary of [row.values, row.configValues]) {
          if (!dictionary) continue;
          const seen = owners.get(dictionary) ?? [];
          if (!seen.includes(map.pack_id)) seen.push(map.pack_id);
          owners.set(dictionary, seen);
        }
      }
    }

    // The fixture must contain the thing the detector detects: two maps, or this passes because
    // there is nothing that COULD cross a boundary — which is precisely the state that let the
    // original claim stand.
    expect(TRADE_RESUME_MAPS.length, "one map cannot challenge a cross-pack claim").toBeGreaterThan(
      1,
    );
    expect(owners.size, "no dictionaries were collected — the walk is broken").toBeGreaterThan(5);

    const crossing = [...owners.values()]
      .filter((packs) => packs.length > 1)
      .map((packs) => packs.sort().join(" + "))
      .filter((key) => SHARED_ON_PURPOSE[key] === undefined);
    expect(
      crossing,
      "a value dictionary is reachable from two packs — say why the vocabulary does not change " +
        "between those trades, in SHARED_ON_PURPOSE above",
    ).toEqual([]);
  });
});

/**
 * MILLING, AGAINST THE RATIFIED SHEET (R13 §3.1).
 *
 * The BadaBhai design sample is a VMC sheet, so this map has a document to be wrong against
 * rather than a judgement to be argued with. The answers below are the sample's worker read back
 * off the page, and the assertions are the nine capability rows it prints, verbatim.
 */
describe("trade resume map — qp_vmc_milling against the ratified sample", () => {
  /** Ramesh Kumar Yadav's capability answers, transcribed from the ratified sheet. */
  const YADAV = {
    milling_machine: ["vmc", "spm"],
    axis_capability: ["three_axis", "four_axis"],
    controller_brand: ["fanuc", "siemens", "mitsubishi"],
    material_worked: ["en_eight", "en_thirty_one", "mild_steel", "aluminium"],
    setting_operation: [
      "tool_offset",
      "work_offset",
      "tool_length",
      "fixture_setting",
      "first_piece",
    ],
    measuring_tools: ["vernier", "micrometer", "bore_gauge", "height_gauge", "snap_gauge"],
    programming_level: "edit_program",
    drawing_reading: "gdt",
    tolerance_band: "0.02",
    sector_worked: ["automotive"],
  };

  it("prints the sample's nine capability rows, in the sample's order", () => {
    const rows = buildTradeCapabilityRows("qp_vmc_milling", YADAV);
    const kept = [
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ];
    expect(kept.sort()).toEqual(
      [
        "Machines",
        "Controllers",
        "Materials",
        "Setting",
        "Measuring instruments",
        "Programming",
        "Drawings",
        "Tolerance held",
        "Sector worked",
      ].sort(),
    );
    // NINE IS WHAT THE SAMPLE ANSWERS, NOT WHAT THE PAGE HOLDS, and the two are no longer the
    // same number. This line read `toHaveLength(CAPABILITY_ROW_BUDGET)`, which was true by
    // coincidence while the budget was nine and false the moment it was re-measured to ten
    // against all twenty-one ratified pages. The property it means to state is that NOTHING IS
    // SHED — which the row list above already pins exactly — so what belongs beside it is the
    // relation to the budget: he is INSIDE it, not filling it.
    expect(kept.length, "the sample's rows all fit — nothing is shed").toBeLessThanOrEqual(
      CAPABILITY_ROW_BUDGET,
    );
  });

  it("appends the axis configuration to the machine chip, exactly as the sample prints it", () => {
    // `VMC · 3-axis  VMC · 4-axis  SPM` — the FIRST use of `configFrom` by any shipped map, and
    // the reason R10 built the seam. One config per chip, never a cross product: two machines and
    // two axis counts would otherwise produce four chips, three of them never claimed.
    const rows = buildTradeCapabilityRows("qp_vmc_milling", YADAV);
    const machines = rows.chipRows.find((r) => r.label === "Machines");
    expect(machines?.values).toEqual(["VMC · 3-axis", "VMC · 4-axis", "SPM"]);
  });

  it("prints the sample's values for every other row it carries", () => {
    const rows = buildTradeCapabilityRows("qp_vmc_milling", YADAV);
    const chips = new Map(rows.chipRows.map((r) => [r.label, r.values]));
    const ticks = new Map(rows.tickRows.map((r) => [r.label, r.values]));
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));

    expect(chips.get("Controllers")).toEqual(["Fanuc", "Siemens", "Mitsubishi"]);
    expect(chips.get("Materials")).toEqual(["EN8", "EN31", "MS", "Aluminium"]);
    expect(ticks.get("Setting")).toEqual([
      "Tool offset",
      "Work offset",
      "Tool length compensation",
      "Fixture setting",
      "First-piece setup",
    ]);
    expect(ticks.get("Measuring instruments")).toEqual([
      "Vernier",
      "Micrometer",
      "Bore dial gauge",
      "Height gauge",
      "Snap gauge",
    ]);
    expect(facts.get("Programming")).toBe("Edits programs (G-code / M-code)");
    expect(facts.get("Drawings")).toBe("Reads 2D drawings and GD&T");
    expect(facts.get("Tolerance held")).toBe("±0.02 mm");
    expect(facts.get("Sector worked")).toBe("Automotive components");
  });

  it("leads the Verdict Line with CONTROLLERS, as the sample's headline does", () => {
    // "VMC Setter-cum-Operator · 8 yrs · Fanuc, Siemens, Mitsubishi · 3 & 4-axis" — the third
    // segment is controllers, which is per-trade data (`inHeadline`) and not a renderer decision.
    const rows = buildTradeCapabilityRows("qp_vmc_milling", YADAV);
    expect(rows.headlineTools).toEqual(["Fanuc", "Siemens", "Mitsubishi"]);
  });

  it("MEASURES the Q2 casualty: what a miller who answers EVERYTHING loses", () => {
    // NOT A DEFECT AND NOT A FIX — the evidence Q2 needs, computed rather than argued.
    //
    // The sample's worker answers nine capability questions and all nine print. A miller who
    // answers all thirteen is over the ten-row budget, and rank decides. This asserts WHICH
    // rows that costs him, so the ruling is made against a list instead of against a principle.
    //
    // THE RE-MEASURED BUDGET BOUGHT ONE ROW BACK. At nine the casualty list opened with
    // "Operations" (rank 63); at ten — the ceiling counted across the twenty-one ratified pages
    // — it survives, and the list is one shorter. The row that still goes is the one below.
    const everything = {
      ...YADAV,
      workholding: ["machine_vice", "fixture", "rotary_table"],
      milling_operation: ["face_milling", "slot_milling", "pocket_milling"],
      quality_work: ["first_piece_check", "in_process"],
      troubleshooting: ["tool_wear", "chatter"],
    };
    const rows = buildTradeCapabilityRows("qp_vmc_milling", everything);
    const kept = new Set([
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ]);
    expect(kept.size).toBe(CAPABILITY_ROW_BUDGET);

    const declared = tradeResumeMapFor("qp_vmc_milling")!.capability.map((c) => c.label);
    const dropped = declared.filter((l) => !kept.has(l));
    expect(dropped).toEqual(["Quality", "Troubleshooting", "Sector worked"]);

    // THE ONE THAT MATTERS: the ratified sheet PRINTS "Sector worked", and a fully-answering
    // miller loses it to "Workholding" (rank 42 beats rank 81). Bending the rank to keep it
    // would substitute a layout preference for the §5.1 order, which is the exact move the
    // turner map's rank comment warns against — so it is measured and routed, not fixed.
    expect(kept.has("Workholding")).toBe(true);
    expect(kept.has("Sector worked")).toBe(false);
  });
});

describe("R16 §1 — the headline axes opt-in", () => {
  // WHY THESE ARE SYNTHETIC SPECS. `qp_vmc_milling` is the only shipped map using `configFrom`,
  // so deleting the `configInHeadline` check changes no rendered output and the whole suite stays
  // green — measured, and the mutation survived. The flag is a claim the shipped data cannot
  // contradict, which is the `MEASURING_TOOLS` shape one packet on. A spec written here can
  // contradict it.
  const base = {
    from: "milling_machine",
    rank: 21,
    kind: "chips",
    label: "Machines",
    values: { vmc: "VMC" },
    configFrom: "axis_capability",
    configValues: { three_axis: "3-axis", four_axis: "4-axis", five_axis: "5-axis" },
  } as const;
  const attrs = { axis_capability: ["four_axis", "three_axis"] };

  it("contributes nothing unless the row OPTS IN", () => {
    expect(headlineAxesFor({ ...base }, attrs)).toEqual([]);
  });

  it("contributes the dictionary-ordered labels when it does", () => {
    expect(headlineAxesFor({ ...base, configInHeadline: true }, attrs)).toEqual([
      "3-axis",
      "4-axis",
    ]);
  });

  it("contributes nothing when the worker answered no configuration", () => {
    expect(headlineAxesFor({ ...base, configInHeadline: true }, {})).toEqual([]);
  });

  it("drops a slug the dictionary does not know, like every other value here", () => {
    expect(
      headlineAxesFor({ ...base, configInHeadline: true }, { axis_capability: ["unknown"] }),
    ).toEqual([]);
  });

  it("exactly one shipped row opts in today, and it is the miller's", () => {
    // The record of how far the claim currently reaches. If a second row opts in, this fails and
    // whoever added it states why that configuration is an AXIS rather than some other qualifier.
    const optedIn = TRADE_RESUME_MAPS.flatMap((m) =>
      m.capability.filter((r) => r.configInHeadline).map((r) => `${m.pack_id}.${r.from}`),
    );
    expect(optedIn).toEqual(["qp_vmc_milling.milling_machine"]);
  });
});

describe("R16 §1 — the chip and the headline state the axis fact ONCE, the same way", () => {
  const REVERSED = { milling_machine: ["vmc"], axis_capability: ["four_axis", "three_axis"] };

  it("the machine chip and the headline agree on order", () => {
    // These read the same dictionary through two different paths — `appendConfiguration` for the
    // chip and `headlineAxesFor` for the segment. Before R16 §1 the chip used the worker's answer
    // order and the headline used the dictionary's, so a man who tapped four-axis first would
    // have read "VMC · 4-axis, VMC · 3-axis" beside a headline saying "3 & 4-axis": one fact,
    // two orders, one page.
    const rows = buildTradeCapabilityRows("qp_vmc_milling", REVERSED);
    const machines = rows.chipRows.find((r) => r.label === "Machines");
    expect(machines?.values).toEqual(["VMC · 3-axis", "VMC · 4-axis"]);
    expect(rows.headlineAxes).toEqual(["3-axis", "4-axis"]);
  });

  it("no shipped row can print its configuration in BOTH headline segments", () => {
    // THE TRAP THE OPT-IN DOES NOT CLOSE ON ITS OWN. `headlineTools` is pushed the CONFIGURED
    // values, so a row carrying both `inHeadline` and `configInHeadline` would put the axis
    // labels in the tools segment and again in the axis segment — "… · Fanuc, 3-axis · 3 & 4-axis".
    // Nothing about `configInHeadline` prevents that pairing; this is what prevents it.
    const both = TRADE_RESUME_MAPS.flatMap((m) =>
      m.capability
        .filter((r) => r.inHeadline && r.configInHeadline)
        .map((r) => `${m.pack_id}.${r.from}`),
    );
    expect(
      both,
      "this row would print its configuration twice in one headline — split the row or drop one flag",
    ).toEqual([]);
  });
});

/**
 * PART PROGRAMMING, AGAINST THE RATIFIED SHEET.
 *
 * The same discipline the milling block above applies, and it is the only thing that turns "the
 * map looks right" into "the map reproduces a page a human signed". Batch 1 shipped both desk
 * trades with no such block and a claim that the two sheets rendered byte-for-byte; two rows do
 * not, and the deltas are asserted below rather than described, so the next editor inherits a
 * measurement instead of a belief.
 */
describe("trade resume map — qp_cam_programming against the ratified sample", () => {
  /** Nitin Deshmukh's capability answers, transcribed from the ratified sheet. */
  const DESHMUKH = {
    cam_software: ["mastercam", "powermill", "solidcam", "edgecam"],
    machine_programmed: ["vmc_three_axis", "vmc_four_axis", "five_axis_trunnion", "turn_mill"],
    controller_brand: ["fanuc", "heidenhain", "siemens"],
    programming_work: [
      "two_d_three_d_toolpath",
      "multi_axis_toolpath",
      "tool_library",
      "cycle_time",
      "strategy_selection",
      "tryout_support",
    ],
    cad_model_handling: [
      "step_iges_import",
      "parasolid_import",
      "model_repair",
      "fixture_modelling",
    ],
    post_processor_work: "edit_and_test",
    simulation_work: "both_checks",
    drawing_reading: "gdt",
    sector_worked: ["automotive", "tool_room"],
    // Captured, and deliberately printed nowhere — see the map entry's header.
    programming_mode: "cam_software",
  };

  it("prints the sample's nine capability rows, and sheds nothing", () => {
    const rows = buildTradeCapabilityRows("qp_cam_programming", DESHMUKH);
    const kept = [
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ];
    // Nine rows against a budget of ten: this worker answers everything the pack asks and loses
    // none of it, which is the pack's design rather than a coincidence. The CAM map defines only
    // nine rows, so the budget can never bind here however it is measured — which is why the
    // count below is stated as "inside the budget" rather than "equal to it".
    expect(kept.slice().sort()).toEqual(
      [
        "CAM software",
        // "for" / "to" restored: the row labels shipped TRUNCATED against the ratified page,
        // which prints "Machines programmed for" and "Controllers posted to". Without the
        // preposition they read as participle lists rather than the relation they state, and
        // neither word can belong to the value — no chip in any pack begins "for " or "to ".
        "Machines programmed for",
        "Controllers posted to",
        "Programming work",
        "CAD model handling",
        "Post-processors",
        "Simulation",
        "Drawings",
        "Sector worked",
      ].sort(),
    );
    expect(kept.length, "nothing is shed").toBeLessThanOrEqual(CAPABILITY_ROW_BUDGET);
    expect(rows.sectionTitle).toBe("Software, machines programmed & capability");
  });

  it("prints the sample's values on every row it carries", () => {
    const rows = buildTradeCapabilityRows("qp_cam_programming", DESHMUKH);
    const chips = new Map(rows.chipRows.map((r) => [r.label, r.values]));
    const ticks = new Map(rows.tickRows.map((r) => [r.label, r.values]));
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));

    expect(chips.get("CAM software")).toEqual(["Mastercam", "PowerMill", "SolidCAM", "EdgeCAM"]);
    // "VMC · 3-axis", not "VMC 3-axis". The middot is PRINTED CONTENT inside the chip, not a
    // separator: chips on these sheets are whitespace-separated, and the row directly above
    // ("CAM software  Mastercam  PowerMill  SolidCAM  EdgeCAM") carries no middot at all. The
    // decisive corroboration is internal — `appendConfiguration` already emits exactly
    // "VMC · 3-axis" on the milling sheet, so the platform was printing one fact, a 3-axis VMC,
    // two different ways on two shipped sheets.
    expect(chips.get("Machines programmed for")).toEqual([
      "VMC · 3-axis",
      "VMC · 4-axis",
      "5-axis trunnion",
      "Turn-mill",
    ]);
    expect(chips.get("Controllers posted to")).toEqual(["Fanuc", "Heidenhain", "Siemens"]);
    expect(ticks.get("Programming work")).toEqual([
      "2D & 3D toolpath",
      "Multi-axis toolpath",
      "Tool library management",
      "Cycle-time optimisation",
      "Machining strategy selection",
      "Shop-floor tryout support",
    ]);
    expect(ticks.get("CAD model handling")).toEqual([
      "STEP / IGES import",
      "Parasolid import",
      "Model repair",
      "Fixture modelling",
    ]);
    expect(facts.get("Simulation")).toBe("Vericut and in-CAM collision check before release");
    expect(facts.get("Drawings")).toBe("Reads 2D drawings and GD&T");
  });

  it("RECORDS the two places this sheet does not reproduce the ratified page verbatim", () => {
    // NOT A DEFECT AND NOT A FIX — the two deltas, pinned, so the ruling is made against the
    // strings rather than against a memory of the page.
    //
    // 1. Post-processors. The page reads "Edits and tests post-processors — Fanuc and
    //    Heidenhain". The controller clause is the Controllers row's own answer and is NOT
    //    re-composed here: joining two rows would assert WHICH controller he has posted for, a
    //    pairing the worker never stated. That is the R8 decision the map entry documents.
    // 2. Sector worked. The page reads "Auto components and tool room" — hand-set prose. A fact
    //    row joins its values with this file's separator, and the two other maps that print a
    //    multi-value sector row (grinding, and this role's own "Sector studied") use the same
    //    " · ". Setting `join: " and "` here would buy one page's punctuation at the cost of the
    //    file carrying three separators for one kind of row, and would still not match, because
    //    the label is "Tool room" and the page lower-cases it.
    const rows = buildTradeCapabilityRows("qp_cam_programming", DESHMUKH);
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));
    expect(facts.get("Post-processors")).toBe("Edits and tests post-processors");
    expect(facts.get("Sector worked")).toBe("Auto components · Tool room");
  });

  it("leads the Verdict Line with CAM SOFTWARE, as the sample's headline does", () => {
    // "CAM Programmer — Programmer · 7 yrs · Mastercam, PowerMill, SolidCAM" — for a desk trade
    // the seat is the advertised vocabulary, so `inHeadline` sits on software and not on a
    // machine. The row carries four values; `toolsPhrase` caps the printed headline at three.
    const rows = buildTradeCapabilityRows("qp_cam_programming", DESHMUKH);
    expect(rows.headlineTools).toEqual(["Mastercam", "PowerMill", "SolidCAM", "EdgeCAM"]);
  });
});

/**
 * THE DRAWING OFFICE, AGAINST THE RATIFIED SHEET — and the only ratified page in this programme
 * with NO WORK-HISTORY SECTION AT ALL.
 *
 * The reference worker is a fresher, which is this role's PRIMARY path rather than its fallback,
 * so the fixture is a student's answers and the assertion is that his seven rows print with
 * nothing shed. A senior's shedding is measured separately at the end.
 */
describe("trade resume map — qp_cad_drafting against the ratified fresher sample", () => {
  /** Pooja Chaudhary's capability answers, transcribed from the ratified sheet. */
  const CHAUDHARY = {
    cad_software: ["autocad", "solidworks", "fusion"],
    cad_modules: ["two_d_drafting", "three_d_modelling", "assembly_module", "sheet_metal"],
    drawing_work: [
      "part_modelling",
      "assembly_mating",
      "views_sections",
      "flat_pattern",
      "dimensioning",
      "revision_control",
    ],
    drawing_standards: ["gdt_symbols", "iso_standard", "title_block", "tolerance_stack"],
    drawing_type: "model_to_drawing",
    output_produced: ["part_drawing", "assembly_drawing", "bom", "dxf_cutting"],
    sector_studied: ["general_engg", "course_project"],
    // Captured and printed on no row: the fresher block's heading is a role-level constant.
    cad_training_source: "private_institute",
  };

  it("prints the sample's seven capability rows, with nothing shed", () => {
    const rows = buildTradeCapabilityRows("qp_cad_drafting", CHAUDHARY);
    const kept = [
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ];
    expect(kept.slice().sort()).toEqual(
      [
        "Software",
        "Modules",
        "Drawing work",
        "Standards & detailing",
        "Drawing type",
        "Output produced",
        "Sector studied",
      ].sort(),
    );
    expect(kept.length).toBeLessThanOrEqual(CAPABILITY_ROW_BUDGET);
    expect(rows.sectionTitle).toBe("Software, drawing work & capability");
  });

  it("prints the sample's values on every row it carries", () => {
    const rows = buildTradeCapabilityRows("qp_cad_drafting", CHAUDHARY);
    const chips = new Map(rows.chipRows.map((r) => [r.label, r.values]));
    const ticks = new Map(rows.tickRows.map((r) => [r.label, r.values]));
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));

    expect(chips.get("Software")).toEqual(["AutoCAD", "SolidWorks", "Fusion 360"]);
    expect(chips.get("Modules")).toEqual([
      "2D drafting",
      "3D modelling",
      "Assembly",
      "Sheet-metal module",
    ]);
    expect(ticks.get("Drawing work")).toEqual([
      "Part modelling",
      "Assembly mating",
      "Drawing views & sections",
      "Sheet-metal flat pattern",
      "Dimensioning",
      "Revision control",
    ]);
    expect(ticks.get("Standards & detailing")).toEqual([
      "GD&T symbols",
      "ISO drawing standard",
      "Title block & BOM",
      "Tolerance stack basics",
    ]);
    expect(facts.get("Drawing type")).toBe("Prepares 2D production drawings from 3D models");
    // "Sector STUDIED", never "worked": printing employment over a student's course projects is
    // the claim the two mutually-gated sector rows exist to keep apart.
    expect(facts.get("Sector studied")).toBe("General engineering · Course projects");
    expect(facts.has("Sector worked")).toBe(false);
  });

  it("RECORDS where this sheet does not reproduce the ratified page verbatim", () => {
    // The page reads "Part and assembly drawings · BOM · DXF for laser cutting" — it folds two
    // chips into one English phrase. A `fact` row joins whole dictionary labels, so no separator
    // reproduces that; the alternative is a compound label that lies whenever the worker taps
    // only one of the two. Pinned, not fixed.
    const rows = buildTradeCapabilityRows("qp_cad_drafting", CHAUDHARY);
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));
    expect(facts.get("Output produced")).toBe(
      "Part drawings · Assembly drawings · BOM · DXF for laser cutting",
    );
  });

  it("leads the Verdict Line with SOFTWARE, as the sample's headline does", () => {
    // "CAD Designer / Draughtsman — Draughtsman · Fresher · AutoCAD, SolidWorks, Fusion 360".
    const rows = buildTradeCapabilityRows("qp_cad_drafting", CHAUDHARY);
    expect(rows.headlineTools).toEqual(["AutoCAD", "SolidWorks", "Fusion 360"]);
  });

  it("MEASURES what a senior draughtsman sheds — and that he never prints BOTH sector rows", () => {
    // The fresher answers seven of twelve rows. A designer with years answers eleven, is over the
    // nine-row budget, and rank decides. `sector_studied` and `sector_drawn` are mutually
    // exclusive by their gates, so the pair can never both reach a sheet — asserted here because
    // two rows sharing one printed label is the kind of thing a later edit merges by accident.
    const senior = {
      cad_software: ["autocad", "solidworks", "creo"],
      cad_modules: ["two_d_drafting", "three_d_modelling", "assembly_module", "surface_module"],
      drawing_work: ["part_modelling", "assembly_mating", "views_sections", "dimensioning"],
      drawing_standards: ["gdt_symbols", "iso_standard", "title_block", "projection_angle"],
      drawing_type: "model_and_drawing",
      output_produced: ["part_drawing", "assembly_drawing", "fabrication_drawing"],
      design_work: ["material_selection", "standard_parts", "fixture_design"],
      design_input_source: "own_design",
      drawing_check_work: "check_regular",
      measuring_tools: ["vernier", "height_gauge", "steel_rule"],
      sector_drawn: ["tool_room", "machine_building"],
    };
    const rows = buildTradeCapabilityRows("qp_cad_drafting", senior);
    const kept = new Set([
      ...rows.chipRows.map((r) => r.label),
      ...rows.tickRows.map((r) => r.label),
      ...rows.factRows.map((r) => r.label),
    ]);
    expect(kept.size).toBe(CAPABILITY_ROW_BUDGET);
    // R4 §3 puts the display-only sector tag at the bottom of the survival order, so it and the
    // instruments are what a senior loses — never his checking capability.
    expect(kept.has("Sector worked")).toBe(false);
    expect(kept.has("Sector studied")).toBe(false);
    expect(kept.has("Drawing checking")).toBe(true);
    expect(kept.has("Design work")).toBe(true);

    // AND THE PRONOUN-FREE LABEL, on the row that carried this file's only gendered string.
    const facts = new Map(rows.factRows.map((r) => [r.label, r.value]));
    expect(facts.get("Design input")).toBe("Designs it independently");
  });
});
