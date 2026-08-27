/**
 * REVIEW GROUPING — the properties that make batching safe, and the vernacular it must keep.
 *
 * The grouping layer exists because merging could not be made safe enough to reduce the queue
 * (see `MERGE_RELATIONS` and the 8,478-row `"wood"` blob it was written to prevent). So these
 * tests are mostly about what grouping REFUSES to do: it never merges, never chains, never
 * loses a candidate, and never depends on the order it saw them in.
 */
import { describe, expect, it } from "vitest";

import {
  anchorToken,
  evidenceTokenCounts,
  groupCandidates,
  groupFacts,
  groupingReduction,
  NON_ANCHOR_TOKENS,
  type GroupingFacts,
} from "./skill-discovery-groups";
import {
  candidateId,
  sealCandidate,
  type SkillCandidateRecord,
} from "./skill-discovery-candidate";
import {
  classifyPhrase,
  isDevanagariActivity,
  namesAnActivity,
  PHRASE_FUNCTION_WORDS,
} from "./skill-discovery-classify";
import { deriveOccupationHeads, DEVANAGARI_ROLE_NOUNS } from "./skill-discovery-heads";
import { reviewTier } from "./skill-discovery-plan";

const RUN = "sdr_20260101-000000Z_test";

/** A minimal fact row. `candidate_id` doubles as the label so failures read clearly. */
function base(id: string, evidenceTokens: readonly string[] = ["wood"]): GroupingFacts {
  return {
    candidate_id: id,
    evidence_tokens: evidenceTokens,
    trade_family: "Craft and Related Trades Workers",
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    has_strong_match: false,
    source_alias_count: 1,
    job_domain_ids: ["jd_a"],
    proposed_action: "create",
    status: "pending",
  };
}


function candidate(
  clusterKey: string,
  over: Partial<SkillCandidateRecord> = {},
): SkillCandidateRecord {
  const sources = over.sources ?? [
    {
      source_type: "job_domain_alias" as const,
      source_id: `src-${clusterKey}`,
      original_text: clusterKey,
      normalized_text: clusterKey,
      job_domain_id: "jd_a",
    },
  ];
  const domains = new Set(sources.map((s) => s.job_domain_id).filter((d): d is string => d !== null));
  return sealCandidate({
    candidate_id: candidateId(RUN, clusterKey),
    run_id: RUN,
    cluster_key: clusterKey,
    normalized_phrase: clusterKey,
    proposed_skill_name: null,
    proposed_description: null,
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    classifier_rule: "HEAD_PLUS_EVIDENCE",
    occupation_heads: ["operator"],
    evidence_tokens: clusterKey.split(" "),
    trade_family: "Craft and Related Trades Workers",
    source_alias_count: sources.length,
    source_domain_count: domains.size,
    proposed_action: "create",
    confidence_band: "low",
    confidence: null,
    status: "pending",
    reviewer_admin_id: null,
    reviewed_at: null,
    review_reason: null,
    resulting_skill_id: null,
    embedding_status: "not_required",
    model: null,
    prompt_version: null,
    corpus_fingerprint: "fp",
    created_at: "2026-01-01T00:00:00.000Z",
    sources,
    matches: [],
    ...over,
  } as Omit<SkillCandidateRecord, "provenance_digest">);
}

// ===========================================================================
// 1. Grouping never merges and never chains
// ===========================================================================

describe("grouping is non-destructive and non-transitive", () => {
  it("every candidate lands in exactly one group", () => {
    const candidates = [
      candidate("wood turn"),
      candidate("wood saw"),
      candidate("metal turn"),
      candidate("glass cut"),
    ];
    const groups = groupCandidates(candidates);
    const seen = candidates.flatMap(() => [] as string[]);
    const ids = new Set<string>();
    for (const g of groups) for (const id of g.candidate_ids) {
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(candidates.length);
    expect(seen).toEqual([]);
  });

  it("no candidate is ever removed, renamed, or absorbed", () => {
    // The property a MERGE cannot have: after grouping, every candidate still exists with its
    // own id, its own cluster_key and its own decision surface.
    const candidates = [candidate("wood turn"), candidate("wood saw")];
    const groups = groupCandidates(candidates);
    const grouped = groups.flatMap((g) => g.candidate_ids);
    for (const c of candidates) expect(grouped).toContain(c.candidate_id);
  });

  it("grouping is order-independent", () => {
    const candidates = [
      candidate("wood turn"),
      candidate("wood saw"),
      candidate("metal turn"),
      candidate("metal press"),
      candidate("glass cut"),
    ];
    const a = groupCandidates(candidates);
    const b = groupCandidates([...candidates].reverse());
    expect(a.map((g) => `${g.key}:${g.candidates}`).sort()).toEqual(
      b.map((g) => `${g.key}:${g.candidates}`).sort(),
    );
  });

  it("a shared token cannot chain two groups together", () => {
    // The exact shape that broke clustering: "wood" ~ "wood metal" ~ "metal" was one component
    // under union-find. Here `wood metal` is assigned to ONE anchor, so `wood` and `metal`
    // groups stay separate no matter what sits between them.
    const groups = groupCandidates([
      candidate("wood"),
      candidate("wood metal"),
      candidate("metal"),
      candidate("metal glass"),
      candidate("glass"),
    ]);
    // Five candidates, and no single group holds all of them — the collapse cannot occur.
    expect(groups.every((g) => g.candidates < 5)).toBe(true);
  });

  it("adding an unrelated candidate never moves an existing one", () => {
    // Stability under growth. A discovery run that finds one new phrase must not reshuffle the
    // batches a reviewer is part-way through.
    const base = [candidate("wood turn"), candidate("wood saw"), candidate("metal press")];
    const before = groupCandidates(base);
    const after = groupCandidates([...base, candidate("silai stitch", { trade_family: "Other" })]);
    const key = (gs: ReturnType<typeof groupCandidates>, id: string) =>
      gs.find((g) => g.candidate_ids.includes(id))?.key;
    for (const c of base) expect(key(after, c.candidate_id)).toBe(key(before, c.candidate_id));
  });
});

// ===========================================================================
// 2. The anchor
// ===========================================================================

describe("anchor selection", () => {
  it("picks the highest-count token, so batches are as large as they can honestly be", () => {
    const candidates = [
      candidate("wood turn"),
      candidate("wood saw"),
      candidate("wood drill"),
      candidate("turn"),
    ];
    const counts = evidenceTokenCounts(candidates);
    expect(counts.get("wood")).toBe(3);
    expect(anchorToken(candidate("wood turn"), counts)).toBe("wood");
  });

  it("breaks ties alphabetically, so the same input always gives the same batch", () => {
    const counts = new Map([
      ["zinc", 2],
      ["brass", 2],
    ]);
    expect(anchorToken(candidate("brass zinc"), counts)).toBe("brass");
  });

  it("refuses a seniority word as a batch axis", () => {
    // "senior" batches a manager with a machinist — breadth without anything in common.
    const counts = new Map([
      ["senior", 50],
      ["lathe", 2],
    ]);
    expect(anchorToken(candidate("senior lathe"), counts)).toBe("lathe");
    for (const t of ["general", "senior", "assistant", "other"]) {
      expect(NON_ANCHOR_TOKENS).toContain(t);
    }
  });

  it("a candidate with no usable token is grouped by family, not forced into a batch", () => {
    const counts = new Map([["general", 5]]);
    expect(anchorToken(candidate("general", { evidence_tokens: ["general"] }), counts)).toBeNull();
  });
});

// ===========================================================================
// 3. Tier separation — the brief's direct-then-derived sequencing
// ===========================================================================

describe("tier separation", () => {
  it("a group never mixes tiers", () => {
    const groups = groupCandidates([
      candidate("wood turn", { phrase_class: "ACTIVITY_PHRASE" }),
      candidate("wood saw", { phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE" }),
      candidate("wood plane", { phrase_class: "AMBIGUOUS" }),
    ]);
    // Same anchor and same family, but three tiers — therefore three groups. A reviewer working
    // the direct queue must not be silently deciding derived candidates.
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.tier)).size).toBe(3);
  });

  it("the reduction report separates tiers", () => {
    const candidates = [
      candidate("a turn", { phrase_class: "ACTIVITY_PHRASE" }),
      candidate("b saw", { phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE" }),
      candidate("c saw", { phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE" }),
    ];
    const r = groupingReduction(candidates, groupCandidates(candidates));
    expect(r.candidates).toBe(3);
    expect(r.by_tier["direct"]?.candidates).toBe(1);
    expect(r.by_tier["derived"]?.candidates).toBe(2);
  });

  it("unanimous_action is null the moment members disagree", () => {
    const groups = groupCandidates([
      candidate("wood turn", { proposed_action: "create" }),
      candidate("wood saw", { proposed_action: "review" }),
    ]);
    const mixed = groups.find((g) => g.candidates === 2);
    if (mixed !== undefined) expect(mixed.unanimous_action).toBeNull();
  });
});

// ===========================================================================
// 4. Vernacular — the population this platform exists for
// ===========================================================================

describe("vernacular is preserved and correctly classified", () => {
  const LEXICON = deriveOccupationHeads([
    "Operator, Strip Mill",
    "Welder, Gas",
    "Electrician",
    "मैकेनिक",
    "टैक्सी ड्राइवर",
  ]);

  it("lowercase Latin vernacular is not scrape noise", () => {
    for (const phrase of ["riksha", "plumbing", "bijli welding", "kharad operator"]) {
      expect(classifyPhrase(phrase, LEXICON).phraseClass).not.toBe("REJECTED_NON_SKILL");
    }
  });

  it("a Devanagari phrase is never rejected as prose", () => {
    // `isProse` decides "starts lowercase", and Devanagari is unicase — that comparison is TRUE
    // for every Devanagari character, so an unguarded rule discards 100% of Hindi input.
    for (const phrase of ["वेल्डिंग", "राज मिस्त्री", "छोटी मशीन का ऑपरेटर", "जूता मरम्मत"]) {
      expect(classifyPhrase(phrase, LEXICON).phraseClass).not.toBe("REJECTED_NON_SKILL");
    }
  });

  it("a Devanagari role noun is recognised as an occupation, not a skill", () => {
    const v = classifyPhrase("मैकेनिक", LEXICON);
    expect(v.occupationHeads).toContain("मैकेनिक");
    expect(v.phraseClass).toBe("OCCUPATION_ONLY");
    for (const head of ["मैकेनिक", "मिस्त्री", "ड्राइवर", "ऑपरेटर", "फिटर"]) {
      expect(DEVANAGARI_ROLE_NOUNS).toContain(head);
    }
  });

  it("a Devanagari activity word reaches the DIRECT tier", () => {
    // These are the highest-value rows in the corpus — a worker's own word for a real skill.
    // Before the Devanagari nominalizers they were all `AMBIGUOUS`.
    for (const phrase of ["वेल्डिंग", "सिलाई", "चिनाई", "घिसाई", "मिलिंग", "वायरिंग"]) {
      const v = classifyPhrase(phrase, LEXICON);
      expect(v.phraseClass, phrase).toBe("ACTIVITY_PHRASE");
    }
  });

  it("the three Devanagari nominalizers, and the guard on stem length", () => {
    expect(isDevanagariActivity("वेल्डिंग")).toBe(true); // -िंग loanword
    expect(isDevanagariActivity("सिलाई")).toBe(true); // -ाई native
    expect(isDevanagariActivity("बनाना")).toBe(true); // -ना infinitive
    expect(isDevanagariActivity("मैकेनिक")).toBe(false); // a role noun
    expect(isDevanagariActivity("welding")).toBe(false); // wrong script — isGerund's job
    expect(namesAnActivity("welding")).toBe(true);
    expect(namesAnActivity("वेल्डिंग")).toBe(true);
  });

  it("a Devanagari phrase groups on its Devanagari anchor", () => {
    const groups = groupCandidates([
      candidate("वेल्डिंग", { evidence_tokens: ["वेल्डिंग"], phrase_class: "ACTIVITY_PHRASE" }),
      candidate("आर्क वेल्डिंग", { evidence_tokens: ["आर्क", "वेल्डिंग"], phrase_class: "ACTIVITY_PHRASE" }),
    ]);
    const batch = groups.find((g) => g.anchor === "वेल्डिंग");
    expect(batch?.candidates).toBe(2);
  });

  it("Devanagari is not in the Latin function-word list", () => {
    // A sanity tripwire: if a Devanagari token ever appeared there it would be silently
    // stripped from every Hindi phrase's evidence.
    for (const w of PHRASE_FUNCTION_WORDS) expect(/[ऀ-ॿ]/.test(w)).toBe(false);
  });
});

// ===========================================================================
// 5. The reduction is reported, never assumed
// ===========================================================================

describe("reduction reporting", () => {
  it("singletons are counted as bought-nothing, not hidden", () => {
    const candidates = [
      candidate("wood turn"),
      candidate("wood saw"),
      candidate("lonely thing", { trade_family: "Other" }),
    ];
    const r = groupingReduction(candidates, groupCandidates(candidates));
    expect(r.singleton_groups).toBeGreaterThanOrEqual(1);
    expect(r.batchable_candidates + r.singleton_groups).toBe(candidates.length);
  });

  it("review_screens equals the group count — the honest headline", () => {
    // NOT a claim that a group is one decision: every member still gets its own decision and
    // its own audit row. It is the number of times a reviewer forms a judgement.
    const candidates = [candidate("wood turn"), candidate("wood saw"), candidate("wood drill")];
    const groups = groupCandidates(candidates);
    const r = groupingReduction(candidates, groups);
    expect(r.review_screens).toBe(groups.length);
    expect(r.review_screens).toBeLessThan(candidates.length);
  });

  it("tiering and grouping together never lose a candidate", () => {
    const candidates = ["a x", "b x", "c y", "d y", "e z"].map((k) => candidate(k));
    const groups = groupCandidates(candidates);
    const total = groups.reduce((n, g) => n + g.candidates, 0);
    expect(total).toBe(candidates.length);
    for (const c of candidates) expect(["direct", "derived", "ambiguous"]).toContain(reviewTier(c));
  });
});

// ===========================================================================
// groupFacts — the same rule, over what a queue read can actually hold
// ===========================================================================
//
// The admin queue cannot build `SkillCandidateRecord`s: a record carries its `sources` and
// `matches`, and materialising 6,673 of them to compute a few counts would mean reading every
// source row and every match row in the table. So the rule is exposed over the facts it reads.
//
// Until it was, the console had two options and picked the honest one: it DEGRADED to grouping by
// `trade_family` alone, within a single server page, and said so in its own header —
// "reimplementing that algorithm client-side is 'server authority' CLAUDE.md invariant #9
// forbids". These assertions are what let the endpoint replace that.

describe("groupFacts is the one implementation, and groupCandidates delegates to it", () => {
  /** The projection `groupCandidates` performs, spelled out so the two can be compared. */
  const factsOf = (candidates: readonly SkillCandidateRecord[]): GroupingFacts[] =>
    candidates.map((c) => ({
      candidate_id: c.candidate_id,
      evidence_tokens: c.evidence_tokens,
      trade_family: c.trade_family,
      phrase_class: c.phrase_class,
      has_strong_match: c.matches.some((m) => m.strength === "strong"),
      source_alias_count: c.source_alias_count,
      job_domain_ids: c.sources
        .map((x) => x.job_domain_id)
        .filter((d): d is string => d !== null),
      proposed_action: c.proposed_action,
      status: c.status,
    }));

  it("produces byte-identical groups from records and from facts", () => {
    // If these ever diverged, the console and the pipeline would disagree about what a batch IS,
    // and a reviewer working "the wood batch" on screen would be resolving a different set than
    // the one the coverage report counted.
    const candidates = ["wood turn", "wood saw", "wood drill", "metal cut", "riksha"].map((k) =>
      candidate(k),
    );
    expect(groupFacts(factsOf(candidates))).toEqual(groupCandidates(candidates));
  });

  it("agrees on a mixed-tier, mixed-family set too", () => {
    const candidates = [
      candidate("wood turn"),
      candidate("wood saw", { phrase_class: "ACTIVITY_PHRASE" }),
      candidate("riksha", { phrase_class: "AMBIGUOUS", evidence_tokens: [] }),
      candidate("metal cut", { trade_family: "Plant and Machine Operators" }),
    ];
    expect(groupFacts(factsOf(candidates))).toEqual(groupCandidates(candidates));
  });
});

describe("the group counts a reviewer actually reads", () => {
  it("counts UNDECIDED members, and treats deferred as decided", () => {
    // `candidates` is how big the batch is; `undecided` is how much of it is still work. Without
    // the split, a fully-decided batch keeps sitting at the top of the queue forever, because
    // groups sort by size.
    //
    // `deferred` counts as DECIDED: somebody looked and could not settle it, which is a different
    // fact from nobody having looked. Folding it in would make "12 left" mean two things.
    const facts: GroupingFacts[] = [
      { ...base("a"), status: "pending" },
      { ...base("b"), status: "needs_review" },
      { ...base("c"), status: "deferred" },
      { ...base("d"), status: "approved_create" },
      { ...base("e"), status: "rejected" },
    ];
    const [group] = groupFacts(facts);
    expect(group?.candidates).toBe(5);
    expect(group?.undecided).toBe(2);
  });

  it("UNIONS the job domains rather than summing them — the double-count trap", () => {
    // `skill_candidate.source_domain_count` is per candidate, and summing it across a group
    // double-counts every domain two members share. A batch is BY CONSTRUCTION candidates from
    // related trades, so that is most of them: three members attested in the same two domains
    // would report six.
    const facts: GroupingFacts[] = [
      { ...base("a"), job_domain_ids: ["jd_1", "jd_2"] },
      { ...base("b"), job_domain_ids: ["jd_2", "jd_3"] },
      { ...base("c"), job_domain_ids: ["jd_1", "jd_3"] },
    ];
    const [group] = groupFacts(facts);
    expect(group?.source_domains).toBe(3);
  });

  it("reports a unanimous suggestion only when the members really agree", () => {
    const agreed = groupFacts([base("a"), base("b")]);
    expect(agreed[0]?.unanimous_action).toBe("create");
    const split = groupFacts([base("a"), { ...base("b"), proposed_action: "review" }]);
    expect(split[0]?.unanimous_action).toBeNull();
  });
});

describe("grouping is deterministic, and the anchor is global to the input", () => {
  it("two calls over the same facts produce identical output", () => {
    // A reviewer returning to "the wood batch" must find the same batch. Nothing is persisted —
    // a group has no id in any table — so determinism is the only thing making the key stable.
    const facts = ["wood turn", "wood saw", "metal cut"].map((k) => base(k, k.split(" ")));
    expect(groupFacts(facts)).toEqual(groupFacts(facts));
  });

  it("is independent of input ORDER", () => {
    // The endpoint's SQL has no guaranteed order without an ORDER BY, so a grouping that depended
    // on arrival order would shuffle batches between identical requests.
    const facts = ["wood turn", "wood saw", "wood drill", "metal cut"].map((k) =>
      base(k, k.split(" ")),
    );
    expect(groupFacts([...facts].reverse())).toEqual(groupFacts(facts));
  });

  it("⚠ the anchor depends on the WHOLE input set, which is why this cannot run per page", () => {
    // `evidenceTokenCounts` counts across everything passed in, so the top token within 50 rows is
    // rarely the top token within 6,673. Grouping a PAGE gives a different anchor for the same
    // candidate than grouping the filtered set — the endpoint must pass the whole set, and this
    // is the assertion that makes that requirement visible rather than a comment.
    const wholeSet = [
      base("a", ["wood", "turn"]),
      base("b", ["wood", "saw"]),
      base("c", ["wood", "drill"]),
      base("d", ["turn", "lathe"]),
    ];
    const page = wholeSet.slice(2); // "c" and "d" only
    const anchorIn = (groups: ReturnType<typeof groupFacts>, id: string): string | null =>
      groups.find((g) => g.candidate_ids.includes(id))?.anchor ?? null;
    // Across everything, `wood` wins for "c" (3 occurrences vs `drill`'s 1).
    expect(anchorIn(groupFacts(wholeSet), "c")).toBe("wood");
    // Within the two-row page, `wood` and `drill` tie at 1 and the alphabetical tie-break takes
    // over — a different batch for the same candidate.
    expect(anchorIn(groupFacts(page), "c")).not.toBe("wood");
  });
});
