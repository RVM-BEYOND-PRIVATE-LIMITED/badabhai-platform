/**
 * THE DISPLAY-SCRIPT RULE (#1679), held against the real catalogue and the real client.
 *
 * `occupation-index.test.ts` proves the picker's ORDER on hand-built rows. What it cannot see is
 * whether the order is enough: a family with no Latin label falls through to Devanagari, and a
 * fixture only contains the families someone thought to write down. So this file reads the
 * committed corpus — every family, every selectable occupation, the #1675 draughtsman — and the
 * Dart the worker app ships, and asserts on what a worker would actually be shown, and on where
 * each label sends them (a pinned label is trade-form routing evidence).
 *
 * PRIVACY: public reference data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadQuestionPackCorpus,
  resolveJobDomainCorpus,
  type ResolvableBinding,
} from "@badabhai/db";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { routeToTradeForm, type TradeFormKind } from "../profiling/trade-form-router";
import { FAMILY_CHIP_LABELS } from "./family-chip-labels";
import { buildOccupationSnapshot, isLatinScript } from "./occupation-index";

const corpus = loadQuestionPackCorpus();

const OCCUPATION_LABEL_DART = join(
  __dirname,
  "../../../worker-app/lib/core/api/occupation_label.dart",
);

/**
 * `kUniversalOccupationLabels` as the worker app compiles it — the labels its trust pill HIDES.
 * Read from the source rather than restated, so a change on either side lands here.
 */
function workerAppHiddenLabels(): string[] {
  const source = readFileSync(OCCUPATION_LABEL_DART, "utf8");
  const set = /kUniversalOccupationLabels\s*=\s*<String>\{([^}]*)\}/.exec(source)?.[1];
  if (set === undefined)
    throw new Error(`could not read kUniversalOccupationLabels from ${OCCUPATION_LABEL_DART}`);
  const labels = [...set.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
  // Vacuity guard: an empty parse would make both assertions below pass on nothing.
  expect(labels.length).toBeGreaterThan(0);
  return labels;
}

describe("FAMILY_CHIP_LABELS", () => {
  it("labels EXACTLY the families the corpus defines — none missing, none stale", () => {
    const corpusIds = corpus.families.map((f) => f.family_id).sort();
    // Vacuity guard: a loader that returned nothing would make an empty map look complete.
    expect(corpusIds.length).toBeGreaterThan(100);
    expect(Object.keys(FAMILY_CHIP_LABELS).sort()).toEqual(corpusIds);
  });

  it("is Latin script, trimmed and non-blank, for every family", () => {
    const offenders = Object.entries(FAMILY_CHIP_LABELS).filter(
      ([, label]) => !isLatinScript(label) || label.trim() !== label || label.length === 0,
    );
    expect(offenders).toEqual([]);
  });

  it("labels the universal fallback with a string the worker app HIDES", () => {
    // `fam_universal` is not a trade. The trust pill drops it by matching these exact strings
    // (case-insensitively); anything else would show a worker "General" as their trade.
    const hidden = workerAppHiddenLabels().map((l) => l.toLowerCase());
    expect(hidden).toContain(FAMILY_CHIP_LABELS.fam_universal?.toLowerCase());
  });

  it("labels no REAL trade with a string the worker app hides", () => {
    // The other direction of the same contract: a real family whose label collided with the
    // hide list would vanish from the trust pill for every worker placed in it.
    const hidden = new Set(workerAppHiddenLabels().map((l) => l.toLowerCase()));
    const vanishing = Object.entries(FAMILY_CHIP_LABELS).filter(
      ([id, label]) => id !== "fam_universal" && hidden.has(label.toLowerCase()),
    );
    expect(vanishing).toEqual([]);
  });

  it("routes to a trade form exactly where this table says, and nowhere else", () => {
    // A pinned label is ROUTING EVIDENCE, not only copy: `routeToTradeForm` reads it on the
    // turn the pin lands, before the model has said anything. These nine hand over on the
    // label alone, each into its own trade's form (`fam_welding` -> welder did so in
    // Devanagari too). A label edit that adds or moves a row here is a routing change and
    // must be reviewed as one — "kharad aur CNC" growing a "turning" would hand the turner
    // form to every occupation that falls back to `fam_machining`.
    const routes: Record<string, TradeFormKind> = {};
    for (const [familyId, label] of Object.entries(FAMILY_CHIP_LABELS)) {
      const kind = routeToTradeForm({
        draft: { domain_label: null, role_label: null, skills: [], experiences: [] },
        occupationFamilyId: familyId,
        occupationLabel: label,
      });
      if (kind !== null) routes[familyId] = kind;
    }
    expect(routes).toEqual({
      fam_welding: "welder",
      fam_welding_trade: "welder",
      fam_cnc_turning: "cnc_turner",
      fam_vmc_milling: "vmc_milling",
      fam_cnc_grinding: "cnc_grinding",
      fam_cam_programming: "cam_programmer",
      fam_cad_drafting: "cad_draughtsman",
      fam_tool_die_making: "tool_die_maker",
      fam_powder_coating: "painter_coating",
      // Batch 2 part two: "sheet metal fabrication" carries the occupation term "sheet metal", so
      // a worker the resolver pins here is handed the sheet metal form — the intended route, and
      // the generic `fam_sheet_metal` ("chadar aur dhancha") stays off this table.
      fam_sheet_metal_fab: "sheet_metal_worker",
      // The same shape for the industrial electrician: "industrial electrician" IS an occupation
      // term, so the pin routes to the form. The generic `fam_electrical` ("bijli ka kaam") and
      // `fam_electrical_equipment` ("bijli upkaran") stay off this table — ruling A2's house
      // wireman must not be handed the panel-and-drive form on a pin.
      fam_industrial_electrician: "industrial_electrician",
      // Batch 2 part two's second: "power press aur stamping" routes on the MACHINE term
      // "power press", corroborated by the pin — the tier a family label always has, because it
      // is only shown for an occupation already resolved into that family. Three of the five
      // bound codes are shown by it (Tool Setter Press, Press Shop Operator and Press Shop
      // Helper carry no vernacular alias), so this row is what hands those workers the form.
      fam_press_operation: "press_operator",
      // "assembly line" IS an occupation term of the assembly line role, so a worker pinned here
      // is handed the line form — intended. The generic `fam_assembly` and `fam_assemblers_other`
      // ("assembly ka kaam") stay off this table: bare "assembly" is not a term, "assembly line" is.
      fam_assembly_line: "assembly_line_worker",
    });
  });
});

describe("the served catalogue", () => {
  const bindings: ResolvableBinding[] = corpus.bindings.map((b) => ({
    familyId: b.family_id,
    jobDomainId: b.job_domain_id ?? null,
    iscoUnitCode: b.isco_unit_code ?? null,
    iscoMinorCode: b.isco_minor_code ?? null,
    iscoSubmajorCode: b.isco_submajor_code ?? null,
    iscoMajorCode: b.isco_major_code ?? null,
    isUniversal: b.is_universal ?? false,
  }));
  const selectable = resolveJobDomainCorpus().filter((d) => d.selectable);

  // Built the way `OccupationIndexService` builds it — the catalogue's Devanagari `label_hi`
  // passed in, the Latin labels left to their DEFAULT, so a snapshot builder that stopped
  // defaulting to the committed map would go red here rather than in production.
  const snapshot = buildOccupationSnapshot({
    catalogVersion: "corpus",
    domains: selectable.map((d) => ({
      jobDomainId: d.jobDomainId,
      labelEn: d.label_en,
      labelHi: d.label_hi,
      iscoUnitCode: d.isco_unit,
    })),
    aliases: selectable.flatMap((d) =>
      (d.aliases ?? []).map((a) => ({ jobDomainId: d.jobDomainId, text: a.text })),
    ),
    bindings,
    familyLabels: new Map(corpus.families.map((f) => [f.family_id, f.label_hi ?? null])),
  });

  // Every SELECTABLE occupation and every alias, searchable or not: a superset of what the
  // production index serves (it also drops shadowed ISCO units and de-duplicated aliases), so
  // a clean result here is a clean result there.
  it("offers every selectable occupation in Latin script", () => {
    // Before #1679 this list held 2,956 occupations: 41 whose shortest alias was Devanagari and
    // 2,915 that fell through to their family's `label_hi`.
    expect(snapshot.domains.size).toBeGreaterThan(3000);
    const devanagari = [...snapshot.domains.values()]
      .filter((d) => !isLatinScript(d.chipLabel))
      .map((d) => `${d.jobDomainId} -> ${d.chipLabel}`);
    expect(devanagari).toEqual([]);
  });

  it("qualifies colliding chips in Latin script too", () => {
    // The collision guard swaps a chip's label for its family's. A Devanagari qualifier would
    // put a second script back into exactly the lists that needed qualifying.
    const devanagari = [...snapshot.familyLabels].filter(([, label]) => !isLatinScript(label));
    expect(devanagari).toEqual([]);
  });

  it("offers the #1675 draughtsman their trade in one script", () => {
    // They were offered `cad`, `नक्शा`, `Kuch aur`: `नक्शा` (5 code units) out-ranked `naksha` (6).
    expect(snapshot.domains.get("jd_nco_3118_0301")?.chipLabel).toBe("naksha");
    expect(snapshot.domains.get("jd_nco_3118_0401")?.chipLabel).toBe("cad");
  });

  it("labels every occupation that owns its own word BY that word, never by its family", () => {
    // Script comes first, so an occupation whose only word is Devanagari falls through to its
    // family — and the family can be another trade. "Well Digger" is bound to
    // `fam_construction_other`, "safedi aur scaffolding": without its Latin twin `kuan khodna`
    // a worker who said कुआं खोदना would be pinned, and recorded, as a whitewasher. The fix for
    // a row here is a Latin twin in `rvm-aliases.jsonl`, never a Devanagari chip.
    const fellThrough: string[] = [];
    let withOwnWord = 0;
    for (const d of selectable) {
      const official = normalizeOccupationText(d.label_en);
      const own = (d.aliases ?? [])
        .map((a) => a.text.trim())
        .filter((t) => t.length > 0 && normalizeOccupationText(t) !== official);
      if (own.length === 0) continue;
      withOwnWord++;
      const chip = snapshot.domains.get(d.jobDomainId)?.chipLabel;
      if (chip === undefined || !own.includes(chip))
        fellThrough.push(`${d.jobDomainId} -> ${chip}`);
    }
    // Vacuity guard: the overlay alone gives 106 occupations their own word.
    expect(withOwnWord).toBeGreaterThan(500);
    expect(fellThrough).toEqual([]);
  });

  it("gives the two Devanagari-only occupations their Latin twins", () => {
    expect(snapshot.domains.get("jd_nco_7119_0100")?.chipLabel).toBe("kuan khodna");
    expect(snapshot.domains.get("jd_nco_6111_0101")?.chipLabel).toBe("dhaan");
  });
});
