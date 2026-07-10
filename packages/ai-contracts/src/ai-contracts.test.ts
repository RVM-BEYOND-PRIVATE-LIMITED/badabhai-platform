import { describe, it, expect } from "vitest";
import {
  AICallMetadataSchema,
  DraftProfileSchema,
  ProfileExtractionInputSchema,
  ProfileExtractionOutputSchema,
  PseudonymizationOutputSchema,
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
