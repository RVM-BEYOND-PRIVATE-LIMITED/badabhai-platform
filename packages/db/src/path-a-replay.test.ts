/**
 * Invariants for the offline Path-A replay.
 *
 * Two jobs. First, keep the replay's candidate rules PINNED to the production statements it
 * claims to mirror — a replay that has drifted from production is not evidence, it is a
 * simulation of a system nobody runs. Second, protect the `pre_merge` reconstruction, because
 * a baseline that flatters itself makes every downstream delta wrong in the same direction.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COVERAGE_ONLY_CATEGORIES } from "./taxonomy-retrieval-eval";
import {
  LEGACY_ANCHOR_SKILL_DOMAIN,
  PRE_MERGE_ALIAS_OWNER,
  PRE_PROMOTION_STATUSES,
  RETRIEVABLE_SKILL_STATUSES,
  buildVariant,
  cosine,
  diffCase,
  findMintedSkillIds,
  mergeFamilies,
  pathACandidates,
  pathBCandidates,
  probeFamilyReachability,
  rankAliases,
  rankSkillsFromAliases,
  replayCase,
  summarizeAgreement,
  summarizeReplay,
  type CorpusInput,
  type ReplayAlias,
  type ReplayCaseResult,
  type ReplaySkill,
} from "./path-a-replay";

const REPOSITORY_TS = join(__dirname, "..", "..", "..", "apps", "api", "src", "skills", "skills.repository.ts");

const v = (n: number): number[] => [n, 1 - n, 0.5];

function skill(id: string, status: ReplaySkill["status"], extra: Partial<ReplaySkill> = {}): ReplaySkill {
  return { skillId: id, status, replacedBy: null, preMergeStatus: status, ...extra };
}
function alias(skillId: string, text: string, domainId = "cnc-machining", vec: number[] | null = v(0.5)): ReplayAlias {
  return { skillId, text, lang: "en", domainId, vector: vec };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// THE PIN — the replay must mirror the statements production actually runs
// ─────────────────────────────────────────────────────────────────────────────────────

function sqlBodyOf(anchor: string): string {
  const src = readFileSync(REPOSITORY_TS, "utf8");
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  expect(src.indexOf(anchor, at + 1), `anchor is ambiguous: ${anchor}`).toBe(-1);
  const open = src.indexOf("`", at);
  return src.slice(open + 1, src.indexOf("`", open + 1));
}

describe("the replay's candidate rules are pinned to production SQL", () => {
  it("Path A joins job_domain_skill and filters BOTH edge status and skill status", () => {
    const sql = sqlBodyOf("private canonicalAliasRows(");
    expect(sql).toMatch(/JOIN job_domain_skill/);
    expect(sql).toMatch(/jds\.status = 'active'/);
    expect(sql).toMatch(/s\.status = 'active'/);
    expect(sql).toMatch(/sa\.embedding IS NOT NULL/);
  });

  it("Path B filters sa.domain_id and — easy to miss — ALSO s.status = 'active'", () => {
    // The whole reason this assertion exists. Path B has no edge join, so a deprecation looks
    // like it cannot touch it. It can: deprecating a skill removes its aliases from the legacy
    // path too. Modelling Path B without the status filter would understate the blast radius
    // of every taxonomy merge.
    const sql = sqlBodyOf("private legacyAliasRows(");
    expect(sql).toMatch(/sa\.domain_id/);
    expect(sql).toMatch(/s\.status = 'active'/);
    expect(sql).toMatch(/sa\.embedding IS NOT NULL/);
    expect(sql).not.toMatch(/job_domain_skill/);
  });

  it("production statuses are active-only, and the widened set is explicit", () => {
    expect([...RETRIEVABLE_SKILL_STATUSES]).toEqual(["active"]);
    expect([...PRE_PROMOTION_STATUSES]).toEqual(["active", "provisional"]);
  });

  it("the legacy anchor matches the one the caller hard-codes", () => {
    const svc = readFileSync(
      join(__dirname, "..", "..", "..", "apps", "api", "src", "job-postings", "job-postings.service.ts"),
      "utf8",
    );
    expect(svc).toMatch(new RegExp(`LEGACY_ANCHOR_SKILL_DOMAIN = "${LEGACY_ANCHOR_SKILL_DOMAIN}"`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Candidate sets
// ─────────────────────────────────────────────────────────────────────────────────────

describe("pathACandidates", () => {
  const base: CorpusInput = {
    skills: [skill("s_active", "active"), skill("s_prov", "provisional"), skill("s_dep", "deprecated")],
    aliases: [alias("s_active", "a"), alias("s_prov", "b"), alias("s_dep", "c")],
    edges: [
      { jobDomainId: "jd1", skillId: "s_active" },
      { jobDomainId: "jd1", skillId: "s_prov" },
      { jobDomainId: "jd1", skillId: "s_dep" },
    ],
  };
  const corpus = buildVariant(base, "as_applied").corpus;

  it("requires an edge AND an active skill — either gate alone excludes", () => {
    expect(pathACandidates(corpus, "jd1").map((a) => a.text)).toEqual(["a"]);
  });

  it("THE R19 CASE: an active skill with zero edges contributes nothing", () => {
    // TD-01 minted `skill_drawing_reading` active with no `job_domain_skill` edge. Being
    // active is not being reachable, and this is the assertion that says so.
    const orphan = buildVariant(
      { skills: [skill("s_new", "active")], aliases: [alias("s_new", "x")], edges: [] },
      "as_applied",
    ).corpus;
    expect(pathACandidates(orphan, "jd1")).toHaveLength(0);
  });

  it("excludes an alias with no vector, mirroring embedding IS NOT NULL", () => {
    const c = buildVariant(
      {
        skills: [skill("s", "active")],
        aliases: [alias("s", "has", "d", v(0.2)), alias("s", "none", "d", null)],
        edges: [{ jobDomainId: "jd1", skillId: "s" }],
      },
      "as_applied",
    ).corpus;
    expect(pathACandidates(c, "jd1").map((a) => a.text)).toEqual(["has"]);
  });

  it("widening to pre-promotion admits provisional but never deprecated", () => {
    expect(pathACandidates(corpus, "jd1", PRE_PROMOTION_STATUSES).map((a) => a.text)).toEqual(["a", "b"]);
  });
});

describe("pathBCandidates", () => {
  it("filters on the legacy slug and the same active-skill rule", () => {
    const c = buildVariant(
      {
        skills: [skill("s1", "active"), skill("s2", "active"), skill("s3", "deprecated")],
        aliases: [alias("s1", "in", "cnc-machining"), alias("s2", "out", "welding"), alias("s3", "dep", "cnc-machining")],
        edges: [],
      },
      "as_applied",
    ).corpus;
    expect(pathBCandidates(c, "cnc-machining").map((a) => a.text)).toEqual(["in"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Variant reconstruction — where a wrong baseline would silently skew every delta
// ─────────────────────────────────────────────────────────────────────────────────────

const merged: CorpusInput = {
  skills: [
    skill("pred_a", "deprecated", { replacedBy: "new", preMergeStatus: "active" }),
    skill("pred_b", "deprecated", { replacedBy: "new", preMergeStatus: "active" }),
    // A growth-corpus dissolution: provisional before, deprecated now, successor already edged.
    skill("growth", "deprecated", { replacedBy: "survivor", preMergeStatus: "provisional" }),
    skill("survivor", "active"),
    skill("new", "active"),
  ],
  aliases: [
    alias("pred_a", "shared-a"),
    alias("pred_b", "shared-b"),
    alias("new", "shared-a"),
    alias("new", "shared-b"),
    alias("new", "drawing padhna"),
    alias("survivor", "surv"),
  ],
  edges: [
    { jobDomainId: "jd1", skillId: "pred_a" },
    { jobDomainId: "jd2", skillId: "pred_b" },
    { jobDomainId: "jd1", skillId: "survivor" },
  ],
};

describe("findMintedSkillIds", () => {
  it("names only merge targets that carry no edge of their own", () => {
    // `survivor` is also a replacedBy target but pre-existed the merge — it has edges.
    expect(findMintedSkillIds(merged)).toEqual(["new"]);
  });
});

describe("buildVariant — pre_merge", () => {
  const { corpus, provenance } = buildVariant(merged, "pre_merge");

  it("deletes the minted skill and its edges", () => {
    expect(corpus.skills.map((s) => s.skillId)).not.toContain("new");
    expect(corpus.edges.every((e) => e.skillId !== "new")).toBe(true);
  });

  it("restores each skill to ITS OWN prior status, never a blanket active", () => {
    // The bug this guards: restoring the growth-corpus row to `active` would invent
    // reachability it never had and blame the merge for a loss it did not cause.
    const byId = new Map(corpus.skills.map((s) => [s.skillId, s.status]));
    expect(byId.get("pred_a")).toBe("active");
    expect(byId.get("pred_b")).toBe("active");
    expect(byId.get("growth")).toBe("provisional");
    expect(provenance.restoredSkillIds).toContain("growth->provisional");
  });

  it("drops a minted alias whose predecessor still holds the same text", () => {
    const texts = corpus.aliases.filter((a) => a.text === "shared-a");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.skillId).toBe("pred_a");
  });

  it("reassigns a minted alias with NO predecessor copy to its declared prior owner", () => {
    const moved = corpus.aliases.find((a) => a.text === "drawing padhna");
    expect(moved?.skillId).toBe(PRE_MERGE_ALIAS_OWNER["drawing padhna"]);
    expect(provenance.reassignedAliases).toEqual([
      { text: "drawing padhna", to: "skill_cad_interpretation" },
    ]);
  });

  it("REFUSES to guess: an orphan alias with no declared owner throws", () => {
    const orphaned: CorpusInput = {
      ...merged,
      aliases: [...merged.aliases, alias("new", "an-alias-nobody-declared")],
    };
    expect(() => buildVariant(orphaned, "pre_merge")).toThrow(/PRE_MERGE_ALIAS_OWNER/);
  });
});

describe("buildVariant — edges_repointed", () => {
  const { corpus, provenance } = buildVariant(merged, "edges_repointed");

  it("moves a deprecated predecessor's edges onto the minted successor", () => {
    expect(provenance.repointedEdges).toHaveLength(2);
    expect(corpus.edges.filter((e) => e.skillId === "new")).toHaveLength(2);
  });

  it("leaves alone a successor that already had its own edges", () => {
    // `growth`'s successor is `survivor`, which was never minted — nothing to give back.
    expect(corpus.edges.filter((e) => e.skillId === "survivor")).toHaveLength(1);
  });

  it("is a counterfactual only — the input is never mutated", () => {
    expect(merged.edges.filter((e) => e.skillId === "new")).toHaveLength(0);
  });
});

describe("buildVariant — as_applied", () => {
  it("passes the corpus through untouched", () => {
    const { corpus } = buildVariant(merged, "as_applied");
    expect(corpus.skills).toBe(merged.skills);
    expect(corpus.edges).toBe(merged.edges);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// Ranking + diffing
// ─────────────────────────────────────────────────────────────────────────────────────

describe("ranking", () => {
  it("cosine of a vector with itself is 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  it("is deterministic under ties — a replay that reorders itself is not evidence", () => {
    const tied = [alias("s2", "zz", "d", v(0.5)), alias("s1", "aa", "d", v(0.5))];
    const once = rankAliases(v(0.5), tied, 5).map((r) => r.text);
    const again = rankAliases(v(0.5), [...tied].reverse(), 5).map((r) => r.text);
    expect(once).toEqual(again);
    expect(once).toEqual(["aa", "zz"]);
  });

  it("keeps only the best alias per skill", () => {
    const rows = [
      { skillId: "s1", text: "lo", score: 0.2 },
      { skillId: "s1", text: "hi", score: 0.9 },
      { skillId: "s2", text: "mid", score: 0.5 },
    ];
    expect(rankSkillsFromAliases(rows)).toEqual([
      { skillId: "s1", text: "hi", score: 0.9 },
      { skillId: "s2", text: "mid", score: 0.5 },
    ]);
  });
});

describe("diffCase precedence", () => {
  const mk = (o: Partial<ReplayCaseResult>): ReplayCaseResult => ({
    caseId: "c", path: "path_a_canonical", variant: "as_applied", candidateCount: 5,
    unresolved: false, top1SkillId: "x", top1Score: 0.9, expectedSkillId: "x",
    negative: false, coverageOnly: false, hit: true, expectedRank: 1, structuralViolations: [], outranked: [], skills: [], ...o,
  });

  it("reports a correctness change ahead of a candidate-set change", () => {
    // Ordering matters: labelling a broken case `candidates_changed` buries the finding.
    const before = mk({ hit: true, top1SkillId: "x" });
    const after = mk({ hit: false, top1SkillId: "y", candidateCount: 9 });
    expect(diffCase(before, after).delta).toBe("broken");
  });

  it("reports became_unresolved when the path returns nothing", () => {
    const before = mk({ hit: false, top1SkillId: "y", expectedRank: null });
    const after = mk({ hit: false, unresolved: true, top1SkillId: null, top1Score: null, candidateCount: 0, expectedRank: null });
    expect(diffCase(before, after).delta).toBe("became_unresolved");
  });

  it("distinguishes a different wrong answer from a silent candidate-set change", () => {
    const before = mk({ hit: false, top1SkillId: "y", expectedRank: null });
    expect(diffCase(before, mk({ hit: false, top1SkillId: "z", expectedRank: null })).delta).toBe("top1_changed");
    expect(diffCase(before, mk({ hit: false, top1SkillId: "y", candidateCount: 7, expectedRank: null })).delta).toBe("candidates_changed");
    expect(diffCase(before, mk({ hit: false, top1SkillId: "y", expectedRank: null })).delta).toBe("unchanged");
  });
});

describe("mergeFamilies", () => {
  it("groups every predecessor under its successor, from replacedBy alone", () => {
    const fams = mergeFamilies(merged);
    expect(fams.map((f) => f.successor)).toEqual(["new", "survivor"]);
    expect(fams[0]!.predecessors).toEqual(["pred_a", "pred_b"]);
    expect(fams[1]!.predecessors).toEqual(["growth"]);
  });

  it("reports successorHasEdges instead of filtering on it", () => {
    const fams = mergeFamilies(merged);
    expect(fams.find((f) => f.successor === "new")!.successorHasEdges).toBe(false);
    expect(fams.find((f) => f.successor === "survivor")!.successorHasEdges).toBe(true);
  });

  it("SURVIVES THE REPAIR: the family is unchanged once the successor gains edges", () => {
    // The reason this function exists separately from `findMintedSkillIds`. If family identity
    // were gated on edgelessness, the diagnostic probe would switch itself off the moment R19
    // was fixed — and the run that proves the fix worked would report nothing, which is
    // indistinguishable from never having run.
    const repaired: CorpusInput = {
      ...merged,
      edges: [...merged.edges, { jobDomainId: "jd1", skillId: "new" }],
    };
    expect(findMintedSkillIds(repaired)).toEqual([]); // correctly no longer "minted"
    const fam = mergeFamilies(repaired).find((f) => f.successor === "new")!;
    expect(fam.predecessors).toEqual(["pred_a", "pred_b"]); // identity unchanged
    expect(fam.successorHasEdges).toBe(true);
  });
});

describe("probeFamilyReachability", () => {
  // A merged skill with an alias, no edges of its own, and a rival that DOES hold the edge.
  const input: CorpusInput = {
    skills: [
      skill("merged", "active"),
      skill("pred", "deprecated", { replacedBy: "merged", preMergeStatus: "active" }),
      skill("rival", "active"),
    ],
    aliases: [
      alias("merged", "gdt", "d", v(0.9)),
      alias("pred", "gdt", "d", v(0.9)),
      alias("rival", "unrelated", "d", v(0.1)),
    ],
    edges: [
      { jobDomainId: "jd1", skillId: "pred" },
      { jobDomainId: "jd1", skillId: "rival" },
    ],
  };
  const vectors = new Map<string, readonly number[]>([["gdt", v(0.9)]]);
  const args = { family: ["merged", "pred"], domains: ["jd1"], vectorsByText: vectors, texts: ["gdt"], k: 5 };

  it("pre_merge: the family is reachable and wins", () => {
    const r = probeFamilyReachability(buildVariant(input, "pre_merge").corpus, args);
    expect(r).toMatchObject({ probes: 1, familyReachable: 1, familyTop1: 1 });
    expect(r.winsInstead).toEqual([]);
  });

  it("as_applied: the family vanishes and something ELSE wins — the distinction that matters", () => {
    // A surface returning nothing is a gap. A surface returning a confident unrelated skill is
    // a misclassification. `winsInstead` is the only field that separates them, and this
    // asserts it actually reports the usurper rather than an empty list.
    const r = probeFamilyReachability(buildVariant(input, "as_applied").corpus, args);
    expect(r).toMatchObject({ probes: 1, familyReachable: 0, familyTop1: 0 });
    expect(r.winsInstead).toEqual([{ skillId: "rival", count: 1 }]);
  });

  it("edges_repointed: the counterfactual restores the family", () => {
    const r = probeFamilyReachability(buildVariant(input, "edges_repointed").corpus, args);
    expect(r).toMatchObject({ probes: 1, familyReachable: 1, familyTop1: 1 });
  });

  it("reports '(nothing returned)' rather than silently skipping an empty domain", () => {
    const empty = buildVariant({ skills: [], aliases: [], edges: [] }, "as_applied").corpus;
    const r = probeFamilyReachability(empty, args);
    expect(r.probes).toBe(1);
    expect(r.winsInstead).toEqual([{ skillId: "(nothing returned)", count: 1 }]);
  });

  it("skips a text with no vector instead of counting it as a miss", () => {
    const r = probeFamilyReachability(buildVariant(input, "as_applied").corpus, {
      ...args,
      texts: ["gdt", "never-embedded"],
    });
    expect(r.probes).toBe(1);
  });
});

describe("summaries", () => {
  const corpus = buildVariant(
    {
      skills: [skill("s1", "active"), skill("s2", "active")],
      aliases: [alias("s1", "a", "d", v(0.9)), alias("s2", "b", "d", v(0.1))],
      edges: [{ jobDomainId: "jd1", skillId: "s1" }, { jobDomainId: "jd1", skillId: "s2" }],
    },
    "as_applied",
  ).corpus;

  const run = (expected: string) =>
    replayCase(corpus, "path_a_canonical", {
      caseId: "c1", query: v(0.9), jobDomainId: "jd1", legacyDomainId: "d",
      expectedSkillId: expected, k: 5,
    });

  it("counts a hit and reports the expected rank", () => {
    const r = run("s1");
    expect(r.hit).toBe(true);
    expect(r.expectedRank).toBe(1);
    expect(summarizeReplay([r])).toMatchObject({ cases: 1, hits: 1, recallAt1: 1, mrr: 1, unresolved: 0 });
  });

  it("reciprocal rank falls away when the expected skill ranks lower", () => {
    const r = run("s2");
    expect(r.hit).toBe(false);
    expect(r.expectedRank).toBe(2);
    expect(summarizeReplay([r]).mrr).toBeCloseTo(0.5, 12);
  });

  it("an unresolved case scores zero rather than throwing", () => {
    const empty = replayCase(buildVariant({ skills: [], aliases: [], edges: [] }, "as_applied").corpus,
      "path_a_canonical",
      { caseId: "c", query: v(0.5), jobDomainId: "jd1", legacyDomainId: "d", expectedSkillId: "s1", k: 5 });
    expect(empty.unresolved).toBe(true);
    expect(summarizeReplay([empty])).toMatchObject({ resolved: 0, unresolved: 1, mrr: 0 });
  });

  it("agreement counts only cases both paths resolved", () => {
    const a = [run("s1")];
    const b = [{ ...run("s1"), unresolved: true, top1SkillId: null }];
    expect(summarizeAgreement(a, b)).toMatchObject({ bothResolved: 0, onlyAResolved: 1, agreementRate: 0 });
  });

  /**
   * The exclusion this replay was missing while two sibling harnesses applied it.
   *
   * `unembedded_shipped` cases have an expected skill that is shipped-and-reused-only, with no
   * locally-authored corpus record — they ask "is this reachable", not "is it ranked first",
   * and the fixture says so per case. Scoring them here made R@1 move the moment the last four
   * such queries got vectors, against a denominator nobody could see.
   */
  const runCat = (expected: string, category: string) =>
    replayCase(corpus, "path_a_canonical", {
      caseId: `c-${category}`, query: v(0.9), jobDomainId: "jd1", legacyDomainId: "d",
      expectedSkillId: expected, k: 5, category,
    });

  it("marks an unembedded_shipped case coverage-only", () => {
    expect(runCat("s1", "unembedded_shipped").coverageOnly).toBe(true);
  });

  it("leaves an ordinary category scoring", () => {
    expect(runCat("s1", "paraphrase_latin").coverageOnly).toBe(false);
  });

  it("treats an omitted category as scoring, not as coverage-only", () => {
    // Fail SAFE toward the stricter reading: a caller that forgets to pass the category gets
    // its case measured, not silently dropped out of recall.
    expect(run("s1").coverageOnly).toBe(false);
  });

  it("keeps coverage-only cases out of scored / R@1 / MRR and reports them separately", () => {
    const s = summarizeReplay([run("s1"), runCat("s2", "unembedded_shipped")]);
    // Two cases; only the ordinary one is scored. Without the exclusion the coverage case's
    // rank-2 result would drag R@1 to 0.5 — which is exactly what happened in production
    // reporting.
    expect(s).toMatchObject({ cases: 2, scored: 1, hits: 1, recallAt1: 1, mrr: 1 });
    expect(s.coverageOnly).toBe(1);
    expect(s.coverageReached).toBe(0);
  });

  it("a coverage-only case that DOES reach its skill is reported as reached", () => {
    const s = summarizeReplay([runCat("s1", "unembedded_shipped")]);
    expect(s).toMatchObject({ scored: 0, recallAt1: 0, coverageOnly: 1, coverageReached: 1 });
  });

  it("a coverage-only case never counts as a false negative", () => {
    // falseNegatives is derived from the same positives set, so this is the property that
    // would silently regress if someone widened `positives` again.
    expect(summarizeReplay([runCat("s_missing", "unembedded_shipped")]).falseNegatives).toBe(0);
  });

  it("a NEGATIVE case is never reclassified as coverage-only", () => {
    // A negative has no expected skill to cover, and its false-positive check must stay in
    // force whatever its category says.
    const neg = replayCase(corpus, "path_a_canonical", {
      caseId: "neg", query: v(0.9), jobDomainId: "jd1", legacyDomainId: "d",
      expectedSkillId: null, k: 5, category: "unembedded_shipped",
    });
    expect(neg.negative).toBe(true);
    expect(neg.coverageOnly).toBe(false);
  });

  it("uses the SAME category set as the eval harness, not a local copy", () => {
    // The defect was three modules disagreeing. Pin the shared source so a future local
    // redefinition here fails rather than drifting.
    for (const category of COVERAGE_ONLY_CATEGORIES) {
      expect(runCat("s1", category).coverageOnly).toBe(true);
    }
  });
});
