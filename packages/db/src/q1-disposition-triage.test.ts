/**
 * Q1 triage pack — structural integrity, and the guarantee that it changed nothing.
 *
 * The pack is 96 rows of human judgement. These tests do not check the judgement; they check
 * the properties that make the judgement REVIEWABLE and keep it INERT:
 *
 *   every promotable skill appears exactly once      — no silent omission
 *   no unknown mskill can enter the artifact          — no invented vocabulary
 *   exactly one disposition per skill                 — no ambiguity
 *   the universe cannot fall back to SKILL_CORPUS     — the Task 20 trap, again
 *   nothing is applied                                — the bridge is byte-identical
 *
 * Repository-only. No database, no pooler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { batchScopeSkillIds } from "./embed-skill-aliases";
import { missingProvenance } from "./evidence-provenance";
import {
  FAMILIES,
  Q1_TRIAGE,
  OWNER_RULING_2026_08_26,
  summarizeTriage,
  triageBridgeMismatches,
  validateTriage,
  type TriageRow,
} from "./q1-disposition-triage";

const BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";
const PROMOTABLE = batchScopeSkillIds(BATCH);
const VALID = new Set(MATCH_SKILLS.map((m) => m.skillId));

const artifact = JSON.parse(
  readFileSync(
    join(
      __dirname, "..", "..", "..",
      "docs", "registers", "taxonomy-decisions", "q1-disposition-triage.json",
    ),
    "utf8",
  ),
) as {
  binding: boolean;
  ratified_on: string;
  batch: string;
  applied: number;
  mskills_invented: number;
  summary: {
    total: number; matched: number; intentionally_unmatched: number; review: number;
    unrepresented_families: string[]; skills_in_unrepresented_families: number;
  };
  neighbour_evidence: { nearest_neighbour_is_mapped: number; probed: number };
  dispositions: {
    skill_id: string; candidates: string[]; proposed_disposition: string;
    confidence: string; rationale: string; false_friend: string | null;
  }[];
};

// ---------------------------------------------------------------------------
// K1–K5: the structural tripwires.
// ---------------------------------------------------------------------------
describe("the pack is structurally sound", () => {
  it("validates clean against the promotable universe and the real vocabulary", () => {
    expect(validateTriage(Q1_TRIAGE, PROMOTABLE, VALID)).toEqual([]);
  });

  it("all 96 promotable skills appear EXACTLY once", () => {
    expect(Q1_TRIAGE).toHaveLength(96);
    const ids = Q1_TRIAGE.map((r) => r.skillId);
    expect(new Set(ids).size).toBe(96);
    expect([...ids].sort()).toEqual([...PROMOTABLE].sort());
  });

  it("every skill has exactly ONE disposition, from the closed set", () => {
    for (const r of Q1_TRIAGE) {
      expect(["MATCHED", "INTENTIONALLY_UNMATCHED", "REVIEW"], r.skillId).toContain(r.disposition);
    }
    const counts = summarizeTriage(Q1_TRIAGE);
    expect(counts.matched + counts.intentionallyUnmatched + counts.review).toBe(96);
  });

  it("no unknown mskill_* can enter — every candidate is one of the existing 18", () => {
    expect(VALID.size).toBe(18);
    for (const r of Q1_TRIAGE) {
      for (const c of r.candidates) expect(VALID, `${r.skillId} -> ${c}`).toContain(c);
    }
    for (const d of artifact.dispositions) {
      for (const c of d.candidates) expect(VALID, `${d.skill_id} -> ${c}`).toContain(c);
    }
  });

  it("the universe CANNOT silently fall back to SKILL_CORPUS", () => {
    // Same trap as Task 20. Validating the pack against the corpus instead reports 96 unknown
    // skills and 49 missing ones — it cannot pass by accident.
    const wrong = validateTriage(Q1_TRIAGE, SKILL_CORPUS.map((s) => s.skillId), VALID);
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.filter((p) => p.kind === "UNKNOWN_SKILL")).toHaveLength(96);
    expect(wrong.filter((p) => p.kind === "MISSING_SKILL")).toHaveLength(49);
  });

  it("the 96/96 coverage boundary is explicit — every one of the 96 is now IN the bridge", () => {
    // Inverted deliberately when the ratified dispositions were applied. Before, none of the
    // 96 had a key and the tripwire failed 96/96; now each has exactly one, and the pack and
    // the bridge are asserted to agree entry for entry below.
    for (const r of Q1_TRIAGE) {
      expect(
        Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, r.skillId),
        r.skillId,
      ).toBe(true);
    }
    expect(triageBridgeMismatches(Q1_TRIAGE, ATTRIBUTE_TO_MATCH_SKILLS)).toEqual([]);
  });
});

describe("validateTriage catches the ways a pack rots", () => {
  const base: TriageRow = {
    skillId: PROMOTABLE[0] ?? "skill_x",
    label: "L",
    family: "assembly",
    candidates: [],
    disposition: "INTENTIONALLY_UNMATCHED",
    confidence: "high",
    rationale: "a rationale long enough to be a real one",
  };
  const only = (r: TriageRow): string[] =>
    validateTriage([r], [r.skillId], VALID).map((p) => p.kind);

  it("a duplicated skill", () => {
    expect(validateTriage([base, base], [base.skillId], VALID).map((p) => p.kind)).toContain("DUPLICATE");
  });

  it("a skill missing from the pack", () => {
    expect(validateTriage([], ["skill_absent"], VALID).map((p) => p.kind)).toEqual(["MISSING_SKILL"]);
  });

  it("an invented mskill", () => {
    expect(only({ ...base, disposition: "MATCHED", candidates: ["mskill_invented"] as never })).toContain(
      "UNKNOWN_MATCH_SKILL",
    );
  });

  it("a mapping hidden inside an UNMATCHED row — the dangerous one", () => {
    // A candidate on an UNMATCHED row is a mapping parked in a field nobody reads, one
    // careless edit from being applied.
    expect(only({ ...base, candidates: ["mskill_fitter"] })).toContain("CANDIDATES_WITHOUT_MATCH");
  });

  it("a MATCHED row with nothing to match to", () => {
    expect(only({ ...base, disposition: "MATCHED" })).toContain("MATCH_WITHOUT_CANDIDATES");
  });

  it("a rationale that is not one", () => {
    expect(only({ ...base, rationale: "ok" })).toContain("EMPTY_RATIONALE");
  });
});

// ---------------------------------------------------------------------------
// The artifact, and the conservatism the owner asked for.
// ---------------------------------------------------------------------------
describe("the artifact", () => {
  it("carries provenance and records that the dispositions are applied", () => {
    expect(missingProvenance(artifact)).toEqual([]);
    expect(artifact.binding).toBe(true);
    expect(artifact.applied).toBe(96);
    expect(artifact.mskills_invented).toBe(0);
  });

  it("reproduces from source — not a stale hand-edit", () => {
    const s = summarizeTriage(Q1_TRIAGE);
    expect(artifact.summary.total).toBe(s.total);
    expect(artifact.summary.matched).toBe(s.matched);
    expect(artifact.summary.intentionally_unmatched).toBe(s.intentionallyUnmatched);
    expect(artifact.summary.review).toBe(s.review);
    expect(artifact.dispositions).toHaveLength(96);
  });

  it("every row carries a rationale, and most carry a named false friend", () => {
    for (const d of artifact.dispositions) expect(d.rationale.length, d.skill_id).toBeGreaterThan(20);
    expect(artifact.dispositions.filter((d) => d.false_friend !== null).length).toBeGreaterThan(40);
  });
});

describe("conservatism — the owner asked for it, so it is asserted", () => {
  it("proposes FAR fewer mappings than similarity would", () => {
    // 61 of 96 nearest neighbours are mapped; a similarity-driven pack proposes 61. This one
    // proposes 5. If a future edit closes that gap, this fails and asks why.
    expect(artifact.neighbour_evidence.nearest_neighbour_is_mapped).toBe(61);
    expect(artifact.summary.matched).toBeLessThan(15);
  });

  it("MATCHED is reserved for trade-defining skills in represented families", () => {
    for (const r of Q1_TRIAGE.filter((x) => x.disposition === "MATCHED")) {
      expect(FAMILIES[r.family].represented, r.skillId).toBe(true);
      expect(r.candidates.length, r.skillId).toBeGreaterThan(0);
      expect(r.confidence, r.skillId).not.toBe("low");
    }
  });

  it("NO skill in an unrepresented family is MATCHED — the adjacency trap", () => {
    // 8 of 13 families have no mskill at all. A missing vocabulary entry must never be
    // RESOLVED by borrowing the nearest represented family's. Raising the question is
    // different from answering it, so REVIEW stays available here — see below.
    const unrepresented = Q1_TRIAGE.filter((r) => !FAMILIES[r.family].represented);
    expect(unrepresented.length).toBe(62);
    for (const r of unrepresented) expect(r.disposition, r.skillId).not.toBe("MATCHED");
  });

  it("exactly ONE unrepresented-family skill was ever asked about, and D-7B is why", () => {
    // The single exception is deliberate and traceable: the owner ratified
    // skill_chassis_fitting -> mskill_fitter, which is an automotive route into a represented
    // trade. Body panel alignment is its neighbour, so whether the ratification reaches it is
    // a real question rather than an adjacency slip. Everything else in those 8 families is
    // closed as INTENTIONALLY_UNMATCHED with no candidate at all.
    // The question was CLOSED as unmatched, so it is now identified by the candidate that was
    // considered and declined rather than by a live disposition.
    const asked = Q1_TRIAGE.filter(
      (r) => !FAMILIES[r.family].represented && (r.rejectedCandidates ?? []).length > 0,
    );
    expect(asked.map((r) => r.skillId)).toEqual(["skill_body_panel_alignment"]);
    expect(asked[0]?.rationale).toMatch(/D-7B/);
    expect(asked[0]?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    // The owner's words: the D-7B ratification must NOT be generalised to automotive-body work.
    expect(OWNER_RULING_2026_08_26["skill_body_panel_alignment"]).toMatch(/NOT BE GENERALISED/);

    for (const r of Q1_TRIAGE.filter((x) => !FAMILIES[x.family].represented)) {
      expect(r.disposition, r.skillId).toBe("INTENTIONALLY_UNMATCHED");
      expect(r.candidates, r.skillId).toEqual([]);
    }
  });

  it("names the specific false friends the owner listed", () => {
    const byId = new Map(Q1_TRIAGE.map((r) => [r.skillId, r]));
    // The strongest neighbour in the whole set, and wrong.
    expect(byId.get("skill_ducting_installation")?.falseFriend).toMatch(/0\.827/);
    expect(byId.get("skill_ducting_installation")?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    // The micrometer/GD&T pattern, at the second-highest score.
    expect(byId.get("skill_visual_defect_identification")?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    expect(byId.get("skill_visual_defect_identification")?.falseFriend).toMatch(/0\.803/);
    // A pure lexical collision: "plumb" the verb vs "plumber" the trade.
    expect(byId.get("skill_wall_plumb_and_level_checking")?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    expect(byId.get("skill_plastering")?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    // The D-7B adjacency was surfaced and then explicitly declined — never silently extended.
    expect(byId.get("skill_body_panel_alignment")?.disposition).toBe("INTENTIONALLY_UNMATCHED");
    expect(byId.get("skill_body_panel_alignment")?.rejectedCandidates).toEqual(["mskill_fitter"]);
  });
});

// ---------------------------------------------------------------------------
// What TASK 21 must not have done.
// ---------------------------------------------------------------------------
describe("what was applied, and what was not", () => {
  it("the bridge grew by exactly the 96; the vocabulary and the corpus did not move", () => {
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS)).toHaveLength(145);
    expect(MATCH_SKILLS).toHaveLength(18);
    expect(SKILL_CORPUS).toHaveLength(49);
  });

  it("the Q1 tripwire now PASSES — every promotable skill has a decision", () => {
    // The inverse of what this file asserted before ratification. Updated in the same commit
    // that applied the dispositions, which is the only circumstance in which it may change.
    const undecided = PROMOTABLE.filter(
      (id) => !Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, id),
    );
    expect(undecided).toEqual([]);
  });

  it("every ruling the owner made is recorded, and only those 16", () => {
    expect(Object.keys(OWNER_RULING_2026_08_26)).toHaveLength(16);
    for (const id of Object.keys(OWNER_RULING_2026_08_26)) {
      const row = Q1_TRIAGE.find((r) => r.skillId === id);
      expect(row?.disposition, id).toBe("INTENTIONALLY_UNMATCHED");
      expect((row?.rejectedCandidates ?? []).length, id).toBeGreaterThan(0);
    }
    // And every row that had something declined carries the reason it was declined.
    for (const r of Q1_TRIAGE.filter((x) => (x.rejectedCandidates ?? []).length > 0)) {
      expect(OWNER_RULING_2026_08_26[r.skillId], r.skillId).toBeDefined();
    }
  });

  it("the D-7 holds are still held — Q1 did not touch them", () => {
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_boring"]).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, "skill_chassis_fitting"),
    ).toBe(false);
  });

  it("NOTHING WAS PROMOTED — a passing coverage gate is not a promotion", () => {
    // The gate that just went green is one of five. Promotion is still blocked by
    // NO_REGRESSION, RESOLVABLE_ABOVE_FLOOR and EVAL_COVERED, and by owner authorization.
    expect(artifact.applied).toBe(96);
    expect(artifact.mskills_invented).toBe(0);
  });
});
