import { describe, it, expect } from "vitest";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import { hasExtractedContent, type ProfileContentFields } from "./profile-content";

/**
 * The #420 dedupe hinges on this predicate: a `completed` extraction job only
 * suppresses a retry when it actually produced something. Getting it wrong in the
 * permissive direction pins a session to an empty profile forever.
 */

/**
 * Persist a DraftProfile the way ProfileExtractionProcessor writes the columns.
 *
 * `richProfileDraft` mirrors `result.worker_profile_draft ?? null` — a SECOND
 * value from the extraction response, not derived from the DraftProfile, so it is
 * passed separately. It defaults to null: that is the AI-down fallback's value.
 */
function persisted(
  profile: ReturnType<typeof DraftProfileSchema.parse>,
  richProfileDraft: unknown = null,
): ProfileContentFields {
  return {
    canonicalTradeId: profile.canonical_trade_id,
    canonicalRoleId: profile.canonical_role_id,
    skills: profile.skills,
    machines: profile.machines,
    experience: profile.experience,
    salaryExpectation: profile.salary_expectation,
    locationPreference: profile.location_preference,
    availability: profile.availability,
    richProfileDraft,
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

/**
 * The MEDIUM-2 gap (PR #430 review): the legacy columns mirror `countFields`,
 * which counts only canonical/legacy columns. `skill_labels` and the rest of the
 * rich draft live inside the draft jsonb and are counted by nothing.
 *
 * So a REAL extraction that canonicalized nothing (TD94: a plain "CNC operator"
 * yields no canonical role) is byte-for-byte identical, across every legacy
 * column, to the AI-down fallback. Without a rich-draft leg the two are
 * indistinguishable — and calling BOTH "no content" means that worker's session
 * is never dedupe-eligible: a fresh ai_job, a fresh worker_profiles row and a
 * fresh AI call on every profile-preview mount, indefinitely.
 *
 * These two cases are the whole point of the leg, so they are asserted together:
 * separating them is the behaviour, not a side effect of it.
 */
describe("hasExtractedContent — content-poor REAL extraction vs the AI-down fallback", () => {
  /** Every legacy column at its schema default — shared by both cases below. */
  const legacyColumnsEmpty = DraftProfileSchema.parse({});

  /**
   * A real extraction of "I am a CNC operator" that the gazetteer could not
   * canonicalize: null ids, empty arrays — but the AI DID answer, so the rich
   * draft is non-null.
   */
  const contentPoorButReal = persisted(legacyColumnsEmpty, {
    skill_labels: ["cnc operator"],
    current_city: "pune",
  });

  /** The AI-down fallback: the same empty columns, and NO rich draft. */
  const aiDownFallback = persisted(legacyColumnsEmpty, null);

  it("the two cases are identical across every legacy column — only the rich draft separates them", () => {
    const { richProfileDraft: _a, ...poorLegacy } = contentPoorButReal;
    const { richProfileDraft: _b, ...fallbackLegacy } = aiDownFallback;
    expect(poorLegacy).toEqual(fallbackLegacy);
  });

  it("a content-poor but REAL extraction IS usable — it must dedupe (no unbounded spend loop)", () => {
    expect(hasExtractedContent(contentPoorButReal)).toBe(true);
  });

  it("the AI-down fallback is STILL not usable — it must never dedupe (the #430 HIGH stays closed)", () => {
    expect(hasExtractedContent(aiDownFallback)).toBe(false);
  });

  it("an empty-object rich draft still counts — the AI answered, it just had little to say", () => {
    expect(hasExtractedContent(persisted(legacyColumnsEmpty, {}))).toBe(true);
  });

  it("does not regress rows written before migration 0046, where the column is null", () => {
    // Null rich draft + real legacy content still dedupes on the legacy legs.
    expect(hasExtractedContent({ ...aiDownFallback, canonicalRoleId: "vmc_operator" })).toBe(true);
  });
});
