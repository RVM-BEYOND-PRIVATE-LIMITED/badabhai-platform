/**
 * Deprecation crosswalks across BOTH corpora — the only place the whole picture is visible.
 *
 * ===========================================================================
 * WHY THIS EXISTS SEPARATELY
 * ===========================================================================
 * `packages/taxonomy` can audit `SKILL_CORPUS` and nothing else, because the D2 growth corpus
 * lives here in `packages/db`. Auditing one half is what let a LIVE widening crosswalk go
 * unnoticed: `skill_chassis_fitting` is a growth-corpus skill, so the taxonomy-side audit never
 * saw it, and its successor `skill_mechanical_assembly` IS in `SKILL_CORPUS` and does map to a
 * posting-level skill.
 *
 * The two corpora have zero id overlap (TASK 9B), so the union is well-defined and this test is
 * the complete view.
 *
 * ===========================================================================
 * THE TWO WIDENING CROSSWALKS ARE NOT EQUALLY URGENT
 * ===========================================================================
 * Both add a match skill a worker never claimed, but only one can fire today:
 *
 *   skill_chassis_fitting -> skill_mechanical_assembly   gains mskill_fitter       LIVE
 *   skill_boring          -> skill_turning               gains mskill_cnc_turner   DORMANT
 *
 * LIVE means production already holds `status='deprecated' AND replaced_by IS NOT NULL` for it,
 * so `db:retag:skills` would act on it on its next run. DORMANT means the deprecation exists
 * only in the committed corpus and has never been seeded, so the retag runner cannot see it —
 * it becomes live the moment someone runs `db:seed:skills` without `--preserve-existing-status`.
 *
 * Those production facts were MEASURED read-only on 2026-08-21 and are recorded in
 * `docs/registers/taxonomy-decisions/d7-crosswalk-drift.md`. They are not asserted here: this
 * file is a static test and must not depend on a database.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, auditCrosswalk, SKILL_CORPUS } from "@badabhai/taxonomy";
import type { CrosswalkSkill } from "@badabhai/taxonomy";

interface GrowthSkillRow {
  skill_id: string;
  status?: string;
  replaced_by?: string | null;
}

const growth: GrowthSkillRow[] = readFileSync("data/taxonomy/skills.jsonl", "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as GrowthSkillRow);

const union: CrosswalkSkill[] = [
  ...SKILL_CORPUS.map((s) => ({ skillId: s.skillId, status: s.status, replacedBy: s.replacedBy })),
  ...growth.map((r) => ({
    skillId: r.skill_id,
    status: r.status,
    replacedBy: r.replaced_by ?? undefined,
  })),
];

const report = auditCrosswalk(union, ATTRIBUTE_TO_MATCH_SKILLS);

describe("the union of both corpora", () => {
  it("has no id collisions, so the union is well-defined", () => {
    expect(new Set(union.map((s) => s.skillId)).size).toBe(union.length);
  });

  it("declares six crosswalks, all structurally sound", () => {
    expect(report.findings).toHaveLength(6);
    expect(report.dangling).toEqual([]);
    expect(report.cycles).toEqual([]);
    expect(report.deadEnds).toEqual([]);
    expect(report.activeWithReplacedBy).toEqual([]);
  });

  // THE COMPLETE FINDING. Pinned by name in both directions: a new widening crosswalk fails
  // this, and so does fixing either of these — in the commit that earns the change.
  it("exactly TWO crosswalks widen a worker's match set", () => {
    expect(report.widening).toEqual(["skill_boring", "skill_chassis_fitting"]);
  });

  it("skill_chassis_fitting would hand a worker mskill_fitter", () => {
    const f = report.findings.find((x) => x.skillId === "skill_chassis_fitting");
    expect(f?.matchSkillsBefore).toEqual([]);
    expect(f?.gained).toEqual(["mskill_fitter"]);
    // Outside SKILL_CORPUS, so the bridge's exhaustiveness test never asked about it — the
    // same blind spot TASK 9B found for the 96 promotable skills.
    expect(SKILL_CORPUS.some((s) => s.skillId === "skill_chassis_fitting")).toBe(false);
  });

  it("skill_boring would hand a worker mskill_cnc_turner", () => {
    const f = report.findings.find((x) => x.skillId === "skill_boring");
    expect(f?.matchSkillsBefore).toEqual([]);
    expect(f?.gained).toEqual(["mskill_cnc_turner"]);
  });

  it("no crosswalk narrows a match set — nothing is silently lost either", () => {
    expect(report.findings.flatMap((f) => f.lost)).toEqual([]);
  });

  it("every successor resolves in one hop to a servable skill", () => {
    for (const f of report.findings) {
      expect(f.chainLength, f.skillId).toBe(1);
      expect(f.targetIsServable, f.skillId).toBe(true);
    }
  });
});
