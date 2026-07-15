import { describe, expect, it } from "vitest";

import { SKILL_CORPUS } from "./skill-corpus";
import {
  WEDGE_ALIASES,
  ratifiedWedgeAliases,
  validateWedgeAliases,
} from "./wedge-aliases";

describe("WEDGE_ALIASES — TAX-5 vernacular proposals (RVM ratification-gated)", () => {
  const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));

  it("is structurally valid (existing ids, no dups, source=rvm)", () => {
    expect(validateWedgeAliases(corpusIds)).toEqual([]);
  });

  it("ships FULLY UNRATIFIED — the seed must insert nothing until the RVM human flips entries", () => {
    // This test is the ratification GATE in executable form: when the RVM owner ratifies
    // entries, update this assertion alongside (the diff makes the human decision visible).
    expect(ratifiedWedgeAliases()).toEqual([]);
  });

  it("covers the launch-wedge machining core with >=1 vernacular proposal each", () => {
    const proposed = new Set(WEDGE_ALIASES.map((w) => w.skillId));
    for (const core of [
      "skill_turning",
      "skill_milling",
      "skill_drilling",
      "skill_tapping_threading",
      "skill_grinding_ops",
      "skill_fixture_setup",
      "skill_cnc_programming",
      "skill_measuring_instruments",
    ]) {
      expect(proposed.has(core), `no vernacular proposal for ${core}`).toBe(true);
    }
  });

  it("owner exemplars are present (kharad -> turning, chhilai -> milling w/ open question)", () => {
    const kharad = WEDGE_ALIASES.find((w) => w.alias.text === "kharad");
    expect(kharad?.skillId).toBe("skill_turning");
    const chhilai = WEDGE_ALIASES.find((w) => w.alias.text === "chhilai");
    expect(chhilai?.skillId).toBe("skill_milling");
    expect(chhilai?.note).toBeTruthy(); // the ambiguity is flagged, not silently decided
  });
});
