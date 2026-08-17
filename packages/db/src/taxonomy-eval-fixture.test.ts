/**
 * Fixture validation, mock detection, and the committed fixture itself.
 *
 * The committed-fixture tests at the bottom are deliberately assertions about REAL data:
 * the ground truth is only worth as much as its traceability to the corpus, and the corpus
 * changes under it.
 */
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALIAS_OVERFETCH,
  BASELINE_FIXTURE,
  classifyAll,
  classifyEmbedding,
  corpusBlockReason,
  evalArg,
  MOCK_MODEL_TAG,
  CANONICAL_RETRIEVAL_SQL,
  COVERAGE_ONLY_CATEGORIES,
  DEFAULT_FIXTURE,
  EMBEDDING_DIMENSION,
  PRE_PROMOTION_SKILL_STATUSES,
  PRODUCTION_SKILL_STATUSES,
  langfuseStatus,
  mockEmbedding,
  partitionCases,
  scoreCase,
} from "./taxonomy-retrieval-eval";
import { loadTaxonomyCorpus } from "./taxonomy-corpus";
import {
  EVAL_CATEGORIES,
  fixtureDistribution,
  loadEvalFixture,
  parseEvalFixture,
  validateEvalFixture,
  type EvalCase,
  type EvalFixture,
} from "./taxonomy-eval-fixture";
import type { TaxonomyCorpus } from "./taxonomy-corpus";

// ── a tiny synthetic corpus, so validator tests do not depend on the real one ──
const corpus = (): TaxonomyCorpus => ({
  domains: [
    { kind: "domain", job_domain_id: "jd_a", label_en: "A", trade_group: "g" },
    { kind: "domain", job_domain_id: "jd_b", label_en: "B", trade_group: "g" },
    { kind: "domain", job_domain_id: "jd_empty", label_en: "Empty", trade_group: "g" },
  ],
  skills: [
    { kind: "skill", skill_id: "skill_x", label_en: "X", label_hi: null, aliases: [] },
    { kind: "skill", skill_id: "skill_y", label_en: "Y", label_hi: null, aliases: [] },
  ],
  edges: [
    { kind: "domain_skill", job_domain_id: "jd_a", skill_id: "skill_x", default_requirement: "required", relevance: 90, confidence: 1, source: "llm_bootstrap" },
    { kind: "domain_skill", job_domain_id: "jd_a", skill_id: "skill_y", default_requirement: "preferred", relevance: 70, confidence: 1, source: "llm_bootstrap" },
    { kind: "domain_skill", job_domain_id: "jd_b", skill_id: "skill_y", default_requirement: "required", relevance: 80, confidence: 1, source: "llm_bootstrap" },
  ],
});

const base: EvalCase = {
  case_id: "C1",
  query: "x work",
  lang: "en",
  category: "paraphrase_latin",
  job_domain_id: "jd_a",
  expected_skill_id: "skill_x",
  provenance: "reviewed_fixture",
};
const fx = (...cases: Partial<EvalCase>[]): EvalFixture => ({
  manifest: { fixture_id: "t", version: 1, corpus_batch: "b", description: "d" },
  cases: cases.map((c, i) => ({ ...base, case_id: `C${i + 1}`, ...c })),
});
const codes = (f: EvalFixture, shipped = new Set<string>()): string[] =>
  validateEvalFixture(f, corpus(), shipped).map((p) => p.code);

describe("validateEvalFixture", () => {
  it("accepts a well-formed, reachable case", () => {
    expect(codes(fx({}))).toEqual([]);
  });

  it("rejects an expected skill that does not exist — the typo that fails forever", () => {
    expect(codes(fx({ expected_skill_id: "skill_typo" }))).toContain("EXPECTED_SKILL_UNKNOWN");
  });

  it("rejects an expected skill NOT WIRED to the queried domain", () => {
    // The canonical query scopes candidates through job_domain_skill, so this case could
    // never pass no matter how good retrieval is — it would silently drag the average down.
    expect(codes(fx({ job_domain_id: "jd_b", expected_skill_id: "skill_x" }))).toContain(
      "EXPECTED_SKILL_NOT_IN_SCOPE",
    );
  });

  it("accepts a SHIPPED id that is not in the corpus files but is declared shipped", () => {
    const f = fx({ expected_skill_id: "skill_shipped", job_domain_id: "jd_a" });
    // still needs the edge; without it, scope is the complaint, not existence
    expect(codes(f, new Set(["skill_shipped"]))).toEqual(["EXPECTED_SKILL_NOT_IN_SCOPE"]);
  });

  it("rejects a domain with no edges — retrieval could only ever return nothing", () => {
    expect(codes(fx({ job_domain_id: "jd_empty", expected_skill_id: null, category: "cross_domain_isolation" }))).toContain(
      "DOMAIN_HAS_NO_EDGES",
    );
  });

  it("rejects an unknown domain", () => {
    expect(codes(fx({ job_domain_id: "jd_nope" }))).toContain("DOMAIN_UNKNOWN");
  });

  it("rejects the SAME query twice in one scope — it double-weights whatever it asserts", () => {
    expect(codes(fx({}, {}))).toContain("QUERY_DUPLICATE");
  });

  it("allows the same query in a DIFFERENT scope — that is the multi-domain test", () => {
    expect(
      codes(fx({ expected_skill_id: "skill_y" }, { job_domain_id: "jd_b", expected_skill_id: "skill_y" })),
    ).toEqual([]);
  });

  it("rejects duplicate case ids", () => {
    const f = fx({}, { query: "different" });
    (f.cases[1] as EvalCase).case_id = "C1";
    expect(codes(f)).toContain("CASE_ID_DUPLICATE");
  });

  it("rejects an alternative that is not wired to the same domain", () => {
    expect(
      codes(fx({ acceptable_skill_ids: ["skill_z"], notes: "why" })),
    ).toContain("ALTERNATIVE_UNKNOWN");
    expect(
      codes(fx({ job_domain_id: "jd_b", expected_skill_id: "skill_y", acceptable_skill_ids: ["skill_x"], notes: "why" })),
    ).toContain("ALTERNATIVE_NOT_IN_SCOPE");
  });

  it("rejects an UNJUSTIFIED alternative, and a token one", () => {
    // An unexplained alternative is indistinguishable from widening the target until the
    // case passes. A domain carries 6-11 wired skills, so four unexplained in-scope
    // alternatives would make any non-empty top-5 a rank-1 hit. A NON-EMPTY note is not
    // enough — one character satisfied that, and boilerplate can be pasted everywhere.
    expect(codes(fx({ acceptable_skill_ids: ["skill_y"] }))).toContain("ALTERNATIVE_UNJUSTIFIED");
    expect(codes(fx({ acceptable_skill_ids: ["skill_y"], notes: "n" }))).toContain("ALTERNATIVE_UNJUSTIFIED");
    expect(codes(fx({ acceptable_skill_ids: ["skill_y"], notes: "ambiguous" }))).toContain(
      "ALTERNATIVE_UNJUSTIFIED",
    );
    expect(
      codes(
        fx({
          acceptable_skill_ids: ["skill_y"],
          notes: "Y is genuinely ambiguous with X in this domain: a worker doing one is routinely hired for the other.",
        }),
      ),
    ).toEqual([]);
  });

  it("enforces the in-scope / out-of-scope rule for forbidden ids", () => {
    // A positive case's forbidden id must be a real in-scope COMPETITOR; retrieval INNER
    // JOINs job_domain_skill, so an out-of-scope one is satisfied by the WHERE clause and
    // measures nothing. A negative case is the mirror: an in-scope id is not cross-domain.
    expect(codes(fx({ must_not_return_skill_ids: ["skill_y"] }))).toEqual([]);
    expect(
      codes(fx({ job_domain_id: "jd_b", expected_skill_id: "skill_y", must_not_return_skill_ids: ["skill_x"] })),
    ).toContain("NEGATIVE_NOT_IN_SCOPE");
    expect(
      codes(
        fx({
          expected_skill_id: null,
          category: "cross_domain_isolation",
          must_not_return_skill_ids: ["skill_y"],
        }),
      ),
    ).toContain("NEGATIVE_IN_SCOPE");
    expect(
      codes(
        fx({
          job_domain_id: "jd_b",
          expected_skill_id: null,
          category: "cross_domain_isolation",
          must_not_return_skill_ids: ["skill_x"],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects an alternative that repeats the expected skill", () => {
    expect(codes(fx({ acceptable_skill_ids: ["skill_x"], notes: "n" }))).toContain("ALTERNATIVE_REDUNDANT");
  });

  it("rejects a MISSPELLED negative — it can never be returned, so it passes forever", () => {
    expect(codes(fx({ must_not_return_skill_ids: ["skill_nope"] }))).toContain("NEGATIVE_SKILL_UNKNOWN");
  });

  it("rejects a negative that contradicts the expected skill or an alternative", () => {
    expect(codes(fx({ must_not_return_skill_ids: ["skill_x"] }))).toContain("NEGATIVE_CONTRADICTS_EXPECTED");
    expect(
      codes(fx({ acceptable_skill_ids: ["skill_y"], must_not_return_skill_ids: ["skill_y"], notes: "n" })),
    ).toContain("NEGATIVE_CONTRADICTS_ALTERNATIVE");
  });

  it("requires provenance — ground truth must be traceable", () => {
    expect(codes(fx({ provenance: "" }))).toContain("PROVENANCE_MISSING");
  });

  it("rejects a null expectation outside the negative category", () => {
    expect(codes(fx({ expected_skill_id: null, category: "exact_alias" }))).toContain("NEGATIVE_CATEGORY");
  });

  it("rejects an unknown category and a bad lang", () => {
    expect(codes(fx({ category: "made_up" as EvalCase["category"] }))).toContain("CATEGORY_UNKNOWN");
    expect(codes(fx({ lang: "fr" as EvalCase["lang"] }))).toContain("LANG_ENUM");
  });
});

describe("parseEvalFixture", () => {
  it("reads the manifest from line 1 and skips '#' comments", () => {
    const f = parseEvalFixture(
      ['# a comment', JSON.stringify({ fixture_id: "f", version: 2 }), JSON.stringify(base)].join("\n"),
    );
    expect(f.manifest.version).toBe(2);
    expect(f.cases).toHaveLength(1);
  });

  it("refuses an empty file and a manifest with no version", () => {
    expect(() => parseEvalFixture("\n# only comments\n")).toThrow(/empty/);
    expect(() => parseEvalFixture(JSON.stringify({ fixture_id: "f" }))).toThrow(/fixture_id \+ version/);
  });
});

describe("mock embedding detection", () => {
  it("produces exactly 768 dimensions in [-1, 1)", () => {
    const v = mockEmbedding("forklift driving");
    expect(v).toHaveLength(EMBEDDING_DIMENSION);
    expect(Math.min(...v)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...v)).toBeLessThan(1);
  });

  it("is deterministic and text-sensitive", () => {
    expect(mockEmbedding("a")).toEqual(mockEmbedding("a"));
    expect(mockEmbedding("a")).not.toEqual(mockEmbedding("b"));
  });

  it("MATCHES the Python implementation — golden vector taken from a real seeded row", () => {
    // Captured from skill_alias.embedding after `db:embed:skills` ran against the actual
    // ai-service. This is what makes the TS port a verified port rather than a guess; if
    // _mock_embedding changes in Python, this fails instead of the detector going blind.
    const golden = [
      0.5501484, -0.4562537, 0.3730408, -0.91844773, -0.32600567, -0.61045885, 0.943228, 0.1674332,
      0.638534, 0.6713834, -0.23853916,
    ];
    const ours = mockEmbedding("forklift driving").slice(0, golden.length);
    for (let i = 0; i < golden.length; i += 1) {
      expect(ours[i]).toBeCloseTo(golden[i] as number, 6);
    }
  });

  it("classifies a mock vector as MOCK and a real-looking one as NOT_MOCK", () => {
    expect(classifyEmbedding("forklift driving", mockEmbedding("forklift driving"))).toBe("MOCK");
    expect(classifyEmbedding("forklift driving", mockEmbedding("something else"))).toBe("NOT_MOCK");
    expect(classifyEmbedding("forklift driving", new Array(768).fill(0.01))).toBe("NOT_MOCK");
  });

  it("tolerates float32 rounding, because pgvector stores real", () => {
    const rounded = mockEmbedding("x").map((v) => Math.fround(v));
    expect(classifyEmbedding("x", rounded)).toBe("MOCK");
  });

  it("does not call a wrong-length vector MOCK", () => {
    expect(classifyEmbedding("x", [0.1, 0.2])).toBe("NOT_MOCK");
  });

  it("classifyAll counts and samples the mock ids", () => {
    const r = classifyAll([
      { id: "i1", text: "a", embedding: mockEmbedding("a") },
      { id: "i2", text: "b", embedding: new Array(768).fill(0.5) },
    ]);
    expect(r).toMatchObject({ embedded: 2, mock: 1, notMock: 1, sampleMockAliasIds: ["i1"] });
  });
});

describe("corpusBlockReason — the gate on scoring at all", () => {
  const base = { embedded: 10, mock: 0, notMock: 10, sampleMockAliasIds: [], models: ["real-model"], unstamped: 0 };

  it("allows a clean, single-model, fully-stamped corpus", () => {
    expect(corpusBlockReason(base)).toBeNull();
  });

  it("blocks an empty corpus", () => {
    expect(corpusBlockReason({ ...base, embedded: 0 })).toMatch(/no embedded aliases/);
  });

  it("blocks on a sha256-proven mock vector", () => {
    expect(corpusBlockReason({ ...base, mock: 1 })).toMatch(/PROVEN MOCK/);
  });

  it("blocks on the mock model stamp even when the hash check finds nothing", () => {
    // The stamp catches rows the recompute cannot: pseudonymized text hashes differently.
    expect(corpusBlockReason({ ...base, models: [MOCK_MODEL_TAG] })).toMatch(/is mock/);
  });

  it("blocks when provenance is UNSTAMPED — unknown is not the same as fine", () => {
    expect(corpusBlockReason({ ...base, unstamped: 3 })).toMatch(/no embedding_model/);
  });

  it("blocks a corpus mixing TWO REAL models — the case a hash check cannot see", () => {
    // Every vector is "not mock" and the vector space is still incoherent, so distances
    // are not comparable and Recall over them is noise.
    const r = corpusBlockReason({ ...base, models: ["gemini-embedding-001", "other-model"] });
    expect(r).toMatch(/mixes 2 embedding models/);
  });
});

describe("langfuse availability", () => {
  it("reports NOT_CONFIGURED when either key is missing — and never throws", () => {
    expect(langfuseStatus({})).toBe("LANGFUSE_NOT_CONFIGURED");
    expect(langfuseStatus({ LANGFUSE_PUBLIC_KEY: "pk" })).toBe("LANGFUSE_NOT_CONFIGURED");
    expect(langfuseStatus({ LANGFUSE_SECRET_KEY: "sk" })).toBe("LANGFUSE_NOT_CONFIGURED");
  });

  it("reports CONFIGURED only when both are present", () => {
    expect(langfuseStatus({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" })).toBe(
      "LANGFUSE_CONFIGURED",
    );
  });
});

describe("CANONICAL_RETRIEVAL_SQL", () => {
  // Pinned because the harness duplicates production's query shape: the /skills/canonicalize
  // contract returns one match, and Recall@k needs the list. A silent divergence here would
  // mean measuring a different system than the one that ships.
  it("keeps every load-bearing clause of the canonical path", () => {
    const s = CANONICAL_RETRIEVAL_SQL.toLowerCase().replace(/\s+/g, " ");
    expect(s).toContain("join job_domain_skill jds on jds.skill_id = sa.skill_id");
    expect(s).toContain("join skill s on s.skill_id = sa.skill_id");
    expect(s).toContain("jds.status = 'active'");
    expect(s).toContain("s.status = any($4::text[])");
    expect(s).toContain("sa.embedding is not null");
    expect(s).toContain("1 - (sa.embedding <=>");
    // the bare ORDER BY ... LIMIT is the only shape an HNSW index serves
    expect(s.indexOf("order by sa.embedding <=>")).toBeLessThan(s.indexOf("limit"));
  });

  it("scopes by job_domain_id, never by the legacy denormalized column", () => {
    const s = CANONICAL_RETRIEVAL_SQL.toLowerCase();
    expect(s).toContain("jds.job_domain_id =");
    expect(s).not.toContain("sa.domain_id");
  });

  it("matches the PRODUCTION repository, read from disk — not just itself", () => {
    // The previous version of this test asserted substrings on the constant, which pinned
    // the harness to its own text and would not have noticed production moving. Reading
    // skills.repository.ts is what makes it a divergence detector.
    const repo = readFileSync(
      join(__dirname, "..", "..", "..", "apps", "api", "src", "skills", "skills.repository.ts"),
      "utf8",
    ).toLowerCase();
    const ours = CANONICAL_RETRIEVAL_SQL.toLowerCase().replace(/\s+/g, " ");
    for (const clause of [
      "join job_domain_skill jds on jds.skill_id = sa.skill_id",
      "join skill s on s.skill_id = sa.skill_id",
      "jds.status = 'active'",
      "sa.embedding is not null",
    ]) {
      expect(repo.replace(/\s+/g, " "), `production no longer contains: ${clause}`).toContain(clause);
      expect(ours, `harness no longer contains: ${clause}`).toContain(clause);
    }
  });

  it("mirrors production's SKILL-status filter, as a parameter rather than a literal", () => {
    // Gate A put `s.status = 'active'` on the production path. The harness cannot copy the
    // LITERAL: every skill in this corpus is provisional, so a literal-matching harness would
    // report Recall@1 = 0 for everything — true of production, useless about the corpus, and
    // certain to be misread as "retrieval broke".
    //
    // So it parameterises the same predicate and DEFAULTS to production's value. What this
    // test pins is that the parameterisation cannot drift into simply dropping the filter:
    // production must still carry the literal, and the harness must still carry the join and
    // a status predicate.
    const repo = readFileSync(
      join(__dirname, "..", "..", "..", "apps", "api", "src", "skills", "skills.repository.ts"),
      "utf8",
    )
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(repo, "production must filter the SKILL status, not only the edge").toContain(
      "s.status = 'active'",
    );
    expect(CANONICAL_RETRIEVAL_SQL.toLowerCase()).toContain("s.status = any($4::text[])");
    // The default is production-equivalent; widening is opt-in and recorded.
    expect(PRODUCTION_SKILL_STATUSES).toEqual(["active"]);
    expect(PRE_PROMOTION_SKILL_STATUSES).toEqual(["active", "provisional"]);
  });

  it("overfetches aliases so Recall@k is over k SKILLS", () => {
    // LIMIT k would cap ALIAS rows; dedupe then collapses them, so "Recall@5" silently
    // became "recall within however few skills survived" (measured mean: 4.09).
    expect(ALIAS_OVERFETCH).toBeGreaterThanOrEqual(2);
    expect(CANONICAL_RETRIEVAL_SQL).toContain("LIMIT $3");
  });
});

describe("scoreCase / partitionCases", () => {
  it("marks a negative case non-positive so it never enters Recall", () => {
    const neg = { ...base, expected_skill_id: null, category: "cross_domain_isolation" as const };
    expect(scoreCase(neg, [], 5).positive).toBe(false);
    expect(scoreCase(base, [], 5).positive).toBe(true);
  });

  it("splits coverage-only categories out of the scored set", () => {
    const f = fx({}, { category: "unembedded_shipped" });
    const { scored, coverageOnly } = partitionCases(f);
    expect(scored).toHaveLength(1);
    expect(coverageOnly).toHaveLength(1);
    expect(COVERAGE_ONLY_CATEGORIES.has("unembedded_shipped")).toBe(true);
  });
});

// ===========================================================================
// The COMMITTED fixture, against the REAL corpus
// ===========================================================================
describe("the committed retrieval fixture", () => {
  const fixture = loadEvalFixture(DEFAULT_FIXTURE);
  const real = loadTaxonomyCorpus();
  const authored = new Set(real.skills.map((s) => s.skill_id));
  const shipped = new Set(real.edges.map((e) => e.skill_id).filter((id) => !authored.has(id)));

  it("has zero ground-truth problems against the corpus on main", () => {
    expect(validateEvalFixture(fixture, real, shipped)).toEqual([]);
  });

  it("covers EVERY domain that has seeded edges", () => {
    // A domain with no queries cannot fail, so its breakage would be invisible.
    const seeded = new Set(real.edges.map((e) => e.job_domain_id));
    const covered = new Set(fixture.cases.map((c) => c.job_domain_id));
    expect([...seeded].filter((d) => !covered.has(d))).toEqual([]);
  });

  it("is not stacked with easy cases — measured by CONTENT, not by category label", () => {
    // The label-based version of this check read 39% while the true share was 55%, because
    // 16 cases outside the *_alias categories used a committed alias verbatim. An exact
    // alias is cosine 1.0 and rank 1 for any deterministic embedder, so it is a floor under
    // Recall@1 that retrieval did not earn — and the floor must be measured on the text.
    const byId = new Map(real.skills.map((s) => [s.skill_id, s]));
    const positives = fixture.cases.filter(
      (c) => c.expected_skill_id !== null && c.category !== "unembedded_shipped",
    );
    const exact = positives.filter((c) =>
      (byId.get(c.expected_skill_id as string)?.aliases ?? []).some((a) => a.text === c.query),
    );
    expect(exact.length / positives.length).toBeLessThan(0.5);
  });

  it("gives EVERY domain at least one SCORED positive", () => {
    // A domain whose only case is a cross_domain_isolation negative cannot fail: the
    // job_domain_skill join makes the assertion unfailable, so its row prints n=1 scored=0
    // leak=0.0% and a completely broken domain there is invisible.
    const scoredPositivesByDomain = new Map<string, number>();
    for (const c of fixture.cases) {
      if (c.expected_skill_id === null || c.category === "unembedded_shipped") continue;
      scoredPositivesByDomain.set(c.job_domain_id, (scoredPositivesByDomain.get(c.job_domain_id) ?? 0) + 1);
    }
    const seeded = new Set(real.edges.map((e) => e.job_domain_id));
    expect([...seeded].filter((d) => (scoredPositivesByDomain.get(d) ?? 0) === 0)).toEqual([]);
  });

  it("carries real negative and multilingual coverage", () => {
    const d = fixtureDistribution(fixture);
    expect(d.byCategory.cross_domain_isolation ?? 0).toBeGreaterThanOrEqual(8);
    expect(d.byLang.hi ?? 0).toBeGreaterThanOrEqual(15);
    expect(d.byCategory.lexical_ambiguity ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("every exact_alias query IS actually a committed alias of its expected skill", () => {
    // Otherwise the category name lies and the "floor" it establishes is not a floor.
    const byId = new Map(real.skills.map((s) => [s.skill_id, s]));
    for (const c of fixture.cases) {
      if (c.category !== "exact_alias" && c.category !== "devanagari_alias") continue;
      const s = byId.get(c.expected_skill_id as string);
      expect(s, `${c.case_id}: ${c.expected_skill_id} not in corpus`).toBeDefined();
      const texts = (s?.aliases ?? []).map((a) => a.text);
      expect(texts, `${c.case_id}: ${JSON.stringify(c.query)} is not an alias`).toContain(c.query);
    }
  });

  it("every paraphrase query is NOT an alias — otherwise it is a disguised exact match", () => {
    const byId = new Map(real.skills.map((s) => [s.skill_id, s]));
    for (const c of fixture.cases) {
      if (c.category !== "paraphrase_latin" && c.category !== "devanagari_paraphrase") continue;
      const texts = (byId.get(c.expected_skill_id as string)?.aliases ?? []).map((a) => a.text);
      expect(texts, `${c.case_id}: ${JSON.stringify(c.query)} IS an alias`).not.toContain(c.query);
    }
  });

  it("uses only known categories", () => {
    const known = new Set<string>(EVAL_CATEGORIES);
    expect(fixture.cases.filter((c) => !known.has(c.category))).toEqual([]);
  });

  it("every negative case names at least one forbidden skill", () => {
    for (const c of fixture.cases) {
      if (c.expected_skill_id !== null) continue;
      expect((c.must_not_return_skill_ids ?? []).length, `${c.case_id} asserts nothing`).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// The v1 -> v2 relationship. This is what keeps a versioned dataset honest.
// ===========================================================================
describe("fixture versioning — v1 is the baseline's immutable instrument", () => {
  const v1 = loadEvalFixture(BASELINE_FIXTURE);
  const v2 = loadEvalFixture(DEFAULT_FIXTURE);

  it("keeps BOTH versions on disk and reachable", () => {
    // The Phase 5 baseline was measured against v1. Editing v1 in place would leave a
    // preserved number whose dataset no longer exists — a baseline that cannot be reproduced
    // is a claim, not a measurement.
    expect(BASELINE_FIXTURE).not.toBe(DEFAULT_FIXTURE);
    expect(v1.manifest.version).toBe(1);
    expect(v2.manifest.version).toBe(2);
    expect(v2.manifest.fixture_id).toBe(v1.manifest.fixture_id);
  });

  it("pins v1's content hash, so an edit to the baseline's dataset fails the build", () => {
    // A test that merely reads v1 would pass after someone "fixed" a case in it. The hash is
    // the only assertion that catches a well-intentioned edit to a frozen artifact.
    const sha = createHash("sha256").update(readFileSync(BASELINE_FIXTURE)).digest("hex");
    expect(sha).toBe("7648dae542fa20314524c60eb24cf11f25670dd99199ec9a9c5108b3bfa511bd");
  });

  it("changes EXACTLY the declared cases and nothing else", () => {
    // The two files are near-duplicates, which is a real drift risk. Rather than trust that
    // the copy stayed a copy, the invariant is checked: every case is byte-identical except
    // the ones the manifest itself declares as corrections.
    const declared = new Set(
      ((v2.manifest as unknown as { corrections?: { case_id: string }[] }).corrections ?? []).map((c) => c.case_id),
    );
    expect(declared.size).toBeGreaterThan(0);

    expect(v2.cases.map((c) => c.case_id)).toEqual(v1.cases.map((c) => c.case_id));
    const byId = new Map(v1.cases.map((c) => [c.case_id, c]));
    const differing: string[] = [];
    for (const c of v2.cases) {
      const before = byId.get(c.case_id);
      if (JSON.stringify(before) !== JSON.stringify(c)) differing.push(c.case_id);
    }
    expect(differing.sort()).toEqual([...declared].sort());
  });

  it("widens DC-18 rather than moving its expected_skill_id onto the model's answer", () => {
    // Ground truth was widened, not relabelled. Moving `expected_skill_id` to the id the
    // model happened to rank first would change no metric (both land in the correct set) and
    // would make a reviewed widening look like it had always been the expectation.
    const a = v1.cases.find((c) => c.case_id === "DC-18");
    const b = v2.cases.find((c) => c.case_id === "DC-18");
    expect(a?.expected_skill_id).toBe("skill_fastener_selection_and_tightening");
    expect(b?.expected_skill_id).toBe(a?.expected_skill_id);
    expect(b?.query).toBe(a?.query);
    expect(b?.job_domain_id).toBe(a?.job_domain_id);
    expect(b?.acceptable_skill_ids).toEqual(["skill_torque_wrench_operation"]);
  });

  it("justifies the DC-18 alternative from the CORPUS, not from the score", () => {
    // The corpus is the evidence: both skills are active edges of the queried domain, and
    // each carries an alias naming one half of the query. Without that, an "acceptable
    // alternative" is just a failing case being marked passing.
    const corpusReal = loadTaxonomyCorpus();
    const edges = new Set(corpusReal.edges.map((e) => `${e.job_domain_id} ${e.skill_id}`));
    expect(edges.has("jd_nco_8211_1200 skill_fastener_selection_and_tightening")).toBe(true);
    expect(edges.has("jd_nco_8211_1200 skill_torque_wrench_operation")).toBe(true);

    const aliasesOf = (id: string): string[] =>
      corpusReal.skills.find((s) => s.skill_id === id)?.aliases.map((a) => a.text) ?? [];
    expect(aliasesOf("skill_fastener_selection_and_tightening")).toContain("fastener tightening");
    expect(aliasesOf("skill_torque_wrench_operation")).toContain("torque tightening");
  });

  it("both versions still pass the ground-truth gate against the real corpus", () => {
    const corpusReal = loadTaxonomyCorpus();
    const authored = new Set(corpusReal.skills.map((s) => s.skill_id));
    const shipped = new Set(corpusReal.edges.map((e) => e.skill_id).filter((id) => !authored.has(id)));
    expect(validateEvalFixture(v1, corpusReal, shipped)).toEqual([]);
    expect(validateEvalFixture(v2, corpusReal, shipped)).toEqual([]);
  });
});

describe("evalArg — selecting a dataset must not fail open", () => {
  it("reads both --flag value and --flag=value", () => {
    expect(evalArg(["--fixture", "a.jsonl"], "--fixture")).toBe("a.jsonl");
    expect(evalArg(["--fixture=b.jsonl"], "--fixture")).toBe("b.jsonl");
  });

  it("returns null when the flag is absent", () => {
    expect(evalArg(["--run"], "--fixture")).toBeNull();
  });

  it("THROWS on a valueless flag instead of falling back to the default dataset", () => {
    // Silently defaulting would measure v2 while the operator believed they selected v1 —
    // and the report would name whichever file was actually loaded, so the mistake is
    // invisible in the output. The same defect in the embed runner widened a blast radius.
    expect(() => evalArg(["--fixture"], "--fixture")).toThrow(/requires a value/);
    expect(() => evalArg(["--fixture", "--run"], "--fixture")).toThrow(/requires a value/);
    expect(() => evalArg(["--fixture="], "--fixture")).toThrow(/no value/);
  });
});
