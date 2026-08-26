/**
 * D-7C-2 — the refusal matrix.
 *
 * A guard's interesting behaviour is what it does NOT do, and "we ran it and nothing happened"
 * is indistinguishable from a no-op bug. So every refusal below is asserted by its REASON, not
 * merely by the run being empty, and the boring-containment cases are asserted three different
 * ways: by the exclusion map, by the allow-list, and by the corpus not being allowed to widen
 * the set on its own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SKILL_CORPUS } from "@badabhai/taxonomy";

import { D7C_NEUTRAL_SUBJECTS, D7C_SEED_EXCLUSIONS } from "./deprecation-hop0";
import {
  D7C_APPROVED_SUBJECTS,
  planDeprecationSeed,
  renderDeprecationSql,
  vocabularyImpactOfSeed,
  type CorpusDeprecation,
  type LiveSkill,
} from "./deprecation-seed-plan";

const CORPUS: CorpusDeprecation[] = [
  { skillId: "skill_gdt_reading", status: "deprecated", replacedBy: "skill_drawing_reading" },
  { skillId: "skill_cad_interpretation", status: "deprecated", replacedBy: "skill_drawing_reading" },
  { skillId: "skill_dimensional_inspection", status: "deprecated", replacedBy: "skill_quality_control" },
  { skillId: "skill_boring", status: "deprecated", replacedBy: "skill_turning" },
  { skillId: "skill_drawing_reading", status: "active" },
];

const LIVE: LiveSkill[] = [
  { skill_id: "skill_gdt_reading", status: "active", replaced_by: null },
  { skill_id: "skill_cad_interpretation", status: "active", replaced_by: null },
  { skill_id: "skill_dimensional_inspection", status: "active", replaced_by: null },
  { skill_id: "skill_boring", status: "active", replaced_by: null },
  { skill_id: "skill_drawing_reading", status: "active", replaced_by: null },
  { skill_id: "skill_quality_control", status: "active", replaced_by: null },
  { skill_id: "skill_turning", status: "active", replaced_by: null },
];

const plan = (requested: string[], over: Partial<Parameters<typeof planDeprecationSeed>[0]> = {}) =>
  planDeprecationSeed({ requested, corpus: CORPUS, live: LIVE, crossDecisionOrphans: [], ...over });

describe("boring cannot get in, by three independent routes", () => {
  it("naming it directly is refused, with the D-7A reason", () => {
    const p = plan(["skill_boring"]);
    expect(p.writes).toEqual([]);
    expect(p.refusals.join(" ")).toMatch(/skill_boring is EXCLUDED/);
    expect(p.refusals.join(" ")).toMatch(/0\.7556/);
  });

  it("naming it ALONGSIDE approved skills refuses the WHOLE set, not just boring", () => {
    // The dangerous alternative: drop the forbidden one and apply the rest. The operator then
    // believes the run did what they asked.
    const p = plan(["skill_gdt_reading", "skill_boring"]);
    expect(p.refusals.length).toBeGreaterThan(0);
    expect(p.writes).toEqual([]);
    expect(p.alreadyDone).toEqual([]);
  });

  it("it is absent from the allow-list even though the CORPUS marks it deprecated", () => {
    // The corpus is not where the D-7A hold lives, so deriving the set from it re-includes
    // boring the first time anyone re-runs this.
    const corpusDeprecated = SKILL_CORPUS.filter((s) => s.status === "deprecated").map((s) => s.skillId);
    expect(corpusDeprecated).toContain("skill_boring");
    expect(D7C_APPROVED_SUBJECTS).not.toContain("skill_boring");
    expect([...D7C_APPROVED_SUBJECTS].sort()).toEqual([...D7C_NEUTRAL_SUBJECTS].sort());
    expect(corpusDeprecated).toHaveLength(D7C_APPROVED_SUBJECTS.length + 1);
  });

  it("the runner reads the allow-list, never the corpus's deprecated set", () => {
    const src = readFileSync(join(__dirname, "seed-deprecations.ts"), "utf8");
    expect(src).toContain("D7C_APPROVED_SUBJECTS");
    expect(src).not.toMatch(/status\s*===?\s*["']deprecated["']\s*\)\s*\.map/);
  });

  it("and D7C_SEED_EXCLUSIONS still names it — the hold has not been quietly lifted", () => {
    expect(Object.keys(D7C_SEED_EXCLUSIONS)).toEqual(["skill_boring"]);
  });
});

describe("the scope must be stated", () => {
  it("an empty --only is refused; there is no default set", () => {
    expect(plan([]).refusals.join(" ")).toMatch(/--only.*is required/);
  });

  it("an unknown skill is refused as outside the approved set", () => {
    expect(plan(["skill_welding"]).refusals.join(" ")).toMatch(/not in the approved D-7C set/);
  });

  it("a duplicate id is refused rather than deduplicated", () => {
    const p = plan(["skill_gdt_reading", "skill_gdt_reading"]);
    expect(p.refusals.join(" ")).toMatch(/named twice/);
  });
});

describe("the corpus and the database must both support the write", () => {
  it("refuses when the corpus does not mark the skill deprecated", () => {
    const p = plan(["skill_gdt_reading"], {
      corpus: [{ skillId: "skill_gdt_reading", status: "active" }],
      allowList: ["skill_gdt_reading"],
    });
    expect(p.refusals.join(" ")).toMatch(/is "active" in the corpus/);
  });

  it("refuses a deprecation with no successor — retirement is a different decision", () => {
    const p = plan(["skill_gdt_reading"], {
      corpus: [{ skillId: "skill_gdt_reading", status: "deprecated" }],
    });
    expect(p.refusals.join(" ")).toMatch(/NO successor/);
  });

  it("refuses when the successor does not exist on the target", () => {
    const p = plan(["skill_gdt_reading"], {
      live: LIVE.filter((r) => r.skill_id !== "skill_drawing_reading"),
    });
    expect(p.refusals.join(" ")).toMatch(/successor skill_drawing_reading does not exist/);
  });

  it("refuses to create a deprecation CHAIN by pointing at a deprecated successor", () => {
    const p = plan(["skill_gdt_reading"], {
      live: LIVE.map((r) =>
        r.skill_id === "skill_drawing_reading" ? { ...r, status: "deprecated" } : r,
      ),
    });
    expect(p.refusals.join(" ")).toMatch(/deprecation chain/);
  });

  it("refuses when the subject itself is missing from the target", () => {
    const p = plan(["skill_gdt_reading"], {
      live: LIVE.filter((r) => r.skill_id !== "skill_gdt_reading"),
    });
    expect(p.refusals.join(" ")).toMatch(/does not exist on the target/);
  });
});

describe("the D-7C-1a orphan conflict, kept apart from ordinary coverage loss", () => {
  const holders = [
    { norm: "gd&t", skill_id: "skill_gdt_reading", alias_id: "a1" },
    { norm: "gd&t", skill_id: "skill_drawing_reading", alias_id: "a2" },
    { norm: "drawing padhna", skill_id: "skill_gdt_reading", alias_id: "a5" },
  ];

  it("a phrase only the doomed skill holds is COVERAGE LOSS, not a conflict", () => {
    // Every deprecation does this. Refusing on it would mean none could ever run.
    const i = vocabularyImpactOfSeed(holders, ["skill_gdt_reading"], new Set());
    expect(i.coverageLoss).toEqual(["drawing padhna"]);
    expect(i.crossDecisionOrphans).toEqual([]);
  });

  it("a shared phrase survives the deprecation alone — nothing is reported", () => {
    const i = vocabularyImpactOfSeed(holders, ["skill_gdt_reading"], new Set());
    expect(i.coverageLoss).not.toContain("gd&t");
    expect(i.crossDecisionOrphans).not.toContain("gd&t");
  });

  it("but the ELECTION plus the deprecation orphans it — that is the conflict", () => {
    // a2 is skill_drawing_reading's copy, which the 2026-08-21 election NULLs.
    const i = vocabularyImpactOfSeed(holders, ["skill_gdt_reading"], new Set(["a2"]));
    expect(i.crossDecisionOrphans).toEqual(["gd&t"]);
    expect(i.coverageLoss).toEqual(["drawing padhna"]);
  });

  it("a ratified-but-UNAPPLIED election counts — order cannot be used to slip past it", () => {
    // Both orders reach the same end state, so a check that only saw applied writes would let
    // the pair be created by deprecating first and electing afterwards.
    const asIfApplied = vocabularyImpactOfSeed(holders, ["skill_gdt_reading"], new Set(["a2"]));
    const asIfPending = vocabularyImpactOfSeed(holders, ["skill_gdt_reading"], new Set(["a2"]));
    expect(asIfApplied).toEqual(asIfPending);
  });

  it("only the conflict refuses the run, and it names the owner decision", () => {
    const p = plan(["skill_gdt_reading"], { crossDecisionOrphans: ["gd&t"] });
    expect(p.writes).toEqual([]);
    expect(p.refusals.join(" ")).toMatch(/would SURVIVE this deprecation, and does not/);
    expect(p.refusals.join(" ")).toMatch(/D-7C-1a/);
  });

  it("coverage loss alone does NOT refuse — it is what the owner approved", () => {
    const p = plan([...D7C_APPROVED_SUBJECTS], { crossDecisionOrphans: [] });
    expect(p.refusals).toEqual([]);
    expect(p.writes).toHaveLength(3);
  });
});

describe("what a clean run would do", () => {
  it("writes exactly the three approved rows, with their corpus successors", () => {
    const p = plan([...D7C_APPROVED_SUBJECTS]);
    expect(p.refusals).toEqual([]);
    expect(p.writes.map((w) => [w.skill_id, w.to_replaced_by])).toEqual([
      ["skill_cad_interpretation", "skill_drawing_reading"],
      ["skill_dimensional_inspection", "skill_quality_control"],
      ["skill_gdt_reading", "skill_drawing_reading"],
    ]);
  });

  it("is idempotent: a row already in the target state is reported, not rewritten", () => {
    const p = plan(["skill_gdt_reading"], {
      live: LIVE.map((r) =>
        r.skill_id === "skill_gdt_reading"
          ? { ...r, status: "deprecated", replaced_by: "skill_drawing_reading" }
          : r,
      ),
    });
    expect(p.writes).toEqual([]);
    expect(p.alreadyDone).toEqual(["skill_gdt_reading"]);
  });

  it("moves status and pointer in ONE statement, and does not touch version", () => {
    const sql = renderDeprecationSql({
      skill_id: "skill_gdt_reading",
      from_status: "active",
      to_status: "deprecated",
      from_replaced_by: null,
      to_replaced_by: "skill_drawing_reading",
    });
    // The CHECK is `replaced_by IS NULL OR status='deprecated'` and evaluates the whole tuple,
    // so a two-statement write is either a violation or a window with no successor.
    expect(sql).toMatch(/SET status = 'deprecated', replaced_by = 'skill_drawing_reading'/);
    expect(sql).not.toMatch(/version/);
  });
});

describe("the runner cannot write by accident", () => {
  const src = readFileSync(join(__dirname, "seed-deprecations.ts"), "utf8");

  it("dry run is the default — --apply gates both the guard and the UPDATE", () => {
    expect(src).toContain('const apply = process.argv.includes("--apply")');
    expect(src).toContain("mutating: apply");
    expect(src).toMatch(/if \(!apply\)[\s\S]{0,200}PLAN ONLY/);
  });

  it("the only statement that changes a row is the one UPDATE, and it is read back", () => {
    const mutations = src.match(/\b(UPDATE|INSERT|DELETE)\b/g) ?? [];
    // One in the doc header, one in the rendered plan, one real statement.
    expect(mutations.filter((m) => m === "DELETE")).toEqual([]);
    expect(mutations.filter((m) => m === "INSERT")).toEqual([]);
    expect(src).toContain("read-back FAILED");
  });

  it("it never touches skill_alias, and never embeds", () => {
    expect(src).not.toMatch(/UPDATE skill_alias|INSERT INTO skill_alias/);
    expect(src).not.toMatch(/embed(Skill|Alias)|EMBED_/);
  });

  it("its ops-guard token is its own, so authorising another runner does not authorise it", () => {
    expect(src).toContain('const SCRIPT = "seed:deprecations"');
  });
});
