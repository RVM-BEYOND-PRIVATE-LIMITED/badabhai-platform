import { describe, it, expect } from "vitest";
import {
  AICallMetadataSchema,
  ConversationStateSchema,
  DraftProfileSchema,
  ProfileExtractionInputSchema,
  ProfileExtractionOutputSchema,
  PseudonymizationOutputSchema,
  GrowthAnchorSchema,
  GrowthClusterInputSchema,
  GrowthClusterOutputSchema,
  GrowthPhraseSchema,
  GrowthProposalSchema,
  ResumeGenerationInputSchema,
  RetagPlanInputSchema,
  RetagPlanOutputSchema,
  RetagResolvedEntrySchema,
  RetagRowSchema,
  SkillAliasEmbedInputSchema,
  SkillAliasEmbedOutputSchema,
  SkillCanonicalizationInputSchema,
  SkillCanonicalizationSchema,
  TranscriptionInputSchema,
  TranscriptionOutputSchema,
  WorkerProfileDraftSchema,
} from "./index";

describe("DraftProfileSchema", () => {
  it("fills sensible defaults from an empty object", () => {
    const profile = DraftProfileSchema.parse({});
    expect(profile.skills).toEqual([]);
    expect(profile.salary_expectation.currency).toBe("INR");
    expect(profile.availability.status).toBe("unknown");
    expect(profile.canonical_role_id).toBeNull();
  });
  it("skill_labels defaults to [] (Q14 — contracts.py parity; old rows unchanged)", () => {
    expect(DraftProfileSchema.parse({}).skill_labels).toEqual([]);
  });
  it("round-trips worker-confirmed raw labels without touching the canonical ids", () => {
    const profile = DraftProfileSchema.parse({
      skills: ["skill_milling"],
      skill_labels: ["MIG welding", "TIG welding"],
    });
    expect(profile.skill_labels).toEqual(["MIG welding", "TIG welding"]);
    expect(profile.skills).toEqual(["skill_milling"]);
  });
});

describe("ResumeGenerationInputSchema (contracts.py parity — Q14/ADR-0030 OQ#3)", () => {
  it("an OLD payload without skill_labels still parses (additive contract change)", () => {
    const inp = ResumeGenerationInputSchema.parse({
      profile: { canonical_role_id: "role_vmc_operator", skills: ["skill_milling"] },
    });
    expect(inp.profile.skill_labels).toEqual([]);
    expect(inp.profile.skills).toEqual(["skill_milling"]);
  });
  it("the new skill_labels field is reachable through profile (the contract change)", () => {
    const inp = ResumeGenerationInputSchema.parse({
      profile: { skill_labels: ["MIG welding"] },
      worker_ref: "w-ref-1",
    });
    expect(inp.profile.skill_labels).toEqual(["MIG welding"]);
    expect(inp.worker_ref).toBe("w-ref-1");
  });
});

describe("ConversationStateSchema (contracts.py parity — COST-4 clarify bound)", () => {
  it("defaults clarify_count to 0 (additive => backward compatible for old states)", () => {
    const st = ConversationStateSchema.parse({});
    expect(st.clarify_count).toBe(0);
    expect(st.turn_count).toBe(0);
    expect(st.asked_question_ids).toEqual([]);
  });
  it("round-trips a bounded clarify_count without stripping sibling fields", () => {
    const st = ConversationStateSchema.parse({
      clarify_count: 2,
      turn_count: 3,
      asked_question_ids: ["role"],
      answered_topics: [],
    });
    expect(st.clarify_count).toBe(2);
    expect(st.asked_question_ids).toEqual(["role"]);
  });
  it("rejects a negative clarify_count (same int().nonnegative() convention as turn_count)", () => {
    expect(() => ConversationStateSchema.parse({ clarify_count: -1 })).toThrow();
  });
});

describe("AICallMetadataSchema (contracts.py parity)", () => {
  const minimal = {
    ai_call_id: "c1",
    task_type: "profile_extraction",
    model_name: "gemini-2.5-flash",
    provider: "google",
    real_call: false,
    created_at: "2026-07-10T00:00:00Z",
  };
  it("defaults the transport-diagnostics trio (attempt_count/candidates_tried/failure_reason)", () => {
    const meta = AICallMetadataSchema.parse(minimal);
    expect(meta.attempt_count).toBe(0);
    expect(meta.candidates_tried).toEqual([]);
    expect(meta.failure_reason).toBeNull();
  });
  it("round-trips a populated diagnostics set without stripping fields", () => {
    const meta = AICallMetadataSchema.parse({
      ...minimal,
      attempt_count: 6,
      candidates_tried: ["gemini-2.5-flash", "claude-haiku-4-5"],
      failure_reason: "no_text_content",
    });
    expect(meta.attempt_count).toBe(6);
    expect(meta.candidates_tried).toEqual(["gemini-2.5-flash", "claude-haiku-4-5"]);
    expect(meta.failure_reason).toBe("no_text_content");
  });
});

describe("WorkerProfileDraftSchema (contracts.py parity)", () => {
  it("defaults canonical_role_id to null and round-trips a set id", () => {
    expect(WorkerProfileDraftSchema.parse({}).canonical_role_id).toBeNull();
    expect(
      WorkerProfileDraftSchema.parse({ canonical_role_id: "vmc_operator" }).canonical_role_id,
    ).toBe("vmc_operator");
  });
});

describe("ProfileExtractionInputSchema", () => {
  it("accepts a transcript", () => {
    expect(ProfileExtractionInputSchema.safeParse({ transcript: "I run a VMC" }).success).toBe(true);
  });
  it("accepts messages", () => {
    expect(
      ProfileExtractionInputSchema.safeParse({
        messages: [{ role: "worker", text: "I run a VMC" }],
      }).success,
    ).toBe(true);
  });
  it("rejects when neither transcript nor messages provided", () => {
    expect(ProfileExtractionInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("ProfileExtractionOutputSchema", () => {
  it("validates a minimal extraction output", () => {
    const out = ProfileExtractionOutputSchema.parse({ profile: {} });
    expect(out.is_mock).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.profile.machines).toEqual([]);
  });
});

describe("TranscriptionInputSchema", () => {
  it("accepts a minimal request with a storage_path", () => {
    expect(TranscriptionInputSchema.safeParse({ storage_path: "w/s/v1.ogg" }).success).toBe(true);
  });
  it("rejects a missing or empty storage_path", () => {
    expect(TranscriptionInputSchema.safeParse({}).success).toBe(false);
    expect(TranscriptionInputSchema.safeParse({ storage_path: "" }).success).toBe(false);
  });
});

describe("TranscriptionOutputSchema", () => {
  it("fills defaults (mock, zero confidence, null language, empty english)", () => {
    const out = TranscriptionOutputSchema.parse({ transcript_text: "vmc operator" });
    expect(out.is_mock).toBe(true);
    expect(out.confidence).toBe(0);
    expect(out.language_code).toBeNull();
    expect(out.english_text).toBe("");
  });
  it("rejects confidence outside 0..1", () => {
    expect(
      TranscriptionOutputSchema.safeParse({ transcript_text: "x", confidence: 1.5 }).success,
    ).toBe(false);
  });
});

describe("SkillCanonicalizationSchema (contracts.py parity — ADR-0030/TAX-4)", () => {
  it("defaults an unresolved result to null skill_id + null score", () => {
    const out = SkillCanonicalizationSchema.parse({ status: "unresolved" });
    expect(out.skill_id).toBeNull();
    expect(out.score).toBeNull();
  });
  it("round-trips a matched result with an assigned id + score", () => {
    const out = SkillCanonicalizationSchema.parse({
      status: "matched",
      skill_id: "skill_vmc_operator",
      score: 0.91,
    });
    expect(out.status).toBe("matched");
    expect(out.skill_id).toBe("skill_vmc_operator");
    expect(out.score).toBeCloseTo(0.91);
  });
  it("rejects a status outside the closed set", () => {
    expect(SkillCanonicalizationSchema.safeParse({ status: "ranked" }).success).toBe(false);
  });
  it("input defaults lang to en", () => {
    const inp = SkillCanonicalizationInputSchema.parse({ phrase: "VMC operator", domain_id: "vmc-machining" });
    expect(inp.lang).toBe("en");
  });
});

describe("SkillAliasEmbed schemas (contracts.py parity — ADR-0030 fork-B seam)", () => {
  it("caps the batch at 200 items (matches Pydantic max_length)", () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ alias_id: `a${i}`, text: "milling" }));
    expect(SkillAliasEmbedInputSchema.safeParse({ items }).success).toBe(false);
    expect(SkillAliasEmbedInputSchema.safeParse({ items: items.slice(0, 200) }).success).toBe(true);
  });
  it("blocked result carries a null vector; defaults mirror Pydantic", () => {
    const out = SkillAliasEmbedOutputSchema.parse({
      results: [
        { alias_id: "ok", vector: [0.1, 0.2], blocked: false },
        { alias_id: "bad" }, // vector defaults null, blocked defaults false
      ],
      model: "mock-embedding",
    });
    expect(out.is_mock).toBe(true);
    // TD64 interim-guard fields default off/zero (mirror Pydantic).
    expect(out.budget_stopped).toBe(false);
    expect(out.errors).toBe(0);
    expect(out.estimated_cost_inr).toBe(0);
    const bad = out.results[1];
    expect(bad?.vector).toBeNull();
    expect(bad?.blocked).toBe(false);
  });
  it("round-trips a budget-stopped partial batch", () => {
    const out = SkillAliasEmbedOutputSchema.parse({
      results: [{ alias_id: "a1", vector: [0.1], blocked: false }],
      model: "text-embedding-004",
      is_mock: false,
      budget_stopped: true,
      errors: 2,
      estimated_cost_inr: 0.000038,
    });
    expect(out.budget_stopped).toBe(true);
    expect(out.errors).toBe(2);
    expect(out.estimated_cost_inr).toBeCloseTo(0.000038);
  });
});

describe("Growth cluster schemas (contracts.py parity — ADR-0030/TAX-7)", () => {
  const vec = (): number[] => new Array(768).fill(0);
  it("enforces the 768 house dim on phrase + anchor vectors", () => {
    expect(
      GrowthPhraseSchema.safeParse({ id: "p1", phrase: "x", count: 1, vector: [0.1, 0.2] })
        .success,
    ).toBe(false);
    expect(
      GrowthAnchorSchema.safeParse({ skill_id: "s", vector: vec() }).success,
    ).toBe(true);
  });
  it("rejects non-finite vector components (matches Pydantic isfinite — NaN AND Infinity)", () => {
    const v = vec();
    v[0] = Infinity;
    expect(GrowthAnchorSchema.safeParse({ skill_id: "s", vector: v }).success).toBe(false);
    v[0] = NaN;
    expect(GrowthAnchorSchema.safeParse({ skill_id: "s", vector: v }).success).toBe(false);
    v[0] = 0.5;
    expect(GrowthAnchorSchema.safeParse({ skill_id: "s", vector: v }).success).toBe(true);
  });
  it("caps phrases at 500 and anchors at 5000 (matches Pydantic max_length)", () => {
    const phrase = { id: "p", phrase: "x", count: 1, vector: vec() };
    const phrases = Array.from({ length: 501 }, (_, i) => ({ ...phrase, id: `p${i}` }));
    expect(
      GrowthClusterInputSchema.safeParse({ domain_id: "d", phrases, anchors: [] }).success,
    ).toBe(false);
    expect(
      GrowthClusterInputSchema.safeParse({
        domain_id: "d",
        phrases: phrases.slice(0, 500),
        anchors: [],
      }).success,
    ).toBe(true);
  });
  it("defaults all tuning params to null (service Settings decide)", () => {
    const inp = GrowthClusterInputSchema.parse({ domain_id: "d", phrases: [], anchors: [] });
    expect(inp.min_cluster_size).toBeNull();
    expect(inp.cluster_threshold).toBeNull();
    expect(inp.floor).toBeNull();
  });
  it("rejects a proposal kind outside the closed set (SG-3: never a rank/score kind)", () => {
    expect(
      GrowthProposalSchema.safeParse({
        kind: "auto_activate",
        leader_phrase: "x",
        member_ids: [],
        member_phrases: [],
        total_count: 1,
      }).success,
    ).toBe(false);
  });
  it("provisional proposal carries no skill_id (SG-5 — defaults null)", () => {
    const p = GrowthProposalSchema.parse({
      kind: "provisional_skill",
      leader_phrase: "unobtainium polishing",
      member_ids: ["p1"],
      member_phrases: ["unobtainium polishing"],
      total_count: 4,
    });
    expect(p.skill_id).toBeNull();
  });
  it("round-trips an alias proposal + report counters", () => {
    const out = GrowthClusterOutputSchema.parse({
      proposals: [
        {
          kind: "alias",
          skill_id: "skill_grinding_ops",
          leader_phrase: "ghisai jaisa kaam",
          member_ids: ["p1", "p2"],
          member_phrases: ["ghisai jaisa kaam", "ghisai type"],
          total_count: 5,
          nearest_skill_id: "skill_grinding_ops",
          nearest_score: 0.68,
        },
      ],
      phrases_in: 3,
      clusters_total: 2,
      clusters_eligible: 1,
      skipped_below_guards: 1,
    });
    expect(out.proposals[0]?.skill_id).toBe("skill_grinding_ops");
    expect(out.skipped_below_guards).toBe(1);
  });
});

describe("Retag plan schemas (contracts.py parity — ADR-0030/TAX-9)", () => {
  it("caps crosswalk at 1000, rows at 5000, ids-per-row at 100 (matches Pydantic)", () => {
    const entry = { deprecated_id: "d", replaced_by: "t" };
    expect(
      RetagPlanInputSchema.safeParse({
        crosswalk: Array.from({ length: 1001 }, () => entry),
        rows: [],
      }).success,
    ).toBe(false);
    expect(
      RetagRowSchema.safeParse({
        row_ref: "r",
        skill_ids: Array.from({ length: 101 }, (_, i) => `s${i}`),
      }).success,
    ).toBe(false);
    expect(RetagRowSchema.safeParse({ row_ref: "r", skill_ids: ["s1"] }).success).toBe(true);
  });
  it("round-trips a plan output (chain terminal + cycle drop + change)", () => {
    const out = RetagPlanOutputSchema.parse({
      resolved: [{ deprecated_id: "a", terminal_id: "c", hops: 2 }],
      dropped: ["x", "y"],
      changes: [{ row_ref: "r1", before: ["a", "k"], after: ["c", "k"] }],
      rows_in: 10,
      rows_changed: 1,
    });
    expect(out.resolved[0]?.terminal_id).toBe("c");
    expect(out.dropped).toEqual(["x", "y"]);
  });
  it("rejects zero-hop resolved entries (a terminal is never its own crosswalk key)", () => {
    expect(
      RetagResolvedEntrySchema.safeParse({ deprecated_id: "a", terminal_id: "a", hops: 0 })
        .success,
    ).toBe(false);
  });
});

describe("PseudonymizationOutputSchema", () => {
  it("only allows placeholder token labels (no raw values implied)", () => {
    const out = PseudonymizationOutputSchema.parse({
      pseudonymized_text: "[PERSON_1] runs a VMC",
      blocked: false,
      replaced_entities: 1,
      placeholder_tokens: ["[PERSON_1]"],
    });
    expect(out.placeholder_tokens).toContain("[PERSON_1]");
  });
});
