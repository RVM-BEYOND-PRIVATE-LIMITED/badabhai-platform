/**
 * The pure half of the scale simulation: vector synthesis, scale planning, plan reading,
 * and the guard that stops this harness ever publishing a semantic claim.
 *
 * The database half is exercised by running it; what is pinned here is the reasoning that
 * would otherwise be invisible in a result table — that the padding is dense enough to
 * actually compete, that "the index was used" is read from the plan rather than assumed,
 * and that a number about noise can never be labelled Recall@1.
 */
import { describe, expect, it } from "vitest";

import {
  assertNoSemanticClaim,
  cosine,
  DEFAULT_NEIGHBOUR_COSINE,
  gaussian,
  makeRng,
  percentile,
  perturb,
  planScale,
  readPlan,
  recallVsExact,
  sigmaForCosine,
  type CorpusShape,
} from "./taxonomy-scale-sim";
import { UNKNOWN_ANN, type ExperimentRecord } from "./taxonomy-experiments";

describe("makeRng", () => {
  it("is DETERMINISTIC for a seed — an experiment must be re-runnable", () => {
    const a = Array.from({ length: 8 }, makeRng(42));
    expect(Array.from({ length: 8 }, makeRng(42))).toEqual(a);
  });

  it("gives different streams for different seeds", () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it("stays in [0, 1)", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 5000; i += 1) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("gaussian", () => {
  it("is centred near 0 with unit spread", () => {
    const rng = makeRng(11);
    const xs = Array.from({ length: 20_000 }, () => gaussian(rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
  });

  it("never returns a non-finite value", () => {
    // log(0) is -Infinity, which would poison an entire 768-dim vector and then the index.
    const rng = makeRng(3);
    for (let i = 0; i < 5000; i += 1) expect(Number.isFinite(gaussian(rng))).toBe(true);
  });
});

describe("perturb", () => {
  const unit = (n: number, seed = 5): number[] => {
    const rng = makeRng(seed);
    const v = Array.from({ length: n }, () => gaussian(rng));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  };

  it("returns a UNIT vector, like the ones the ai-service stores", () => {
    // A padding set at a different magnitude is separable by cosine distance alone, which
    // would let the ANN look good for a reason unrelated to the index.
    const out = perturb(unit(768), sigmaForCosine(DEFAULT_NEIGHBOUR_COSINE), makeRng(1));
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("keeps the same dimensionality", () => {
    expect(perturb(unit(768), 0.3, makeRng(1))).toHaveLength(768);
  });

  it("lands in the CONFUSABLE band, not orthogonal and not a duplicate", () => {
    // The whole design rests on this. Uniform random padding sits at cosine ~0 in 768
    // dimensions, so HNSW would walk straight past it and report perfect recall at every
    // ef_search — an experiment that proves the index is free. The padding has to crowd.
    const parent = unit(768);
    const sims = Array.from({ length: 200 }, (_, i) =>
      cosine(parent, perturb(parent, sigmaForCosine(DEFAULT_NEIGHBOUR_COSINE), makeRng(100 + i))),
    );
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    expect(mean).toBeGreaterThan(DEFAULT_NEIGHBOUR_COSINE - 0.03); // competes
    expect(mean).toBeLessThan(DEFAULT_NEIGHBOUR_COSINE + 0.03); // but is not a duplicate
  });

  it("crowds harder as sigma falls and drifts toward orthogonal as it rises", () => {
    const parent = unit(768);
    const tight = cosine(parent, perturb(parent, sigmaForCosine(0.99), makeRng(9)));
    const loose = cosine(parent, perturb(parent, sigmaForCosine(0.2), makeRng(9)));
    expect(tight).toBeGreaterThan(loose);
    expect(loose).toBeLessThan(0.35);
  });

  it("is reproducible for a seed", () => {
    const parent = unit(768);
    expect(perturb(parent, 0.3, makeRng(4))).toEqual(perturb(parent, 0.3, makeRng(4)));
  });
});

describe("planScale", () => {
  const shape: CorpusShape = { aliasesPerSkill: 2.01, skillsPerDomain: 8.5, domainsPerSkill: 1.817 };

  it("pads only the shortfall above the real corpus", () => {
    expect(planScale(1000, 197, shape).syntheticAliases).toBe(803);
  });

  it("never asks for negative padding when the target is already met", () => {
    expect(planScale(100, 197, shape).syntheticAliases).toBe(0);
  });

  it("scales skills and domains WITH the corpus, preserving selectivity", () => {
    // The filtered-ANN pathology depends on how small a slice one domain is. Padding 9k
    // aliases across the original 28 domains would make each filter match a third of the
    // table and hide the very behaviour under test.
    const small = planScale(1000, 197, shape);
    const large = planScale(9121, 197, shape);
    expect(large.syntheticSkills).toBeGreaterThan(small.syntheticSkills);
    expect(large.syntheticDomains).toBeGreaterThan(small.syntheticDomains);
    const ratio = large.syntheticAliases / small.syntheticAliases;
    expect(large.syntheticDomains / small.syntheticDomains).toBeCloseTo(ratio, 0);
  });

  it("keeps roughly the measured skills-per-domain", () => {
    const p = planScale(9121, 197, shape);
    const perDomain = (p.syntheticSkills * shape.domainsPerSkill) / p.syntheticDomains;
    expect(perDomain).toBeGreaterThan(shape.skillsPerDomain * 0.9);
    expect(perDomain).toBeLessThan(shape.skillsPerDomain * 1.1);
  });
});

describe("readPlan", () => {
  const plan = (node: unknown, planning = 1.5, execution = 2.5): unknown => [
    { Plan: node, "Planning Time": planning, "Execution Time": execution },
  ];

  it("reports HNSW use only when the plan names the HNSW index", () => {
    // A plan can index-scan skill_id and still sort every candidate by distance, which is
    // exact NN with extra steps. Counting that as "the ANN engaged" would report the
    // Phase 5 caveat as resolved while it is still fully in force.
    const viaHnsw = plan({ "Node Type": "Index Scan", "Index Name": "sim_alias_embedding_hnsw", "Actual Rows": 40 });
    const viaOther = plan({ "Node Type": "Index Scan", "Index Name": "sim_alias_skill", "Actual Rows": 40 });
    expect(readPlan(viaHnsw, "sim_alias_embedding_hnsw").hnswUsed).toBe(true);
    expect(readPlan(viaOther, "sim_alias_embedding_hnsw").hnswUsed).toBe(false);
  });

  it("detects a Seq Scan — the Phase 5 shape", () => {
    const p = plan({
      "Node Type": "Limit",
      Plans: [{ "Node Type": "Sort", Plans: [{ "Node Type": "Seq Scan", "Actual Rows": 197 }] }],
    });
    const facts = readPlan(p, "sim_alias_embedding_hnsw");
    expect(facts.seqScan).toBe(true);
    expect(facts.hnswUsed).toBe(false);
    expect(facts.nodeTypes).toContain("Sort");
  });

  it("finds the index NESTED under joins and limits, not just at the root", () => {
    const p = plan({
      "Node Type": "Limit",
      Plans: [
        {
          "Node Type": "Nested Loop",
          Plans: [
            { "Node Type": "Index Scan", "Index Name": "sim_alias_embedding_hnsw" },
            { "Node Type": "Index Only Scan", "Index Name": "sim_ds_domain" },
          ],
        },
      ],
    });
    expect(readPlan(p, "sim_alias_embedding_hnsw").hnswUsed).toBe(true);
  });

  it("reads the timings", () => {
    const facts = readPlan(plan({ "Node Type": "Seq Scan", "Actual Rows": 12 }, 0.4, 9.1), "x");
    expect(facts.planningMs).toBe(0.4);
    expect(facts.executionMs).toBe(9.1);
    expect(facts.actualRows).toBe(12);
  });

  it("survives an unexpected plan shape rather than throwing mid-experiment", () => {
    expect(readPlan({}, "x").hnswUsed).toBe(false);
    expect(readPlan([], "x").executionMs).toBe(0);
  });
});

describe("recallVsExact", () => {
  it("is the overlap with the exact result at the same depth", () => {
    expect(recallVsExact(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(recallVsExact(["a", "x", "y"], ["a", "b", "c"])).toBeCloseTo(1 / 3, 4);
    expect(recallVsExact([], ["a"])).toBe(0);
  });

  it("ignores ORDER — recall is set membership, not ranking", () => {
    expect(recallVsExact(["c", "b", "a"], ["a", "b", "c"])).toBe(1);
  });

  it("returns null when there is no ground truth, rather than a free 100%", () => {
    // An exact run that found nothing means the scope was empty. Scoring that 1.0 would
    // report perfect ANN recall for a query that retrieved nothing at all.
    expect(recallVsExact(["a"], [])).toBeNull();
  });
});

describe("percentile", () => {
  it("picks the expected order statistics", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile(xs, 100)).toBe(10);
  });

  it("does not depend on input order", () => {
    expect(percentile([9, 1, 5], 50)).toBe(percentile([1, 5, 9], 50));
  });

  it("is NaN for no samples rather than 0", () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe("assertNoSemanticClaim", () => {
  const base: ExperimentRecord = {
    experiment: "EXP-ANN-DEFAULT",
    run_id: "r",
    recorded_at: "2026-08-17T00:00:00.000Z",
    purpose: "p",
    evaluator_version: 0,
    fixture_id: null,
    fixture_version: null,
    corpus_batch: null,
    model: null,
    embedding_model: null,
    query_count: 40,
    failure_count: 0,
    latency_ms: null,
    recall_at_1: null,
    recall_at_3: null,
    recall_at_5: null,
    mrr: null,
    input_tokens: null,
    cost_inr_metered: null,
    cost_inr_estimated: null,
    ann: { ...UNKNOWN_ANN, corpus_rows: 9121 },
    notes: [],
  };

  it("accepts an infrastructure-only record", () => {
    expect(() => assertNoSemanticClaim(base)).not.toThrow();
  });

  it("REFUSES a record that puts a quality number on synthetic vectors", () => {
    // The realistic failure is not malice — it is a later change reusing the shared
    // ExperimentRecord and filling the quality fields because they are there.
    expect(() => assertNoSemanticClaim({ ...base, recall_at_1: 0.99 })).toThrow(/synthetic/);
    expect(() => assertNoSemanticClaim({ ...base, mrr: 0.9 })).toThrow(/synthetic/);
    expect(() => assertNoSemanticClaim({ ...base, recall_at_5: 0 })).toThrow(/synthetic/);
  });
});

describe("sigmaForCosine", () => {
  it("hits the requested cosine at 768 dimensions", () => {
    // The bug this function exists to prevent: sigma is PER COMPONENT, so its meaning
    // depends on dimensionality. A "small" 0.35 at 768 dims adds noise of norm ~9.7
    // against a signal of 1 and lands at cosine 0.10 — orthogonal padding, and an ANN
    // experiment that would have reported the index as free.
    const rng = makeRng(21);
    const v = Array.from({ length: 768 }, () => gaussian(rng));
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const parent = v.map((x) => x / n);
    for (const target of [0.7, 0.85, 0.95, 0.99]) {
      const sims = Array.from({ length: 60 }, (_, i) =>
        cosine(parent, perturb(parent, sigmaForCosine(target), makeRng(500 + i))),
      );
      const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
      expect(Math.abs(mean - target)).toBeLessThan(0.02);
    }
  });

  it("shows how badly a raw sigma misleads at this width", () => {
    expect(sigmaForCosine(0.85)).toBeLessThan(0.03);
    expect(sigmaForCosine(0.85)).toBeGreaterThan(0.01);
  });

  it("scales with dimensionality, so the knob survives a model change", () => {
    expect(sigmaForCosine(0.85, 128)).toBeGreaterThan(sigmaForCosine(0.85, 768));
  });

  it("rejects a cosine outside (0, 1)", () => {
    expect(() => sigmaForCosine(0)).toThrow(/must be in/);
    expect(() => sigmaForCosine(1)).toThrow(/must be in/);
    expect(() => sigmaForCosine(1.2)).toThrow(/must be in/);
  });
});

describe("readPlan — index names", () => {
  it("names EVERY index the plan touched, not just the HNSW one", () => {
    // "hnsw=no, seq=no" is a real and important outcome: the planner took a THIRD path.
    // A boolean pair cannot say which, and the production recommendation turns on exactly
    // that — the scoped query reaches its ~9 candidate rows through the domain btree and
    // sorts them exactly, so the ANN never runs and never can be wrong.
    const p = [
      {
        Plan: {
          "Node Type": "Limit",
          Plans: [
            {
              "Node Type": "Sort",
              Plans: [
                {
                  "Node Type": "Nested Loop",
                  Plans: [
                    { "Node Type": "Index Scan", "Index Name": "sim_ds_domain" },
                    { "Node Type": "Index Scan", "Index Name": "sim_alias_skill" },
                  ],
                },
              ],
            },
          ],
        },
        "Planning Time": 0.4,
        "Execution Time": 0.2,
      },
    ];
    const facts = readPlan(p, "sim_alias_embedding_hnsw");
    expect(facts.hnswUsed).toBe(false);
    expect(facts.seqScan).toBe(false);
    expect(facts.indexNames).toEqual(["sim_ds_domain", "sim_alias_skill"]);
    expect(facts.nodeTypes).toContain("Sort");
  });

  it("does not repeat an index used twice", () => {
    const p = [
      {
        Plan: {
          "Node Type": "Nested Loop",
          Plans: [
            { "Node Type": "Index Scan", "Index Name": "idx_a" },
            { "Node Type": "Index Scan", "Index Name": "idx_a" },
          ],
        },
      },
    ];
    expect(readPlan(p, "x").indexNames).toEqual(["idx_a"]);
  });
});
