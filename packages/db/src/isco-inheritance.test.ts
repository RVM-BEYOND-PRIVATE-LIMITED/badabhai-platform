/**
 * The inheritance rules, tested without a database.
 *
 * Each test asks whether the materializer can be made to WRITE SOMETHING IT SHOULD NOT —
 * overwrite an authored edge, guess past an ambiguity, resurrect a deprecated skill, duplicate
 * on a second run, or hang on a cycle. A materializer that merely produces plausible edges is
 * not the hard part; refusing to produce the wrong ones is.
 */
import { describe, expect, it } from "vitest";

import {
  descendants,
  fanOut,
  planInheritance,
  verifyInvariants,
  type DomainNode,
  type ExistingEdge,
  type SkillRef,
} from "./isco-inheritance";

const dom = (id: string, parent: string | null, over: Partial<DomainNode> = {}): DomainNode => ({
  job_domain_id: id,
  parent_job_domain_id: parent,
  status: "active",
  selectable: true,
  ...over,
});

const edge = (d: string, s: string, over: Partial<ExistingEdge> = {}): ExistingEdge => ({
  job_domain_id: d,
  skill_id: s,
  source: "llm_bootstrap",
  status: "active",
  default_requirement: "preferred",
  relevance: 50,
  confidence: 0.9,
  ...over,
});

const SKILLS: SkillRef[] = [
  { skill_id: "skill_a", status: "active" },
  { skill_id: "skill_p", status: "provisional" },
  { skill_id: "skill_d", status: "deprecated" },
];

/** parent -> child -> grandchild */
const CHAIN: DomainNode[] = [dom("jd_root", null), dom("jd_child", "jd_root"), dom("jd_grand", "jd_child")];

describe("descendants — the walk", () => {
  it("returns strict descendants with depth, never the root itself", () => {
    const kids = new Map([
      ["jd_root", [dom("jd_child", "jd_root")]],
      ["jd_child", [dom("jd_grand", "jd_child")]],
    ]);
    const d = descendants("jd_root", kids, []);
    expect([...d.entries()].sort()).toEqual([["jd_child", 1], ["jd_grand", 2]]);
    expect(d.has("jd_root")).toBe(false);
  });

  it("a childless leaf has no descendants — this is why fan-out is small", () => {
    expect(descendants("jd_leaf", new Map(), []).size).toBe(0);
  });

  it("terminates on a cycle instead of hanging, and records it", () => {
    // parent_job_domain_id is a self-FK with nothing preventing a loop.
    const kids = new Map([
      ["jd_a", [dom("jd_b", "jd_a")]],
      ["jd_b", [dom("jd_a", "jd_b")]],
    ]);
    const cycles: string[] = [];
    const d = descendants("jd_a", kids, cycles);
    expect(d.get("jd_b")).toBe(1);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe("planInheritance — what it proposes", () => {
  it("fans an authored edge down to every descendant", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a")], SKILLS);
    expect(p.roots).toEqual(["jd_root"]);
    const cands = p.proposals.filter((x) => x.disposition === "CANDIDATE");
    expect(cands.map((c) => c.job_domain_id)).toEqual(["jd_child", "jd_grand"]);
    expect(cands.map((c) => c.depth)).toEqual([1, 2]);
    expect(cands.every((c) => c.inherited_from === "jd_root")).toBe(true);
  });

  it("every proposal carries provenance — ancestor, depth and a reason", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a")], SKILLS);
    for (const c of p.proposals) {
      expect(c.inherited_from).toBe("jd_root");
      expect(c.depth).toBeGreaterThanOrEqual(1);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it("carries the ancestor's requirement and relevance rather than inventing them", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a", { default_requirement: "required", relevance: 95 })], SKILLS);
    const c = p.proposals.find((x) => x.job_domain_id === "jd_child");
    expect(c?.default_requirement).toBe("required");
    expect(c?.relevance).toBe(95);
  });

  it("proposes nothing upward or sideways — a sibling is not a descendant", () => {
    const doms = [dom("jd_root", null), dom("jd_a", "jd_root"), dom("jd_b", "jd_root")];
    const p = planInheritance(doms, [edge("jd_a", "skill_a")], SKILLS);
    expect(p.proposals).toEqual([]);
  });
});

describe("planInheritance — what it refuses", () => {
  it("AUTHORED_WINS — never overwrites an edge the child authored itself", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a"), edge("jd_child", "skill_a", { source: "curated" })], SKILLS);
    const child = p.proposals.find((x) => x.job_domain_id === "jd_child");
    expect(child?.disposition).toBe("AUTHORED_WINS");
    expect(p.counts.CANDIDATE).toBe(1); // only the grandchild
  });

  it("UNRESOLVABLE — an unknown skill is reported, never guessed", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_missing")], SKILLS);
    expect(p.counts.UNRESOLVABLE).toBe(2);
    expect(p.counts.CANDIDATE).toBe(0);
  });

  it("SKIPPED_DEPRECATED_SKILL — inheritance never resurrects a retired skill", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_d")], SKILLS);
    expect(p.counts.SKIPPED_DEPRECATED_SKILL).toBe(2);
    expect(p.counts.CANDIDATE).toBe(0);
  });

  it("SKIPPED_DOMAIN — a non-selectable or inactive domain gains nothing", () => {
    const doms = [dom("jd_root", null), dom("jd_agg", "jd_root", { selectable: false }), dom("jd_dead", "jd_root", { status: "deprecated" })];
    const p = planInheritance(doms, [edge("jd_root", "skill_a")], SKILLS);
    expect(p.counts.SKIPPED_DOMAIN).toBe(2);
    expect(p.counts.CANDIDATE).toBe(0);
  });

  it("AMBIGUOUS — two equally-near ancestors that disagree are never resolved by guessing", () => {
    // A diamond: jd_x has two parents' worth of reach at the same depth via distinct roots.
    const doms = [
      dom("jd_r1", null), dom("jd_r2", null),
      dom("jd_x", "jd_r1"), dom("jd_x2", "jd_r2"),
    ];
    // Force the same target from two roots at the same depth by making jd_x a child of both
    // in the children index — expressed here as two roots reaching one shared id.
    const shared: DomainNode[] = [...doms, dom("jd_shared", "jd_r1"), dom("jd_shared", "jd_r2")];
    const p = planInheritance(
      shared,
      [
        edge("jd_r1", "skill_a", { default_requirement: "required", relevance: 90 }),
        edge("jd_r2", "skill_a", { default_requirement: "preferred", relevance: 10 }),
      ],
      SKILLS,
    );
    const sharedProposal = p.proposals.find((x) => x.job_domain_id === "jd_shared");
    expect(sharedProposal?.disposition).toBe("AMBIGUOUS");
    expect(sharedProposal?.reason).toMatch(/both reach/);
  });

  it("nearest ancestor wins when depths differ — that is decidable, so it is decided", () => {
    const doms = [dom("jd_top", null), dom("jd_mid", "jd_top"), dom("jd_leaf", "jd_mid")];
    const p = planInheritance(
      doms,
      [edge("jd_top", "skill_a", { relevance: 10 }), edge("jd_mid", "skill_a", { source: "curated", relevance: 90 })],
      SKILLS,
    );
    const leaf = p.proposals.find((x) => x.job_domain_id === "jd_leaf");
    expect(leaf?.inherited_from).toBe("jd_mid");
    expect(leaf?.depth).toBe(1);
    expect(leaf?.relevance).toBe(90);
  });
});

describe("planInheritance — idempotency and determinism", () => {
  it("a second run over its own output proposes NOTHING new", () => {
    const first = planInheritance(CHAIN, [edge("jd_root", "skill_a")], SKILLS);
    const written: ExistingEdge[] = first.proposals
      .filter((p) => p.disposition === "CANDIDATE")
      .map((p) => edge(p.job_domain_id, p.skill_id, { source: "inherited" }));

    const second = planInheritance(CHAIN, [edge("jd_root", "skill_a"), ...written], SKILLS);
    expect(second.counts.CANDIDATE).toBe(0);
    expect(second.counts.EXISTING).toBe(2);
  });

  it("inherited edges are NOT roots — inheritance cannot cascade off its own output", () => {
    // If it did, order of execution would change the result and the plan would not converge.
    const p = planInheritance(CHAIN, [edge("jd_child", "skill_a", { source: "inherited" })], SKILLS);
    expect(p.roots).toEqual([]);
    expect(p.proposals).toEqual([]);
  });

  it("output is deterministic and sorted regardless of input order", () => {
    const a = planInheritance(CHAIN, [edge("jd_root", "skill_a"), edge("jd_root", "skill_p")], SKILLS);
    const b = planInheritance([...CHAIN].reverse(), [edge("jd_root", "skill_p"), edge("jd_root", "skill_a")], SKILLS);
    expect(JSON.stringify(a.proposals)).toBe(JSON.stringify(b.proposals));
  });

  it("empty input produces an empty plan, not an error", () => {
    const p = planInheritance([], [], []);
    expect(p.proposals).toEqual([]);
    expect(p.roots).toEqual([]);
    expect(p.counts.CANDIDATE).toBe(0);
  });

  it("a domain whose parent does not exist is simply unreachable, not a crash", () => {
    const p = planInheritance([dom("jd_orphan", "jd_nonexistent")], [edge("jd_nonexistent", "skill_a")], SKILLS);
    expect(p.counts.CANDIDATE).toBe(1); // the orphan IS a child of the missing id by pointer
    expect(p.proposals[0]?.job_domain_id).toBe("jd_orphan");
  });
});

describe("planInheritance — provisional visibility", () => {
  it("counts candidates that depend on a provisional skill, separately", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a"), edge("jd_root", "skill_p")], SKILLS);
    expect(p.counts.CANDIDATE).toBe(4); // 2 domains x 2 skills
    expect(p.candidatesOnProvisionalSkills).toBe(2);
  });

  it("does not refuse a provisional skill — it reports the dependency", () => {
    // Production retrieval serves `active` only, so these edges exist but cannot be served.
    // That is a promotion question, not an inheritance question, so inheritance states it
    // rather than deciding it.
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_p")], SKILLS);
    expect(p.counts.CANDIDATE).toBe(2);
    expect(p.proposals.every((x) => x.skill_status === "provisional")).toBe(true);
  });
});

describe("fanOut — who actually produced the total", () => {
  const TREE: DomainNode[] = [
    dom("jd_big", null),
    dom("jd_big_a", "jd_big"),
    dom("jd_big_b", "jd_big"),
    dom("jd_small", null),
    dom("jd_small_a", "jd_small"),
    dom("jd_leaf", null), // childless: authors edges, fans nothing
  ];

  it("separates roots that fan out from roots that only author", () => {
    const p = planInheritance(
      TREE,
      [edge("jd_big", "skill_a"), edge("jd_small", "skill_a"), edge("jd_leaf", "skill_a")],
      SKILLS,
    );
    const f = fanOut(p);
    expect(f.authoredRoots).toBe(3);
    expect(f.rootsThatFanOut).toBe(2); // jd_leaf reaches nobody
  });

  it("reports concentration, so a headline total cannot hide a thin corpus", () => {
    const p = planInheritance(
      TREE,
      [edge("jd_big", "skill_a"), edge("jd_big", "skill_p"), edge("jd_small", "skill_a")],
      SKILLS,
    );
    const f = fanOut(p);
    // jd_big: 2 skills x 2 children = 4. jd_small: 1 skill x 1 child = 1.
    expect(f.totalEdges).toBe(5);
    expect(f.byRoot[0]).toEqual({ root: "jd_big", edges: 4, targets: 2 });
    expect(f.topTwoRootShare).toBe(1);
  });

  it("counts a skill by the DOMAINS it reaches, not by the edges it produces", () => {
    const p = planInheritance(CHAIN, [edge("jd_root", "skill_a")], SKILLS);
    const f = fanOut(p);
    expect(f.bySkill).toEqual([{ skill_id: "skill_a", targets: 2, skill_status: "active" }]);
    expect(f.depthHistogram).toEqual({ "1": 1, "2": 1 });
  });

  it("an empty plan reports zero rather than dividing by it", () => {
    const f = fanOut(planInheritance([], [], []));
    expect(f.totalEdges).toBe(0);
    expect(f.topTwoRootShare).toBe(0);
  });
});

describe("verifyInvariants — re-derived, not trusted", () => {
  it("holds on a healthy plan, and converges in one pass", () => {
    const edges = [edge("jd_root", "skill_a")];
    const plan = planInheritance(CHAIN, edges, SKILLS);
    const inv = verifyInvariants(CHAIN, edges, SKILLS, plan);
    expect(inv.downwardOnly).toBe(true);
    expect(inv.inheritedNeverRoot).toBe(true);
    expect(inv.converged).toBe(true);
    expect(inv.secondPassCandidates).toBe(0);
    expect(inv.violations).toEqual([]);
  });

  // The point of re-deriving: a plan that lies must be caught, not echoed.
  it("catches a proposal aimed at a domain that is NOT a descendant", () => {
    const edges = [edge("jd_root", "skill_a")];
    const plan = planInheritance(CHAIN, edges, SKILLS);
    const lying = {
      ...plan,
      proposals: [
        ...plan.proposals,
        { ...plan.proposals[0]!, job_domain_id: "jd_elsewhere" },
      ],
    };
    const inv = verifyInvariants(CHAIN, edges, SKILLS, lying);
    expect(inv.downwardOnly).toBe(false);
    expect(inv.violations.some((v) => v.includes("not a strict descendant"))).toBe(true);
  });

  it("catches a wrong depth even when the target IS a descendant", () => {
    const edges = [edge("jd_root", "skill_a")];
    const plan = planInheritance(CHAIN, edges, SKILLS);
    const lying = { ...plan, proposals: plan.proposals.map((p) => ({ ...p, depth: 9 })) };
    const inv = verifyInvariants(CHAIN, edges, SKILLS, lying);
    expect(inv.downwardOnly).toBe(false);
    expect(inv.violations.some((v) => v.includes("recorded 9"))).toBe(true);
  });

  it("catches a self-inheriting proposal", () => {
    const edges = [edge("jd_root", "skill_a")];
    const plan = planInheritance(CHAIN, edges, SKILLS);
    const lying = {
      ...plan,
      proposals: [{ ...plan.proposals[0]!, job_domain_id: "jd_root", inherited_from: "jd_root" }],
    };
    expect(verifyInvariants(CHAIN, edges, SKILLS, lying).downwardOnly).toBe(false);
  });

  it("proves inherited edges cannot root, by relabelling the whole corpus", () => {
    const edges = [edge("jd_root", "skill_a")];
    const inv = verifyInvariants(CHAIN, edges, SKILLS, planInheritance(CHAIN, edges, SKILLS));
    expect(inv.inheritedNeverRoot).toBe(true);
  });

  it("population makes a zero readable: nothing at risk vs rule never ran", () => {
    const edges = [edge("jd_root", "skill_a")];
    const inv = verifyInvariants(CHAIN, edges, SKILLS, planInheritance(CHAIN, edges, SKILLS));
    // SKILLS holds a deprecated skill, but no authored edge points at it. So a
    // SKIPPED_DEPRECATED_SKILL count of 0 means "nothing was at risk", not "the rule is dead".
    expect(inv.population.deprecatedSkillsInCorpus).toBe(1);
    expect(inv.population.deprecatedSkillsOnAuthoredEdges).toBe(0);
    expect(inv.population.inheritedEdgesToday).toBe(0);
    expect(inv.population.domainsReachedByMoreThanOneRoot).toBe(0);
  });

  it("population counts a deprecated skill that IS on an authored edge", () => {
    const edges = [edge("jd_root", "skill_d")];
    const inv = verifyInvariants(CHAIN, edges, SKILLS, planInheritance(CHAIN, edges, SKILLS));
    expect(inv.population.deprecatedSkillsOnAuthoredEdges).toBe(1);
    expect(inv.population.deprecatedSkillEdgesReachingDescendants).toBe(1);
  });

  // The two fields must be allowed to disagree — that disagreement IS the explanation for a
  // SKIPPED_DEPRECATED_SKILL count of zero in production.
  it("a deprecated skill on a CHILDLESS root is on an edge but reaches nothing to skip", () => {
    const edges = [edge("jd_leaf", "skill_d")];
    const doms = [...CHAIN, dom("jd_leaf", null)];
    const inv = verifyInvariants(doms, edges, SKILLS, planInheritance(doms, edges, SKILLS));
    expect(inv.population.deprecatedSkillsOnAuthoredEdges).toBe(1);
    expect(inv.population.deprecatedSkillEdgesReachingDescendants).toBe(0);
  });

  it("population counts domains two roots both reach — the only way AMBIGUOUS can fire", () => {
    const doms = [dom("jd_r1", null), dom("jd_r2", null), dom("jd_x", "jd_r1"), dom("jd_x", "jd_r2")];
    const edges = [edge("jd_r1", "skill_a"), edge("jd_r2", "skill_a")];
    const inv = verifyInvariants(doms, edges, SKILLS, planInheritance(doms, edges, SKILLS));
    expect(inv.population.domainsReachedByMoreThanOneRoot).toBeGreaterThan(0);
  });

  it("population reports authored edges excluded because they are not active", () => {
    const edges = [edge("jd_root", "skill_a"), edge("jd_root", "skill_p", { status: "retired" })];
    const inv = verifyInvariants(CHAIN, edges, SKILLS, planInheritance(CHAIN, edges, SKILLS));
    expect(inv.population.inactiveAuthoredEdges).toBe(1);
  });
});
