/**
 * The taxonomy seeder's PURE PLANNERS.
 *
 * Deliberately NOT a database test. The seeder's writes are three `ON CONFLICT DO UPDATE`
 * statements whose correctness is a property of the SQL and the schema constraints, and
 * proving those needs a real Postgres — which is QA's cross-cutting fresh-DB run, not a
 * unit test pretending to have one. What IS decidable here, and what actually goes wrong
 * in practice, is everything upstream of the connection:
 *
 *   - `text_norm` must come from the SAME normalizer the retrieval path uses, or L0 stops
 *     hitting and every profiling turn falls through to a paid embedding;
 *   - exactly ONE row per (skill_id, text_norm, lang) may be `is_searchable`, because
 *     `skill_alias_skill_norm_lang_uq` is a UNIQUE partial index — a second winner is not
 *     a soft conflict, it aborts the whole apply;
 *   - a `reuses_existing` record must NOT produce a `skill` row, or the seed would restate
 *     (and eventually overwrite) provenance `seed-skills.ts` owns.
 *
 * Importing this module runs no CLI: `seed-domain-skills.ts` guards its `main()`.
 */
import { describe, expect, it } from "vitest";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import {
  buildClaimedSet,
  planAliasRows,
  planEdgeRows,
  planSkillRows,
  shippedDependencies,
} from "./seed-domain-skills";
import { deterministicAliasId } from "./skill-alias-id";
import { shippedSkillIds, type TaxonomyCorpus, type TaxonomySkillRecord } from "./taxonomy-corpus";

function skill(overrides: Partial<TaxonomySkillRecord> = {}): TaxonomySkillRecord {
  return {
    kind: "skill",
    skill_id: "skill_fanuc_cnc",
    label_en: "Fanuc CNC",
    label_hi: null,
    aliases: [{ text: "fanuc", lang: "en" }],
    ...overrides,
  };
}

describe("planSkillRows", () => {
  it("maps a corpus skill to its row", () => {
    expect(planSkillRows([skill({ label_hi: "फैनुक" })])).toEqual([
      { skillId: "skill_fanuc_cnc", labelEn: "Fanuc CNC", labelHi: "फैनुक" },
    ]);
  });

  it("EXCLUDES a reuses_existing record — seed-skills.ts owns that row", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    expect(planSkillRows([skill({ skill_id: shipped, reuses_existing: true })])).toEqual([]);
  });
});

describe("planAliasRows", () => {
  it("computes text_norm with the SAME normalizer the retrieval path calls", () => {
    const rows = planAliasRows([skill({ aliases: [{ text: "Fanuc Controller", lang: "en" }] })]);
    expect(rows[0]?.textNorm).toBe(normalizeOccupationText("Fanuc Controller"));
  });

  it("derives the row id deterministically from (skill_id, text, lang)", () => {
    const rows = planAliasRows([skill()]);
    expect(rows[0]?.id).toBe(deterministicAliasId("skill_fanuc_cnc", "fanuc", "en"));
    // Stable across calls, which is what makes ON CONFLICT (id) DO UPDATE a no-op re-run
    // and what stops a paid embedding being stranded on an orphaned duplicate row.
    expect(planAliasRows([skill()])[0]?.id).toBe(rows[0]?.id);
  });

  it("elects exactly ONE searchable row per (skill, text_norm, lang)", () => {
    // Two texts that collapse to one normalized key. A clean corpus cannot contain this —
    // the validator rejects it — but the election must still be total, because `claimed`
    // and future corpus edits can both produce a group with more than one member.
    const rows = planAliasRows([
      skill({
        aliases: [
          { text: "fanuc wala", lang: "en" },
          { text: "fanuc", lang: "en" },
        ],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isSearchable)).toHaveLength(1);
    // Shortest text wins — the least particle-laden form.
    expect(rows.find((r) => r.isSearchable)?.text).toBe("fanuc");
  });

  it("elects the same winner on a re-run, so the upsert stays a genuine no-op", () => {
    const first = planAliasRows([skill({ aliases: [{ text: "fanuc", lang: "en" }, { text: "fanuc wala", lang: "en" }] })]);
    const second = planAliasRows([skill({ aliases: [{ text: "fanuc wala", lang: "en" }, { text: "fanuc", lang: "en" }] })]);
    expect(first.find((r) => r.isSearchable)?.id).toBe(second.find((r) => r.isSearchable)?.id);
  });

  it("does not de-elect its OWN previous run — the run1 -> run2 feedback loop", () => {
    // THE REGRESSION THIS EXISTS FOR, and it is the one the sibling test above cannot see.
    // That test hand-builds `claimed`; this one feeds run 1's actual output back in the way
    // the runner does, which is where the bug lived.
    //
    // The runner reads `claimed` from `skill_alias WHERE is_searchable` — which, on a second
    // run, INCLUDES the winners it elected on the first. Treated as foreign claims, every
    // group gets skipped during election, every alias comes back `is_searchable: false`, and
    // the upsert's `IS DISTINCT FROM` guard sees true-vs-false as a real change and writes
    // it. Run 3 finds nothing claimed and flips them all back. The state oscillates, and
    // nothing errors or logs — the runner reports "N updated" both times and looks busy
    // rather than broken.
    //
    // The fix subtracts the seeder's own planned alias ids before building `claimed`, which
    // is sound because `deterministicAliasId` does not depend on election: a row's identity
    // is stable across runs even when its `is_searchable` value is not.
    const corpus = [
      skill({
        aliases: [
          { text: "fanuc", lang: "en" },
          { text: "fanuc wala", lang: "en" },
          { text: "haas", lang: "en" },
        ],
      }),
    ];

    const run1 = planAliasRows(corpus);

    // Exactly what the runner reads back from `skill_alias WHERE is_searchable` after run 1.
    const rowsInDb = run1
      .filter((r) => r.isSearchable)
      .map((r) => ({ id: r.id, skillId: r.skillId, textNorm: r.textNorm, lang: r.lang }));
    expect(rowsInDb.length).toBeGreaterThan(0); // the loop is only meaningful if run 1 elected

    // `buildClaimedSet` is the REAL function the runner calls — not a re-implementation of
    // it here. That matters: a test that recreated the subtraction inline would keep passing
    // if the runner's own copy regressed.
    const claimed = buildClaimedSet(rowsInDb, planAliasRows(corpus));
    const run2 = planAliasRows(corpus, { claimed });

    const winners = (rows: typeof run1) =>
      rows
        .filter((r) => r.isSearchable)
        .map((r) => r.id)
        .sort();
    expect(winners(run2)).toEqual(winners(run1));

    // And the whole row set is unchanged, so the upsert's setWhere finds nothing to write.
    expect(run2.map((r) => [r.id, r.isSearchable])).toEqual(
      run1.map((r) => [r.id, r.isSearchable]),
    );
  });

  it("elects NOBODY for a group an already-seeded row claims", () => {
    // A shipped alias already holds is_searchable on this group. Electing a second winner
    // would violate skill_alias_skill_norm_lang_uq and abort the apply.
    const claimed = new Set([`skill_fanuc_cnc|${normalizeOccupationText("fanuc")}|en`]);
    const rows = planAliasRows([skill()], { claimed });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isSearchable).toBe(false);
  });

  it("keeps langs in separate groups", () => {
    const rows = planAliasRows([
      skill({
        aliases: [
          { text: "fanuc", lang: "en" },
          { text: "fanuc", lang: "hi" },
        ],
      }),
    ]);
    expect(rows.filter((r) => r.isSearchable)).toHaveLength(2);
  });

  it("skips an alias that normalizes to nothing rather than writing an empty key", () => {
    // An empty text_norm collides with every other empty one under NULLS NOT DISTINCT.
    expect(planAliasRows([skill({ aliases: [{ text: "///", lang: "en" }] })])).toEqual([]);
  });

  it("seeds aliases for a reuses_existing record even though its skill row is skipped", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    const rows = planAliasRows([skill({ skill_id: shipped, reuses_existing: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skillId).toBe(shipped);
  });
});

describe("planEdgeRows", () => {
  it("projects an edge and stamps one `now` on both timestamps", () => {
    const now = new Date("2026-08-16T09:30:00.000Z");
    const rows = planEdgeRows(
      [
        {
          kind: "domain_skill",
          job_domain_id: "jd_nco_7223_6002",
          skill_id: "skill_fanuc_cnc",
          default_requirement: "required",
          relevance: 90,
          confidence: 0.9,
          source: "llm_bootstrap",
        },
      ],
      now,
    );
    expect(rows).toEqual([
      {
        jobDomainId: "jd_nco_7223_6002",
        skillId: "skill_fanuc_cnc",
        defaultRequirement: "required",
        relevance: 90,
        confidence: 0.9,
        source: "llm_bootstrap",
        computedAt: now,
        updatedAt: now,
      },
    ]);
  });
});

describe("shippedDependencies — the precondition the run refuses on", () => {
  const shipped = [...shippedSkillIds()][0] as string;

  function corpus(overrides: Partial<TaxonomyCorpus> = {}): TaxonomyCorpus {
    return { domains: [], skills: [], edges: [], ...overrides };
  }

  it("names a shipped skill referenced only by an edge", () => {
    const c = corpus({
      edges: [
        {
          kind: "domain_skill",
          job_domain_id: "jd_x",
          skill_id: shipped,
          default_requirement: "required",
          relevance: 50,
          confidence: null,
          source: "llm_bootstrap",
        },
      ],
    });
    expect(shippedDependencies(c)).toEqual([shipped]);
  });

  it("names a shipped skill a reuses_existing record hangs aliases on", () => {
    const c = corpus({ skills: [skill({ skill_id: shipped, reuses_existing: true })] });
    expect(shippedDependencies(c)).toEqual([shipped]);
  });

  it("does NOT name a skill this corpus creates itself", () => {
    const c = corpus({
      skills: [skill()],
      edges: [
        {
          kind: "domain_skill",
          job_domain_id: "jd_x",
          skill_id: "skill_fanuc_cnc",
          default_requirement: "required",
          relevance: 50,
          confidence: null,
          source: "llm_bootstrap",
        },
      ],
    });
    expect(shippedDependencies(c)).toEqual([]);
  });
});
