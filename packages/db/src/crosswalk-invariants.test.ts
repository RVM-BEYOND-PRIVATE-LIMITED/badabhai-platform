/**
 * D-7 — the crosswalk matrix, pinned.
 *
 * The programme found every crosswalk defect so far by someone happening to look at one skill.
 * These assertions turn "we looked" into "it cannot change without failing", over BOTH crosswalk
 * sets — the live one production holds and the corpus one a seed would write. Auditing only the
 * live set would say the D-7C deprecations are not a crosswalk problem, because they are not a
 * crosswalk yet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS } from "@badabhai/taxonomy";

import { claimsGained } from "./audit-crosswalk-invariants";
import { D7C_NEUTRAL_SUBJECTS } from "./deprecation-hop0";
import { missingProvenance } from "./evidence-provenance";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

interface Crosswalk {
  skill_id: string;
  successor: string;
  source: "LIVE" | "CORPUS-ONLY";
  subject_status: string;
  bridge_subject: string[] | null;
  bridge_successor: string[] | null;
  claims_gained: string[];
  widening: boolean;
  retag_eligible: boolean;
  hop0_lands_on_successor: number;
  hop0_lands_elsewhere_above_floor: { phrase: string; got: string; score: number }[];
  ruling: string | null;
}
interface Artifact {
  ai_spend_inr: number;
  floor: number;
  crosswalk_count: number;
  widening_count: number;
  unruled_widening_count: number;
  crosswalks: Crosswalk[];
  production_mutation_performed: boolean;
}

const art = JSON.parse(readFileSync(join(DOCS, "d7-crosswalk-invariants.json"), "utf8")) as Artifact;
const by = new Map(art.crosswalks.map((c) => [c.skill_id, c]));

describe("claimsGained", () => {
  it("an ABSENT bridge entry claims nothing — the conservative reading, and the runtime's", () => {
    expect(claimsGained(null, ["mskill_fitter"])).toEqual(["mskill_fitter"]);
  });

  it("an explicit [] claims nothing either, so the successor's whole set is gained", () => {
    expect(claimsGained([], ["mskill_fitter"])).toEqual(["mskill_fitter"]);
  });

  it("nothing is gained when the subject already implies it", () => {
    expect(claimsGained(["mskill_fitter"], ["mskill_fitter"])).toEqual([]);
  });

  it("a successor that implies nothing cannot widen anything", () => {
    expect(claimsGained(["mskill_fitter"], [])).toEqual([]);
    expect(claimsGained(null, null)).toEqual([]);
  });

  it("only the NEW ones count, and they come back sorted", () => {
    expect(claimsGained(["b"], ["c", "a", "b"])).toEqual(["a", "c"]);
  });
});

describe("the matrix as measured", () => {
  it("carries provenance, cost nothing, wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
    expect(art.floor).toBe(0.75);
  });

  it("covers SIX crosswalks — two live, four corpus-only", () => {
    expect(art.crosswalk_count).toBe(6);
    expect(art.crosswalks.filter((c) => c.source === "LIVE").map((c) => c.skill_id).sort()).toEqual([
      "skill_chassis_fitting",
      "skill_go_no_go_gauge_checking",
    ]);
    expect(art.crosswalks.filter((c) => c.source === "CORPUS-ONLY")).toHaveLength(4);
  });

  it("EVERY widening crosswalk has a ruling — this is the number that must stay zero", () => {
    expect(art.widening_count).toBe(2);
    expect(art.unruled_widening_count).toBe(0);
    for (const c of art.crosswalks.filter((x) => x.widening)) {
      expect(c.ruling, c.skill_id).not.toBeNull();
    }
  });
});

describe("D-7A — boring is contained, and VISIBLE", () => {
  const b = by.get("skill_boring")!;

  it("appears in the matrix; absence would be indistinguishable from a filter bug", () => {
    expect(b).toBeDefined();
  });

  it("is corpus-only, so `db:retag:skills` cannot touch it", () => {
    expect(b.source).toBe("CORPUS-ONLY");
    expect(b.retag_eligible).toBe(false);
    expect(b.subject_status).toBe("active");
  });

  it("still widens on paper — the hazard is dormant, not gone", () => {
    expect(b.widening).toBe(true);
    expect(b.claims_gained).toEqual(["mskill_cnc_turner"]);
    expect(b.ruling).toMatch(/D-7A/);
  });

  it("and its phrase lands on skill_drilling at 0.7556, not on the corpus successor", () => {
    // The D-7A finding exactly: above the floor, a different operation, and skill_turning
    // would not win. Reproduced here by a second instrument.
    expect(b.hop0_lands_on_successor).toBe(0);
    expect(b.hop0_lands_elsewhere_above_floor).toHaveLength(1);
    expect(b.hop0_lands_elsewhere_above_floor[0]!.got).toBe("skill_drilling");
    expect(b.hop0_lands_elsewhere_above_floor[0]!.score).toBeCloseTo(0.7556, 4);
  });

  it("is excluded from the D-7C seed set", () => {
    expect(D7C_NEUTRAL_SUBJECTS).not.toContain("skill_boring");
  });
});

describe("D-7B — chassis fitting is live, widening, and ratified", () => {
  const c = by.get("skill_chassis_fitting")!;

  it("is the ONE crosswalk that is both live and widening", () => {
    const both = art.crosswalks.filter((x) => x.widening && x.source === "LIVE");
    expect(both.map((x) => x.skill_id)).toEqual(["skill_chassis_fitting"]);
    expect(c.subject_status).toBe("deprecated");
    expect(c.claims_gained).toEqual(["mskill_fitter"]);
  });

  it("the claim does NOT wait for a retag — HOP-0 already routes to the successor", () => {
    // Retrieval never reads replaced_by. Forbidding db:retag:skills contains nothing here.
    expect(c.hop0_lands_on_successor).toBeGreaterThan(0);
  });

  it("carries the ratification, so it stops reading as an open defect", () => {
    expect(c.ruling).toMatch(/D-7B, RATIFIED/);
  });
});

describe("go-no-go is the contrast case", () => {
  const g = by.get("skill_go_no_go_gauge_checking")!;

  it("live and retag-eligible, and widens NOTHING — the successor's bridge is empty", () => {
    expect(g.source).toBe("LIVE");
    expect(g.retag_eligible).toBe(true);
    expect(g.widening).toBe(false);
    expect(g.bridge_successor).toEqual([]);
  });

  it("so a live crosswalk is not automatically a hazard — the bridge decides", () => {
    expect(g.claims_gained).toEqual([]);
    expect(g.ruling).toBeNull();
  });
});

describe("the three D-7C subjects", () => {
  it("all three are CORPUS-ONLY — the seed has not run", () => {
    for (const s of D7C_NEUTRAL_SUBJECTS) {
      expect(by.get(s)?.source, s).toBe("CORPUS-ONLY");
      expect(by.get(s)?.subject_status, s).toBe("active");
    }
  });

  it("none of them widens: every successor's bridge entry is already implied", () => {
    // This is the match-set-neutral property D-7C rests on, re-derived from the bridge rather
    // than from the HOP-0 sweep — two independent routes to the same claim.
    for (const s of D7C_NEUTRAL_SUBJECTS) {
      expect(by.get(s)?.widening, s).toBe(false);
      expect(by.get(s)?.claims_gained, s).toEqual([]);
    }
  });

  it("but dimensional inspection misassigns in TWO canonical domains, at 0.7570", () => {
    const d = by.get("skill_dimensional_inspection")!;
    expect(d.hop0_lands_elsewhere_above_floor).toHaveLength(2);
    for (const h of d.hop0_lands_elsewhere_above_floor) {
      expect(h.phrase).toBe("dimensional inspection");
      expect(h.got).toBe("skill_drawing_reading");
      expect(h.score).toBeCloseTo(0.757, 3);
    }
  });

  it("neutral-on-the-bridge and safe-in-retrieval are different properties", () => {
    // The whole D-7C lesson in one assertion: the bridge says these three invent no claim, and
    // one of them still lands a phrase on the wrong skill above the floor.
    const d = by.get("skill_dimensional_inspection")!;
    expect(d.widening).toBe(false);
    expect(d.hop0_lands_elsewhere_above_floor.length).toBeGreaterThan(0);
  });
});

describe("the bridge is code, and the audit reads the same code the runtime does", () => {
  it("every successor named in the matrix agrees with ATTRIBUTE_TO_MATCH_SKILLS", () => {
    for (const c of art.crosswalks) {
      const live = Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, c.successor)
        ? (ATTRIBUTE_TO_MATCH_SKILLS[c.successor] ?? [])
        : null;
      expect(c.bridge_successor, c.successor).toEqual(live);
    }
  });
});
