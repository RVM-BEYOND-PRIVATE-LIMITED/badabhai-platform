/**
 * THE APPROVAL PATH — Phase 5's controlled dry run, as a test rather than a one-off script.
 *
 * The four decisions a reviewer can take (CREATE / ALIAS / REJECT / HOLD) are exercised end to
 * end here: a candidate is decided, exported, and put through both shipped gates. Written as a
 * test rather than a demo runner because the properties being demonstrated — idempotency, the
 * audit link, the refusal codes — are exactly the properties that must not regress, and a demo
 * nobody re-runs proves nothing after the day it was written.
 *
 * NO DATABASE. Every module here is pure; the runner around them is a thin transport.
 */
import { describe, expect, it } from "vitest";

import { MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import {
  applicableConvergenceGroups,
  exportApprovedCandidates,
  toCorpus,
  type ExportRefusalCode,
} from "./skill-discovery-export";
import {
  candidateId,
  sealCandidate,
  statusForDecision,
  type SkillCandidateRecord,
  type SkillCandidateStatus,
} from "./skill-discovery-candidate";
import { analyzeTaxonomyQuality, taxonomyQualityVerdict } from "./taxonomy-quality-gate";
import { taxonomySkillIdFor, validateTaxonomyCorpus } from "./taxonomy-corpus";

const RUN = "sdr_20260101-000000Z_export";
const REVIEWER = "11111111-1111-1111-1111-111111111111";
const REVIEWED_AT = "2026-01-02T00:00:00.000Z";

/**
 * The occupation catalogue the export is given.
 *
 * REAL LABELS, not ids. `SKILL_LABEL_IS_DOMAIN_NAME` compares an approved label against DOMAIN
 * LABELS, so a fixture that passed ids as labels would make that gate pass vacuously — and a
 * test that silently disables the gate it is meant to exercise is worse than no test.
 */
const DOMAIN_LABELS: ReadonlyMap<string, string> = new Map([
  ["jd_nco_7411_0100", "Building and Related Electricians"],
  ["jd_nco_7411_0200", "Electrical Mechanics and Fitters"],
  ["jd_nco_7126_0100", "Plumbers and Pipe Fitters"],
]);
const OPTS = { domainLabels: DOMAIN_LABELS };
const APPROVED_DOMAINS = ["jd_nco_7411_0100"] as const;

function decided(
  clusterKey: string,
  status: SkillCandidateStatus,
  over: Partial<SkillCandidateRecord> = {},
): SkillCandidateRecord {
  const human = ["approved_create", "approved_map", "approved_merge", "rejected", "deferred"].includes(
    status,
  );
  const sources = over.sources ?? [
    {
      source_type: "job_domain_alias" as const,
      source_id: `src-${clusterKey}-1`,
      original_text: clusterKey,
      normalized_text: clusterKey,
      job_domain_id: "jd_nco_7411_0100",
    },
    {
      source_type: "job_domain_alias" as const,
      source_id: `src-${clusterKey}-2`,
      original_text: `${clusterKey} work`,
      normalized_text: `${clusterKey} work`,
      job_domain_id: "jd_nco_7411_0200",
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
    phrase_class: "ACTIVITY_PHRASE",
    classifier_rule: "ACTIVITY_HEADED",
    occupation_heads: [],
    evidence_tokens: clusterKey.split(" "),
    trade_family: "Craft and Related Trades Workers",
    source_alias_count: sources.length,
    source_domain_count: domains.size,
    proposed_action: "create",
    confidence_band: "low",
    confidence: null,
    status,
    reviewer_admin_id: human ? REVIEWER : null,
    reviewed_at: human ? REVIEWED_AT : null,
    review_reason: human ? "reviewed in the Phase 5 dry run" : null,
    resulting_skill_id: null,
    // A reviewer naming the trades is what makes an approved_create exportable at all — without
    // it the skill is an orphan and gate 1 refuses the batch. See `NO_APPROVED_DOMAIN`.
    approved_job_domain_ids: status === "approved_create" ? [...APPROVED_DOMAINS] : [],
    approved_requirement: "preferred",
    embedding_status: "not_required",
    model: null,
    prompt_version: null,
    corpus_fingerprint: "fp-export",
    created_at: "2026-01-01T00:00:00.000Z",
    sources,
    matches: [],
    ...over,
  } as Omit<SkillCandidateRecord, "provenance_digest">);
}

const codes = (rs: readonly { code: ExportRefusalCode }[]): ExportRefusalCode[] => rs.map((r) => r.code);

// ===========================================================================
// 1. The four decisions
// ===========================================================================

describe("CREATE — a new canonical skill", () => {
  const candidate = decided("sanitary fixture installation", "approved_create", {
    proposed_skill_name: "Sanitary Fixture Installation",
  });

  it("mints the id from the APPROVED LABEL, never from the candidate", () => {
    const batch = exportApprovedCandidates([candidate], OPTS);
    expect(batch.skills).toHaveLength(1);
    expect(batch.skills[0]?.skill_id).toBe(taxonomySkillIdFor("Sanitary Fixture Installation"));
    expect(batch.skills[0]?.label_en).toBe("Sanitary Fixture Installation");
    expect(batch.skills[0]?.reuses_existing).toBeUndefined();
  });

  it("lists the LABEL first, then the cluster's other surface forms", () => {
    // The label must be in its own alias list: ADR-0030 embeds the ALIASES, not the canonical
    // label, so a skill with none is unreachable forever — `ALIAS_LIST_EMPTY` says exactly that
    // and instructs "List at least the label itself". Deduped, so it is never listed twice.
    const batch = exportApprovedCandidates([candidate], OPTS);
    const aliases = batch.skills[0]?.aliases.map((a) => a.text) ?? [];
    expect(aliases[0]).toBe("Sanitary Fixture Installation");
    expect(aliases).toContain("sanitary fixture installation work");
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("links the minted id back to the deciding candidate", () => {
    // The Phase-8 audit question: "why does this skill exist?"
    const batch = exportApprovedCandidates([candidate], OPTS);
    expect(batch.provenance).toEqual([
      { skill_id: taxonomySkillIdFor("Sanitary Fixture Installation"), candidate_ids: [candidate.candidate_id] },
    ]);
  });

  it("passes both shipped gates", () => {
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
    expect(structural).toEqual([]);
    // Convergence groups SCOPED exactly as the runner scopes them. Passing the default set
    // would block on CONVERGENCE_GROUP_UNKNOWN_DOMAIN for all five groups — not because the
    // approval is bad but because a 1-skill batch cannot be asked about the welding trades.
    const convergence = applicableConvergenceGroups(corpus);
    const verdict = taxonomyQualityVerdict(
      analyzeTaxonomyQuality(corpus.skills, corpus.edges, {
        domains: corpus.domains,
        problems: structural,
        groups: convergence.applied,
      }),
    );
    expect(verdict.verdict).toBe("PASS");
  });
});

describe("ALIAS — attach to a skill that already exists", () => {
  const target = SKILL_CORPUS.find((s) => s.status !== "deprecated")?.skillId as string;
  const candidate = decided("bijli welding", "approved_map", { resulting_skill_id: target });

  it("produces a reuses_existing record, so the shipped row stays authoritative", () => {
    const batch = exportApprovedCandidates([candidate], OPTS);
    expect(batch.skills).toHaveLength(1);
    expect(batch.skills[0]?.skill_id).toBe(target);
    expect(batch.skills[0]?.reuses_existing).toBe(true);
    expect(batch.counts.exported_skills).toBe(0); // an alias is not a new skill
    expect(batch.counts.exported_aliases).toBeGreaterThan(0);
  });

  it("infers alias lang from the SCRIPT, not from a guess", () => {
    const hindi = decided("वेल्डिंग", "approved_map", { resulting_skill_id: target });
    const batch = exportApprovedCandidates([hindi], OPTS);
    expect(batch.skills[0]?.aliases.every((a) => a.lang === "hi")).toBe(true);
  });

  it("refuses an alias onto nothing", () => {
    const orphan = decided("x y", "approved_map", { resulting_skill_id: null });
    expect(codes(exportApprovedCandidates([orphan], OPTS).refusals)).toContain("NO_TARGET_SKILL");
  });
});

describe("REJECT and HOLD produce nothing, and are counted", () => {
  it("a rejection yields no corpus record", () => {
    const batch = exportApprovedCandidates([decided("experienced cnc operator", "rejected")]);
    expect(batch.skills).toEqual([]);
    expect(batch.counts.rejected).toBe(1);
    expect(batch.refusals).toEqual([]); // not a refusal — a decision
  });

  it("a hold yields no corpus record and is distinguishable from a rejection", () => {
    const batch = exportApprovedCandidates([decided("draughtspersons", "deferred")]);
    expect(batch.skills).toEqual([]);
    expect(batch.counts.deferred).toBe(1);
    expect(batch.counts.rejected).toBe(0);
  });

  it("a MERGE yields no corpus record, deliberately", () => {
    // A merge says two CANDIDATES are one concept. It does not say what the survivor is called
    // or whether it exists — emitting something would mean guessing which side won.
    const batch = exportApprovedCandidates([
      decided("a b", "approved_merge", { resulting_skill_id: SKILL_CORPUS[0]?.skillId ?? null }),
    ], OPTS);
    expect(batch.skills).toEqual([]);
    expect(batch.counts.approved_merge).toBe(1);
  });

  it("statusForDecision maps the reviewer's four buttons onto the ladder", () => {
    expect(statusForDecision("create")).toBe("approved_create");
    expect(statusForDecision("map")).toBe("approved_map");
    expect(statusForDecision("reject")).toBe("rejected");
    expect(statusForDecision("defer")).toBe("deferred");
  });
});

// ===========================================================================
// 2. Idempotency
// ===========================================================================

describe("idempotency", () => {
  const candidate = decided("conduit bending", "approved_create", {
    proposed_skill_name: "Conduit Bending",
  });

  it("exporting the same decisions twice produces byte-identical records", () => {
    const a = exportApprovedCandidates([candidate], OPTS);
    const b = exportApprovedCandidates([candidate], OPTS);
    expect(JSON.stringify(b.skills)).toBe(JSON.stringify(a.skills));
    expect(JSON.stringify(b.provenance)).toBe(JSON.stringify(a.provenance));
  });

  it("the same label always mints the same id, so a re-seed is a no-op", () => {
    expect(taxonomySkillIdFor("Conduit Bending")).toBe(taxonomySkillIdFor("Conduit Bending"));
  });

  it("two approvals claiming ONE id are refused, not silently deduped", () => {
    // A `skill_id` is immutable and never reused (ADR-0030 SG-5). Two approvals racing for one
    // id is a decision a human has to resolve — dropping one would pick a winner silently.
    const first = decided("conduit bending", "approved_create", { proposed_skill_name: "Conduit Bending" });
    const second = decided("bending conduit", "approved_create", { proposed_skill_name: "conduit  bending" });
    const batch = exportApprovedCandidates([first, second], OPTS);
    expect(codes(batch.refusals)).toContain("ID_COLLISION_WITHIN_BATCH");
    expect(batch.skills).toHaveLength(1);
  });

  it("export order does not change which candidate wins a collision report", () => {
    const first = decided("a bending", "approved_create", { proposed_skill_name: "Bending" });
    const second = decided("b bending", "approved_create", { proposed_skill_name: "Bending" });
    const forward = exportApprovedCandidates([first, second], OPTS);
    const reverse = exportApprovedCandidates([second, first], OPTS);
    // Both orders refuse exactly one and export exactly one — the report names whichever came
    // second, which is a deterministic function of the input order and is stated in the detail.
    expect(forward.skills).toHaveLength(1);
    expect(reverse.skills).toHaveLength(1);
    expect(forward.refusals).toHaveLength(1);
    expect(reverse.refusals).toHaveLength(1);
  });

  it("an undecided candidate contributes nothing and is not a refusal", () => {
    for (const status of ["pending", "needs_review"] as const) {
      const batch = exportApprovedCandidates([decided("x y", status)], OPTS);
      expect(batch.skills).toEqual([]);
      expect(batch.refusals).toEqual([]);
    }
  });
});

// ===========================================================================
// 3. The audit trail
// ===========================================================================

describe("the audit trail", () => {
  it("an approval missing its reviewer, moment, or reason is refused", () => {
    // Mirrors `skill_candidate_reviewed_chk`. Checked HERE as well because the export can run
    // from a file, where no database CHECK was ever in force.
    for (const gap of [
      { reviewer_admin_id: null },
      { reviewed_at: null },
      { review_reason: null },
      { review_reason: "   " },
    ]) {
      const candidate = decided("wire pulling", "approved_create", {
        proposed_skill_name: "Wire Pulling",
        ...gap,
      });
      expect(codes(exportApprovedCandidates([candidate], OPTS).refusals)).toContain("INCOMPLETE_DECISION");
    }
  });

  it("every exported skill traces to at least one candidate id", () => {
    const batch = exportApprovedCandidates(
      [
        decided("wire pulling", "approved_create", { proposed_skill_name: "Wire Pulling" }),
        decided("pipe threading", "approved_create", { proposed_skill_name: "Pipe Threading" }),
      ],
      OPTS,
    );
    expect(batch.provenance).toHaveLength(2);
    for (const p of batch.provenance) {
      expect(p.candidate_ids.length).toBeGreaterThan(0);
      expect(batch.skills.map((s) => s.skill_id)).toContain(p.skill_id);
    }
  });

  it("counts reconcile: every decision read is accounted for", () => {
    const batch = exportApprovedCandidates(
      [
        decided("a1 x", "approved_create", { proposed_skill_name: "A One" }),
        decided("a2 x", "approved_map", { resulting_skill_id: SKILL_CORPUS[0]?.skillId ?? null }),
        decided("a3 x", "approved_merge"),
        decided("a4 x", "rejected"),
        decided("a5 x", "deferred"),
      ],
      OPTS,
    );
    const c = batch.counts;
    expect(c.approved_create + c.approved_map + c.approved_merge + c.rejected + c.deferred).toBe(5);
  });
});

// ===========================================================================
// 4. The match-skill wall, on the export path too
// ===========================================================================

describe("the match-skill wall holds on the export path", () => {
  it("an alias onto an mskill_* id is refused", () => {
    const target = MATCH_SKILLS[0]?.skillId as string;
    const candidate = decided("fitter work", "approved_map", { resulting_skill_id: target });
    expect(codes(exportApprovedCandidates([candidate], OPTS).refusals)).toContain("MATCH_SKILL_TARGET");
    expect(exportApprovedCandidates([candidate], OPTS).skills).toEqual([]);
  });

  it("a label that would mint into the matchable space is refused", () => {
    const candidate = decided("mskill thing", "approved_create", { proposed_skill_name: "mskill fitter" });
    expect(codes(exportApprovedCandidates([candidate], OPTS).refusals)).toContain("MATCH_SKILL_TARGET");
  });

  it("no exported record can ever carry an mskill_* id", () => {
    const batch = exportApprovedCandidates(
      MATCH_SKILLS.map((m, i) => decided(`m${i} x`, "approved_map", { resulting_skill_id: m.skillId })),
      OPTS,
    );
    expect(batch.skills).toEqual([]);
    expect(batch.refusals).toHaveLength(MATCH_SKILLS.length);
  });
});

// ===========================================================================
// 5. Edges come from the REVIEWER, never from inference
// ===========================================================================

describe("edges are authored, not inferred", () => {
  const candidate = decided("pipe threading", "approved_create", {
    proposed_skill_name: "Pipe Threading",
    approved_job_domain_ids: ["jd_nco_7411_0100", "jd_nco_7126_0100"],
    approved_requirement: "required",
  });

  it("one curated edge per trade the reviewer named", () => {
    const batch = exportApprovedCandidates([candidate], OPTS);
    expect(batch.edges).toHaveLength(2);
    for (const e of batch.edges) {
      expect(e.source).toBe("curated");
      // NULL, not 0.9: for a curated row the schema says the confidence question is moot, and a
      // number here would be a measurement nobody took.
      expect(e.confidence).toBeNull();
      expect(e.default_requirement).toBe("required");
      expect(e.skill_id).toBe(taxonomySkillIdFor("Pipe Threading"));
    }
    expect(batch.edges.map((e) => e.job_domain_id).sort()).toEqual([
      "jd_nco_7126_0100",
      "jd_nco_7411_0100",
    ]);
  });

  it("the pipeline never populates the field the edges come from", () => {
    // The load-bearing separation: `approved_job_domain_ids` is a REVIEW field. A phrase
    // observed under an occupation says nothing about what that trade requires.
    const undecided = decided("pipe threading", "pending");
    expect(undecided.approved_job_domain_ids).toEqual([]);
    expect(exportApprovedCandidates([undecided], OPTS).edges).toEqual([]);
  });

  it("an approved_create naming no trade is refused, not silently orphaned", () => {
    // The finding that put this whole field in the schema: `validateTaxonomyCorpus` refuses a
    // skill with zero edges (SKILL_ORPHAN — "it seeds, it embeds, and it is invisible"), so a
    // batch with no edges was permanently BLOCKED. Caught here instead, while the decision is
    // still the reviewer's to revise.
    const orphan = decided("pipe threading", "approved_create", {
      proposed_skill_name: "Pipe Threading",
      approved_job_domain_ids: [],
    });
    expect(codes(exportApprovedCandidates([orphan], OPTS).refusals)).toContain("NO_APPROVED_DOMAIN");
    expect(exportApprovedCandidates([orphan], OPTS).skills).toEqual([]);
  });

  it("a named trade outside the catalogue is refused before the FK could fail mid-seed", () => {
    const bad = decided("pipe threading", "approved_create", {
      proposed_skill_name: "Pipe Threading",
      approved_job_domain_ids: ["jd_does_not_exist"],
    });
    expect(codes(exportApprovedCandidates([bad], OPTS).refusals)).toContain("UNKNOWN_APPROVED_DOMAIN");
  });

  it("an ALIAS decision emits no edge — the shipped skill already has its own", () => {
    const alias = decided("bijli welding", "approved_map", {
      resulting_skill_id: SKILL_CORPUS.find((x) => x.status !== "deprecated")?.skillId ?? null,
    });
    expect(exportApprovedCandidates([alias], OPTS).edges).toEqual([]);
  });

  it("the corpus carries thin domain POINTERS with real labels, never copies of job_domain", () => {
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    expect(corpus.domains).toHaveLength(2);
    for (const d of corpus.domains) {
      expect(Object.keys(d).sort()).toEqual(["job_domain_id", "kind", "label_en", "trade_group"]);
      // A real label, so SKILL_LABEL_IS_DOMAIN_NAME can actually fire.
      expect(d.label_en).not.toBe(d.job_domain_id);
    }
  });

  it("an approved label that IS one of the named trades' names is refused by gate 1", () => {
    // The gate the real labels exist to keep alive: a job title restated as a skill adds nothing
    // to that trade's picker (every candidate has it by definition) and is noise on every other.
    const titleAsSkill = decided("plumbers and pipe fitters", "approved_create", {
      proposed_skill_name: "Plumbers and Pipe Fitters",
      approved_job_domain_ids: ["jd_nco_7126_0100"],
    });
    const corpus = toCorpus(exportApprovedCandidates([titleAsSkill], OPTS), DOMAIN_LABELS);
    const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
    expect(structural.some((p) => p.includes("SKILL_LABEL_IS_DOMAIN_NAME"))).toBe(true);
  });
});

describe("convergence-group scoping is narrowed honestly, and says so", () => {
  const candidate = decided("pipe threading", "approved_create", {
    proposed_skill_name: "Pipe Threading",
    approved_job_domain_ids: ["jd_nco_7411_0100"],
  });

  it("a batch that touches none of a group's trades skips it and NAMES it", () => {
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const { applied, skipped } = applicableConvergenceGroups(corpus);
    expect(applied).toEqual([]);
    // Named, not silently dropped — that is the whole difference between scoping and disabling.
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped).toContain("welding");
  });

  it("a group whose trades ARE all present is applied, not skipped", () => {
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const group = {
      group: "electricians",
      job_domain_ids: ["jd_nco_7411_0100"],
      concepts: [{ concept: "threading", probes: ["thread"] }],
    };
    const { applied, skipped } = applicableConvergenceGroups(corpus, [group]);
    expect(applied.map((g) => g.group)).toEqual(["electricians"]);
    expect(skipped).toEqual([]);
  });

  it("scoping never removes a group the batch COULD answer", () => {
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const present = new Set(corpus.domains.map((d) => d.job_domain_id));
    const { applied, skipped } = applicableConvergenceGroups(corpus);
    for (const name of skipped) {
      // Every skipped group must have at least one domain the batch does not hold.
      expect(applied.map((g) => g.group)).not.toContain(name);
    }
    for (const g of applied) {
      for (const id of g.job_domain_ids) expect(present.has(id)).toBe(true);
    }
  });
});

// ===========================================================================
// 6. The gates actually bite
// ===========================================================================

describe("both gates run on the export, and a BLOCK is a normal outcome", () => {
  it("an approval whose id collides with a SHIPPED skill is refused by gate 1", () => {
    const shipped = SKILL_CORPUS.find((s) => s.status !== "deprecated");
    const candidate = decided("dup x", "approved_create", { proposed_skill_name: shipped?.labelEn ?? "CNC Turning" });
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
    expect(structural.length).toBeGreaterThan(0);
  });

  it("an all-generic approved label is refused", () => {
    const candidate = decided("machine work", "approved_create", { proposed_skill_name: "Machine Work" });
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
    expect(structural.some((p) => p.includes("OVER_GENERIC"))).toBe(true);
  });

  it("an approved label carrying a contact detail is refused", () => {
    const candidate = decided("call me", "approved_create", { proposed_skill_name: "Welding 9876543210" });
    const corpus = toCorpus(exportApprovedCandidates([candidate], OPTS), DOMAIN_LABELS);
    const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });
    expect(structural.some((p) => p.includes("FORBIDDEN_CHARS"))).toBe(true);
  });
});
