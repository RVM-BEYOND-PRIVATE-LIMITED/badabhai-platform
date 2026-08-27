/**
 * D-7C-1 — the cleanup rules, and the tripwires on what the cleanup was measured to do.
 *
 * Two halves. The first exercises the pure classification against constructed corpora, including
 * the cases production does not currently contain but a promotion would create. The second pins
 * the committed measurement, so the three claims that came out of it — the cleanup fixes no
 * ceiling, it relocates rather than resolves `dimensional inspection`, and combining it with the
 * D-7C seed orphans two phrases — cannot quietly stop being true.
 *
 * The third of those was RESOLVED on 2026-08-26 by owner ruling D-7C-1a option A: the two GD&T
 * exclusions were re-pointed at the deprecation subject, so the surviving holder keeps the text.
 * The tripwire is inverted rather than deleted — it now asserts the fix, and would fail again if
 * anyone re-pointed them back.
 */
import { existsSync, readFileSync } from "node:fs";
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

describe("the proposal was RATIFIED and MOVED, 2026-08-26", () => {
  // The owner ruled D-7C-1a option A and D-7C-1b option A. Ratifying, in this design, means
  // MOVING the rows into the file the runners actually read and DELETING the proposal — not
  // flipping a flag in place, which `parseCleanupProposal` refuses precisely so that a second
  // source of truth cannot exist. These tests pin the completed move.
  const ratified = loadAliasExclusions(join(DATA, "decollided-aliases.json"));

  it("the proposal file is gone, and the loader degrades to empty rather than throwing", () => {
    expect(existsSync(join(DATA, "proposed-d7c1-cleanup.json"))).toBe(false);
    expect(loadCleanupProposal(join(DATA, "proposed-d7c1-cleanup.json"))).toEqual([]);
  });

  it("the ratified file now holds 8 — 2 originals, 2 re-pointed, 4 moved", () => {
    expect(ratified).toHaveLength(8);
    expect(ratified.filter((x) => x.phase === "9 / D-7C-1b")).toHaveLength(4);
    expect(ratified.filter((x) => x.phase === "9 / D-7C-1a")).toHaveLength(2);
  });

  it("D-7C-1a: the GD&T exclusions now de-elect the DEPRECATION SUBJECT, not the survivor", () => {
    // The whole point of the ruling. Before: skill_drawing_reading's copies were excluded so
    // skill_gdt_reading kept the text — and D-7C then deprecates skill_gdt_reading, so both
    // phrases left retrieval. After: the surviving holder keeps them.
    for (const text of ["GD&T", "geometric dimensioning and tolerancing"]) {
      const row = ratified.find((x) => x.text === text)!;
      expect(row.skill_id, text).toBe("skill_gdt_reading");
      expect(row.winner_skill_id, text).toBe("skill_drawing_reading");
    }
  });

  it("and the rows that USED to be excluded are no longer excluded by anything", () => {
    // 60913ff3 / b6cf46a9 are skill_drawing_reading's copies. If either were still in the file
    // the re-point would have added an exclusion instead of moving one, and the phrase would
    // still be lost.
    const ids = new Set(ratified.map((x) => x.alias_id));
    expect(ids.has("60913ff3-3420-511e-8ec4-4605afe6d970")).toBe(false);
    expect(ids.has("b6cf46a9-3cdb-560c-8b40-7a166b226d2d")).toBe(false);
  });

  it("no text is de-elected on BOTH holders — that is what losing a phrase looks like", () => {
    // A cheap structural guard against the class of defect D-7C-1a was: the same text excluded
    // twice, on two different skills, leaves nobody serving it.
    const byText = new Map<string, number>();
    for (const x of ratified) byText.set(x.text, (byText.get(x.text) ?? 0) + 1);
    for (const [text, n] of byText) expect(n, text).toBe(1);
  });

  it("every ratified row still satisfies the file's own validation", () => {
    expect(() =>
      parseAliasExclusions(JSON.stringify({ kind: "alias-exclusions", exclusions: ratified })),
    ).not.toThrow();
  });

  it("the parser still refuses a flag flip and a wrong kind", () => {
    // The negative behaviour outlives the file: it is what stops the NEXT proposal being
    // ratified in place.
    const flipped = JSON.stringify({
      kind: "alias-cleanup-proposal",
      decision: "X",
      owner_decision: "RATIFIED",
      why: "w",
      wired_into: "n",
      proposals: [],
    });
    expect(() => parseCleanupProposal(flipped)).toThrow(/decollided-aliases\.json/);
    expect(() => parseCleanupProposal('{"kind":"alias-exclusions","proposals":[]}')).toThrow(
      /wrong kind/,
    );
  });

  it("the proposal path is still not referenced by any writing runner", () => {
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

describe("the cross-decision conflict — found 2026-08-26, RESOLVED the same day", () => {
  it("the artifact still records the conflict as it was measured", () => {
    // The 2026-08-21 election handed GD&T to skill_gdt_reading; the D-7C seed deprecates
    // skill_gdt_reading. Neither file mentioned the other. The artifact is the DATED evidence
    // that this was once true and is not edited — the fix lives in the exclusions file, and
    // the next test asserts it there.
    expect(art.orphaned_if_d7c_also_seeds).toEqual([
      "gd&t",
      "geometric dimensioning and tolerancing",
    ]);
    expect(art.cross_decision_conflict).toMatch(/OWNER DECISION REQUIRED/);
    expect(art.cross_decision_conflict).toMatch(/ORDERING IS NOT A FIX/);
  });

  it("NO winner named in the ratified file is a skill D-7C deprecates — the inverted tripwire", () => {
    // This assertion used to read `toEqual(["skill_gdt_reading"])`, pinning the defect. The
    // owner ruled D-7C-1a option A, so it now pins the FIX: a de-election may not hand a text
    // to a holder that is about to go dark. Re-pointing either exclusion back fails here, and
    // so does adding a new election whose winner is any D-7C subject.
    const ratified = loadAliasExclusions(join(DATA, "decollided-aliases.json"));
    const winners = new Set(ratified.map((x) => x.winner_skill_id));
    const doomed = [...winners].filter((w) => w !== null && D7C_NEUTRAL_SUBJECTS.includes(w));
    expect(doomed).toEqual([]);
  });

  it("and the rule generalises to any future subject, not just this one", () => {
    // Stated as a property so a fourth deprecation subject is covered without editing a list.
    const ratified = loadAliasExclusions(join(DATA, "decollided-aliases.json"));
    for (const x of ratified) {
      if (x.winner_skill_id === null) continue;
      expect(D7C_NEUTRAL_SUBJECTS.includes(x.winner_skill_id), `${x.text} -> ${x.winner_skill_id}`).toBe(
        false,
      );
    }
  });
});

describe("the RE-MEASUREMENT after the ruling — a second artifact, not an edit of the first", () => {
  // The pre-ruling artifact above is dated evidence and stays exactly as it was measured. This
  // one is the same instrument run again against live rows AFTER the exclusions moved, so the
  // pair reads as a before and an after rather than as a document that changed its mind.
  const post = JSON.parse(
    readFileSync(join(DOCS, "d7c1-alias-collision-cleanup-postruling-2026-08-26.json"), "utf8"),
  ) as Artifact & {
    orphaned_if_d7c_also_seeds: string[];
    cross_decision_conflict: string | null;
    scope_orphaned: string[];
    ratified_election_count: number;
    proposed_election_count: number;
  };

  it("carries its own provenance, cost nothing, and wrote nothing", () => {
    expect(missingProvenance(post)).toEqual([]);
    expect(post.ai_spend_inr).toBe(0);
    expect(post.production_mutation_performed).toBe(false);
  });

  it("THE CONFLICT IS GONE, measured from live rows rather than asserted", () => {
    expect(post.orphaned_if_d7c_also_seeds).toEqual([]);
    expect(post.cross_decision_conflict).toBeNull();
  });

  it("all 8 elections are ratified and none is left proposed", () => {
    expect(post.ratified_election_count).toBe(8);
    expect(post.proposed_election_count).toBe(0);
  });

  it("the accepted cost of D-7C-1b was PAID, so the delta audit now reports none", () => {
    // This audit measures what WOULD change if the elections were applied. They were applied on
    // 2026-08-26, so the remaining delta is empty — and that is the fix landing, not the cost
    // disappearing. The cost is real and was verified against production: all four phrases are
    // gone from the cnc-programming slug (0 live rows each) and the slug fell from 28 Path B
    // candidates to 10. The historical claim stays readable in the PRE-ruling artifact, which
    // is not edited.
    expect(post.scope_orphaned).toEqual([]);
    expect((art as unknown as { scope_orphaned: string[] }).scope_orphaned).toEqual([
      "cad @ cnc-programming",
      "drawing padhna @ cnc-programming",
      "read engineering drawings @ cnc-programming",
      "technical drawing @ cnc-programming",
    ]);
  });

  it("and the ceilings did NOT move — the cleanup buys determinism, not floor safety", () => {
    // The §5a correction, re-confirmed after the ruling: an election preserves the winning
    // text, so a score cannot move because of one. Anyone reading "cleanup" as "ceiling fix"
    // is reading it wrong, before and after.
    type Ceilings = { anchor_path_negative: number; sibling_confusion: number };
    const ceil = (x: unknown): Ceilings => (x as { ceilings: Ceilings }).ceilings;
    const before = new Map(art.scenarios.map((s) => [s.id, s]));
    let compared = 0;
    for (const s of post.scenarios) {
      const b = before.get(s.id);
      if (b === undefined) continue;
      expect(ceil(s).anchor_path_negative, s.id).toBeCloseTo(ceil(b).anchor_path_negative, 4);
      expect(ceil(s).sibling_confusion, s.id).toBeCloseTo(ceil(b).sibling_confusion, 4);
      compared += 1;
    }
    // A silent zero here would make the assertion vacuous, which is how a comparison test
    // passes while comparing nothing.
    expect(compared).toBe(4);
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
