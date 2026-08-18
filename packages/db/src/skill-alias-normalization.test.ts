import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { describe, expect, it } from "vitest";

import {
  assertRetrievalPredicateSafe,
  findCrossSkillCollisions,
  findUniqueKeyConflicts,
  planSkillAliasNormalization,
  retrievalPredicateReadiness,
  type SkillAliasNormalizationRow,
} from "./skill-alias-normalization";

/** A row with sane defaults; each test overrides only what it is about. */
function row(over: Partial<SkillAliasNormalizationRow> & { id: string }): SkillAliasNormalizationRow {
  return {
    skillId: "skill_turning",
    text: "turning",
    textNorm: null,
    lang: "en",
    skillStatus: "provisional",
    isSearchable: false,
    hasEmbedding: false,
    ...over,
  };
}

describe("planSkillAliasNormalization — the write set", () => {
  it("plans exactly the rows whose text_norm is NULL", () => {
    const plan = planSkillAliasNormalization([
      row({ id: "a", text: "CNC Turning" }),
      row({ id: "b", text: "Milling", textNorm: "milling" }),
      row({ id: "c", text: "Welding" }),
    ]);

    expect(plan.totalRows).toBe(3);
    expect(plan.alreadyNormalized).toBe(1);
    expect(plan.missingTextNorm).toBe(2);
    expect(plan.writes.map((w) => w.id)).toEqual(["a", "c"]);
    expect(plan.writes.map((w) => w.textNorm)).toEqual(["cnc turning", "welding"]);
  });

  it("is idempotent: applying the plan and re-planning yields no writes", () => {
    const before = [row({ id: "a", text: "CNC Turning" }), row({ id: "b", text: "Bench Fitting" })];
    const first = planSkillAliasNormalization(before);
    expect(first.writes).toHaveLength(2);

    // Apply: the ONLY mutation this runner makes is text_norm on the planned rows.
    const applied = before.map((r) => {
      const w = first.writes.find((x) => x.id === r.id);
      return w === undefined ? r : { ...r, textNorm: w.textNorm };
    });

    const second = planSkillAliasNormalization(applied);
    expect(second.writes).toEqual([]);
    expect(second.missingTextNorm).toBe(0);
    expect(second.alreadyNormalized).toBe(2);
    // And a third pass is identical to the second — no oscillation.
    expect(planSkillAliasNormalization(applied)).toEqual(second);
  });

  it("delegates to normalizeOccupationText rather than defining a second normalizer", () => {
    // The whole hazard this pins: a second definition drifts, L0 stops matching, and every
    // profiling turn silently falls through to a paid embedding.
    const samples = ["Bench Fitting", "मशीन ऑपरेटर", "gas-cutting", "TIG/MIG welding", "fitter ka kaam"];
    const plan = planSkillAliasNormalization(
      samples.map((text, i) => row({ id: `s${i}`, text })),
    );
    expect(plan.writes.map((w) => w.textNorm)).toEqual(samples.map(normalizeOccupationText));
  });
});

describe("planSkillAliasNormalization — Unicode, Hinglish and Devanagari", () => {
  it("normalizes Devanagari and keeps it distinct from its Latin transliteration", () => {
    const plan = planSkillAliasNormalization([
      row({ id: "dev", text: "वेल्डिंग" }),
      row({ id: "lat", text: "Welding" }),
    ]);
    const [dev, lat] = plan.writes;
    expect(dev?.textNorm).toBe("वेल्डिंग");
    expect(lat?.textNorm).toBe("welding");
    // Two scripts are two surface forms. The normalizer does NOT transliterate, so these
    // must not collapse — collapsing them would be a silent taxonomy merge.
    expect(dev?.textNorm).not.toBe(lat?.textNorm);
  });

  it("strips Hinglish occupational particles", () => {
    const plan = planSkillAliasNormalization([
      row({ id: "a", text: "welding ka kaam" }),
      row({ id: "b", text: "silaiwala" }),
    ]);
    expect(plan.writes.map((w) => w.textNorm)).toEqual([
      normalizeOccupationText("welding ka kaam"),
      normalizeOccupationText("silaiwala"),
    ]);
    // The particle really is removed — otherwise this test would pass vacuously by
    // comparing the normalizer against itself.
    expect(plan.writes[0]?.textNorm).toBe("welding");
  });

  it("applies NFKC, so a compatibility form and its canonical form share one key", () => {
    // U+FF23 FULLWIDTH LATIN CAPITAL C etc. NFKC-fold to ASCII.
    const plan = planSkillAliasNormalization([
      row({ id: "wide", skillId: "skill_cnc", text: "ＣＮＣ" }),
      row({ id: "ascii", skillId: "skill_cnc", text: "CNC" }),
    ]);
    expect(plan.writes.map((w) => w.textNorm)).toEqual(["cnc", "cnc"]);
    // Same skill, same normalized form => this is a unique-key group, not two rows.
    expect(plan.uniqueKeyConflicts).toHaveLength(1);
  });
});

describe("planSkillAliasNormalization — punctuation and whitespace", () => {
  it("collapses whitespace and strips edge punctuation", () => {
    const plan = planSkillAliasNormalization([
      row({ id: "a", text: "  Gas   Cutting.  " }),
      row({ id: "b", text: "(Turning)" }),
    ]);
    expect(plan.writes.map((w) => w.textNorm)).toEqual(["gas cutting", "turning"]);
  });

  it("KEEPS intra-word hyphens and slashes, so they are NOT interchangeable with a space", () => {
    // Counter-intuitive and load-bearing: `bench-fitting` and `bench fitting` are two
    // distinct L0 keys. Anyone reasoning about collisions must know this, and a previous
    // test in this repo asserted the opposite and was wrong about the code, not the code
    // about the test.
    const plan = planSkillAliasNormalization([
      row({ id: "hyphen", text: "bench-fitting" }),
      row({ id: "space", text: "Bench fitting" }),
      row({ id: "slash", text: "TIG/MIG" }),
    ]);
    expect(plan.writes.map((w) => w.textNorm)).toEqual(["bench-fitting", "bench fitting", "tig/mig"]);
    expect(plan.uniqueKeyConflicts).toEqual([]);
  });

  it("reports a row that normalizes to empty instead of writing it", () => {
    // An empty text_norm would collide with every other empty one under the unique index's
    // NULLS NOT DISTINCT, so it is a corpus defect to surface, not a value to write.
    const plan = planSkillAliasNormalization([row({ id: "junk", text: "!!! ---" })]);
    expect(plan.writes).toEqual([]);
    expect(plan.normalizesToEmpty).toEqual(["junk"]);
    expect(plan.byStatus.provisional?.normalizesToEmpty).toBe(1);
  });
});

describe("planSkillAliasNormalization — existing text_norm is preserved", () => {
  it("never rewrites a populated text_norm, and reports the drift instead", () => {
    const rows = [row({ id: "drifted", text: "Welding", textNorm: "stale-value", isSearchable: true })];
    const plan = planSkillAliasNormalization(rows);

    expect(plan.writes).toEqual([]);
    expect(plan.drift).toEqual([
      { id: "drifted", skillId: "skill_turning", stored: "stale-value", recomputed: "welding" },
    ]);
  });

  it("does not report drift when the stored value already matches", () => {
    const plan = planSkillAliasNormalization([row({ id: "ok", text: "Welding", textNorm: "welding" })]);
    expect(plan.drift).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("uses the STORED value for collision detection on a drifted row", () => {
    // The plan must describe the post-apply table. Since a drifted row keeps its stored
    // key, a collision must be computed against that key — not against the value the
    // normalizer would have produced but will not write.
    const plan = planSkillAliasNormalization([
      row({ id: "drifted", skillId: "skill_x", text: "Welding", textNorm: "gas cutting" }),
      row({ id: "fresh", skillId: "skill_x", text: "Gas Cutting" }),
    ]);
    expect(plan.uniqueKeyConflicts).toHaveLength(1);
    expect(plan.uniqueKeyConflicts[0]?.ids).toEqual(["drifted", "fresh"]);
  });
});

describe("findUniqueKeyConflicts — the (skill_id, text_norm, lang) index shape", () => {
  it("groups same-skill rows that share a normalized form", () => {
    const conflicts = findUniqueKeyConflicts([
      row({ id: "a", skillId: "skill_weld", text: "Welding", isSearchable: true }),
      row({ id: "b", skillId: "skill_weld", text: "welding." }),
      row({ id: "c", skillId: "skill_weld", text: "Gas cutting" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.ids).toEqual(["a", "b"]);
    // Reported separately, because 1 searchable member is a legal elected group and 2
    // would mean the live index is already violated.
    expect(conflicts[0]?.searchableIds).toEqual(["a"]);
  });

  it("treats NULL lang as EQUAL, matching the index's NULLS NOT DISTINCT", () => {
    const conflicts = findUniqueKeyConflicts([
      row({ id: "a", skillId: "skill_weld", text: "Welding", lang: null }),
      row({ id: "b", skillId: "skill_weld", text: "welding", lang: null }),
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("does NOT group rows that differ only by lang", () => {
    const conflicts = findUniqueKeyConflicts([
      row({ id: "a", skillId: "skill_weld", text: "Welding", lang: "en" }),
      row({ id: "b", skillId: "skill_weld", text: "welding", lang: "hi" }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("does not confuse a NULL lang with the literal string 'null'", () => {
    // The grouping key is JSON, not a delimiter join, precisely so these stay distinct.
    const conflicts = findUniqueKeyConflicts([
      row({ id: "a", skillId: "skill_weld", text: "Welding", lang: null }),
      row({ id: "b", skillId: "skill_weld", text: "welding", lang: "null" }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("does not group rows of different skills — the index is partitioned by skill_id", () => {
    expect(
      findUniqueKeyConflicts([
        row({ id: "a", skillId: "skill_weld", text: "Welding" }),
        row({ id: "b", skillId: "skill_fab", text: "welding" }),
      ]),
    ).toEqual([]);
  });

  it("ignores rows that normalize to nothing — they are outside the partial index", () => {
    expect(
      findUniqueKeyConflicts([
        row({ id: "a", skillId: "skill_weld", text: "!!!" }),
        row({ id: "b", skillId: "skill_weld", text: "---" }),
      ]),
    ).toEqual([]);
  });
});

describe("findCrossSkillCollisions — the L0 ranking hazard", () => {
  it("reports one normalized form owned by two skills", () => {
    const collisions = findCrossSkillCollisions([
      row({ id: "a", skillId: "skill_bench_fitting", text: "Fitting" }),
      row({ id: "b", skillId: "skill_pipe_fitting", text: "fitting" }),
      row({ id: "c", skillId: "skill_pipe_fitting", text: "Pipe fitting" }),
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.textNorm).toBe("fitting");
    expect(collisions[0]?.skillIds).toEqual(["skill_bench_fitting", "skill_pipe_fitting"]);
    expect(collisions[0]?.ids).toEqual(["a", "b"]);
  });

  it("does not report a same-skill duplicate as a cross-skill collision", () => {
    expect(
      findCrossSkillCollisions([
        row({ id: "a", skillId: "skill_weld", text: "Welding" }),
        row({ id: "b", skillId: "skill_weld", text: "welding" }),
      ]),
    ).toEqual([]);
  });

  it("separates collisions by lang", () => {
    expect(
      findCrossSkillCollisions([
        row({ id: "a", skillId: "skill_weld", text: "Welding", lang: "en" }),
        row({ id: "b", skillId: "skill_fab", text: "welding", lang: "hi" }),
      ]),
    ).toEqual([]);
  });
});

describe("planSkillAliasNormalization — active vs provisional breakdown", () => {
  it("counts each status separately and never averages the active catalogue away", () => {
    const plan = planSkillAliasNormalization([
      row({ id: "a1", skillStatus: "active", text: "Turning", hasEmbedding: true }),
      row({ id: "a2", skillStatus: "active", text: "Milling", hasEmbedding: true }),
      row({ id: "p1", skillStatus: "provisional", text: "Grinding", textNorm: "grinding", isSearchable: true, hasEmbedding: true }),
      row({ id: "p2", skillStatus: "provisional", text: "Boring" }),
    ]);

    expect(plan.byStatus.active).toEqual({
      rows: 2,
      alreadyNormalized: 0,
      newlyDerivable: 2,
      normalizesToEmpty: 0,
      embedded: 2,
      searchable: 0,
    });
    expect(plan.byStatus.provisional).toEqual({
      rows: 2,
      alreadyNormalized: 1,
      newlyDerivable: 1,
      normalizesToEmpty: 0,
      embedded: 1,
      searchable: 1,
    });
  });
});

describe("retrievalPredicateReadiness — the invariant that guards `AND sa.is_searchable`", () => {
  const activeEmbeddedHidden = row({
    id: "gateB",
    skillStatus: "active",
    hasEmbedding: true,
    isSearchable: false,
    textNorm: null,
  });

  it("is NOT safe while an active embedded alias is hidden by missing normalization", () => {
    const readiness = retrievalPredicateReadiness([activeEmbeddedHidden]);
    expect(readiness.safe).toBe(false);
    expect(readiness.hiddenByMissingNormalization).toEqual(["gateB"]);
    expect(readiness.hiddenWithoutElection).toEqual([]);
  });

  it("reproduces the live 2026-08-18 corpus shape: 98 active aliases block the predicate", () => {
    const corpus = [
      ...Array.from({ length: 197 }, (_, i) =>
        row({ id: `prov-${i}`, skillId: `s${i}`, skillStatus: "provisional", textNorm: `n${i}`, isSearchable: true, hasEmbedding: true }),
      ),
      ...Array.from({ length: 98 }, (_, i) =>
        row({ id: `act-${i}`, skillId: `a${i}`, skillStatus: "active", textNorm: null, isSearchable: false, hasEmbedding: true }),
      ),
      ...Array.from({ length: 33 }, (_, i) =>
        row({ id: `unemb-${i}`, skillId: `u${i}`, skillStatus: "provisional", textNorm: null, isSearchable: false, hasEmbedding: false }),
      ),
    ];
    const readiness = retrievalPredicateReadiness(corpus);
    expect(corpus).toHaveLength(328);
    expect(readiness.safe).toBe(false);
    expect(readiness.hiddenByMissingNormalization).toHaveLength(98);
    expect(() => assertRetrievalPredicateSafe(corpus)).toThrow(/98 active embedded alias/);
  });

  it("STAYS unsafe after normalization until election actually runs", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The first version of this check treated any
    // populated `text_norm` as proof of intent, so it flipped to SAFE at the midpoint of
    // the rolled-back rehearsal — with all 98 active aliases normalized and none elected,
    // which is the same total blackout, one step later.
    const normalized = Array.from({ length: 98 }, (_, i) =>
      row({ id: `act-${i}`, skillId: `a${i}`, skillStatus: "active", textNorm: `n${i}`, isSearchable: false, hasEmbedding: true }),
    );
    const midpoint = retrievalPredicateReadiness(normalized);
    expect(midpoint.safe).toBe(false);
    expect(midpoint.hiddenByMissingNormalization).toEqual([]);
    expect(midpoint.hiddenWithoutElection).toHaveLength(98);

    const elected = normalized.map((r) => ({ ...r, isSearchable: true }));
    expect(retrievalPredicateReadiness(elected).safe).toBe(true);
  });

  it("does not block on a LOSING DUPLICATE — its normalized form is still reachable", () => {
    // Measured in the rehearsal: `kharad` / `kharad ka kaam` both normalize to `kharad`,
    // election keeps one. The loser keeps its row and its paid embedding and stops being
    // retrievable, which is what election is FOR.
    const readiness = retrievalPredicateReadiness([
      row({ id: "winner", skillId: "skill_turning", textNorm: "kharad", lang: "hi", skillStatus: "active", hasEmbedding: true, isSearchable: true }),
      row({ id: "loser", skillId: "skill_turning", textNorm: "kharad", lang: "hi", skillStatus: "active", hasEmbedding: true, isSearchable: false }),
    ]);
    expect(readiness.safe).toBe(true);
    expect(readiness.hiddenAsLosingDuplicate).toEqual(["loser"]);
    expect(readiness.hiddenWithoutElection).toEqual([]);
  });

  it("a winner in a DIFFERENT group does not excuse an unelected row", () => {
    const readiness = retrievalPredicateReadiness([
      row({ id: "other", skillId: "skill_turning", textNorm: "kharad", lang: "hi", skillStatus: "active", hasEmbedding: true, isSearchable: true }),
      row({ id: "orphan", skillId: "skill_turning", textNorm: "lathe", lang: "en", skillStatus: "active", hasEmbedding: true, isSearchable: false }),
    ]);
    expect(readiness.safe).toBe(false);
    expect(readiness.hiddenWithoutElection).toEqual(["orphan"]);
  });

  it("a DELIBERATE demotion clears the invariant only when it is RECORDED", () => {
    // `fitting` / `gauge`: normalized, embedded, active, and the only row carrying their
    // text_norm — so after demotion their group has no winner and they look exactly like
    // an unelected row. No column distinguishes them; intent must come from outside.
    const demoted = [
      row({ id: "fitting", skillId: "skill_bench_fitting", skillStatus: "active", text: "fitting", textNorm: "fitting", hasEmbedding: true, isSearchable: false }),
      row({ id: "gauge", skillId: "skill_measuring_instruments", skillStatus: "active", text: "gauge", textNorm: "gauge", hasEmbedding: true, isSearchable: false }),
    ];

    // Unrecorded: fails closed.
    expect(retrievalPredicateReadiness(demoted).safe).toBe(false);
    expect(retrievalPredicateReadiness(demoted).hiddenWithoutElection).toEqual(["fitting", "gauge"]);

    // Recorded: accepted, and reported as a decision rather than an omission.
    const recorded = retrievalPredicateReadiness(demoted, {
      intentionallyDemoted: ["fitting", "gauge"],
    });
    expect(recorded.safe).toBe(true);
    expect(recorded.hiddenByDecision).toEqual(["fitting", "gauge"]);
    expect(() => assertRetrievalPredicateSafe(demoted, { intentionallyDemoted: ["fitting", "gauge"] })).not.toThrow();
  });

  it("the register does NOT excuse a row that was never normalized", () => {
    // Recording intent cannot substitute for processing: an un-normalized row has no L0
    // key at all, so "we meant to hide it" is not the same claim.
    const readiness = retrievalPredicateReadiness([activeEmbeddedHidden], {
      intentionallyDemoted: ["gateB"],
    });
    expect(readiness.safe).toBe(false);
    expect(readiness.hiddenByMissingNormalization).toEqual(["gateB"]);
  });

  it("ignores non-active and unembedded rows — neither is reachable by these paths", () => {
    expect(
      retrievalPredicateReadiness([
        row({ id: "prov", skillStatus: "provisional", hasEmbedding: true, textNorm: null }),
        row({ id: "unemb", skillStatus: "active", hasEmbedding: false, textNorm: null }),
      ]).safe,
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// THE SOURCE PIN
// ─────────────────────────────────────────────────────────────────────────────────────

const REPO = join(__dirname, "..", "..", "..");

/**
 * The three SQL sites that read `skill_alias` for retrieval. All three must be listed:
 * a file-level `toContain` over only one of them passes while the other is open, which is
 * exactly how an earlier version of this pin reported both skill paths protected when
 * neither was — `nearestDomains` in the same file contains the string for its own,
 * unrelated, `job_domain_alias` predicate.
 */
const SKILL_ALIAS_RETRIEVAL_SITES = [
  {
    method: "canonicalAliasRows",
    file: join(REPO, "apps", "api", "src", "skills", "skills.repository.ts"),
    // The DEFINITION, not the call site. `this.canonicalAliasRows(...)` appears ~130 lines
    // earlier, and anchoring there would walk to the NEXT backtick — which is
    // `legacyAliasRows`' SQL. The pin would then read the wrong statement and pass.
    anchor: "private canonicalAliasRows(",
    mustContain: /job_domain_skill/,
  },
  {
    method: "legacyAliasRows",
    file: join(REPO, "apps", "api", "src", "skills", "skills.repository.ts"),
    anchor: "private legacyAliasRows(",
    mustContain: /sa\.domain_id/,
  },
  {
    method: "CANONICAL_RETRIEVAL_SQL",
    file: join(REPO, "packages", "db", "src", "taxonomy-retrieval-eval.ts"),
    anchor: "export const CANONICAL_RETRIEVAL_SQL =",
    mustContain: /job_domain_skill/,
  },
] as const;

type RetrievalSite = (typeof SKILL_ALIAS_RETRIEVAL_SITES)[number];

/** The SQL template literal belonging to one site, isolated from its neighbours. */
function sqlBodyOf(site: RetrievalSite): string {
  const src = readFileSync(site.file, "utf8");
  const at = src.indexOf(site.anchor);
  expect(at, `anchor not found: ${site.anchor}`).toBeGreaterThan(-1);
  expect(src.indexOf(site.anchor, at + 1), `anchor is ambiguous: ${site.anchor}`).toBe(-1);
  const open = src.indexOf("`", at);
  const close = src.indexOf("`", open + 1);
  expect(close, `unterminated template after ${site.anchor}`).toBeGreaterThan(open);
  return src.slice(open + 1, close);
}

describe("skill-alias retrieval paths — the predicate is not enabled, and cannot diverge", () => {
  it.each(SKILL_ALIAS_RETRIEVAL_SITES)(
    "$method does not filter on is_searchable",
    (site) => {
      // NOT a style preference. On 2026-08-18 the live corpus had 98 active embedded
      // aliases with is_searchable = false and text_norm IS NULL — every alias of every
      // active skill. Adding the predicate to this statement makes all 30 active skills
      // unreachable, and the build stays green because no test owns a live corpus.
      //
      // TO ENABLE IT, IN THIS ORDER:
      //   1. pnpm db:normalize:skill-aliases --apply          (fills text_norm)
      //   2. elect is_searchable                              (a separate gated change)
      //   3. pnpm db:normalize:skill-aliases --assert-predicate-safe   (must PASS)
      //   4. only then edit this pin, together with all three sites at once.
      expect(sqlBodyOf(site)).not.toMatch(/is_searchable/);
    },
  );

  it("holds all three sites to the same rule, so two paths cannot silently diverge", () => {
    const flagged = SKILL_ALIAS_RETRIEVAL_SITES.filter((s) => /is_searchable/.test(sqlBodyOf(s)));
    // 0 or 3 — never 1 or 2. A partial rollout is the failure mode where the canonical
    // path refuses a skill the legacy path still returns, and the evaluation harness
    // disagrees with both.
    expect([0, SKILL_ALIAS_RETRIEVAL_SITES.length]).toContain(flagged.length);
  });

  it("reads the intended statement at each site, so the pin cannot pass by mis-parsing", () => {
    // Anti-vacuity. Every assertion above is a NEGATIVE match, which is exactly the shape
    // that passes when the extractor returns the wrong text — or no text at all.
    for (const site of SKILL_ALIAS_RETRIEVAL_SITES) {
      const body = sqlBodyOf(site);
      expect(body, site.method).toMatch(/skill_alias/);
      expect(body, site.method).toMatch(/sa\.embedding/);
      expect(body, `${site.method} extracted a neighbouring statement`).toMatch(site.mustContain);
    }
    // The two API-side sites are genuinely different statements, not one read twice.
    const [canonical, legacy] = SKILL_ALIAS_RETRIEVAL_SITES.map(sqlBodyOf);
    expect(canonical).not.toBe(legacy);
  });
});
