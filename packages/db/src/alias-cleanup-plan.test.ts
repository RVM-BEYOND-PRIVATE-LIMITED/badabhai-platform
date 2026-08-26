/**
 * D-7C-1 — the cleanup rules, and the tripwires on what the cleanup was measured to do.
 *
 * Two halves. The first exercises the pure classification against constructed corpora, including
 * the cases production does not currently contain but a promotion would create. The second pins
 * the committed measurement, so the three claims that came out of it — the cleanup fixes no
 * ceiling, it relocates rather than resolves `dimensional inspection`, and combining it with the
 * D-7C seed orphans two phrases — cannot quietly stop being true.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAliasExclusions, parseAliasExclusions } from "./alias-exclusions";
import {
  buildScenarios,
  classifyDuplicateGroup,
  loadCleanupProposal,
  orphanedPhrases,
  parseCleanupProposal,
  PROPOSED_CLEANUP_PATH,
  scopeOrphanedPhrases,
  unresolvedGroups,
  type DuplicateGroup,
  type DuplicateMember,
} from "./alias-cleanup-plan";
import { D7C_NEUTRAL_SUBJECTS } from "./deprecation-hop0";
import { missingProvenance } from "./evidence-provenance";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");
const DATA = join(__dirname, "..", "data", "taxonomy");

const member = (o: Partial<DuplicateMember> & { alias_id: string; skill_id: string }): DuplicateMember => ({
  text: "x",
  domain_id: "slug",
  embedded: true,
  skill_status: "active",
  ...o,
});

const group = (norm: string, members: DuplicateMember[]): DuplicateGroup => ({ norm, members });

describe("classifying a duplicate-text group", () => {
  const a = member({ alias_id: "a", skill_id: "skill_one" });
  const b = member({ alias_id: "b", skill_id: "skill_two" });

  it("two live holders and no election is UNDECIDED — the nondeterministic state", () => {
    expect(classifyDuplicateGroup(group("x", [a, b]), new Set())).toBe("UNDECIDED");
  });

  it("electing one of two is DECIDED_COMPLETE", () => {
    expect(classifyDuplicateGroup(group("x", [a, b]), new Set(["b"]))).toBe("DECIDED_COMPLETE");
  });

  it("electing one of THREE is DECIDED_PARTIAL — a half-ruled group is not resolved", () => {
    const c = member({ alias_id: "c", skill_id: "skill_three" });
    expect(classifyDuplicateGroup(group("x", [a, b, c]), new Set(["c"]))).toBe("DECIDED_PARTIAL");
  });

  it("electing ALL of them is WOULD_ORPHAN, and that beats looking internally consistent", () => {
    // The failure mode of a stale exclusion file is that it agrees with itself.
    expect(classifyDuplicateGroup(group("x", [a, b]), new Set(["a", "b"]))).toBe("WOULD_ORPHAN");
  });

  it("a second holder that is PROVISIONAL is LATENT, not a collision — until it is promoted", () => {
    // This is why the row side and the probe side disagree: §5a filters status='active', so a
    // duplicate whose partner is provisional never appeared in that sweep at all.
    const prov = member({ alias_id: "b", skill_id: "skill_two", skill_status: "provisional" });
    expect(classifyDuplicateGroup(group("x", [a, prov]), new Set())).toBe("LATENT");
    // …and promotion turns exactly the same rows into a live nondeterministic collision.
    const promoted = member({ alias_id: "b", skill_id: "skill_two" });
    expect(classifyDuplicateGroup(group("x", [a, promoted]), new Set())).toBe("UNDECIDED");
  });

  it("an UNEMBEDDED second holder is LATENT too — a backfill is enough to arm it", () => {
    const dark = member({ alias_id: "b", skill_id: "skill_two", embedded: false });
    expect(classifyDuplicateGroup(group("x", [a, dark]), new Set())).toBe("LATENT");
  });

  it("counts distinct SKILLS, not rows: two aliases of ONE skill are not a collision", () => {
    const a2 = member({ alias_id: "a2", skill_id: "skill_one" });
    expect(classifyDuplicateGroup(group("x", [a, a2]), new Set())).toBe("LATENT");
  });
});

describe("the safety rules", () => {
  it("a phrase whose holders are all elected out is reported as globally orphaned", () => {
    const g = group("x", [
      member({ alias_id: "a", skill_id: "skill_one" }),
      member({ alias_id: "b", skill_id: "skill_two" }),
    ]);
    expect(orphanedPhrases([g], new Set(["a", "b"]))).toEqual(["x"]);
    expect(orphanedPhrases([g], new Set(["a"]))).toEqual([]);
  });

  it("SCOPE orphaning is invisible to the global rule — the case that decides D-7C-1", () => {
    // "CAD" survives globally on skill_drawing_reading in cnc-machining, and disappears from
    // cnc-programming entirely. Path B filters sa.domain_id, so that slug loses the word.
    const g = group("cad", [
      member({ alias_id: "a", skill_id: "skill_cad_interpretation", domain_id: "cnc-programming" }),
      member({ alias_id: "b", skill_id: "skill_drawing_reading", domain_id: "cnc-machining" }),
    ]);
    expect(orphanedPhrases([g], new Set(["a"]))).toEqual([]);
    expect(scopeOrphanedPhrases([g], new Set(["a"]))).toEqual(["cad @ cnc-programming"]);
  });

  it("unresolvedGroups counts a half-ruled group alongside an unruled one", () => {
    const two = group("x", [
      member({ alias_id: "a", skill_id: "s1" }),
      member({ alias_id: "b", skill_id: "s2" }),
    ]);
    const three = group("y", [
      member({ alias_id: "c", skill_id: "s1" }),
      member({ alias_id: "d", skill_id: "s2" }),
      member({ alias_id: "e", skill_id: "s3" }),
    ]);
    expect(unresolvedGroups([two, three], new Set(["e"])).map((g) => g.norm)).toEqual(["x", "y"]);
  });
});

describe("the proposal is a proposal", () => {
  const raw = readFileSync(join(DATA, "proposed-d7c1-cleanup.json"), "utf8");

  it("parses, is PENDING, and names four rows", () => {
    const doc = parseCleanupProposal(raw);
    expect(doc.owner_decision).toBe("PENDING");
    expect(doc.decision).toBe("D-7C-1");
    expect(doc.proposals).toHaveLength(4);
  });

  it("refuses to load if someone marks it RATIFIED in place", () => {
    // Ratifying means MOVING the rows into the file the runners read. Flipping a flag here
    // would create a second source of truth that no runner consults.
    const flipped = raw.replace('"owner_decision": "PENDING"', '"owner_decision": "RATIFIED"');
    expect(() => parseCleanupProposal(flipped)).toThrow(/decollided-aliases\.json/);
  });

  it("refuses a file that is not a proposal at all", () => {
    expect(() => parseCleanupProposal('{"kind":"alias-exclusions","proposals":[]}')).toThrow(
      /wrong kind/,
    );
  });

  it("every proposed row satisfies the SAME validation the ratified file must", () => {
    // The proposal has to be applicable as-is on ratification, so it is checked by the ratified
    // file's own parser — including the rule that a row cannot lose a text to itself.
    const asExclusions = JSON.stringify({
      kind: "alias-exclusions",
      exclusions: parseCleanupProposal(raw).proposals,
    });
    expect(() => parseAliasExclusions(asExclusions)).not.toThrow();
  });

  it("NO runner reads it: none of its ids are in the ratified file, which still holds 4", () => {
    const ratified = loadAliasExclusions(join(DATA, "decollided-aliases.json"));
    expect(ratified).toHaveLength(4);
    const ratifiedIds = new Set(ratified.map((x) => x.alias_id));
    for (const p of loadCleanupProposal(join(DATA, "proposed-d7c1-cleanup.json"))) {
      expect(ratifiedIds.has(p.alias_id), p.text).toBe(false);
    }
  });

  it("the proposal path is not referenced by any writing runner", () => {
    const runner = readFileSync(join(__dirname, "decollide-skill-aliases.ts"), "utf8");
    const embed = readFileSync(join(__dirname, "embed-skill-aliases.ts"), "utf8");
    expect(runner).not.toContain(PROPOSED_CLEANUP_PATH);
    expect(embed).not.toContain(PROPOSED_CLEANUP_PATH);
  });
});

describe("scenarios", () => {
  const ex = (id: string) => ({
    alias_id: id,
    skill_id: "s",
    text: "t",
    domain_id: null,
    winner_skill_id: null,
    reason: "r",
    decided_by: "d",
    phase: "p",
  });

  it("S3 folds the D-7C subject aliases in and de-duplicates the overlap", () => {
    const s = buildScenarios([ex("a")], [ex("b")], ["b", "c"]);
    expect(s.map((x) => x.id)).toEqual([
      "S0_TODAY",
      "S1_RATIFIED_APPLIED",
      "S2_RATIFIED_PLUS_PROPOSED",
      "S3_PLUS_D7C_DEPRECATION",
    ]);
    expect([...s[3]!.excluded].sort()).toEqual(["a", "b", "c"]);
  });

  it("the baseline excludes nothing — every delta is measured against production as it is", () => {
    expect(buildScenarios([ex("a")], [], [])[0]!.excluded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE COMMITTED MEASUREMENT
// ---------------------------------------------------------------------------
interface Artifact {
  ai_spend_inr: number;
  production_mutation_performed: boolean;
  floor: number;
  owner_decision: string;
  orphaned_globally: string[];
  scope_orphaned: string[];
  orphaned_if_d7c_also_seeds: string[];
  cross_decision_conflict: string | null;
  unresolved_after_all: string[];
  groups: { norm: string; today: string; after_all: string }[];
  scenarios: {
    id: string;
    ceilings: Record<string, number>;
    above_floor: Record<string, number>;
    duplicate_residue_rows: number;
    traced: { phrase: string; got: string; score: number; verdict: string }[];
  }[];
  sibling_collisions_cleared_by_cleanup: { phrase: string }[];
  sibling_collisions_surviving_cleanup_and_d7c: { phrase: string; own_skill: string; score: number }[];
  delta_today_to_full_cleanup: Record<string, number>;
}

const art = JSON.parse(
  readFileSync(join(DOCS, "d7c1-alias-collision-cleanup.json"), "utf8"),
) as Artifact;
const byId = new Map(art.scenarios.map((s) => [s.id, s]));

describe("what the cleanup was measured to do", () => {
  it("carries provenance, cost nothing, and wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
    expect(art.owner_decision).toBe("PENDING");
  });

  it("nine duplicate groups exist — one more than the eight PHRASES §5a reported", () => {
    // The ninth has a provisional holder, so the active-only sweep could not see it.
    expect(art.groups).toHaveLength(9);
    const latent = art.groups.filter((g) => g.today === "LATENT");
    expect(latent.map((g) => g.norm)).toEqual(["finishing"]);
  });

  it("it drives nondeterminism to zero: 19 duplicate rows -> 0, 0 groups unresolved", () => {
    expect(byId.get("S0_TODAY")!.duplicate_residue_rows).toBe(19);
    expect(byId.get("S2_RATIFIED_PLUS_PROPOSED")!.duplicate_residue_rows).toBe(0);
    expect(art.unresolved_after_all).toEqual([]);
    expect(art.orphaned_globally).toEqual([]);
  });

  it("and moves NO ceiling — the headline result, and the one worth disbelieving first", () => {
    // Every claim that this cleanup improves floor safety dies here.
    expect(art.delta_today_to_full_cleanup["anchor_path_negative"]).toBe(0);
    expect(art.delta_today_to_full_cleanup["sibling_confusion"]).toBe(0);
    expect(art.delta_today_to_full_cleanup["above_floor_anchor"]).toBe(0);
    for (const s of art.scenarios) {
      expect(s.ceilings["sibling_confusion"], s.id).toBeCloseTo(0.8405, 4);
      expect(s.ceilings["anchor_path_negative"], s.id).toBeCloseTo(0.776, 3);
    }
  });

  it("`dimensional inspection` RELOCATES rather than resolves — §5a's attribution was wrong", () => {
    // §5a step 1 claimed the cleanup removes this collision "which shares a cause". It does not:
    // the winning phrase survives the election by design, so the score is identical and only the
    // skill that owns it changes — from one D-7C subject to another.
    const t0 = byId.get("S0_TODAY")!.traced.find((t) => t.phrase === "dimensional inspection")!;
    const t2 = byId
      .get("S2_RATIFIED_PLUS_PROPOSED")!
      .traced.find((t) => t.phrase === "dimensional inspection")!;
    expect(t0.got).toBe("skill_drawing_reading");
    expect(t2.got).toBe("skill_gdt_reading");
    expect(t2.score).toBeCloseTo(t0.score, 4);
    expect(t2.verdict).toBe("MISASSIGNED ABOVE FLOOR");
  });

  it("neither known vernacular collision is touched by it", () => {
    for (const id of ["S0_TODAY", "S2_RATIFIED_PLUS_PROPOSED", "S3_PLUS_D7C_DEPRECATION"]) {
      const w = byId.get(id)!.traced.find((t) => t.phrase === "welding ka kaam")!;
      expect(w.got, id).toBe("skill_drilling");
      expect(w.score, id).toBeCloseTo(0.776, 3);
    }
  });
});

describe("the cross-decision conflict", () => {
  it("two ratified decisions, each safe alone, orphan two phrases together", () => {
    // The 2026-08-21 election hands GD&T to skill_gdt_reading; the D-7C seed deprecates
    // skill_gdt_reading. Neither file mentions the other.
    expect(art.orphaned_if_d7c_also_seeds).toEqual([
      "gd&t",
      "geometric dimensioning and tolerancing",
    ]);
    expect(art.cross_decision_conflict).toMatch(/OWNER DECISION REQUIRED/);
    expect(art.cross_decision_conflict).toMatch(/ORDERING IS NOT A FIX/);
  });

  it("and the winners named in the ratified file are exactly the skills D-7C would deprecate", () => {
    const ratified = loadAliasExclusions(join(DATA, "decollided-aliases.json"));
    const winners = new Set(ratified.map((x) => x.winner_skill_id));
    const doomed = [...winners].filter((w) => w !== null && D7C_NEUTRAL_SUBJECTS.includes(w));
    expect(doomed).toEqual(["skill_gdt_reading"]);
  });
});

describe("what survives every corpus decision on the table", () => {
  it("11 above-floor sibling pairs remain, in exactly three lexical families", () => {
    const rest = art.sibling_collisions_surviving_cleanup_and_d7c;
    expect(rest).toHaveLength(11);
    expect(rest[0]!.score).toBeCloseTo(0.8405, 4);
    // Welding processes, controller brands, boring/drilling. None is a scoping or corpus defect;
    // all three are lexically-close names for genuinely different work. This is §5a-2's exact
    // population, and no decision in the current plan reduces it.
    const families = {
      welding: rest.filter((c) => /welding/.test(c.own_skill)).length,
      controllers: rest.filter((c) => /fanuc|mitsubishi/.test(c.own_skill)).length,
      holemaking: rest.filter((c) => /boring|drilling/.test(c.own_skill)).length,
    };
    expect(families).toEqual({ welding: 7, controllers: 2, holemaking: 2 });
    expect(families.welding + families.controllers + families.holemaking).toBe(rest.length);
  });

  it("the cleanup clears only 2 of the 16, and both are drawing-family artifacts", () => {
    expect(art.sibling_collisions_cleared_by_cleanup.map((c) => c.phrase).sort()).toEqual([
      "drawing padhna",
      "read engineering drawings",
    ]);
  });
});
