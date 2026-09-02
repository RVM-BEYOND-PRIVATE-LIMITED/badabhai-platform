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
  it("exists alongside the milling map, and only real pack ids resolve", () => {
    expect(map).toBeDefined();
    expect(TRADE_RESUME_MAPS.map((m) => m.pack_id)).toEqual([
      "qp_cnc_turning",
      "qp_vmc_milling",
      "qp_cnc_grinding",
    ]);
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

    // THIS WORKER ANSWERS 12 CAPABILITY ROWS AND THE PAGE HOLDS 9. Before the budget existed this
    // rendered a two-page PDF, which breaks the one-page product contract (guideline §6.3). The
    // three lowest-ranked answered rows are dropped: Tolerance held (62), Operations (63) and
    // Sector worked (81 — §4.3 calls it "display only, never a matching input", so it goes first).
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
      "Machine capability",
    ]);
    expect(CAPABILITY_ROW_BUDGET).toBe(9);

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
    expect(kept).toHaveLength(CAPABILITY_ROW_BUDGET);
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
    // answers all thirteen is over the nine-row budget, and rank decides. This asserts WHICH
    // rows that costs him, so the ruling is made against a list instead of against a principle.
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
    expect(dropped).toEqual(["Operations", "Quality", "Troubleshooting", "Sector worked"]);

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
