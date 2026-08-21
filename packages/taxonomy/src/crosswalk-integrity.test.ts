/**
 * Deprecation crosswalks, checked in the direction nobody checks.
 *
 * The interesting assertion is the last block: exactly one crosswalk in the live corpus WIDENS
 * a worker's match set, and it is pinned by name. That is not a demand that the defect persist
 * — it is a demand that its size stay known. A new widening crosswalk breaks this test; fixing
 * the existing one also breaks it, in the commit that earns the change.
 */
import { describe, expect, it } from "vitest";

import { auditCrosswalk, resolveTerminal, WIDENING_NOTICE, type CrosswalkSkill } from "./crosswalk-integrity";
import { ATTRIBUTE_TO_MATCH_SKILLS } from "./match-skills";
import { SKILL_CORPUS } from "./skill-corpus";

const s = (
  skillId: string,
  status?: string,
  replacedBy?: string,
): CrosswalkSkill => ({ skillId, status, replacedBy });

describe("resolveTerminal", () => {
  const chain = new Map(
    [s("a", "deprecated", "b"), s("b", "deprecated", "c"), s("c", "active")].map((x) => [x.skillId, x]),
  );

  it("follows a multi-hop chain to its end", () => {
    expect(resolveTerminal("a", chain)).toEqual({ terminal: "c", chainLength: 2, cyclic: false });
  });

  it("a live skill is its own terminal", () => {
    expect(resolveTerminal("c", chain)).toEqual({ terminal: "c", chainLength: 0, cyclic: false });
  });

  it("stops on a loop instead of spinning", () => {
    const loop = new Map([s("x", "deprecated", "y"), s("y", "deprecated", "x")].map((v) => [v.skillId, v]));
    expect(resolveTerminal("x", loop).cyclic).toBe(true);
  });

  it("reports a missing successor as no terminal", () => {
    const gone = new Map([s("a", "deprecated", "nope")].map((v) => [v.skillId, v]));
    expect(resolveTerminal("a", gone).terminal).toBeNull();
  });
});

describe("auditCrosswalk — the two directions", () => {
  it("flags a crosswalk that ADDS a match skill", () => {
    const r = auditCrosswalk(
      [s("skill_old", "deprecated", "skill_new"), s("skill_new", "active")],
      { skill_old: [], skill_new: ["mskill_cnc_turner"] },
    );
    expect(r.widening).toEqual(["skill_old"]);
    expect(r.findings[0]?.gained).toEqual(["mskill_cnc_turner"]);
    expect(r.findings[0]?.lost).toEqual([]);
  });

  it("does NOT flag a crosswalk that only removes one — losing reach is the safe direction", () => {
    const r = auditCrosswalk(
      [s("skill_old", "deprecated", "skill_new"), s("skill_new", "active")],
      { skill_old: ["mskill_fitter"], skill_new: [] },
    );
    expect(r.widening).toEqual([]);
    expect(r.findings[0]?.lost).toEqual(["mskill_fitter"]);
  });

  it("computes the delta against the TERMINAL, not the first hop", () => {
    // A two-hop chain lands the worker on `c`, so `c`'s mapping is what they inherit.
    const r = auditCrosswalk(
      [s("a", "deprecated", "b"), s("b", "deprecated", "c"), s("c", "active")],
      { a: [], b: [], c: ["mskill_plumber"] },
    );
    expect(r.findings.find((f) => f.skillId === "a")?.gained).toEqual(["mskill_plumber"]);
    expect(r.findings.find((f) => f.skillId === "a")?.chainLength).toBe(2);
  });

  it("reports a dangling successor rather than assuming an empty mapping is fine", () => {
    const r = auditCrosswalk([s("a", "deprecated", "ghost")], { a: [] });
    expect(r.dangling).toEqual(["a"]);
    expect(r.findings[0]?.targetExists).toBe(false);
  });

  it("reports a dead end — a successor that is itself not servable", () => {
    const r = auditCrosswalk(
      [s("a", "deprecated", "b"), s("b", "deprecated")],
      { a: [], b: [] },
    );
    expect(r.deadEnds).toEqual(["a"]);
  });

  it("reports a pointer on a non-deprecated row, which the DB CHECK forbids", () => {
    const r = auditCrosswalk([s("a", "active", "b"), s("b", "active")], { a: [], b: [] });
    expect(r.activeWithReplacedBy).toEqual(["a"]);
  });

  it("an empty corpus is an empty report", () => {
    const r = auditCrosswalk([], {});
    expect(r.findings).toEqual([]);
    expect(r.widening).toEqual([]);
  });
});

/**
 * SKILL_CORPUS ONLY — and that is a real limit, not a scoping convenience.
 *
 * Production also carries crosswalks declared in the D2 growth corpus
 * (`packages/db/data/taxonomy/skills.jsonl`), which this package cannot see. Auditing only
 * this half missed a LIVE widening crosswalk; the union is checked in
 * `packages/db/src/crosswalk-integrity-corpus.test.ts`, which is where both corpora are
 * reachable. Neither test is sufficient alone.
 */
describe("the live corpus (SKILL_CORPUS half)", () => {
  const report = auditCrosswalk(SKILL_CORPUS, ATTRIBUTE_TO_MATCH_SKILLS);

  it("has four crosswalks, all well-formed", () => {
    expect(report.findings).toHaveLength(4);
    expect(report.dangling).toEqual([]);
    expect(report.cycles).toEqual([]);
    expect(report.deadEnds).toEqual([]);
    expect(report.activeWithReplacedBy).toEqual([]);
  });

  it("every successor is a live skill reached in one hop", () => {
    for (const f of report.findings) {
      expect(f.targetIsServable, f.skillId).toBe(true);
      expect(f.chainLength, f.skillId).toBe(1);
    }
  });

  // THE FINDING. TD-03 concluded "no matching signal is lost" for skill_boring, which is true
  // and answers the wrong direction: boring maps to nothing, turning maps to mskill_cnc_turner,
  // so re-tagging GIVES a boring worker a CNC-turner claim they never made. Boring is done on a
  // machining centre or a boring mill as readily as on a lathe.
  //
  // Pinned by name so a second one cannot appear unnoticed, and so fixing this one is a
  // deliberate edit here rather than a silent change of behaviour.
  it("exactly one crosswalk IN THIS CORPUS widens a match set, and it is skill_boring", () => {
    expect(report.widening).toEqual(["skill_boring"]);
    const boring = report.findings.find((f) => f.skillId === "skill_boring");
    expect(boring?.matchSkillsBefore).toEqual([]);
    expect(boring?.matchSkillsAfter).toEqual(["mskill_cnc_turner"]);
    expect(boring?.gained).toEqual(["mskill_cnc_turner"]);
  });

  it("no crosswalk silently narrows reach either", () => {
    expect(report.findings.flatMap((f) => f.lost)).toEqual([]);
  });

  it("the notice names the direction the analysis missed", () => {
    expect(WIDENING_NOTICE).toMatch(/invents one/);
    expect(WIDENING_NOTICE).toMatch(/does not answer it/);
  });
});
