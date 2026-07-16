import { describe, expect, it } from "vitest";

import { SKILL_CORPUS } from "./skill-corpus";
import {
  WEDGE_ALIASES,
  ratifiedWedgeAliases,
  validateWedgeAliases,
} from "./wedge-aliases";

describe("WEDGE_ALIASES — TAX-5 vernacular aliases (RVM-ratified 2026-07-16, gate d)", () => {
  const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));

  it("is structurally valid (existing ids, no dups, source=rvm)", () => {
    expect(validateWedgeAliases(corpusIds)).toEqual([]);
  });

  it("is FULLY RATIFIED — the RVM owner ratified all 22 entries on 2026-07-16 (gate d closed)", () => {
    // The ratification GATE in executable form: this diff IS the visible human decision.
    // Owner rulings: Q-A chhilai → skill_deburring (shop-floor sense = finishing);
    // Q-B "drawing padhna" → skill_cad_interpretation (reading CAD/digital models).
    const ratified = ratifiedWedgeAliases();
    expect(ratified).toHaveLength(22);
    expect(ratified).toHaveLength(WEDGE_ALIASES.length); // every entry — none held back
    expect(ratified.find((w) => w.alias.text === "chhilai")?.skillId).toBe("skill_deburring");
    expect(ratified.find((w) => w.alias.text === "drawing padhna")?.skillId).toBe(
      "skill_cad_interpretation",
    );
  });

  it("covers the launch-wedge machining core with >=1 vernacular alias each", () => {
    const proposed = new Set(WEDGE_ALIASES.map((w) => w.skillId));
    // skill_milling is intentionally ABSENT from this list since ratification: its only
    // vernacular proposal (chhilai) was remapped to skill_deburring by the owner's Q-A
    // ruling (2026-07-16) — milling has no vernacular alias post-ratification.
    for (const core of [
      "skill_turning",
      "skill_drilling",
      "skill_tapping_threading",
      "skill_grinding_ops",
      "skill_fixture_setup",
      "skill_cnc_programming",
      "skill_measuring_instruments",
    ]) {
      expect(proposed.has(core), `no vernacular alias for ${core}`).toBe(true);
    }
  });

  it("owner exemplars hold (kharad -> turning; chhilai -> deburring per ratified Q-A)", () => {
    const kharad = WEDGE_ALIASES.find((w) => w.alias.text === "kharad");
    expect(kharad?.skillId).toBe("skill_turning");
    const chhilai = WEDGE_ALIASES.find((w) => w.alias.text === "chhilai");
    expect(chhilai?.skillId).toBe("skill_deburring");
    expect(chhilai?.note).toContain("Q-A"); // the ruling is recorded on the entry, not silent
  });
});
