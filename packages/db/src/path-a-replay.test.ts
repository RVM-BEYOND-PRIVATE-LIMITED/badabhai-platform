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
import {
  LEGACY_ANCHOR_SKILL_DOMAIN,
  PRE_MERGE_ALIAS_OWNER,
  PRE_PROMOTION_STATUSES,
  RETRIEVABLE_SKILL_STATUSES,
  buildVariant,
  cosine,
  diffCase,
  findMintedSkillIds,
  pathACandidates,
  pathBCandidates,
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
    negative: false, hit: true, expectedRank: 1, structuralViolations: [], outranked: [], skills: [], ...o,
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
});
