/**
 * Trade catalogue DB parity (#2998) — the catalogue row ⇔ the pack corpus files.
 *
 * For every loaded catalogue entry: the family exists in `_families.jsonl`,
 * every NCO code is bound to it (`jd_nco_` + the code with the dot as an
 * underscore, per #3008 step 1), and a form file exists for the pack. New
 * trades (above LOADED_WAVE) gain families, bindings and files with their wave
 * issues; until then they are unchecked here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOADED_WAVE, TRADE_CATALOGUE } from "@badabhai/taxonomy";

const DATA_DIR = join(__dirname, "..", "data", "question-packs");

interface CorpusIndex {
  families: Set<string>;
  bindings: Map<string, Set<string>>;
  packFiles: Set<string>;
}

function indexCorpus(): CorpusIndex {
  const families = new Set<string>();
  const bindings = new Map<string, Set<string>>();
  for (const line of readFileSync(join(DATA_DIR, "_families.jsonl"), "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const rec = JSON.parse(trimmed) as {
      kind: string;
      family_id: string;
      job_domain_id?: string | null;
    };
    if (rec.kind === "family") {
      families.add(rec.family_id);
    } else if (rec.kind === "binding" && rec.job_domain_id) {
      const set = bindings.get(rec.family_id) ?? new Set<string>();
      set.add(rec.job_domain_id);
      bindings.set(rec.family_id, set);
    }
  }
  const packFiles = new Set(
    readdirSync(join(DATA_DIR, "packs")).filter((f) => f.endsWith(".json")),
  );
  return { families, bindings, packFiles };
}

const loaded = TRADE_CATALOGUE.filter((e) => e.wave <= LOADED_WAVE);

describe("trade catalogue DB parity", () => {
  it("every loaded family exists and binds every catalogue NCO code", () => {
    const { families, bindings } = indexCorpus();
    expect(loaded.length).toBeGreaterThan(0);
    for (const e of loaded) {
      expect(families.has(e.familyId), `${e.code} family ${e.familyId}`).toBe(true);
      const bound = bindings.get(e.familyId) ?? new Set<string>();
      for (const code of e.ncoCodes) {
        const binding = `jd_nco_${code.replace(".", "_")}`;
        expect(bound.has(binding), `${e.code} binds ${binding}`).toBe(true);
      }
    }
  });

  it("every loaded pack has a form file", () => {
    const { packFiles } = indexCorpus();
    for (const e of loaded) {
      const hit = [...packFiles].some(
        (f) => f === `${e.packId}.json` || f.startsWith(`${e.packId}@`),
      );
      expect(hit, `${e.code} form file for ${e.packId}`).toBe(true);
    }
  });
});

/**
 * Wave 1 (#3008, and the foundry split #3009), checked ahead of LOADED_WAVE. Raising LOADED_WAVE
 * to 1 also turns on the posting-trade, answer-skill and résumé-map checks, which land with #3005,
 * #3011 and #3012. Until then this block holds what #3008 and #3009 load: the family, every
 * section 13.1 binding, and the form files.
 */
/**
 * #2995 point 4 default, awaiting Akshit's ruling: pack 13.1 lists these four under T45, but the
 * casting pair stays with T24 and the forging pair with T26 (#3009), so T45 does not bind them.
 */
const T45_LEFT_WITH_FOUNDRY: Readonly<Record<string, string>> = {
  "3122.4401": "fam_foundry_casting",
  "3122.4402": "fam_foundry_casting",
  "3122.4501": "fam_forging",
  "3122.4502": "fam_forging",
};
/**
 * T24 deepens the live Foundry / Forging trade under a NEW form id, so its v1 is the compiled sheet
 * and the form it replaces (another id, on another family) is the one deprecated in place.
 */
const DEEPENED_UNDER_NEW_ID: Readonly<Record<string, { packId: string; familyId: string }>> = {
  T24: { packId: "qp_foundry_forging", familyId: "fam_foundry_forging" },
};
const wave1 = TRADE_CATALOGUE.filter((e) => e.wave === 1);

interface PackFileHead {
  pack_id: string;
  version: number;
  status: string;
  family_id: string;
}

function packHead(file: string): PackFileHead {
  return JSON.parse(readFileSync(join(DATA_DIR, "packs", file), "utf8")) as PackFileHead;
}

describe("trade catalogue DB parity — Wave 1 forms (#3008)", () => {
  it("covers the 18 trades #3008 and #3009 load", () => {
    expect(wave1.map((e) => e.code)).toEqual([
      "T17",
      "T21",
      "T24",
      "T25",
      "T26",
      "T27",
      "T29",
      "T33",
      "T37",
      "T38",
      "T43",
      "T45",
      "T46",
      "T47",
      "T48",
      "T52",
      "T54",
      "T58",
    ]);
  });

  it("every Wave 1 family exists, with a Devanagari label_hi, and binds its section 13.1 codes", () => {
    const { families, bindings } = indexCorpus();
    const labels = new Map<string, string>();
    for (const line of readFileSync(join(DATA_DIR, "_families.jsonl"), "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const rec = JSON.parse(t) as { kind: string; family_id: string; label_hi?: string };
      if (rec.kind === "family") labels.set(rec.family_id, rec.label_hi ?? "");
    }
    for (const e of wave1) {
      expect(families.has(e.familyId), `${e.code} family ${e.familyId}`).toBe(true);
      expect(labels.get(e.familyId) ?? "", `${e.code} label_hi`).toMatch(/[ऀ-ॿ]/);
      const bound = bindings.get(e.familyId) ?? new Set<string>();
      for (const code of e.ncoCodes) {
        const binding = `jd_nco_${code.replace(".", "_")}`;
        const expected = !(e.code === "T45" && code in T45_LEFT_WITH_FOUNDRY);
        expect(bound.has(binding), `${e.code} binds ${binding}`).toBe(expected);
      }
    }
    for (const [code, familyId] of Object.entries(T45_LEFT_WITH_FOUNDRY)) {
      const binding = `jd_nco_${code.replace(".", "_")}`;
      expect(bindings.get(familyId)?.has(binding), `${familyId} binds ${binding}`).toBe(true);
    }
    // T33 has no NCO-2015 code (pack section 13.2); it binds the minted entry (#3007).
    expect(bindings.get("fam_cmm")?.has("jd_rvm_cmm_operator")).toBe(true);
  });

  it("each Wave 1 form has exactly one active version, on its own family", () => {
    const { packFiles } = indexCorpus();
    for (const e of wave1) {
      const files = [...packFiles].filter(
        (f) => f === `${e.packId}.json` || f.startsWith(`${e.packId}@`),
      );
      const heads = files.map(packHead);
      const active = heads.filter((h) => h.status === "active");
      expect(
        active.map((h) => h.version),
        `${e.code} active versions`,
      ).toHaveLength(1);
      expect(active[0]?.family_id).toBe(e.familyId);
      // A deepened trade's live v1 is kept, deprecated in place; v2 is the compiled sheet.
      // Deepened under a new form id (T24), the compiled sheet is v1 and the replaced form is
      // the one deprecated.
      const replaced = DEEPENED_UNDER_NEW_ID[e.code];
      const expectedActive = e.status === "deepen" && !replaced ? 2 : 1;
      expect(active[0]?.version, `${e.code} active version`).toBe(expectedActive);
      if (replaced) {
        const old = [...packFiles]
          .filter((f) => f === `${replaced.packId}.json` || f.startsWith(`${replaced.packId}@`))
          .map(packHead);
        expect(
          old.map((h) => `${h.family_id}@${h.version}:${h.status}`),
          `${e.code} replaced form`,
        ).toEqual([`${replaced.familyId}@1:deprecated`]);
      } else if (e.status === "deepen") {
        expect(heads.find((h) => h.version === 1)?.status, `${e.code} v1`).toBe("deprecated");
      }
    }
  });
});

/**
 * Wave 2 — 18 shop-floor trades (#3016), checked ahead of LOADED_WAVE. Raising LOADED_WAVE to 2
 * also turns on the posting-trade, answer-skill and résumé-map checks for these trades; until
 * then this block holds what #3016 loads: the family, every section 13.1 binding, and the form
 * files.
 */
const wave2 = TRADE_CATALOGUE.filter((e) => e.wave === 2);

describe("trade catalogue DB parity — Wave 2 forms (#3016)", () => {
  it("covers the 18 trades #3016 loads", () => {
    expect(wave2.map((e) => e.code)).toEqual([
      "T18",
      "T19",
      "T20",
      "T22",
      "T23",
      "T28",
      "T30",
      "T31",
      "T32",
      "T34",
      "T35",
      "T36",
      "T39",
      "T40",
      "T41",
      "T42",
      "T56",
      "T57",
    ]);
  });

  it("every Wave 2 family exists, with a Devanagari label_hi, and binds its section 13.1 codes", () => {
    const { families, bindings } = indexCorpus();
    const labels = new Map<string, string>();
    for (const line of readFileSync(join(DATA_DIR, "_families.jsonl"), "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const rec = JSON.parse(t) as { kind: string; family_id: string; label_hi?: string };
      if (rec.kind === "family") labels.set(rec.family_id, rec.label_hi ?? "");
    }
    for (const e of wave2) {
      expect(families.has(e.familyId), `${e.code} family ${e.familyId}`).toBe(true);
      expect(labels.get(e.familyId) ?? "", `${e.code} label_hi`).toMatch(/[ऀ-ॿ]/);
      const bound = bindings.get(e.familyId) ?? new Set<string>();
      for (const code of e.ncoCodes) {
        const binding = `jd_nco_${code.replace(".", "_")}`;
        expect(bound.has(binding), `${e.code} binds ${binding}`).toBe(true);
      }
    }
    // T34 has no 8-digit NCO-2015 code (pack section 13.2); it binds the minted NDT entries
    // under NCO 7543 and 3119 (#3007), like T33's minted CMM entry above.
    expect(bindings.get("fam_ndt")?.size ?? 0, "fam_ndt binds the minted NDT entries").toBeGreaterThan(
      0,
    );
  });

  it("each Wave 2 form has exactly one active version, on its own family", () => {
    const { packFiles } = indexCorpus();
    for (const e of wave2) {
      const files = [...packFiles].filter(
        (f) => f === `${e.packId}.json` || f.startsWith(`${e.packId}@`),
      );
      const heads = files.map(packHead);
      const active = heads.filter((h) => h.status === "active");
      expect(
        active.map((h) => h.version),
        `${e.code} active versions`,
      ).toEqual([1]);
      expect(active[0]?.family_id).toBe(e.familyId);
    }
  });
});
