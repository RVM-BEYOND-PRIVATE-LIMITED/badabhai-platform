/**
 * THE DISPLAY-SCRIPT RULE (#1679), held against the real catalogue and the real client.
 *
 * `occupation-index.test.ts` proves the picker's ORDER on hand-built rows. What it cannot see is
 * whether the order is enough: a family with no Latin label falls through to Devanagari, and a
 * fixture only contains the families someone thought to write down. So this file reads the
 * committed corpus — every family, every reachable occupation, the #1675 draughtsman — and the
 * Dart the worker app ships, and asserts on what a worker would actually be shown.
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
      iscoUnitCode: d.isco_unit ?? /^jd_(?:nco|isco)_(\d{4})/.exec(d.jobDomainId)?.[1] ?? null,
    })),
    aliases: selectable.flatMap((d) =>
      (d.aliases ?? []).map((a) => ({ jobDomainId: d.jobDomainId, text: a.text })),
    ),
    bindings,
    familyLabels: new Map(corpus.families.map((f) => [f.family_id, f.label_hi ?? null])),
  });

  it("offers every reachable occupation in Latin script", () => {
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

  it("gives an occupation with only Devanagari aliases its family's Latin label", () => {
    // `धान` is this occupation's only alias besides its English title.
    const paddy = snapshot.domains.get("jd_nco_6111_0101");
    expect(paddy?.familyId).not.toBeNull();
    expect(paddy?.chipLabel).toBe(FAMILY_CHIP_LABELS[paddy?.familyId ?? ""]);
  });
});
