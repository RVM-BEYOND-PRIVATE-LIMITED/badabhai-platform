import { describe, it, expect } from "vitest";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import { hasExtractedContent, type ProfileContentFields } from "./profile-content";

/**
 * The #420 dedupe hinges on this predicate: a `completed` extraction job only
 * suppresses a retry when it actually produced something. Getting it wrong in the
 * permissive direction pins a session to an empty profile forever.
 */

/** Persist a DraftProfile the way ProfileExtractionProcessor writes the columns. */
function persisted(profile: ReturnType<typeof DraftProfileSchema.parse>): ProfileContentFields {
  return {
    canonicalTradeId: profile.canonical_trade_id,
    canonicalRoleId: profile.canonical_role_id,
    skills: profile.skills,
    machines: profile.machines,
    experience: profile.experience,
    salaryExpectation: profile.salary_expectation,
    locationPreference: profile.location_preference,
    availability: profile.availability,
  };
}

describe("hasExtractedContent — the AI-down fallback profile", () => {
  it("is FALSE for the exact fallback AiService.extractProfile returns (DraftProfileSchema.parse({}))", () => {
    // This is the whole point: the fallback is every field at its schema default,
    // so it can never satisfy any leg of the predicate. Structural, not a threshold.
    expect(hasExtractedContent(persisted(DraftProfileSchema.parse({})))).toBe(false);
  });

  it("is FALSE for a missing profile (LEFT JOIN miss / no row)", () => {
    expect(hasExtractedContent(null)).toBe(false);
    expect(hasExtractedContent(undefined)).toBe(false);
  });
});

describe("hasExtractedContent — each field counts on its own", () => {
  const empty = persisted(DraftProfileSchema.parse({}));

  it("canonical_role_id alone is content", () => {
    expect(hasExtractedContent({ ...empty, canonicalRoleId: "vmc_operator" })).toBe(true);
  });

  it("canonical_trade_id alone is content", () => {
    expect(hasExtractedContent({ ...empty, canonicalTradeId: "cnc" })).toBe(true);
  });

  it("a skill alone is content", () => {
    expect(hasExtractedContent({ ...empty, skills: ["vmc_operation"] })).toBe(true);
  });

  it("a machine alone is content", () => {
    expect(hasExtractedContent({ ...empty, machines: ["haas_vf2"] })).toBe(true);
  });

  it("experience.total_years alone is content", () => {
    expect(hasExtractedContent({ ...empty, experience: { total_years: 4 } })).toBe(true);
    expect(hasExtractedContent({ ...empty, experience: { total_years: 0 } })).toBe(true);
  });

  it("either salary bound alone is content", () => {
    expect(hasExtractedContent({ ...empty, salaryExpectation: { amount_min: 20000 } })).toBe(true);
    expect(hasExtractedContent({ ...empty, salaryExpectation: { amount_max: 30000 } })).toBe(true);
  });

  it("a preferred city alone is content", () => {
    expect(
      hasExtractedContent({ ...empty, locationPreference: { preferred_cities: ["pune"] } }),
    ).toBe(true);
  });

  it("a known availability status is content, but 'unknown' is not", () => {
    expect(hasExtractedContent({ ...empty, availability: { status: "immediate" } })).toBe(true);
    expect(hasExtractedContent({ ...empty, availability: { status: "unknown" } })).toBe(false);
  });
});

describe("hasExtractedContent — malformed jsonb never throws", () => {
  const empty = persisted(DraftProfileSchema.parse({}));

  it("tolerates null / scalar / array jsonb without treating it as content", () => {
    expect(hasExtractedContent({ ...empty, experience: null })).toBe(false);
    expect(hasExtractedContent({ ...empty, salaryExpectation: "nonsense" })).toBe(false);
    expect(hasExtractedContent({ ...empty, locationPreference: [1, 2, 3] })).toBe(false);
    expect(hasExtractedContent({ ...empty, availability: 42 })).toBe(false);
  });

  it("does not treat a non-array preferred_cities as content", () => {
    expect(hasExtractedContent({ ...empty, locationPreference: { preferred_cities: "pune" } })).toBe(
      false,
    );
  });
});
