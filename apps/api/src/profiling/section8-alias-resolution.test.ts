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
    // Phase 2 #2 (sheet 15 "Words"): the part/process compounds and the new
    // machine term carry "grinding"/"grinder", so they route on their own too.
    ["Manufacturing", "thread grinding", null, "cnc_grinding"],
    ["Manufacturing", "gear grinding", null, "cnc_grinding"],
    ["Manufacturing", "bore grinding", null, "cnc_grinding"],
    ["Manufacturing", "bearing grinding", null, "cnc_grinding"],
    ["Manufacturing", "shaft grinding", null, "cnc_grinding"],
    ["Manufacturing", "crank grinding", null, "cnc_grinding"],
    ["Manufacturing", "double disc grinder", null, "cnc_grinding"],
    ["Manufacturing", "gear grinding", "fam_machining", "cnc_grinding"],
    // Phase 2 #2: the bottom rung's words corroborate the pin, never route alone.
    ["Manufacturing", "trainee hoon", "fam_cnc_grinding", "cnc_grinding"],
    ["Manufacturing", "trainee hoon", null, null],
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

  // TRACK A #5 (@2) — the sheet-5 ladder. CAD had no level question before, so
  // there are no frozen rows; @2 asks trainee/designer (Draughtsman)/senior/
  // lead/supervisor, and the chips capture the same way.
  const cadLevel2 = loadItem("qp_cad_drafting@2.json", "cad_level");
  it.each([
    ["Trainee", "trainee"],
    ["trainee hoon", "trainee"],
    ["Draughtsman", "designer"],
    ["draughtsman hoon", "designer"],
    ["Senior Draughtsman", "senior_designer"],
    ["Lead / Checker", "lead"],
    ["lead hoon", "lead"],
    ["Head", "supervisor"],
  ])("design_level@2: %s → %s", (text, expected) => {
    expect(rungFor(cadLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #1 (@2) — the sheet-6 ladder. Old helper/fitter/senior_fitter keys
  // live on in frozen @1 (no rung block existed then); @2 asks helper/fitter/
  // skilled/senior_fitter/supervisor, and the chips capture the same way.
  const fitterLevel2 = loadItem("qp_fitter@2.json", "fitter_level");
  it.each([
    ["Helper", "helper"],
    ["helper hoon", "helper"],
    ["Fitter", "fitter"],
    ["fitter hoon", "fitter"],
    ["Skilled Fitter", "skilled"],
    ["skilled fitter hoon", "skilled"],
    ["Senior Fitter", "senior_fitter"],
    ["senior fitter hoon", "senior_fitter"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("fitter_level@2: %s → %s", (text, expected) => {
    expect(rungFor(fitterLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #2 (@2) — the sheet-7 ladder. Old helper/electrician/senior keys
  // live on in frozen @1 (no rung block existed then); @2 asks helper/
  // electrician/senior/supervisor, and the chips capture the same way.
  const electricianLevel2 = loadItem("qp_industrial_electrician@2.json", "electrician_level");
  it.each([
    ["Helper", "helper"],
    ["helper hoon", "helper"],
    ["Electrician", "electrician"],
    ["electrician hoon", "electrician"],
    ["Senior Electrician", "senior"],
    ["senior electrician hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("electrician_level@2: %s → %s", (text, expected) => {
    expect(rungFor(electricianLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #3 (@2) — the sheet-8 ladder. Old helper/welder/certified_welder
  // keys live on in frozen @1 (no rung block existed then); @2 asks helper/
  // welder/skilled/senior/supervisor, the history chip still captures, and the
  // new rungs capture the same way. Full chip labels resolve singly; a bare
  // rung word beside the Welder option (e.g. "skilled welder hoon") matches
  // both and falls to the re-ask path — never a wrong rung.
  const welderLevel2 = loadItem("qp_welding_trade@2.json", "welder_level");
  it.each([
    ["Helper", "helper"],
    ["helper hoon", "helper"],
    ["Welder", "welder"],
    ["welder hoon", "welder"],
    ["Skilled / TIG / Certified", "certified_welder"],
    ["Senior Welder", "senior"],
    ["senior welder hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("welder_level@2: %s → %s", (text, expected) => {
    expect(rungFor(welderLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #4 (@2) — the sheet-9 ladder. Old helper/operator/skilled keys
  // live on in frozen @1 (no rung block existed then); @2 asks helper/
  // operator/skilled/senior/supervisor, and the chips capture the same way.
  const machiningLevel2 = loadItem("qp_conventional_machining@2.json", "machining_level");
  it.each([
    ["Helper", "helper"],
    ["helper hoon", "helper"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Skilled Machinist", "skilled"],
    ["skilled hoon", "skilled"],
    ["Senior", "senior"],
    ["senior hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("machining_level@2: %s → %s", (text, expected) => {
    expect(rungFor(machiningLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #5 (@2) — the sheet-10 ladder. Old helper/operator/skilled keys
  // live on in frozen @1 (no rung block existed then); @2 asks helper/
  // operator/skilled/senior/supervisor, and the chips capture the same way.
  const sheetLevel2 = loadItem("qp_sheet_metal_fab@2.json", "sheet_metal_level");
  it.each([
    ["Helper", "helper"],
    ["helper hoon", "helper"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Skilled", "skilled"],
    ["skilled hoon", "skilled"],
    ["Senior / Programmer", "senior"],
    ["senior hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("sheet_metal_level@2: %s → %s", (text, expected) => {
    expect(rungFor(sheetLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #6 (@2) — the sheet-11 ladder. Old helper/operator/skilled keys
  // live on in frozen @1 (no rung block existed then); @2 asks trainee/line
  // operator/assembly-technician/line-leader/supervisor, and the chips capture
  // the same way. Full chip phrases resolve; the bare rung words land through
  // the chips (the Turner-through-Sheet-metal convention).
  const assemblyLevel2 = loadItem("qp_assembly_line@2.json", "assembly_level");
  it.each([
    ["Trainee", "helper"],
    ["trainee hoon", "helper"],
    ["Line Operator", "operator"],
    ["line operator hoon", "operator"],
    ["Assembly Technician", "skilled"],
    ["assembly technician hoon", "skilled"],
    ["Line Leader", "senior"],
    ["line leader hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("assembly_level@2: %s → %s", (text, expected) => {
    expect(rungFor(assemblyLevel2, text as string)).toEqual([expected]);
  });

  // TRACK B #7 (@2) — the sheet-12 ladder. Old inspector/qc_engineer keys
  // live on in frozen @1 (no rung block existed then); @2 asks trainee/
  // inspector/senior-inspector/qc-engineer/supervisor, and the chips capture
  // the same way. Full chip phrases resolve (the all-tracks convention).
  const qcLevel2 = loadItem("qp_quality_inspection@2.json", "inspection_level");
  it.each([
    ["Trainee", "trainee"],
    ["trainee hoon", "trainee"],
    ["Inspector", "inspector"],
    ["inspector hoon", "inspector"],
    ["Senior Inspector", "senior_inspector"],
    ["senior inspector hoon", "senior_inspector"],
    ["QC Engineer", "qc_engineer"],
    ["qc engineer hoon", "qc_engineer"],
    ["QC Head", "supervisor"],
    ["qc head hoon", "supervisor"],
  ])("inspection_level@2: %s → %s", (text, expected) => {
    expect(rungFor(qcLevel2, text as string)).toEqual([expected]);
  });

  // PHASE 2 #1 (@2) — the sheet-13 ladder. Old trainee/tool-maker/senior keys
  // live on in frozen @1 (no rung block existed then); @2 asks trainee/
  // operator/skilled/senior/supervisor, the history chip still captures, and
  // the new rungs capture the same way.
  const toolLevel2 = loadItem("qp_tool_die_making@2.json", "toolroom_level");
  it.each([
    ["Trainee", "trainee"],
    ["trainee hoon", "trainee"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Skilled / Tool maker", "tool_maker"],
    ["tool maker hoon", "tool_maker"],
    // No bare `skilled` chip exists — the word lands on the rung's own chip,
    // which aliases to skilled downstream.
    ["skilled hoon", "tool_maker"],
    ["Senior", "senior"],
    ["senior hoon", "senior"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("toolroom_level@2: %s → %s", (text, expected) => {
    expect(rungFor(toolLevel2, text as string)).toEqual([expected]);
  });

  // PHASE 2 #2 (@6) — the sheet-15 ladder. The first chip reads "Helper/Trainee"
  // and stores `trainee` (Turner @6 precedent); @5's `helper` lives on frozen.
  const grindingLevel6 = loadItem("qp_cnc_grinding@6.json", "grinding_level");
  it.each([
    ["Helper/Trainee", "trainee"],
    ["Helper", "trainee"],
    ["Trainee", "trainee"],
    ["trainee hoon", "trainee"],
    ["Operator", "operator"],
    ["operator hoon", "operator"],
    ["Setter", "setter"],
    ["setter hoon", "setter"],
    ["Setter-cum-Programmer", "setter_programmer"],
    ["Supervisor", "supervisor"],
    ["supervisor hoon", "supervisor"],
  ])("grinding_level@6: %s → %s", (text, expected) => {
    expect(rungFor(grindingLevel6, text as string)).toEqual([expected]);
  });

  it("grinding_level@6: programmer still claims no rung (no such rung on sheet 15)", () => {
    expect(rungFor(grindingLevel6, "Programmer" as string)).toEqual([]);
    expect(rungFor(grindingLevel6, "programmer hoon" as string)).toEqual([]);
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

  // TRACK A #5 (@2) — the sheet-5 software/work-area sets and the separating
  // confirms resolve at capture. The AutoCAD Mechanical / DraftSight / ZWCAD /
  // BricsCAD chips are new; the kept history chips (SolidWorks, Fusion, Creo,
  // CATIA) capture the same way.
  it.each([
    ["qp_cad_drafting@2.json", "cad_software", "AutoCAD", "autocad"],
    ["qp_cad_drafting@2.json", "cad_software", "AutoCAD Mechanical", "autocad_mech"],
    ["qp_cad_drafting@2.json", "cad_software", "DraftSight", "draftsight"],
    ["qp_cad_drafting@2.json", "cad_software", "ZWCAD", "zwcad"],
    ["qp_cad_drafting@2.json", "cad_software", "BricsCAD", "bricscad"],
    ["qp_cad_drafting@2.json", "cad_software", "SolidWorks", "solidworks"],
    ["qp_cad_drafting@2.json", "cad_software", "Fusion 360", "fusion"],
    // The none-of-above chips capture `unknown` (their stored value); the
    // engine — not capture — decides what that closes.
    ["qp_cad_drafting@2.json", "cad_software", "Koi aur software", "unknown"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Machine parts", "machine_parts"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Sheet metal", "sheetmetal_fab"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Structural", "structural"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Conveyor / SPM", "conveyor_spm"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Electrical / panel", "elec_panel"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Piping", "piping"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Civil / architecture", "civil_arch"],
    ["qp_cad_drafting@2.json", "drawing_subject", "Koi aur", "unknown"],
    ["qp_cad_drafting@2.json", "drawing_from_model", "Haan, nikalta hoon", "yes"],
    ["qp_cad_drafting@2.json", "cad_senior_confirm", "Haan, check karta hoon", "self"],
    ["qp_cad_drafting@2.json", "cad_senior_confirm", "Nahi, sirf apni dekhta hoon", "other"],
    ["qp_cad_drafting@2.json", "cad_lead_confirm", "Haan, mere naam se jaati hain", "self"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #1 (@2) — the sheet-6 work-type/industry sets and the separating
  // confirms resolve at capture. The pipe/structural/die-press work chips and
  // the SPM/fabrication/pumps industry chips are new; the kept history chips
  // capture the same way.
  it.each([
    ["qp_fitter@2.json", "fitter_work_type", "Mechanical assembly", "assembly_fitting"],
    ["qp_fitter@2.json", "fitter_work_type", "Maintenance fitting", "maintenance_fitting"],
    ["qp_fitter@2.json", "fitter_work_type", "Pipe fitting", "pipe_fitting"],
    ["qp_fitter@2.json", "fitter_work_type", "Structural fitting", "structural_fitting"],
    ["qp_fitter@2.json", "fitter_work_type", "Machine erection / commissioning", "erection_commissioning"],
    ["qp_fitter@2.json", "fitter_work_type", "Die / press fitting", "die_press_fitting"],
    ["qp_fitter@2.json", "fitter_work_type", "Bench fitting", "bench_fitting"],
    ["qp_fitter@2.json", "sector_worked", "Auto components", "auto_components"],
    ["qp_fitter@2.json", "sector_worked", "SPM / machine building", "spm_machine_building"],
    ["qp_fitter@2.json", "sector_worked", "Fabrication", "fabrication"],
    ["qp_fitter@2.json", "sector_worked", "Pumps / compressors", "pumps_compressors"],
    ["qp_fitter@2.json", "sector_worked", "Plant maintenance", "plant_maintenance"],
    ["qp_fitter@2.json", "measuring_tools", "Height gauge", "height_gauge"],
    ["qp_fitter@2.json", "fitter_skilled_confirm", "Khud kar leta hoon", "self"],
    ["qp_fitter@2.json", "fitter_skilled_confirm", "Senior ke saath karta hoon", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #2 (@2) — the sheet-7 work-type/equipment sets and the separating
  // confirm resolve at capture. The factory/HT-LT/solar/generator work chips
  // and the contactor/sensor/PLC-panel/transformer/UPS equipment chips are new;
  // the kept history chips capture the same way.
  it.each([
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Factory maintenance", "factory_maintenance"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Panel wiring / control panel", "panel_wiring"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Motor & drive", "motor_drive"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "HT / LT substation", "ht_lt_substation"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Solar", "solar"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Generator / DG", "generator_dg"],
    ["qp_industrial_electrician@2.json", "electrical_work_type", "Building wiring", "lighting_power"],
    ["qp_industrial_electrician@2.json", "electrical_equipment", "Contactors & relays", "contactor_relay"],
    ["qp_industrial_electrician@2.json", "electrical_equipment", "Sensors", "sensors"],
    ["qp_industrial_electrician@2.json", "electrical_equipment", "PLC panel (wiring only)", "plc_panel_wiring"],
    ["qp_industrial_electrician@2.json", "electrical_equipment", "Transformer", "transformer"],
    ["qp_industrial_electrician@2.json", "electrical_equipment", "UPS / batteries", "ups_battery"],
    ["qp_industrial_electrician@2.json", "measuring_tools", "Thermal camera", "thermal_camera"],
    ["qp_industrial_electrician@2.json", "electrician_senior_confirm", "Khud dhoondh ke theek karta hoon", "self"],
    ["qp_industrial_electrician@2.json", "electrician_senior_confirm", "Senior ko batata hoon", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #3 (@2) — the sheet-8 process/material/position sets, the new
  // certificate row and the separating confirms resolve at capture. The
  // robotic/gas-brazing/submerged process chips, the alloy/copper materials,
  // the pipe-6G position and the certificate chips are new; the kept history
  // chips capture the same way. New process chips derive no match skill
  // (no robotic/submerged vocabulary — reach unchanged, pinned above).
  it.each([
    ["qp_welding_trade@2.json", "welding_process", "MIG / CO2", "mig_mag"],
    ["qp_welding_trade@2.json", "welding_process", "TIG / Argon", "tig"],
    ["qp_welding_trade@2.json", "welding_process", "Arc / stick", "arc"],
    ["qp_welding_trade@2.json", "welding_process", "Robotic welding", "robotic"],
    ["qp_welding_trade@2.json", "welding_process", "Gas / brazing", "gas_brazing"],
    ["qp_welding_trade@2.json", "welding_process", "Submerged arc", "submerged_arc"],
    ["qp_welding_trade@2.json", "welding_process", "Spot welding", "spot"],
    ["qp_welding_trade@2.json", "material_worked", "Alloy steel", "alloy_steel"],
    ["qp_welding_trade@2.json", "material_worked", "Copper / brass", "copper_brass"],
    ["qp_welding_trade@2.json", "welding_position", "Flat (1G)", "flat"],
    ["qp_welding_trade@2.json", "welding_position", "Pipe (6G)", "pipe_six_g"],
    ["qp_welding_trade@2.json", "welder_certificate", "Haan, IBR / ASME / third party", "cert_ibr"],
    ["qp_welding_trade@2.json", "welder_certificate", "ITI Welder", "iti_welder"],
    ["qp_welding_trade@2.json", "welder_certificate", "Company test pass kiya", "company_test"],
    ["qp_welding_trade@2.json", "welder_skilled_confirm", "Haan, karta hoon", "self"],
    ["qp_welding_trade@2.json", "welder_skilled_confirm", "Nahi, nahi kiya", "other"],
    ["qp_welding_trade@2.json", "welder_senior_confirm", "Haan, main karta hoon", "self"],
    ["qp_welding_trade@2.json", "welder_senior_confirm", "Nahi, senior karte hain", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #4 (@2) — the sheet-9 machine/operation/material sets, the CNC
  // crossover, the work-type row and the separating confirms resolve at
  // capture. The grinder/hacksaw machine chips, the taper/keyway/gear/grinding
  // operation chips, the alloy/titanium/plastic material chips and the 0.005
  // tolerance chip are new; the kept history chips capture the same way.
  it.each([
    ["qp_conventional_machining@2.json", "machining_machine", "Lathe (manual)", "centre_lathe"],
    ["qp_conventional_machining@2.json", "machining_machine", "Milling (manual)", "vertical_milling"],
    ["qp_conventional_machining@2.json", "machining_machine", "Drilling / radial drill", "radial_drill"],
    ["qp_conventional_machining@2.json", "machining_machine", "Surface grinder", "surface_grinder"],
    ["qp_conventional_machining@2.json", "machining_machine", "Cylindrical grinder", "cylindrical_grinder"],
    ["qp_conventional_machining@2.json", "machining_machine", "Hacksaw / bandsaw", "hacksaw_bandsaw"],
    ["qp_conventional_machining@2.json", "machining_machine", "Boring", "boring_machine"],
    ["qp_conventional_machining@2.json", "machining_cnc", "Haan", "yes"],
    ["qp_conventional_machining@2.json", "machining_cnc", "Thoda (operator)", "some"],
    ["qp_conventional_machining@2.json", "machining_operation", "Turning", "turning_facing"],
    ["qp_conventional_machining@2.json", "machining_operation", "Facing", "facing_op"],
    ["qp_conventional_machining@2.json", "machining_operation", "Threading", "screw_cutting"],
    ["qp_conventional_machining@2.json", "machining_operation", "Taper", "taper_op"],
    ["qp_conventional_machining@2.json", "machining_operation", "Keyway", "keyway"],
    ["qp_conventional_machining@2.json", "machining_operation", "Gear cutting", "gear_cutting"],
    ["qp_conventional_machining@2.json", "machining_operation", "Slotting", "milling_slotting"],
    ["qp_conventional_machining@2.json", "machining_operation", "Grinding", "grinding_op"],
    ["qp_conventional_machining@2.json", "material_worked", "EN8, EN31 alloy steel", "alloy_steel"],
    ["qp_conventional_machining@2.json", "material_worked", "Titanium / Inconel", "titanium"],
    ["qp_conventional_machining@2.json", "material_worked", "Plastics", "plastic"],
    ["qp_conventional_machining@2.json", "machining_work_type", "Production batch", "batch_production"],
    ["qp_conventional_machining@2.json", "machining_work_type", "Job work", "job_work"],
    ["qp_conventional_machining@2.json", "machining_work_type", "Tool room", "tool_room"],
    ["qp_conventional_machining@2.json", "machining_work_type", "Repair / maintenance", "repair_maintenance"],
    ["qp_conventional_machining@2.json", "machining_work_type", "Forging / casting finishing", "forge_cast_finish"],
    ["qp_conventional_machining@2.json", "machining_skilled_confirm", "Haan, khud nikaal leta hoon", "self"],
    ["qp_conventional_machining@2.json", "machining_skilled_confirm", "Nahi, senior karte hain", "other"],
    ["qp_conventional_machining@2.json", "machining_senior_confirm", "Haan, main karta hoon", "self"],
    ["qp_conventional_machining@2.json", "machining_senior_confirm", "Nahi, senior karte hain", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #5 (@2) — the sheet-10 machine/product/operation/material/thickness
  // sets, the work-type/extra rows and the separating confirms resolve at
  // capture. The CO2-laser/manual-brake/hand-fab machine chips, the product
  // chips, the taper/keyway/gear/grinding operation chips, the re-banded
  // thickness chips and the extra-work chips are new; the kept history chips
  // capture the same way.
  it.each([
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Fibre laser", "fibre_laser"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "CO2 laser", "co_two_laser"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Press brake (CNC)", "cnc_press_brake"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Press brake (manual)", "manual_press_brake"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Turret punch / CNC punch", "turret_punch"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Shearing", "shearing"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Plasma / waterjet", "plasma_cutting"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_machine", "Hand fabrication only", "hand_fab"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Panels / enclosures", "panels_enclosures"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Auto parts", "auto_parts"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Ducting / HVAC", "ducting_hvac"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Furniture", "furniture"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Structural / brackets", "structural_brackets"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Kitchen / SS products", "kitchen_ss"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_product", "Koi aur", "unknown"],
    ["qp_sheet_metal_fab@2.json", "material_worked", "MS", "ms_sheet"],
    ["qp_sheet_metal_fab@2.json", "material_worked", "SS", "stainless"],
    ["qp_sheet_metal_fab@2.json", "material_worked", "GI", "gi_sheet"],
    ["qp_sheet_metal_fab@2.json", "sheet_thickness", "1 se 3 mm", "one_to_three"],
    ["qp_sheet_metal_fab@2.json", "sheet_thickness", "6 mm se zyada", "above_six"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_extra", "Welding", "welding"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_extra", "Grinding / finishing", "grinding_finish"],
    ["qp_sheet_metal_fab@2.json", "sheet_metal_extra", "Powder-coat prep", "powdercoat_prep"],
    ["qp_sheet_metal_fab@2.json", "sheet_skilled_confirm", "Khud set karta hoon", "self"],
    ["qp_sheet_metal_fab@2.json", "sheet_skilled_confirm", "Set kiya hua chalata hoon", "other"],
    ["qp_sheet_metal_fab@2.json", "sheet_senior_confirm", "Haan, khud banata hoon", "self"],
    ["qp_sheet_metal_fab@2.json", "sheet_senior_confirm", "Nahi, bana-banaya chalata hoon", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #6 (@2) — the sheet-11 product/tools/skills/company rows and the
  // separating confirms resolve at capture. The segment product chips, the
  // hand/press-jig/soldering/test-bench tool chips, the skills/company rows
  // and the confirms are new; the kept history chips capture the same way.
  it.each([
    ["qp_assembly_line@2.json", "assembly_line_product", "Auto / 2-wheeler", "auto_two_wheeler"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Engine / gearbox / axle", "engine_gearbox_axle"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Electrical / switchgear", "elec_switchgear"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Appliances", "appliances"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Electronics / EMS", "electronics_ems"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Machines / SPM", "machines_spm"],
    ["qp_assembly_line@2.json", "assembly_line_product", "Pumps / motors", "pumps_motors"],
    ["qp_assembly_line@2.json", "assembly_line_product", "EV / battery pack", "ev_battery"],
    ["qp_assembly_line@2.json", "assembly_tool", "Hand tools", "hand_tools"],
    ["qp_assembly_line@2.json", "assembly_tool", "Press / jig fixtures", "press_jig"],
    ["qp_assembly_line@2.json", "assembly_tool", "Soldering / crimping", "soldering_crimping"],
    ["qp_assembly_line@2.json", "assembly_tool", "Test bench", "test_bench"],
    ["qp_assembly_line@2.json", "assembly_skill", "Testing & inspection", "testing_inspection"],
    ["qp_assembly_line@2.json", "assembly_skill", "Troubleshooting / rework", "troubleshoot_rework"],
    ["qp_assembly_line@2.json", "assembly_skill", "Line changeover", "line_changeover"],
    ["qp_assembly_line@2.json", "assembly_skill", "Kaizen / 5S", "kaizen_five_s"],
    ["qp_assembly_line@2.json", "assembly_skill", "Training others", "training_others"],
    ["qp_assembly_line@2.json", "company_type", "OEM", "oem"],
    ["qp_assembly_line@2.json", "company_type", "Tier-1", "tier_one"],
    ["qp_assembly_line@2.json", "company_type", "Contract (thekedar)", "contract"],
    ["qp_assembly_line@2.json", "assembly_skilled_confirm", "Haan, khud kar leta hoon", "self"],
    ["qp_assembly_line@2.json", "assembly_skilled_confirm", "Nahi, senior karte hain", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // TRACK B #7 (@2) — the sheet-12 instrument/inspection/material/drawing
  // rows, the systems chips and the separating confirms resolve at capture.
  // The split vernier/micrometer, the bore/thread/hardness/multimeter
  // instruments, the segment materials, the tolerance-stack drawing chip, the
  // FMEA/MSA documentation chips and the confirms are new; the kept history
  // chips capture the same way.
  it.each([
    ["qp_quality_inspection@2.json", "measuring_tools", "Vernier", "vernier"],
    ["qp_quality_inspection@2.json", "measuring_tools", "Micrometer", "micrometer"],
    ["qp_quality_inspection@2.json", "measuring_tools", "Bore gauge", "bore_gauge"],
    ["qp_quality_inspection@2.json", "measuring_tools", "Thread / plug / ring gauge", "thread_gauge"],
    ["qp_quality_inspection@2.json", "measuring_tools", "Hardness tester", "hardness_tester"],
    ["qp_quality_inspection@2.json", "measuring_tools", "Multimeter / hipot", "multimeter_hipot"],
    ["qp_quality_inspection@2.json", "material_worked", "Machined parts", "machined_steel"],
    ["qp_quality_inspection@2.json", "material_worked", "Sheet metal / welding", "sheetmetal_welding"],
    ["qp_quality_inspection@2.json", "material_worked", "Plastics", "plastics"],
    ["qp_quality_inspection@2.json", "material_worked", "Electrical / electronics", "elec_electronics"],
    ["qp_quality_inspection@2.json", "material_worked", "Assembly", "assembly_product"],
    ["qp_quality_inspection@2.json", "drawing_reading", "Tolerance stack", "tolerance_stack"],
    ["qp_quality_inspection@2.json", "inspection_documentation", "FMEA", "fmea"],
    ["qp_quality_inspection@2.json", "inspection_documentation", "MSA", "msa"],
    ["qp_quality_inspection@2.json", "inspection_senior_confirm", "Haan, khud karta hoon", "self"],
    ["qp_quality_inspection@2.json", "inspection_senior_confirm", "Nahi, senior karte hain", "other"],
    ["qp_quality_inspection@2.json", "inspection_engineer_confirm", "Haan, main banata hoon", "self"],
    ["qp_quality_inspection@2.json", "inspection_engineer_confirm", "Nahi, doosre banate hain", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // PHASE 2 #1 (@2) — the sheet-13 tooling/machine/steel/work rows, the
  // institute row and the separating confirms resolve at capture. The
  // plastic/die-casting/forging/rubber tool chips, the VMC/EDM/jig-boring/
  // polishing machine chips, the H13/P20 steels, the spotting/maintenance/
  // polishing work chips and the institute chips are new; the kept history
  // chips capture the same way.
  it.each([
    ["qp_tool_die_making@2.json", "tooling_made", "Press tools / stamping dies", "press_tool"],
    ["qp_tool_die_making@2.json", "tooling_made", "Press tools / stamping dies", "press_tool"],
    ["qp_tool_die_making@2.json", "tooling_made", "Plastic injection moulds", "plastic_injection"],
    ["qp_tool_die_making@2.json", "tooling_made", "Die-casting dies", "die_casting"],
    ["qp_tool_die_making@2.json", "tooling_made", "Forging dies", "forging_die"],
    ["qp_tool_die_making@2.json", "tooling_made", "Rubber moulds", "rubber_mould"],
    ["qp_tool_die_making@2.json", "toolroom_machine", "VMC", "vmc"],
    ["qp_tool_die_making@2.json", "toolroom_machine", "EDM", "edm"],
    ["qp_tool_die_making@2.json", "toolroom_machine", "Jig boring", "jig_boring"],
    ["qp_tool_die_making@2.json", "toolroom_machine", "Polishing / lapping", "polishing_lapping"],
    ["qp_tool_die_making@2.json", "tool_steel", "H13", "h_thirteen"],
    ["qp_tool_die_making@2.json", "tool_steel", "P20", "p_twenty"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Die fitting & assembly", "die_assembly"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Spotting / blue matching", "spotting"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Tryout", "tryout_correction"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Die maintenance / repair", "die_maintenance"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Sharpening", "regrind"],
    ["qp_tool_die_making@2.json", "toolroom_work", "Polishing", "polishing"],
    ["qp_tool_die_making@2.json", "tool_training_institute", "NTTF", "nttf"],
    ["qp_tool_die_making@2.json", "tool_training_institute", "CIPET", "cipet"],
    ["qp_tool_die_making@2.json", "toolroom_skilled_confirm", "Haan, khud karta hoon", "self"],
    ["qp_tool_die_making@2.json", "toolroom_skilled_confirm", "Nahi, senior karte hain", "other"],
    ["qp_tool_die_making@2.json", "toolroom_senior_confirm", "Haan, main lead karta hoon", "self"],
    ["qp_tool_die_making@2.json", "toolroom_senior_confirm", "Nahi, doosre karte hain", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );

  // PHASE 2 #2 (@6) — the sheet-15 machine and tolerance chips and the
  // separating confirm resolve at capture. Thread/gear and double-disc are new
  // machine chips, the micron band is a new tolerance chip and 0.002 is a band
  // of its own; the kept chips capture as they did on @5.
  it.each([
    ["qp_cnc_grinding@6.json", "grinding_machine", "Thread / gear grinding", "thread_gear"],
    ["qp_cnc_grinding@6.json", "grinding_machine", "gear grinding", "thread_gear"],
    ["qp_cnc_grinding@6.json", "grinding_machine", "Double disc", "double_disc"],
    ["qp_cnc_grinding@6.json", "grinding_machine", "double disc grinder", "double_disc"],
    ["qp_cnc_grinding@6.json", "grinding_machine", "centreless grinding", "centreless"],
    ["qp_cnc_grinding@6.json", "grinding_machine", "Tool aur cutter grinder", "tool_cutter"],
    ["qp_cnc_grinding@6.json", "tolerance_band", "0.002 mm tak", "0.002"],
    ["qp_cnc_grinding@6.json", "tolerance_band", "Micron / 0.001 mm ya usse kam", "0.001"],
    ["qp_cnc_grinding@6.json", "tolerance_band", "micron", "0.001"],
    ["qp_cnc_grinding@6.json", "tolerance_band", "micron ka kaam", "0.001"],
    ["qp_cnc_grinding@6.json", "controller_brand", "Sinumerik", "siemens"],
    ["qp_cnc_grinding@6.json", "grinding_setting_confirm", "Haan, khud karta hoon", "self"],
    ["qp_cnc_grinding@6.json", "grinding_setting_confirm", "Nahi, koi aur karta hai", "other"],
  ] as ReadonlyArray<readonly [string, string, string, string | null]>)(
    "%s %s: %s → %s",
    (packFile, questionKey, text, expected) => {
      expect(capturedOption(packFile, questionKey, text)).toEqual(
        expected === null ? [] : [expected],
      );
    },
  );
});
