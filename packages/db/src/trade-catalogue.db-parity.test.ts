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
