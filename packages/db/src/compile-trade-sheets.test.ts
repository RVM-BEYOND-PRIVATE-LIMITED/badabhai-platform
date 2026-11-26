/**
 * Sheet compiler tests (#2997).
 *
 * Compiles the real CEO pack v2 in memory — nothing is written — and holds the
 * contract: 44 forms, 977 questions; T18 (new) and T17 (deepened) byte-shape;
 * the compiled corpus passes validateQuestionPackCorpus with no problems (the
 * T45 wording is ruled by a prompt override, point 1 of #2995); two runs are
 * byte-identical; every form on disk matches its compile; and the
 * published-versions guard refuses a listed version.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateQuestionPackCorpus,
  type FamilyRecord,
  type BindingRecord,
  type PackRecord,
  type QuestionPackCorpus,
} from "./question-pack-corpus";
import {
  compileAllSheets,
  dryRun,
  loadPublishedVersions,
  loadSheetOverrides,
  packFilename,
  publishedCollisions,
  selectForms,
  serialisePack,
} from "./compile-trade-sheets";

const PACK = join(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "reference",
  "BadaBhai_Manufacturing_Taxonomy_and_Question_Pack_v2.md",
);
const OVERRIDES = join(__dirname, "..", "data", "question-packs", "_sheet-overrides.json");
const PACKS_DIR = join(__dirname, "..", "data", "question-packs", "packs");
const LEDGER = join(__dirname, "..", "data", "question-packs", "_published-versions.jsonl");

/** The 18 forms Wave 1 wrote (#3008, 15 + foundry split #3009's three). */
const WAVE_1_FORMS = [
  "qp_edm_wirecut",
  "qp_cnc_router",
  // The foundry split (#3009).
  "qp_foundry_casting",
  "qp_die_casting",
  "qp_forging",
  "qp_heat_treatment",
  "qp_injection_moulding",
  "qp_cmm",
  "qp_quality_engineer",
  "qp_plc_automation",
  "qp_maintenance_engineer",
  "qp_production_supervisor",
  "qp_production_engineer",
  "qp_process_engineer",
  "qp_npd_engineer",
  "qp_ppc",
  "qp_purchase",
  "qp_cad_design_3d",
];

/** The 18 forms Wave 2 writes (#3016). */
const WAVE_2_FORMS = [
  "qp_gear_cutting",
  "qp_boring_machine",
  "qp_spm_finishing",
  "qp_fabrication",
  "qp_tube_forming",
  "qp_surface_treatment",
  "qp_blow_moulding",
  "qp_plastic_extrusion",
  "qp_rubber_moulding",
  "qp_ndt",
  "qp_calibration",
  "qp_material_lab",
  "qp_robotics",
  "qp_instrumentation",
  "qp_hvac_rac",
  "qp_utility",
  "qp_forklift",
  "qp_crane_rigging",
];

function compileAll(): PackRecord[] {
  const overrides = loadSheetOverrides(OVERRIDES);
  return compileAllSheets(readFileSync(PACK, "utf8"), overrides);
}

function testCorpus(packs: PackRecord[]): QuestionPackCorpus {
  // Scaffold families/bindings so the pack rules run standalone: the validator is
  // built for exactly this (an empty view disables its cross-reference). WARNs are
  // filtered the same way resolveQuestionPackCorpus filters them.
  const families: FamilyRecord[] = packs.map((p) => ({
    kind: "family",
    family_id: p.family_id,
    label_en: p.family_id,
  }));
  const bindings: BindingRecord[] = packs.map((p) => ({
    kind: "binding",
    family_id: p.family_id,
    job_domain_id: `jd_test_${p.family_id}`,
  }));
  // A corpus without a universal fallback is invalid on its own terms; the first
  // family carries it here so only pack rules are under test.
  const first = packs[0];
  if (first) bindings.push({ kind: "binding", family_id: first.family_id, is_universal: true });
  return { families, bindings, packs };
}

describe("sheet compiler", () => {
  it("lists 44 forms and 977 questions", () => {
    const result = dryRun(PACK, OVERRIDES, PACKS_DIR);
    expect(result.packs).toHaveLength(44);
    expect(result.questions).toBe(977);
  });

  it("compiles T18 as a new form", () => {
    const packs = compileAll();
    const t18 = packs.find((p) => p.pack_id === "qp_gear_cutting");
    expect(t18).toBeDefined();
    expect(t18?.version).toBe(1);
    expect(t18?.family_id).toBe("fam_gear_cutting");
    expect(t18?.locale).toBe("hi-IN");
    expect(t18?.status).toBe("active");
    expect(t18?.items).toHaveLength(23);

    // Experience: six fixed bands, value_number ONLY (the #776 trap).
    const exp = t18?.items[0];
    expect(exp?.question_key).toBe("gear_experience");
    expect(exp?.answer_type).toBe("single_select");
    expect(exp?.max_asks).toBe(2);
    expect(exp?.retry_text).toBeTruthy();
    for (const o of exp?.options ?? []) {
      expect(o.value_number).toBeTypeOf("number");
      expect(o.value_text).toBeUndefined();
      expect(o.option_key).toMatch(/^[a-z_]+$/);
    }
    expect((exp?.options ?? []).map((o) => o.value_number)).toEqual([0, 0, 2, 4, 7, 12]);

    // Level: second ask with retry wording.
    const level = t18?.items[1];
    expect(level?.question_key).toBe("gear_level");
    expect(level?.max_asks).toBe(2);
    expect(level?.retry_text).toBeTruthy();

    // Everything else asks once, with no retry.
    for (const item of (t18?.items ?? []).slice(2)) {
      expect(item.max_asks).toBe(1);
      expect(item.retry_text).toBeUndefined();
    }

    // A gated question compiles to the contract shape.
    const gated = (t18?.items ?? []).find((i) => i.ask_if !== undefined);
    expect(gated).toBeDefined();
    expect(JSON.stringify(gated?.ask_if)).toContain('"op"');

    // Escape chips are flagged none-of-above with the unknown value.
    const escapes = (t18?.items ?? [])
      .flatMap((i) => i.options ?? [])
      .filter((o) => o.is_none_of_above);
    expect(escapes.length).toBeGreaterThan(0);
    for (const o of escapes) {
      expect(o.value_text).toBe("unknown");
      expect(o.option_key).toBe("unknown");
    }

    // File naming: a v1 keeps the bare name.
    expect(packFilename(t18 as PackRecord)).toBe("qp_gear_cutting.json");
  });

  it("compiles T17 as a deepened form under the kept live keys", () => {
    const packs = compileAll();
    const t17 = packs.find((p) => p.pack_id === "qp_edm_wirecut");
    expect(t17).toBeDefined();
    expect(t17?.version).toBe(2);
    expect(t17?.items).toHaveLength(23);
    expect(packFilename(t17 as PackRecord)).toBe("qp_edm_wirecut@2.json");

    const keys = new Set((t17?.items ?? []).map((i) => i.question_key));
    // Renames applied: the sheet's keys become the kept live keys (#3008 §3).
    for (const kept of [
      "edm_setting_confirm",
      "edm_program_confirm",
      "edm_machine",
      "edm_brand",
      "edm_tolerance",
      "edm_work_type",
      "edm_program_source",
    ]) {
      expect(keys.has(kept)).toBe(true);
    }
    // And the sheet keys they replace are gone.
    for (const gone of [
      "edm_setter_confirm",
      "edm_setter_programmer_confirm",
      "edm_machine_type",
      "edm_machine_make",
      "tolerance_band",
      "edm_operation",
      "edm_programming_level",
    ]) {
      expect(keys.has(gone)).toBe(false);
    }

    // Conditions still reference live keys in this pack.
    const fields = new Set<string>();
    for (const item of t17?.items ?? []) {
      const ask = item.ask_if as
        | { left?: { field?: string }; predicates?: { left?: { field?: string } }[] }
        | undefined;
      if (ask?.left?.field) fields.add(ask.left.field);
      for (const pr of ask?.predicates ?? []) {
        if (pr.left?.field) fields.add(pr.left.field);
      }
    }
    for (const f of fields) expect(keys.has(f)).toBe(true);

    // The deepened tolerance band stores text, as live does.
    const tol = (t17?.items ?? []).find((i) => i.question_key === "edm_tolerance");
    expect(tol?.options?.map((o) => o.value_text)).toContain("0.05");
    expect(tol?.options?.every((o) => o.value_number === undefined)).toBe(true);
  });

  it("passes corpus validation with no problems", () => {
    // The T45 in-charge prompt's banned deictic (#2995 point 1) is replaced by the
    // reviewed prompt override, so nothing the compiler emits is refused.
    const corpus = testCorpus(compileAll());
    const problems = validateQuestionPackCorpus(corpus);
    expect(problems.filter((p) => !p.includes("WARN"))).toEqual([]);
  });

  it("serves the ruled T45 in-charge prompt, and refuses an override whose sheet line moved", () => {
    const t45 = compileAll().find((p) => p.pack_id === "qp_production_supervisor") as PackRecord;
    const item = t45.items?.find((i) => i.question_key === "prodsup_incharge_confirm");
    expect(item?.prompt_text).toBe("Aap kaunsa department sambhalte hain?");
    expect(item?.answer_type).toBe("text");

    const overrides = loadSheetOverrides(OVERRIDES);
    const form = overrides.forms.qp_production_supervisor;
    const stale = {
      ...overrides,
      forms: {
        ...overrides.forms,
        qp_production_supervisor: {
          ...form,
          promptOverrides: {
            prodsup_incharge_confirm: {
              sheetAsks: "an older wording of the sheet line",
              asks: "Aap kaunsa department sambhalte hain?",
              ruling: "test",
            },
          },
        },
      },
    } as typeof overrides;
    expect(() => compileAllSheets(readFileSync(PACK, "utf8"), stale)).toThrow(
      /prompt override prodsup_incharge_confirm pins/,
    );
  });

  it("selects a subset of forms, and refuses a form id it did not compile", () => {
    const packs = compileAll();
    expect(selectForms(packs, null)).toHaveLength(44);
    expect(selectForms(packs, ["qp_cmm", "qp_ppc"]).map((p) => p.pack_id)).toEqual([
      "qp_cmm",
      "qp_ppc",
    ]);
    expect(() => selectForms(packs, ["qp_cmm", "qp_not_a_form"])).toThrow(/qp_not_a_form/);
  });

  it("every form already on disk is byte-identical to its compile", () => {
    // The written files are a pure function of the sheet plus the overrides file:
    // a hand edit to a compiled form, or a sheet edit after writing, shows up here.
    const result = dryRun(PACK, OVERRIDES, PACKS_DIR);
    const changed = result.diffs.filter((d) => d.status === "changed").map((d) => d.filename);
    expect(changed).toEqual([]);
    const written = result.diffs.filter((d) => d.status === "unchanged").map((d) => d.formId);
    expect(written).toEqual(expect.arrayContaining(WAVE_1_FORMS));
  });

  it("is byte-identical across runs", () => {
    const first = compileAll().map(serialisePack);
    const second = compileAll().map(serialisePack);
    expect(second).toEqual(first);
  });

  it("refuses a version the ledger already publishes", () => {
    // Pinned to reality: the live thin EDM form shipped, so v1 is published; Wave 1
    // (#3008) published its 15 compiled forms and the foundry split (#3009) its three; Wave 2
    // (#3016) published its 18; Wave 3 is not published yet.
    const published = loadPublishedVersions(LEDGER);
    expect(published.has("qp_edm_wirecut@1")).toBe(true);
    expect(published.has("qp_gear_cutting@1")).toBe(true);
    expect(published.has("qp_service_engineer@1")).toBe(false);

    const packs = compileAll();
    const t17 = packs.find((p) => p.pack_id === "qp_edm_wirecut") as PackRecord;
    const t18 = packs.find((p) => p.pack_id === "qp_gear_cutting") as PackRecord;
    // Every loaded wave collides; a rerun of --write for a loaded wave is refused.
    expect(
      publishedCollisions(packs, published)
        .map((kv) => kv.split("@")[0])
        .sort(),
    ).toEqual([...WAVE_1_FORMS, ...WAVE_2_FORMS].sort());
    expect(publishedCollisions([t18], published)).toEqual(["qp_gear_cutting@1"]);
    // A v1 recompile of the live form would collide; an unpublished version would not.
    expect(
      publishedCollisions(
        [
          { ...t18, pack_id: "qp_edm_wirecut", version: 1 },
          { ...t17, version: 3 },
        ],
        published,
      ),
    ).toEqual(["qp_edm_wirecut@1"]);
  });
});
