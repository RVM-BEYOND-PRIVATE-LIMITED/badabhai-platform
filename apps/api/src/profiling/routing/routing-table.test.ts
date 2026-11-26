/**
 * Routing table test (#3015) — walks every row of pack section 6 plus the installation entry.
 *
 * Each row pins: triggering phrases (normalised), the verbatim routing question (passes
 * checkPromptPersona), and every chip's outcome. Expected values are restated here from the
 * pack, not read from the table, so a drifted label or a retargeted chip goes red.
 */
import { describe, expect, it } from "vitest";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROUTING_TABLE,
  type RoutingEntry,
} from "./routing-table";

function byId(id: string): RoutingEntry {
  const e = ROUTING_TABLE.find((r) => r.id === id);
  if (!e) throw new Error(`routing entry ${id} missing`);
  return e;
}

describe("routing table — pack section 6, one entry per row", () => {
  it("has the 17 pack rows plus installation (point 10 of #2995), each with a prompt and chips", () => {
    const ids = ROUTING_TABLE.map((r) => r.id);
    for (const id of [
      "machine",
      "cnc",
      "helper",
      "engineer",
      "supervisor",
      "quality",
      "maintenance",
      "designer",
      "programmer",
      "moulding",
      "die",
      "welding-fab",
      "fitter",
      "electrician",
      "store",
      "driver",
      "lab",
      "installation",
    ]) {
      expect(ids, id).toContain(id);
    }
    // Second entries chained from two-target rows.
    for (const id of [
      "helper-foundry",
      "helper-store",
      "supervisor-quality",
      "supervisor-maintenance",
      "programmer-machine",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("serves the pack's verbatim questions (one question mark, at most 20 words)", () => {
    const prompts: Record<string, string> = {
      machine: "Aap kaunsi machine chalate hain?",
      cnc: "CNC me kaunsi machine chalate hain?",
      helper: "Aap kis department me helper hain?",
      engineer: "Aap kaunse department me kaam karte hain?",
      supervisor: "Aap kaunsa department sambhalte hain?",
      quality: "Quality me aap kya karte hain?",
      maintenance: "Maintenance me aap kya dekhte hain?",
      designer: "Aap kaunsa software chalate hain?",
      programmer: "Aap kis cheez ka program banate hain?",
      moulding: "Kaunsi moulding karte hain?",
      die: "Die ya mould banate hain, ya us par production karte hain?",
      "welding-fab": "Zyada kaam welding ka hai ya marking, cutting aur fit-up ka?",
      fitter: "Aap kahaan fitting karte hain?",
      electrician: "Aap kaunsa electrical kaam karte hain?",
      store: "Store me aapka kaam kya hai?",
      driver: "Aap kaunsi gaadi ya crane chalate hain?",
      lab: "Lab me kaunsi testing karte hain?",
      installation: "Machine service karte hain ya plant erection?",
    };
    for (const [id, prompt] of Object.entries(prompts)) {
      expect(byId(id).prompt, id).toBe(prompt);
      const marks = (prompt.match(/\?/g) ?? []).length;
      expect(marks, `${id} question marks`).toBe(1);
      expect(prompt.split(/\s+/).filter(Boolean).length, `${id} words`).toBeLessThanOrEqual(20);
    }
  });

  it("fires on every Worker-says phrase, normalised (plus particles via the normaliser)", () => {
    const cases: Record<string, string[]> = {
      machine: ["machine operator", "operator hoon", "machine chalata hoon", "production operator"],
      cnc: ["cnc operator", "cnc ka kaam"],
      helper: ["helper", "helper ka kaam"],
      engineer: ["engineer hoon", "diploma engineer", "b.tech hoon", "get", "det"],
      supervisor: ["supervisor", "in-charge", "shift in-charge"],
      quality: ["quality", "qc", "checking ka kaam"],
      maintenance: ["maintenance", "maintenance ka kaam"],
      designer: ["designer", "design ka kaam", "cad"],
      programmer: ["programmer"],
      moulding: ["moulding", "moulding ka kaam"],
      die: ["die ka kaam", "mould ka kaam"],
      "welding-fab": ["welding aur fabrication"],
      fitter: ["fitter", "fitting ka kaam"],
      electrician: ["electrician", "electrician hoon"],
      store: ["store", "godown", "warehouse"],
      driver: ["driver", "forklift", "crane"],
      lab: ["lab", "testing", "lab testing"],
      installation: ["installation engineer", "commissioning engineer"],
    };
    for (const [id, phrases] of Object.entries(cases)) {
      const entry = byId(id);
      for (const p of phrases) {
        expect(entry.phrases, `${id} phrases`).toContain(p);
      }
      // Normalised lookup hits the same entry (proves the normaliser folds particles).
      for (const p of phrases) {
        const norm = normalizeOccupationText(p);
        const hit = ROUTING_TABLE.find((r) => r.phrases.some((q) => normalizeOccupationText(q) === norm));
        expect(hit?.id, p).toBe(id);
      }
    }
  });

  it("chains two-target rows through a second entry (T08/T22, T16/T37, T13/T43, T24/T26, T53/T55, T01/T02)", () => {
    const helper = byId("helper");
    expect(helper.chips.find((c) => c.label === "Welding / fabrication")).toMatchObject({
      kind: "next",
      next: "welding-fab",
    });
    expect(helper.chips.find((c) => c.label === "Foundry / forging")).toMatchObject({
      kind: "next",
      next: "helper-foundry",
    });
    expect(helper.chips.find((c) => c.label === "Store / dispatch")).toMatchObject({
      kind: "next",
      next: "helper-store",
    });
    expect(byId("supervisor").chips.find((c) => c.label === "Quality")).toMatchObject({
      kind: "next",
      next: "supervisor-quality",
    });
    expect(byId("supervisor").chips.find((c) => c.label === "Maintenance")).toMatchObject({
      kind: "next",
      next: "supervisor-maintenance",
    });
    expect(byId("programmer").chips.find((c) => c.label === "Machine par hi program")).toMatchObject(
      { kind: "next", next: "programmer-machine" },
    );
    expect(byId("helper-foundry").chips.map((c) => c.kind === "trade" ? (c as { familyId: string }).familyId : null)).toEqual([
      "fam_foundry_casting",
      "fam_forging",
    ]);
    expect(byId("programmer-machine").chips.map((c) => c.kind === "trade" ? (c as { familyId: string }).familyId : null)).toEqual([
      "fam_cnc_turning",
      "fam_vmc_milling",
    ]);
  });

  it("helper and supervisor-machine chips carry the level (trainee / supervisor, unconfirmed)", () => {
    for (const chip of byId("helper").chips) {
      if (chip.kind === "trade") {
        expect(chip.level?.rung, chip.label).toBe("trainee");
      }
    }
    const ask = byId("supervisor").chips.find((c) => c.label === "Ek machine");
    expect(ask).toMatchObject({ kind: "next", next: "machine", level: { rung: "supervisor" } });
  });

  it("table phrases are not also loaded as trade phrases (minus retirements)", () => {
    // The must-NOT lines say the table is the single place these are implemented: a phrase in
    // the table must not also be a row in rvm-aliases.jsonl (the authored overlay — published
    // NCO/ISCO titles are not checked here, since retiring a published title is a separate
    // owner call; e.g. "electrician" stays on house wiring for direct retrieval, while
    // identify.service checks routing first in production so the worker still gets the question).
    // resolveJobDomainCorpus() is NOT used here because it merges published titles in.
    // Retired rows do not count (plant/breakdown, cnc, shift, design/moulding ka kaam, etc.).
    const dir = join(__dirname, "..", "..", "..", "..", "..", "packages", "db", "data", "job-domains");
    const overlayNorms = new Set<string>();
    for (const line of readFileSync(join(dir, "rvm-aliases.jsonl"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      try {
        const r = JSON.parse(t);
        if (r.kind === "alias") overlayNorms.add(normalizeOccupationText(r.text));
      } catch { continue; }
    }
    const retiredNorms = new Set<string>();
    for (const line of readFileSync(join(dir, "rvm-alias-retirements.jsonl"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      try {
        const r = JSON.parse(t);
        if (r.kind === "retire") retiredNorms.add(normalizeOccupationText(r.text));
      } catch { continue; }
    }
    for (const n of retiredNorms) overlayNorms.delete(n);
    // Pre-existing shared words + #3010 Wave1 loads stay for direct retrieval (reachability
    // still pins, since it bypasses routing); identify.service checks routing first in
    // production, so the worker still gets the question. Grandfathered: live (quality/qc/cad/
    // fitter), generic loading (godown/warehouse), generic machining/cnc/shift/driver +
    // #3010 Wave1 loads (design/moulding ka kaam) that pre-date routing + #3016 Wave2 loads
    // (forklift/crane reach T56/T57 directly). #3015 adds no alias
    // rows — routing takes precedence in production via identify.service order.
    const grandfathered = new Set(
      [
        "quality",
        "qc",
        "cad",
        "fitter",
        "godown",
        "warehouse",
        "cnc",
        "cnc operator",
        "cnc ka kaam",
        "shift in-charge",
        "shift incharge",
        "design ka kaam",
        "moulding",
        "moulding ka kaam",
        "driver",
        "forklift",
        "crane",
      ].map(normalizeOccupationText),
    );
    const bad: string[] = [];
    for (const entry of ROUTING_TABLE) {
      for (const p of entry.phrases) {
        const n = normalizeOccupationText(p);
        if (overlayNorms.has(n) && !grandfathered.has(n)) bad.push(`${entry.id}: ${p}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
