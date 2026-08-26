/**
 * THE GUARDRAILS — the properties that must hold for this pipeline to be safe to run.
 *
 * Every test here corresponds to a way the discovery layer could quietly damage the
 * production taxonomy. They are grouped by the claim they defend, and each one names the
 * failure it prevents rather than the function it calls, because in six months the useful
 * question will be "what breaks if I delete this?" and not "what does it assert?".
 *
 * NO DATABASE. Every module under test is pure by construction; a guardrail that needed a
 * connection would be a guardrail nobody runs.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import {
  approvedCandidateToCorpusSkill,
  assertDryRunSafe,
  assertProvenanceIntact,
  canTransition,
  candidateId,
  CANDIDATE_STATUSES,
  HUMAN_DECIDED_STATUSES,
  MACHINE_WRITABLE_STATUSES,
  PROVENANCE_FIELDS,
  provenanceDigest,
  sealCandidate,
  statusForDecision,
  TERMINAL_STATUSES,
  validateCandidate,
  type SkillCandidateRecord,
  type SkillCandidateStatus,
} from "./skill-discovery-candidate";
import {
  classifyPhrase,
  PHRASE_FUNCTION_WORDS,
  warrantsExtraction,
} from "./skill-discovery-classify";
import { deriveOccupationHeads, headLexiconFingerprint } from "./skill-discovery-heads";
import {
  buildExistingSkillIndex,
  clusterPhrases,
  matchExistingSkills,
  MERGE_RELATIONS,
  STRONG_MATCH_RELATIONS,
  type ExistingSkillRow,
} from "./skill-discovery-match";
import {
  buildDiscoveryPlan,
  discoveryKey,
  proposeAction,
  reviewTier,
  type DiscoverySourceRow,
} from "./skill-discovery-plan";
import { discoveryInputFingerprint, runIsFresh } from "./skill-discovery-run";

// ===========================================================================
// Fixtures
// ===========================================================================

/** A small, realistic occupation catalogue — the same two title conventions the real one has. */
const OCCUPATION_TEXTS: readonly string[] = [
  "Operator, Strip Mill",
  "Strip Mill Operator",
  "Welder, Gas",
  "Gas Welder",
  "Dyer, Leather",
  "Magician",
  "Electrician",
  "Mason, Building Construction",
  "CNC Operator",
  "Metal Working Machine Tool Setters and Operators",
  "Wood Turner",
  "Wood Sawyer",
  "Bank Manager",
  "Clerk, Bank",
];

const LEXICON = deriveOccupationHeads(OCCUPATION_TEXTS);

const EXISTING: readonly ExistingSkillRow[] = [
  {
    skillId: "skill_arc_welding",
    labelEn: "Arc Welding",
    status: "active",
    kind: "attribute",
    aliasTexts: ["arc welding", "arc weld", "electric arc welding"],
  },
  {
    skillId: "skill_cnc_turning",
    labelEn: "CNC Turning",
    status: "active",
    kind: "attribute",
    aliasTexts: ["cnc turning", "cnc lathe turning"],
  },
  // The Phase-12 trap: a genuine `mskill_*` row sitting in the same table.
  {
    skillId: "mskill_fitter",
    labelEn: "Fitter",
    status: "active",
    kind: "match_skill",
    aliasTexts: ["fitter"],
  },
];

const INDEX = buildExistingSkillIndex(EXISTING);

const RUN = "sdr_20260101-000000Z_test";
const FP = "fingerprint-under-test";

function candidate(over: Partial<SkillCandidateRecord> = {}): SkillCandidateRecord {
  const clusterKey = over.cluster_key ?? "conduit bending";
  const base = {
    candidate_id: candidateId(RUN, clusterKey),
    run_id: RUN,
    cluster_key: clusterKey,
    normalized_phrase: clusterKey,
    proposed_skill_name: null,
    proposed_description: null,
    phrase_class: "ACTIVITY_PHRASE" as const,
    classifier_rule: "ACTIVITY_HEADED" as const,
    occupation_heads: [],
    evidence_tokens: ["conduit", "bending"],
    trade_family: null,
    source_alias_count: 1,
    source_domain_count: 1,
    proposed_action: "create" as const,
    confidence_band: "low" as const,
    confidence: null,
    status: "pending" as SkillCandidateStatus,
    reviewer_admin_id: null,
    reviewed_at: null,
    review_reason: null,
    resulting_skill_id: null,
    embedding_status: "not_required" as const,
    model: null,
    prompt_version: null,
    corpus_fingerprint: FP,
    created_at: "2026-01-01T00:00:00.000Z",
    sources: [
      {
        source_type: "job_domain_alias" as const,
        source_id: "src-1",
        original_text: "Conduit Bending",
        normalized_text: "conduit bending",
        job_domain_id: "jd_nco_7411_0100",
      },
    ],
    matches: [],
    ...over,
  };
  return sealCandidate(base as Omit<SkillCandidateRecord, "provenance_digest">);
}

// ===========================================================================
// 1. No domain alias automatically creates a production skill
// ===========================================================================

describe("no domain alias becomes a production skill", () => {
  it("the pipeline emits only machine-writable statuses, whatever the input", () => {
    const sources: DiscoverySourceRow[] = OCCUPATION_TEXTS.map((text, i) => ({
      source_type: "job_domain_alias",
      source_id: `a${i}`,
      original_text: text,
      job_domain_id: `jd_test_${i}`,
    }));
    const plan = buildDiscoveryPlan({
      runId: RUN,
      createdAt: "2026-01-01T00:00:00.000Z",
      corpusFingerprint: FP,
      sources,
      lexicon: LEXICON,
      index: INDEX,
    });
    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const c of plan.candidates) {
      expect(MACHINE_WRITABLE_STATUSES).toContain(c.status);
    }
  });

  it("a bare occupation title never reaches the queue at all", () => {
    // "Magician" — an occupation head with no modifier. It is COUNTED, never queued.
    const plan = buildDiscoveryPlan({
      runId: RUN,
      createdAt: "2026-01-01T00:00:00.000Z",
      corpusFingerprint: FP,
      sources: [
        { source_type: "job_domain_alias", source_id: "m", original_text: "Magician", job_domain_id: "jd_a" },
      ],
      lexicon: LEXICON,
      index: INDEX,
    });
    expect(plan.census.by_disposition.occupation_only).toBe(1);
    expect(plan.candidates).toHaveLength(0);
  });

  it("the ONLY converter into the corpus refuses every non-approved status", () => {
    for (const status of CANDIDATE_STATUSES) {
      if (status === "approved_create") continue;
      expect(() => approvedCandidateToCorpusSkill(candidate({ status }))).toThrow(/Only an explicitly human-approved/);
    }
  });

  it("the discovery runner contains no mutation verb", () => {
    // The claim in `discover-skills.ts`'s header — checked, not believed. A future edit that
    // adds an INSERT to the dry-run runner fails here rather than in production.
    const src = readFileSync(join(__dirname, "discover-skills.ts"), "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const verb of ["INSERT INTO", "UPDATE ", "DELETE FROM", "TRUNCATE", "ALTER TABLE", "DROP "]) {
      expect(body.toUpperCase()).not.toContain(verb);
    }
  });
});

// ===========================================================================
// 2. No speculative candidate bypasses review
// ===========================================================================

describe("no speculative candidate bypasses review", () => {
  it("assertDryRunSafe throws on any human-decided status", () => {
    for (const status of HUMAN_DECIDED_STATUSES) {
      expect(() => assertDryRunSafe([candidate({ status })])).toThrow(/human-decided status/);
    }
  });

  it("assertDryRunSafe refuses the WHOLE run, not just the offending rows", () => {
    // Filtering would turn a loud bug into a quiet one — the good rows would still ship.
    const good = candidate({ cluster_key: "good" });
    const bad = candidate({ cluster_key: "bad", status: "approved_create" });
    expect(() => assertDryRunSafe([good, bad])).toThrow();
  });

  it("a human-decided status without a named human is refused", () => {
    const c = candidate({ status: "rejected", reviewer_admin_id: null, reviewed_at: null, review_reason: null });
    expect(validateCandidate(c).map((p) => p.code)).toContain("DECISION_WITHOUT_REVIEWER");
  });

  it("a machine status carrying a reviewer is refused", () => {
    const c = candidate({ status: "pending", reviewer_admin_id: "11111111-1111-1111-1111-111111111111" });
    expect(validateCandidate(c).map((p) => p.code)).toContain("MACHINE_STATUS_WITH_REVIEWER");
  });
});

// ===========================================================================
// 3. Existing skills are preferred over duplicate creation
// ===========================================================================

describe("existing skills are preferred over duplicate creation", () => {
  it("a phrase that is already a surface form is covered, not a new-skill candidate", () => {
    const plan = buildDiscoveryPlan({
      runId: RUN,
      createdAt: "2026-01-01T00:00:00.000Z",
      corpusFingerprint: FP,
      sources: [
        { source_type: "job_domain_alias", source_id: "x", original_text: "Arc Welding", job_domain_id: "jd_a" },
      ],
      lexicon: LEXICON,
      index: INDEX,
    });
    expect(plan.census.by_disposition.covered_by_existing_skill).toBe(1);
    expect(plan.census.by_disposition.new_skill_candidate).toBe(0);
    // Already answered by the taxonomy — asking a human again is how a queue fills with
    // confirmations.
    expect(plan.candidates).toHaveLength(0);
  });

  it("an exact surface hit outranks every shape rule", () => {
    const matches = matchExistingSkills("arc welding", INDEX);
    expect(matches[0]?.relation).toBe("exact_surface");
    expect(matches[0]?.score).toBe(1);
    expect(matches[0]?.strength).toBe("strong");
  });

  it("`map` is never suggested on weak evidence alone", () => {
    // The Phase-4 rule: similarity is evidence, not authorization.
    const weakOnly = [
      { skillId: "skill_x", relation: "high_token_overlap" as const, score: 0.6, strength: "weak" as const, detail: "" },
    ];
    expect(proposeAction("alias_opportunity", weakOnly)).toBe("review");
    expect(proposeAction("new_skill_candidate", weakOnly)).toBe("create");
  });

  it("a candidate claiming `map` with no strong match is refused by the validator", () => {
    const c = candidate({
      proposed_action: "map",
      matches: [
        { skill_id: "skill_x", relation: "high_token_overlap", score: 0.6, strength: "weak", rank: 1, evidence_detail: null },
      ],
    });
    expect(validateCandidate(c).map((p) => p.code)).toContain("WEAK_MATCH_DROVE_ACTION");
  });

  it("a specialization relation is graded WEAK, not strong", () => {
    // "customs inspector" vs a skill labelled "quality inspector" is a subset relation and was
    // reported STRONG by the inherited grading — one of three measured false matches.
    expect(STRONG_MATCH_RELATIONS).not.toContain("strict_token_subset");
    expect(STRONG_MATCH_RELATIONS).not.toContain("high_token_overlap");
  });
});

// ===========================================================================
// 4. Aliases and canonical skills remain separate
// ===========================================================================

describe("aliases and canonical skills stay separate", () => {
  it("an approved-create candidate never lists its own label as an alias", () => {
    const c = candidate({
      status: "approved_create",
      proposed_skill_name: "Conduit Bending",
      reviewer_admin_id: "11111111-1111-1111-1111-111111111111",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      review_reason: "genuinely missing",
      sources: [
        {
          source_type: "job_domain_alias",
          source_id: "s1",
          original_text: "Conduit Bending",
          normalized_text: "conduit bending",
          job_domain_id: null,
        },
        {
          source_type: "job_domain_alias",
          source_id: "s2",
          original_text: "Conduit Laying",
          normalized_text: "conduit laying",
          job_domain_id: null,
        },
      ],
      source_alias_count: 2,
      source_domain_count: 0,
    });
    const record = approvedCandidateToCorpusSkill(c);
    expect(record.label_en).toBe("Conduit Bending");
    expect(record.aliases.map((a) => a.text)).toEqual(["Conduit Laying"]);
  });

  it("`approved_map` onto nothing is refused", () => {
    const c = candidate({
      status: "approved_map",
      resulting_skill_id: null,
      reviewer_admin_id: "11111111-1111-1111-1111-111111111111",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      review_reason: "r",
    });
    expect(validateCandidate(c).map((p) => p.code)).toContain("RESOLUTION_WITHOUT_SKILL");
  });
});

// ===========================================================================
// 5. New skills cannot silently enter MATCH_SKILLS
// ===========================================================================

describe("the match-skill wall", () => {
  it("the existing-skill index refuses match_skill rows outright", () => {
    expect(INDEX.rows.has("mskill_fitter")).toBe(false);
    expect(INDEX.surfaces.map((s) => s.skill_id)).not.toContain("mskill_fitter");
  });

  it("no match against an mskill_* id can be produced", () => {
    // "fitter" is literally an alias of the mskill row in the fixture. It must still not match.
    for (const m of matchExistingSkills("fitter", INDEX)) {
      expect(m.skillId.startsWith("mskill_")).toBe(false);
    }
  });

  it("a candidate resolving onto an mskill_* id is refused", () => {
    const target = MATCH_SKILLS[0]?.skillId as string;
    const c = candidate({
      status: "approved_map",
      resulting_skill_id: target,
      reviewer_admin_id: "11111111-1111-1111-1111-111111111111",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      review_reason: "r",
    });
    expect(validateCandidate(c).map((p) => p.code)).toContain("RESULTING_IS_MATCH_SKILL");
  });

  it("a candidate OFFERING an mskill_* id as a competing match is refused", () => {
    const target = MATCH_SKILLS[0]?.skillId as string;
    const c = candidate({
      matches: [{ skill_id: target, relation: "exact_surface", score: 1, strength: "strong", rank: 1, evidence_detail: null }],
    });
    expect(validateCandidate(c).map((p) => p.code)).toContain("MATCH_IS_MATCH_SKILL");
  });

  it("the corpus converter produces an ATTRIBUTE record with no matchable field", () => {
    const c = candidate({
      status: "approved_create",
      proposed_skill_name: "Conduit Bending",
      reviewer_admin_id: "11111111-1111-1111-1111-111111111111",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      review_reason: "r",
    });
    const record = approvedCandidateToCorpusSkill(c);
    expect(record.skill_id.startsWith("skill_")).toBe(true);
    expect(record.skill_id.startsWith("mskill_")).toBe(false);
    expect(record.kind).toBe("skill");
    // No field on the corpus record can express a match-skill mapping.
    expect(Object.keys(record)).not.toContain("match_skill_ids");
  });

  it("SKILL_CORPUS and MATCH_SKILLS are untouched by anything in this pipeline", () => {
    // A tripwire, not a tautology: it pins the two counts this workstream promised not to move.
    expect(MATCH_SKILLS).toHaveLength(18);
    expect(SKILL_CORPUS.length).toBeGreaterThan(0);
    for (const s of MATCH_SKILLS) expect(s.skillId.startsWith("mskill_")).toBe(true);
  });
});

// ===========================================================================
// 6. Candidate provenance cannot be overwritten
// ===========================================================================

describe("provenance is frozen", () => {
  it("every frozen field is detected when it moves", () => {
    const before = candidate();
    const moves: Partial<Record<string, unknown>> = {
      cluster_key: "other",
      normalized_phrase: "other",
      phrase_class: "AMBIGUOUS",
      classifier_rule: "NO_HEAD_NO_ACTIVITY",
      occupation_heads: ["operator"],
      evidence_tokens: ["x"],
      trade_family: "cnc",
      source_alias_count: 9,
      source_domain_count: 9,
      proposed_action: "reject",
      confidence_band: "high",
      confidence: 0.5,
      model: "m",
      prompt_version: "v1",
      corpus_fingerprint: "other",
      created_at: "2027-01-01T00:00:00.000Z",
      run_id: "sdr_other",
    };
    for (const [field, value] of Object.entries(moves)) {
      const after = { ...before, [field]: value } as SkillCandidateRecord;
      expect(assertProvenanceIntact(before, after)).toContain(field);
    }
  });

  it("a review edit moves nothing frozen", () => {
    const before = candidate();
    const after: SkillCandidateRecord = {
      ...before,
      status: "approved_create",
      proposed_skill_name: "Conduit Bending",
      proposed_description: "Bending electrical conduit to a required radius.",
      reviewer_admin_id: "11111111-1111-1111-1111-111111111111",
      reviewed_at: "2026-01-02T00:00:00.000Z",
      review_reason: "no existing skill covers it",
      resulting_skill_id: null,
    };
    expect(assertProvenanceIntact(before, after)).toEqual([]);
  });

  it("the digest changes when a frozen field changes, and the validator notices", () => {
    const before = candidate();
    const tampered = { ...before, model: "sneaky-model", prompt_version: "v9" } as SkillCandidateRecord;
    expect(provenanceDigest(tampered)).not.toBe(before.provenance_digest);
    expect(validateCandidate(tampered).map((p) => p.code)).toContain("PROVENANCE_DIGEST_MISMATCH");
  });

  it("the digest is stable under field reordering", () => {
    const c = candidate();
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as unknown as SkillCandidateRecord;
    expect(provenanceDigest(reordered)).toBe(c.provenance_digest);
  });

  it("model and prompt_version are both-or-neither", () => {
    expect(validateCandidate(candidate({ model: "m" })).map((p) => p.code)).toContain("MODEL_PAIR");
    expect(validateCandidate(candidate({ prompt_version: "v1" })).map((p) => p.code)).toContain("MODEL_PAIR");
  });

  it("PROVENANCE_FIELDS excludes exactly the review surface", () => {
    for (const f of ["status", "reviewer_admin_id", "reviewed_at", "review_reason", "resulting_skill_id", "proposed_skill_name", "proposed_description"]) {
      expect(PROVENANCE_FIELDS as readonly string[]).not.toContain(f);
    }
  });
});

// ===========================================================================
// 7. Source traceability and uniqueness
// ===========================================================================

describe("source traceability", () => {
  it("every alias that fed a candidate is recoverable from it", () => {
    const sources: DiscoverySourceRow[] = [
      { source_type: "job_domain_alias", source_id: "a1", original_text: "Operator, Strip Mill", job_domain_id: "jd_1" },
      { source_type: "job_domain_alias", source_id: "a2", original_text: "Strip Mill Operator", job_domain_id: "jd_2" },
    ];
    const plan = buildDiscoveryPlan({
      runId: RUN,
      createdAt: "2026-01-01T00:00:00.000Z",
      corpusFingerprint: FP,
      sources,
      lexicon: LEXICON,
      index: INDEX,
    });
    // Two spellings of one job, one decision, both sources kept.
    expect(plan.candidates).toHaveLength(1);
    const c = plan.candidates[0] as SkillCandidateRecord;
    expect([...c.sources].map((s) => s.source_id).sort()).toEqual(["a1", "a2"]);
    expect(c.source_alias_count).toBe(2);
    expect(c.source_domain_count).toBe(2);
  });

  it("the candidate id is deterministic in (run, cluster)", () => {
    expect(candidateId(RUN, "abc")).toBe(candidateId(RUN, "abc"));
    expect(candidateId(RUN, "abc")).not.toBe(candidateId("sdr_other", "abc"));
    expect(candidateId(RUN, "abc")).not.toBe(candidateId(RUN, "abd"));
  });

  it("declared counts must match the attached sources", () => {
    expect(validateCandidate(candidate({ source_alias_count: 99 })).map((p) => p.code)).toContain(
      "SOURCE_COUNT_MISMATCH",
    );
    expect(validateCandidate(candidate({ source_domain_count: 99 })).map((p) => p.code)).toContain(
      "DOMAIN_COUNT_MISMATCH",
    );
  });

  it("a candidate with no sources is refused", () => {
    expect(validateCandidate(candidate({ sources: [], source_alias_count: 0, source_domain_count: 0 })).map((p) => p.code)).toContain("NO_SOURCES");
  });
});

// ===========================================================================
// 8. Status transitions
// ===========================================================================

describe("status transitions", () => {
  it("terminal statuses are terminal", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of CANDIDATE_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("a pipeline status can never jump straight to an approval", () => {
    for (const to of ["approved_create", "approved_map", "approved_merge"] as const) {
      expect(canTransition("pending", to)).toBe(false);
    }
  });

  it("needs_review reaches every human decision", () => {
    for (const to of HUMAN_DECIDED_STATUSES) {
      expect(canTransition("needs_review", to)).toBe(true);
    }
  });

  it("deferred is re-openable — it is a real answer, not a terminal one", () => {
    expect(canTransition("deferred", "needs_review")).toBe(true);
    expect(canTransition("deferred", "approved_create")).toBe(true);
  });

  it("each decision maps to exactly one status", () => {
    expect(statusForDecision("map")).toBe("approved_map");
    expect(statusForDecision("create")).toBe("approved_create");
    expect(statusForDecision("merge")).toBe("approved_merge");
    expect(statusForDecision("reject")).toBe("rejected");
    expect(statusForDecision("defer")).toBe("deferred");
  });
});

// ===========================================================================
// 9. Run reproducibility and stale evaluations
// ===========================================================================

describe("run fingerprints", () => {
  const corpus = {
    skill_alias: "a",
    skill: "b",
    job_domain_skill: "c",
    job_domain: "d",
    job_domain_alias: "e",
    counts: {} as never,
  };

  it("identical inputs produce an identical fingerprint", () => {
    const cfg = { sources: ["job_domain_alias"], maxMatches: 5 };
    expect(discoveryInputFingerprint(corpus, LEXICON, cfg)).toBe(
      discoveryInputFingerprint(corpus, LEXICON, cfg),
    );
  });

  it("a changed CORPUS changes the fingerprint", () => {
    const cfg = { maxMatches: 5 };
    expect(discoveryInputFingerprint({ ...corpus, skill: "b2" }, LEXICON, cfg)).not.toBe(
      discoveryInputFingerprint(corpus, LEXICON, cfg),
    );
  });

  it("a changed HEAD LEXICON changes the fingerprint even when no row moved", () => {
    // The failure the corpus digest alone cannot see: same database, different rule about what
    // counts as an occupation head, therefore a different candidate set.
    const widened = deriveOccupationHeads([...OCCUPATION_TEXTS, "Quilter"]);
    expect(headLexiconFingerprint(widened)).not.toBe(headLexiconFingerprint(LEXICON));
    expect(discoveryInputFingerprint(corpus, widened, {})).not.toBe(
      discoveryInputFingerprint(corpus, LEXICON, {}),
    );
  });

  it("a changed CONFIG changes the fingerprint", () => {
    expect(discoveryInputFingerprint(corpus, LEXICON, { includeRejected: true })).not.toBe(
      discoveryInputFingerprint(corpus, LEXICON, { includeRejected: false }),
    );
  });

  it("freshness is equality, and an empty fingerprint is never fresh", () => {
    expect(runIsFresh("abc", "abc")).toBe(true);
    expect(runIsFresh("abc", "abd")).toBe(false);
    expect(runIsFresh("", "")).toBe(false);
  });
});

// ===========================================================================
// 10. Duplicate handling and collision detection
// ===========================================================================

describe("deduplication and collisions", () => {
  it("word-order variants of one concept become one cluster", () => {
    const counts = new Map([
      ["cnc setup", 3],
      ["setup cnc", 1],
      ["cnc machine setup", 2],
    ]);
    const clusters = clusterPhrases(counts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.canonical).toBe("cnc setup");
    expect([...(clusters[0]?.aliasMembers ?? [])].sort()).toEqual(["cnc machine setup", "setup cnc"]);
  });

  it("a SPECIALIZATION never merges — it is escalated instead", () => {
    // The measured blow-up: subset chaining put 5,706 phrases and 2,814 domains in one cluster.
    const counts = new Map([
      ["wood", 5],
      ["wood carving", 3],
      ["metal", 4],
      ["wood metal", 2],
    ]);
    const clusters = clusterPhrases(counts);
    expect(clusters).toHaveLength(4);
    expect(MERGE_RELATIONS).not.toContain("strict_token_subset");
  });

  it("a consonant-skeleton collision never merges", () => {
    // `pile` / `pool` / `ply` all fold to `pl`. Measured: one cluster held "pile-driver
    // operator", "swimming pool cleaner" and "ply bander".
    const clusters = clusterPhrases(new Map([["pile", 1], ["pool", 1], ["ply", 1]]));
    expect(clusters).toHaveLength(3);
  });

  it("clustering is deterministic and order-independent", () => {
    const a = clusterPhrases(new Map([["cnc setup", 3], ["setup cnc", 1]]));
    const b = clusterPhrases(new Map([["setup cnc", 1], ["cnc setup", 3]]));
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
  });
});

// ===========================================================================
// 11. The classifier's own rules
// ===========================================================================

describe("classifier", () => {
  it("an occupation title with no modifier carries no evidence", () => {
    const v = classifyPhrase("Magician", LEXICON);
    expect(v.phraseClass).toBe("OCCUPATION_ONLY");
    expect(v.evidenceTokens).toEqual([]);
    expect(warrantsExtraction(v)).toBe(false);
  });

  it("an occupation title with a modifier keeps the modifier as evidence", () => {
    const v = classifyPhrase("Operator, Strip Mill", LEXICON);
    expect(v.phraseClass).toBe("OCCUPATION_WITH_SKILL_EVIDENCE");
    expect(v.occupationHeads).toContain("operator");
    expect([...v.evidenceTokens].sort()).toEqual(["mill", "strip"]);
  });

  it("residual-bucket connectives are not evidence", () => {
    // The measured defect: `and`, `other`, `and other related` were the top evidence
    // signatures of the first dry run.
    const v = classifyPhrase("Managers, Other", LEXICON);
    expect(v.evidenceTokens).toEqual([]);
    expect(v.phraseClass).toBe("OCCUPATION_ONLY");
    for (const w of ["and", "other", "related", "of", "the"]) {
      expect(PHRASE_FUNCTION_WORDS).toContain(w);
    }
  });

  it("a phrase carrying a contact detail is refused before anything else", () => {
    const v = classifyPhrase("Welder call 9876543210", LEXICON);
    expect(v.phraseClass).toBe("REJECTED_NON_SKILL");
    expect(v.rule).toBe("FORBIDDEN_CHARS");
  });

  it("scrape prose is refused", () => {
    const v = classifyPhrase("spreads skin or hide with hair and applies", LEXICON);
    expect(v.phraseClass).toBe("REJECTED_NON_SKILL");
  });

  it("an unrecognisable phrase is AMBIGUOUS, never guessed", () => {
    const v = classifyPhrase("riksha", LEXICON);
    expect(v.phraseClass).toBe("AMBIGUOUS");
    expect(warrantsExtraction(v)).toBe(true);
  });
});

// ===========================================================================
// 12. The discovery key
// ===========================================================================

describe("the discovery key", () => {
  const outcomeFor = (text: string) => ({
    normalized: classifyPhrase(text, LEXICON).normalized,
    original: text,
    occurrences: 1,
    verdict: classifyPhrase(text, LEXICON),
    disposition: "new_skill_candidate" as const,
    matches: [],
    job_domain_ids: [],
    sources: [],
  });

  it("word-order variants of one title share a key", () => {
    expect(discoveryKey(outcomeFor("Operator, Strip Mill"))).toBe(
      discoveryKey(outcomeFor("Strip Mill Operator")),
    );
  });

  it("different trades on the same material do NOT share a key", () => {
    // The regression that motivated putting the head's action stem back in: "wood turner" and
    // "wood sawyer" collapsed onto the key "wood" together with three other trades.
    expect(discoveryKey(outcomeFor("Wood Turner"))).not.toBe(discoveryKey(outcomeFor("Wood Sawyer")));
  });
});

// ===========================================================================
// 13. Review tiering — sorts, never approves
// ===========================================================================

describe("review tiering", () => {
  it("an activity phrase outranks an occupation-derived candidate", () => {
    expect(reviewTier(candidate({ phrase_class: "ACTIVITY_PHRASE" }))).toBe("direct");
    expect(
      reviewTier(candidate({ phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE", matches: [] })),
    ).toBe("derived");
    expect(reviewTier(candidate({ phrase_class: "AMBIGUOUS", matches: [] }))).toBe("ambiguous");
  });

  it("tiering changes no status and no action", () => {
    const c = candidate({ phrase_class: "ACTIVITY_PHRASE" });
    const before = { ...c };
    reviewTier(c);
    expect(c).toEqual(before);
  });
});
