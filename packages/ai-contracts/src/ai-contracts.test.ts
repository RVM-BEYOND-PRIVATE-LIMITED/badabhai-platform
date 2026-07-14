import { describe, it, expect } from "vitest";
import {
  AICallMetadataSchema,
  DraftProfileSchema,
  ProfileExtractionInputSchema,
  ProfileExtractionOutputSchema,
  PseudonymizationOutputSchema,
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
