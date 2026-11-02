import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { matchOptions } from "./answer-capture";
import { routeToTradeForm, type TradeFormKind } from "./trade-form-router";

/**
 * MIDDLE-WAY §8 ALIAS RESOLUTION — every Turner + VMC starter row, pinned to the
 * mechanism that actually resolves it (P6, DoD §7.9).
 *
 * A §8 "Resolves to" cell is satisfied at FOUR different layers, and conflating
 * them is how an alias looks loaded while resolving nowhere:
 *
 *   FAMILY — retrieval pins the trade's family (`familyFor` in the db package;
 *   covered for the ADDED rows by `question-pack-reachability.test.ts` P4 block
 *   and for the shipped rows by its turning/milling tables — not re-asserted here).
 *   ROUTE — the handover router, asserted HERE: occupation phrases route alone,
 *   machine/rung phrases corroborate a family pin and never route alone, vetoes win.
 *   RUNG — the level answer capture, asserted HERE against the REAL pack items:
 *   rung words ("setter hoon") match the option label; §8 signal phrases
 *   ("setting karta hoon") deliberately do NOT — they are router corroboration
 *   (P4 scope, owner-approved), and the rung lands via chips or rung words.
 *   OPTION — machine/controller capture, asserted HERE: exact labels match;
 *   typed variants that match no label re-ask with chips (bounded, fail-safe).
 *
 * Rows tagged GAP do not resolve at capture today. Each names its EXPAND-12 item:
 * they need pack option alignment or ratified label/alias work, which is a pack
 * release (versions, seed, TTS re-render) — explicitly out of P6's verify+plan
 * scope. The interview still completes for these workers: an unmatched answer is
 * re-asked with chips, never looped (DoD §7.4) and never guessed (spec §4).
 *
 * SCOPE: Turner (§8.1) + VMC (§8.2) — the v1 trades P4 loaded — plus Grinding
 * (E4 starter table below) and CAM (E5 starter table below). Neither has a §8
 * sheet; their starters live in EXPAND-12 E4/E5.
 */

function route(
  domain: string | null,
  role: string | null,
  familyId: string | null = null,
  occupationLabel: string | null = null,
  workerText: string | null = null,
): TradeFormKind | null {
  return routeToTradeForm({
    draft: { domain_label: domain, role_label: role, skills: [], experiences: [] },
    occupationFamilyId: familyId,
    occupationLabel,
    workerText,
  });
}

interface PackOption {
  option_key: string;
  label_text: string;
  value_text?: string | null;
  value_number?: number | null;
  value_bool?: boolean | null;
}
interface PackItem {
  question_key: string;
  options?: PackOption[];
}

function loadItem(packFile: string, questionKey: string): { options: PackOption[] } {
  const pack = JSON.parse(
    readFileSync(
      join(__dirname, "../../../../packages/db/data/question-packs/packs", packFile),
      "utf8",
    ),
  ) as { items: PackItem[] };
  const item = pack.items.find((i) => i.question_key === questionKey);
  if (!item?.options) throw new Error(`no options for ${packFile}#${questionKey}`);
  // Mirrors `question-pack-corpus.ts` option-value resolution
  // (value_bool ?? value_number ?? value_text): the value capture stores.
  return {
    options: item.options.map((o) => ({
      option_key: o.option_key,
      label_text: o.label_text,
      value: o.value_bool ?? o.value_number ?? o.value_text ?? o.label_text,
    })),
  } as never;
}

/** The option a free-text machine/controller answer resolves to, or null. */
function capturedOption(packFile: string, questionKey: string, text: string): unknown[] {
  return matchOptions(loadItem(packFile, questionKey) as never, text);
}

describe("§8.1 Turner — trade routing (DoD §7.9, trade column)", () => {
  const cases: ReadonlyArray<
    readonly [string | null, string | null, string | null, TradeFormKind | null]
  > = [
    // Occupation-tier: a worker who says one has claimed the trade (P4 starter).
    ["CNC Machining", "CNC kharad", null, "cnc_turner"],
    ["Manufacturing", "lathe wala", null, "cnc_turner"],
    ["Manufacturing", "turning karta hoon", null, "cnc_turner"],
    ["Manufacturing", "kharad wala", null, "cnc_turner"],
    // Bare machine + family pin corroborates (P4 starter: khraad/kharad shared with
    // conventional machining by value, so the pin decides).
    ["Manufacturing", "kharad", "fam_cnc_turning", "cnc_turner"],
    // Ambiguous by the worker's own account: ask slot 2, route nowhere.
    ["Manufacturing", "CNC karta hoon", null, null],
    ["Manufacturing", "CNC karta hoon", "fam_cnc_turning", null],
    // Not this trade: the veto fires with or without a pin.
    ["Manufacturing", "VMC", null, null],
    ["Manufacturing", "VMC", "fam_cnc_turning", null],
    ["Manufacturing", "milling", null, "vmc_milling"],
    ["Manufacturing", "machining centre", null, "vmc_milling"],
    // Slot-2 machine types corroborate the pin, never route alone.
    ["Manufacturing", "live tool", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "C-axis", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "twin spindle", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "sliding head", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "swiss", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "vtl", "fam_cnc_turning", "cnc_turner"],
    ["Manufacturing", "live tool", null, null],
    ["Manufacturing", "C-axis", null, null],
    ["Manufacturing", "swiss", null, null],
    // P4 ruling, pinned against regression: "turn mill" contains the standalone word
    // "mill" — a competing machine — so the veto withholds the form even with a pin.
    // Retrieval still pins the turning family for pack depth (rvm-alias row).
    ["Manufacturing", "turn mill", "fam_cnc_turning", null],
    ["Manufacturing", "turn mill", null, null],
  ];
  for (const [domain, role, family, expected] of cases) {
    it(`${JSON.stringify(role)}${family ? ` + pin` : ""} → ${expected ?? "nothing"}`, () => {
      expect(route(domain, role, family)).toBe(expected);
    });
  }
});

describe("§8.2 VMC — trade routing (DoD §7.9, trade column)", () => {
  const cases: ReadonlyArray<
    readonly [string | null, string | null, string | null, TradeFormKind | null]
  > = [
    // Occupation-tier: route alone (P4 starter).
    ["Manufacturing", "VMC machine", null, "vmc_milling"],
    ["Manufacturing", "milling machine", null, "vmc_milling"],
    ["Manufacturing", "machining centre", null, "vmc_milling"],
    ["Manufacturing", "machining center", null, "vmc_milling"],
    // Bare machine words corroborate the pin, never route alone (signals.py rule).
    ["Manufacturing", "hmc", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "hmc", null, null],
    ["Manufacturing", "horizontal", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "horizontal", null, null],
    // Slot-2 features corroborate the pin (P4 starter).
    ["Manufacturing", "4th axis", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "rotary table", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "indexer", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "5 axis", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "trunnion", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "dmg", "fam_vmc_milling", "vmc_milling"],
    ["Manufacturing", "4th axis", null, null],
    ["Manufacturing", "dmg", null, null],
    // HMC is the same role (one machining-centre trade, machine as attribute).
    ["CNC Machining", "HMC Operator", null, "vmc_milling"],
    // Cross-trade vetoes hold both directions — with one deliberate asymmetry: an
    // occupation term routes on its OWN evidence, and the pin corroborates rather
    // than overrides. So a model label naming turner still routes turner under a VMC
    // pin (the "does not let the turner form claim a miller" test pins the mirror:
    // what must NOT happen is a VMC handover on turner evidence).
    ["CNC Machining", "CNC turner", "fam_vmc_milling", "cnc_turner"],
    ["Manufacturing", "turning karta hoon", "fam_vmc_milling", "cnc_turner"],
    // CAM's words belong to CAM: bare packages route to the desk trade, never here.
    ["Manufacturing", "Mastercam", null, "cam_programmer"],
    ["Manufacturing", "PowerMill", null, "cam_programmer"],
    // Optional industry rows are pack content, not routing evidence: no form either way.
    ["Manufacturing", "mould ka kaam", null, null],
    ["Manufacturing", "die ka kaam", null, null],
    // Controllers are capture vocabulary, not routing vocabulary: no form either way.
    ["Manufacturing", "Heidenhain", null, null],
    ["Manufacturing", "TNC", null, null],
    ["Manufacturing", "Fanuc", null, null],
    ["Manufacturing", "Sinumerik", null, null],
    ["Manufacturing", "M70", null, null],
    ["Manufacturing", "Mazatrol", null, null],
    // Grinding is its own enabled trade: routes there, never here.
    ["Manufacturing", "grinding operator", null, "cnc_grinding"],
  ];
  for (const [domain, role, family, expected] of cases) {
    it(`${JSON.stringify(role)}${family ? ` + pin` : ""} → ${expected ?? "nothing"}`, () => {
      expect(route(domain, role, family)).toBe(expected);
    });
  }
});

describe("E4 Grinding — trade routing (DoD §7.9, trade column)", () => {
  const cases: ReadonlyArray<
    readonly [string | null, string | null, string | null, TradeFormKind | null]
  > = [
    // Occupation-tier: route alone (E4 starter, Turner P4 mirror).
    ["Manufacturing", "cnc grinding", null, "cnc_grinding"],
    ["Manufacturing", "grinding wala", null, "cnc_grinding"],
    ["Manufacturing", "ghisai wala", null, "cnc_grinding"],
    ["Manufacturing", "grinding karta hoon", null, "cnc_grinding"],
    ["Manufacturing", "ghisai karta hoon", null, "cnc_grinding"],
    // Bare machine + family pin corroborates (E4 starter). Stronger still: every
    // "X grinding" phrase carries the occupation word "grinding", so it routes on
    // its OWN evidence with or without a pin — the same asymmetry Turner pins at
    // §8.2 ("CNC turner" under a VMC pin still routes turner). No rival word, no veto.
    ["Manufacturing", "surface grinding", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "cylindrical grinding", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "centreless grinding", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "internal grinding", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "surface grinding", null, "cnc_grinding"],
    ["Manufacturing", "cylindrical grinding", null, "cnc_grinding"],
    ["Manufacturing", "surface grinding", "fam_machining", "cnc_grinding"],
    ["Manufacturing", "surface grinding", "fam_vmc_milling", "cnc_grinding"],
    // Level signals corroborate the pin, never route alone (E4 starter).
    ["Manufacturing", "setting karta hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "job lagata hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "machine chalata hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "production karta hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "running karta hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "setter hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "setting karta hoon", null, null],
    // Not this trade: rival occupations route to their own form, even with a pin.
    ["Manufacturing", "milling", null, "vmc_milling"],
    ["Manufacturing", "milling", "fam_cnc_grinding", "vmc_milling"],
    ["Manufacturing", "VMC", "fam_cnc_grinding", null],
    ["Manufacturing", "turning karta hoon", "fam_cnc_grinding", "cnc_turner"],
    // CAM's words belong to CAM.
    ["Manufacturing", "Mastercam", null, "cam_programmer"],
    ["Manufacturing", "Mastercam", "fam_cnc_grinding", "cam_programmer"],
    // Controllers are capture vocabulary, not routing vocabulary: no form either way.
    ["Manufacturing", "Fanuc", null, null],
    ["Manufacturing", "Siemens", null, null],
  ];
  for (const [domain, role, family, expected] of cases) {
    it(`${JSON.stringify(role)}${family ? ` + pin` : ""} → ${expected ?? "nothing"}`, () => {
      expect(route(domain, role, family)).toBe(expected);
    });
  }
});

describe("E5 CAM — trade routing (DoD §7.9, trade column)", () => {
  const cases: ReadonlyArray<
    readonly [string | null, string | null, string | null, TradeFormKind | null]
  > = [
    // Occupation-tier: route alone (shipped Batch 1 rows, re-pinned here as the
    // E5 baseline the new rows must not move).
    ["Manufacturing", "Mastercam", null, "cam_programmer"],
    ["Manufacturing", "PowerMill", null, "cam_programmer"],
    ["Manufacturing", "cam programmer", null, "cam_programmer"],
    ["Manufacturing", "part programming", null, "cam_programmer"],
    // E5 machine-tier: the toolpath pair corroborates the pin, never routes alone.
    ["Manufacturing", "toolpath", "fam_cam_programming", "cam_programmer"],
    ["Manufacturing", "tool path", "fam_cam_programming", "cam_programmer"],
    ["Manufacturing", "toolpath", null, null],
    ["Manufacturing", "tool path", null, null],
    // E5 level signals corroborate the pin, never route alone.
    ["Manufacturing", "programmer hoon", "fam_cam_programming", "cam_programmer"],
    ["Manufacturing", "senior programmer hoon", "fam_cam_programming", "cam_programmer"],
    ["Manufacturing", "toolpath banata hoon", "fam_cam_programming", "cam_programmer"],
    ["Manufacturing", "programmer hoon", null, null],
    ["Manufacturing", "toolpath banata hoon", null, null],
    // Not this desk: machine trades route to their own forms, even with a CAM pin.
    ["Manufacturing", "milling", null, "vmc_milling"],
    ["Manufacturing", "milling", "fam_cam_programming", "vmc_milling"],
    ["Manufacturing", "turning karta hoon", "fam_cam_programming", "cnc_turner"],
    // Bare software rivals stay out (E5 Q&A): NX/CATIA/Creo resolve nowhere.
    ["Manufacturing", "nx", null, null],
    ["Manufacturing", "catia", null, null],
    ["Manufacturing", "creo", null, null],
  ];
  for (const [domain, role, family, expected] of cases) {
    it(`${JSON.stringify(role)}${family ? ` + pin` : ""} → ${expected ?? "nothing"}`, () => {
      expect(route(domain, role, family)).toBe(expected);
    });
  }
});

describe("§8 rung words resolve to the rung; signal phrases corroborate the trade, never self-resolve (DoD §7.9, level column)", () => {
  // Real level items straight off the v3 packs — no hand-written options, so a
  // pack edit that renames a chip breaks this before it breaks a worker.
  const turnerLevel = loadItem("qp_cnc_turning@4.json", "turning_level");
  const millingLevel = loadItem("qp_vmc_milling@4.json", "milling_level");
  const grindingLevel = loadItem("qp_cnc_grinding@4.json", "grinding_level");
  const camLevel = loadItem("qp_cam_programming@3.json", "cam_level");

  const rungFor = (level: { options: PackOption[] }, text: string) =>
    matchOptions(level as never, text);

  it.each([
    ["Setter", "setter"],
    ["setter hoon", "setter"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Programmer", "programmer"],
    ["Supervisor", "supervisor"],
    ["Helper", "helper"],
    ["Setter-cum-Programmer", "setter_programmer"],
    ["VMC setter", "setter"],
  ])("turning_level: %s → %s", (text, expected) => {
    expect(rungFor(turnerLevel, text as string)).toEqual([expected]);
  });

  it.each([
    ["Setter", "setter"],
    ["setter hoon", "setter"],
    ["VMC programmer", "programmer"],
    // No senior rung on the VMC ladder (spec §8.2 + LADDERS.md): "senior" falls
    // through to the programmer chip, and the separating question sorts out the rest.
    ["Senior Programmer", "programmer"],
  ])("milling_level: %s → %s", (text, expected) => {
    expect(rungFor(millingLevel, text as string)).toEqual([expected]);
  });

  it.each([
    ["Setter", "setter"],
    ["setter hoon", "setter"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Helper", "helper"],
    ["Supervisor", "supervisor"],
    ["Setter-cum-Programmer", "setter_programmer"],
    // No programmer rung on the grinding ladder (LADDERS.md): "programmer" must
    // NOT resolve to a rung here — a grinder claiming it keeps the chips.
    ["Grinding setter", "setter"],
  ])("grinding_level: %s → %s", (text, expected) => {
    expect(rungFor(grindingLevel, text as string)).toEqual([expected]);
  });

  it("grinding_level: programmer claims no rung (no such rung on this ladder)", () => {
    expect(rungFor(grindingLevel, "Programmer" as string)).toEqual([]);
    expect(rungFor(grindingLevel, "programmer hoon" as string)).toEqual([]);
  });

  it.each([
    ["Junior Programmer", "junior_programmer"],
    ["junior programmer hoon", "junior_programmer"],
    ["Programmer", "programmer"],
    ["programmer hoon", "programmer"],
    ["Senior Programmer", "senior_programmer"],
    ["senior programmer hoon", "senior_programmer"],
    ["CAM programmer", "programmer"],
  ])("cam_level: %s → %s", (text, expected) => {
    expect(rungFor(camLevel, text as string)).toEqual([expected]);
  });

  // TRACK A #3 (@4) — the sheet-3 ladder. Old junior/senior-programmer keys
  // live on in frozen @3 (rows above); @4 asks trainee/programmer/senior/
  // lead/supervisor, and the new chips capture the same way.
  const camLevel4 = loadItem("qp_cam_programming@4.json", "cam_level");
  it.each([
    ["Trainee", "trainee"],
    ["trainee hoon", "trainee"],
    ["Programmer", "programmer"],
    ["programmer hoon", "programmer"],
    ["Senior Programmer", "senior"],
    ["senior programmer hoon", "senior"],
    ["Lead", "lead"],
    ["lead hoon", "lead"],
    ["Supervisor", "supervisor"],
    ["CAM programmer", "programmer"],
  ])("cam_level@4: %s → %s", (text, expected) => {
    expect(rungFor(camLevel4, text as string)).toEqual([expected]);
  });

  // The P4 contract, owner-approved: §8 signal phrases corroborate the family pin
  // (asserted in the routing tables above) and NEVER write a rung by themselves.
  // The rung lands when the worker taps a chip or names it. Each null below is the
  // re-ask-with-chips path, bounded by max_asks — never a loop (DoD §7.4).
  it.each([
    "machine chalata hoon",
    "production karta hoon",
    "running karta hoon",
    "setting karta hoon",
    "job lagata hoon",
    "program edit kar leta hoon",
    "program edit karta hoon",
    "program likhta hoon",
    "drawing se program banata hoon",
    "in-charge hoon",
    "line sambhalta hoon",
    "zero lagata hoon",
    "edge finder",
    "probe se zero",
    "tool offset",
    "length offset",
    "H offset",
    "nx se program",
    "सेटर",
  ])("turning/milling level: %s → no self-resolved rung", (text) => {
    expect(rungFor(turnerLevel, text as string)).toEqual([]);
    expect(rungFor(millingLevel, text as string)).toEqual([]);
  });

  // E4: the grinding starter's signal phrases corroborate the family pin (asserted
  // in the E4 routing table above) and NEVER write a rung by themselves — same
  // contract as P4, minus the programmer phrases this ladder has no rung for.
  it.each([
    "machine chalata hoon",
    "production karta hoon",
    "running karta hoon",
    "setting karta hoon",
    "job lagata hoon",
    "सेटर",
  ])("grinding level: %s → no self-resolved rung", (text) => {
    expect(rungFor(grindingLevel, text as string)).toEqual([]);
  });

  // E5: the CAM starter's signal phrases corroborate the family pin (asserted in
  // the E5 routing table above) and NEVER write a rung by themselves.
  it.each(["toolpath banata hoon", "प्रोग्रामर"])(
    "cam level: %s → no self-resolved rung",
    (text) => {
      expect(rungFor(camLevel, text as string)).toEqual([]);
    },
  );
});

describe("§8 machine/controller rows resolve at capture; unlisted spellings re-ask (DoD §7.9, machine/controller columns)", () => {
  it.each([
    ["qp_cnc_turning@4.json", "turning_machine", "CNC lathe", "cnc_lathe"],
    ["qp_cnc_turning@4.json", "turning_machine", "Khraad", "conventional_lathe"],
    // E1: VTL and Swiss labels split to /-forms — the bare words capture now.
    ["qp_cnc_turning@4.json", "turning_machine", "VTL / vertical lathe", "vtl"],
    ["qp_cnc_turning@4.json", "turning_machine", "VTL", "vtl"],
    ["qp_cnc_turning@4.json", "turning_machine", "Swiss / sliding head", "sliding_head"],
    ["qp_cnc_turning@4.json", "turning_machine", "swiss", "sliding_head"],
    // E1: new slot-2 chips. "Turn-mill / turn mill" catches both spellings; the
    // handover veto is untouched (it withholds the FORM, while this captures the
    // machine once the worker is already inside it).
    ["qp_cnc_turning@4.json", "turning_machine", "Turn-mill / turn mill", "turn_mill"],
    ["qp_cnc_turning@4.json", "turning_machine", "turn mill", "turn_mill"],
    ["qp_cnc_turning@4.json", "turning_machine", "live tool", "live_tool"],
    ["qp_cnc_turning@4.json", "turning_machine", "C-axis", "c_axis"],
    ["qp_cnc_turning@4.json", "turning_machine", "C axis", "c_axis"],
    ["qp_cnc_turning@4.json", "turning_machine", "twin spindle", "twin_spindle"],
    // E1: VMC/HMC labels split to /-forms — the bare words capture now.
    ["qp_vmc_milling@4.json", "milling_machine", "VMC / vertical machining centre", "vmc"],
    ["qp_vmc_milling@4.json", "milling_machine", "VMC", "vmc"],
    ["qp_vmc_milling@4.json", "milling_machine", "VMC machine", "vmc"],
    ["qp_vmc_milling@4.json", "milling_machine", "HMC / horizontal machining centre", "hmc"],
    ["qp_vmc_milling@4.json", "milling_machine", "HMC", "hmc"],
    [
      "qp_vmc_milling@4.json",
      "milling_machine",
      "Conventional milling machine",
      "conventional_mill",
    ],
    ["qp_vmc_milling@4.json", "milling_machine", "Bed ya knee type mill", "bed_mill"],
    ["qp_cnc_turning@5.json", "controller_brand", "Fanuc", "fanuc"],
    ["qp_cnc_turning@5.json", "controller_brand", "Fanuc pe", "fanuc"],
    ["qp_cnc_turning@5.json", "controller_brand", "Siemens", "siemens"],
    ["qp_cnc_turning@5.json", "controller_brand", "Siemens / Sinumerik", "siemens"],
    ["qp_cnc_turning@5.json", "controller_brand", "Sinumerik", "siemens"],
    ["qp_cnc_turning@5.json", "controller_brand", "Mitsubishi", "mitsubishi"],
    ["qp_cnc_turning@5.json", "controller_brand", "Mitsubishi / M70", "mitsubishi"],
    ["qp_cnc_turning@5.json", "controller_brand", "M70", "mitsubishi"],
    ["qp_cnc_turning@5.json", "controller_brand", "Haas", "haas"],
    ["qp_cnc_turning@5.json", "controller_brand", "Mazak", "mazak"],
    ["qp_cnc_turning@5.json", "controller_brand", "Mazak / Mazatrol", "mazak"],
    ["qp_cnc_turning@5.json", "controller_brand", "Mazatrol", "mazak"],
    ["qp_vmc_milling@5.json", "controller_brand", "Heidenhain", "heidenhain"],
    ["qp_vmc_milling@5.json", "controller_brand", "Heidenhain / TNC", "heidenhain"],
    ["qp_vmc_milling@5.json", "controller_brand", "TNC", "heidenhain"],
    // "Pata nahi" is a DECLINE, not a capture: the negation mask blanks "nahi"
    // before option matching runs, so no needle lands. DoD §7.3 owns this path
    // ("nahi pata" closes, never re-asks) — asserting the miss pins the division
    // of labour rather than a gap.
    ["qp_cnc_turning@5.json", "controller_brand", "Pata nahi", null],
    ["qp_cnc_grinding@5.json", "controller_brand", "Sinumerik", "siemens"],
    ["qp_cnc_grinding@5.json", "controller_brand", "M70", "mitsubishi"],
    // E1 (@4 grinding-first relabels): the typed "X grinding" variants now hit.
    ["qp_cnc_grinding@4.json", "grinding_machine", "Surface grinding / surface grinder", "surface"],
    [
      "qp_cnc_grinding@4.json",
      "grinding_machine",
      "Cylindrical grinding / cylindrical grinder",
      "cylindrical",
    ],
    [
      "qp_cnc_grinding@4.json",
      "grinding_machine",
      "Centreless grinding / centreless grinder",
      "centreless",
    ],
    [
      "qp_cnc_grinding@4.json",
      "grinding_machine",
      "Internal grinding / internal grinder, ID",
      "internal",
    ],
    ["qp_cnc_grinding@4.json", "grinding_machine", "surface grinding", "surface"],
    ["qp_cnc_grinding@4.json", "grinding_machine", "cylindrical grinding", "cylindrical"],
    ["qp_cnc_grinding@4.json", "grinding_machine", "centreless grinding", "centreless"],
    ["qp_cnc_grinding@4.json", "grinding_machine", "internal grinding", "internal"],
    ["qp_cnc_grinding@4.json", "grinding_machine", "Tool aur cutter grinder", "tool_cutter"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // E1 CLOSED the Turner slot-2 GAP (@4 chips), the VMC bare-word GAP (@4
  // /-relabels), and E2 CLOSES the controller GAP (@5 synonyms). What remains
  // re-asks with chips: the VMC slot-2 FEATURES (axis questions already capture
  // 4/5-axis + rotary — see axis_capability) and the rival word VMC on the
  // Turner question.
  //
  // TRACK A #1 (@6) NARROWS THE TURNER GAP FURTHER: the sheet-1 machine set
  // keeps VMC a re-ask (still no VMC chip), while the merged "Turn-mill /
  // live tool" chip keeps bare "live tool" capturing and the dropped c_axis
  // machine chip moves that word to the re-ask set (C-axis lives on the
  // advanced_capability row).
  // TRACK A #2 (@6) LEAVES THE VMC GAP AS-IS: the "+"-joined "VMC + 4th
  // axis" chip captures its full label, but bare "4th axis", "5 axis",
  // "rotary table" and "indexer" still re-ask ("+"/"-" labels do not split
  // the way "/" labels do - E1 mechanism), as do "horizontal", "trunnion",
  // "dmg" and "milling machine".
  it.each([
    ["qp_cnc_turning@5.json", "turning_machine", "VMC"],
    ["qp_cnc_turning@6.json", "turning_machine", "VMC"],
    ["qp_cnc_turning@6.json", "turning_machine", "C-axis"],
    ["qp_vmc_milling@5.json", "milling_machine", "horizontal"],
    ["qp_vmc_milling@5.json", "milling_machine", "4th axis"],
    ["qp_vmc_milling@5.json", "milling_machine", "rotary table"],
    ["qp_vmc_milling@5.json", "milling_machine", "indexer"],
    ["qp_vmc_milling@5.json", "milling_machine", "5 axis"],
    ["qp_vmc_milling@5.json", "milling_machine", "trunnion"],
    ["qp_vmc_milling@5.json", "milling_machine", "dmg"],
    ["qp_vmc_milling@5.json", "milling_machine", "milling machine"],
    ["qp_vmc_milling@6.json", "milling_machine", "horizontal"],
    ["qp_vmc_milling@6.json", "milling_machine", "milling machine"],
    ["qp_vmc_milling@6.json", "milling_machine", "dmg"],
    ["qp_vmc_milling@6.json", "milling_machine", "4th axis"],
    ["qp_vmc_milling@6.json", "milling_machine", "5 axis"],
    ["qp_vmc_milling@6.json", "milling_machine", "indexer"],
    ["qp_vmc_milling@6.json", "milling_machine", "trunnion"],
  ] as ReadonlyArray<readonly [string, string, string]>)(
    "%s %s: %s → re-ask (no chip label matches)",
    (packFile, questionKey, text) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual([]);
    },
  );

  // TRACK A #1 (@6) — the retagged Turner set resolves at capture: the /-forms
  // split the bare words (E1 mechanism, carried forward), the own-value
  // Mazatrol chip captures the bare word (E2 synonym made a value), and the
  // new Advanced rows capture their sheet-1 words.
  it.each([
    // Machine (slot-2 set per sheet 1 + kept history chips).
    ["qp_cnc_turning@6.json", "turning_machine", "CNC lathe 2-axis", "cnc_lathe"],
    ["qp_cnc_turning@6.json", "turning_machine", "Turn-mill / live tool", "turn_mill"],
    ["qp_cnc_turning@6.json", "turning_machine", "live tool", "turn_mill"],
    ["qp_cnc_turning@6.json", "turning_machine", "Twin spindle", "twin_spindle"],
    ["qp_cnc_turning@6.json", "turning_machine", "twin spindle", "twin_spindle"],
    ["qp_cnc_turning@6.json", "turning_machine", "Swiss / sliding head", "sliding_head"],
    ["qp_cnc_turning@6.json", "turning_machine", "VTL / vertical lathe", "vtl"],
    ["qp_cnc_turning@6.json", "turning_machine", "CNC + conventional dono", "both_types"],
    ["qp_cnc_turning@6.json", "turning_machine", "Khraad ya conventional lathe", "conventional_lathe"],
    ["qp_cnc_turning@6.json", "turning_machine", "SPM machine", "spm"],
    // Controller (Mazatrol as its own value; Fagor/Syntec new).
    ["qp_cnc_turning@6.json", "controller_brand", "Fanuc", "fanuc"],
    ["qp_cnc_turning@6.json", "controller_brand", "Siemens / Sinumerik", "siemens"],
    ["qp_cnc_turning@6.json", "controller_brand", "Mitsubishi / M70", "mitsubishi"],
    ["qp_cnc_turning@6.json", "controller_brand", "Mazatrol", "mazatrol"],
    ["qp_cnc_turning@6.json", "controller_brand", "Fagor", "fagor"],
    ["qp_cnc_turning@6.json", "controller_brand", "Syntec", "syntec"],
    ["qp_cnc_turning@6.json", "controller_brand", "Pata nahi", null],
    // Advanced rows (sheet 1 Q9–Q12).
    ["qp_cnc_turning@6.json", "turning_operation", "Hard turning", "hard_turning"],
    ["qp_cnc_turning@6.json", "material_worked", "Titanium / Inconel", "titanium"],
    ["qp_cnc_turning@6.json", "material_worked", "Plastics", "plastic"],
    ["qp_cnc_turning@6.json", "tolerance_band", "0.005 mm / H7 tak", "0.005"],
    ["qp_cnc_turning@6.json", "sector_worked", "Two-wheeler parts", "two_wheeler"],
    ["qp_cnc_turning@6.json", "sector_worked", "Bearing ke parts", "bearings"],
    ["qp_cnc_turning@6.json", "sector_worked", "Fastener", "fasteners"],
    // Separating confirms (self/other VALUES resolve; option keys are chips).
    ["qp_cnc_turning@6.json", "setting_confirm", "Khud karta hoon", "self"],
    ["qp_cnc_turning@6.json", "setting_confirm", "Koi aur karta hai", "other"],
    ["qp_cnc_turning@6.json", "program_edit_confirm", "Khud likhta hoon", "self"],
    ["qp_cnc_turning@6.json", "program_edit_confirm", "Edit hi karta hoon", "other"],
    ["qp_cnc_turning@6.json", "program_write_confirm", "Haan, khud banata hoon", "self"],
    ["qp_cnc_turning@6.json", "program_write_confirm", "Bana-banaya chalata hoon", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK A #2 (@6) — the retagged VMC/HMC set resolves at capture: the
  // /-forms split the bare words (E1 mechanism, carried forward), the sheet-2
  // machine variants capture their words, and the unified Advanced rows
  // capture the Turner-shared vocabulary.
  it.each([
    // Machine (slot-2 set per sheet 2 + kept history chips).
    ["qp_vmc_milling@6.json", "milling_machine", "VMC 3-axis", "vmc"],
    ["qp_vmc_milling@6.json", "milling_machine", "VMC + 4th axis", "fourth_axis"],
    ["qp_vmc_milling@6.json", "milling_machine", "5-axis", "five_axis"],
    ["qp_vmc_milling@6.json", "milling_machine", "HMC / horizontal machining centre", "hmc"],
    ["qp_vmc_milling@6.json", "milling_machine", "HMC", "hmc"],
    ["qp_vmc_milling@6.json", "milling_machine", "Drill-tap centre", "drill_tap"],
    ["qp_vmc_milling@6.json", "milling_machine", "Double-column / large bed", "double_column"],
    ["qp_vmc_milling@6.json", "milling_machine", "Conventional milling machine", "conventional_mill"],
    ["qp_vmc_milling@6.json", "milling_machine", "Bed ya knee type mill", "bed_mill"],
    ["qp_vmc_milling@6.json", "milling_machine", "SPM machine", "spm"],
    // Controller (+Fagor/Syntec).
    ["qp_vmc_milling@6.json", "controller_brand", "Heidenhain / TNC", "heidenhain"],
    ["qp_vmc_milling@6.json", "controller_brand", "Fagor", "fagor"],
    ["qp_vmc_milling@6.json", "controller_brand", "Syntec", "syntec"],
    ["qp_vmc_milling@6.json", "controller_brand", "Pata nahi", null],
    // Operations (sheet 2 Q9 additions).
    ["qp_vmc_milling@6.json", "milling_operation", "Thread mill", "thread_mill"],
    ["qp_vmc_milling@6.json", "milling_operation", "3D surface", "three_d_surface"],
    ["qp_vmc_milling@6.json", "milling_operation", "Engraving", "engraving"],
    // Materials (unified to the Turner set).
    ["qp_vmc_milling@6.json", "material_worked", "EN8, EN31 alloy steel", "alloy_steel"],
    ["qp_vmc_milling@6.json", "material_worked", "Brass ya copper", "brass"],
    ["qp_vmc_milling@6.json", "material_worked", "Titanium / Inconel", "titanium"],
    ["qp_vmc_milling@6.json", "material_worked", "Plastics", "plastic"],
    ["qp_vmc_milling@6.json", "tolerance_band", "0.005 mm / H7 tak", "0.005"],
    // Industry (sheet 2 Q12 additions).
    ["qp_vmc_milling@6.json", "sector_worked", "SPM / machine parts", "spm_parts"],
    ["qp_vmc_milling@6.json", "sector_worked", "Electronics / EMS", "electronics"],
    // Separating confirms (self/other VALUES resolve).
    ["qp_vmc_milling@6.json", "milling_setting_confirm", "Khud karta hoon", "self"],
    ["qp_vmc_milling@6.json", "milling_setting_confirm", "Koi aur karta hai", "other"],
    ["qp_vmc_milling@6.json", "milling_program_write_confirm", "Haan, khud banata hoon", "self"],
    ["qp_vmc_milling@6.json", "milling_program_write_confirm", "Bana-banaya chalata hoon", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK A #3 (@4) — the sheet-3 machine/controller/software sets resolve at
  // capture. Bare "EDM" hits the "Wire-cut / EDM" chip, but bare "Wire cut"
  // re-asks (hyphen-joined labels do not split — same finding as Track A #2).
  it.each([
    ["qp_cam_programming@4.json", "machine_programmed", "VMC 3-axis", "vmc_three_axis"],
    ["qp_cam_programming@4.json", "machine_programmed", "VMC 4-axis", "vmc_four_axis"],
    ["qp_cam_programming@4.json", "machine_programmed", "5-axis trunnion", "five_axis_trunnion"],
    ["qp_cam_programming@4.json", "machine_programmed", "Turn-mill", "turn_mill"],
    ["qp_cam_programming@4.json", "machine_programmed", "CNC Turning", "cnc_turning"],
    ["qp_cam_programming@4.json", "machine_programmed", "Wire-cut / EDM", "wirecut_edm"],
    ["qp_cam_programming@4.json", "machine_programmed", "EDM", "wirecut_edm"],
    ["qp_cam_programming@4.json", "machine_programmed", "Router", "router"],
    ["qp_cam_programming@4.json", "controller_brand", "Fanuc", "fanuc"],
    ["qp_cam_programming@4.json", "controller_brand", "Heidenhain", "heidenhain"],
    ["qp_cam_programming@4.json", "controller_brand", "Siemens", "siemens"],
    ["qp_cam_programming@4.json", "controller_brand", "Mitsubishi", "mitsubishi"],
    ["qp_cam_programming@4.json", "controller_brand", "Haas", "haas"],
    ["qp_cam_programming@4.json", "controller_brand", "Mazatrol", "mazatrol"],
    ["qp_cam_programming@4.json", "controller_brand", "Pata nahi", null],
    ["qp_cam_programming@4.json", "cam_software", "NX CAM", "nx_cam"],
    ["qp_cam_programming@4.json", "cam_software", "Fusion 360", "fusion"],
    ["qp_cam_programming@4.json", "cam_software", "hyperMILL", "hypermill"],
    ["qp_cam_programming@4.json", "cam_software", "Cimatron", "cimatron"],
    ["qp_cam_programming@4.json", "cam_software", "WorkNC", "worknc"],
    ["qp_cam_programming@4.json", "cam_software", "ESPRIT", "esprit"],
    ["qp_cam_programming@4.json", "cam_software", "Manual G-code only", "manual_gcode"],
    // Separating confirms (self/other VALUES resolve).
    ["qp_cam_programming@4.json", "cam_program_confirm", "Haan, khud banata hoon", "self"],
    ["qp_cam_programming@4.json", "cam_program_confirm", "Bana-banaya chalata hoon", "other"],
    ["qp_cam_programming@4.json", "cam_senior_confirm", "Haan, khud karta hoon", "self"],
    ["qp_cam_programming@4.json", "cam_lead_confirm", "Haan, main chalata hoon", "self"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );
});
