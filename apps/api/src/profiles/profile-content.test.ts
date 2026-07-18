import { describe, it, expect } from "vitest";
import { DraftProfileSchema, WorkerProfileDraftSchema } from "@badabhai/ai-contracts";
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
    expect(
      hasExtractedContent({ ...empty, locationPreference: { preferred_cities: "pune" } }),
    ).toBe(false);
  });
});

/**
 * The MEDIUM-2 gap (PR #430 review): the legacy columns mirror `countFields`,
 * which counts only canonical/legacy columns. The rich draft's skill labels and
 * the rest live inside the draft jsonb and are counted by nothing.
 *
 * So a REAL extraction that canonicalized nothing (TD94: a plain "CNC operator"
 * yields no canonical role) is byte-for-byte identical, across every legacy
 * column, to the AI-down fallback. Without a rich-draft leg the two are
 * indistinguishable — and calling BOTH "no content" means that worker's session
 * is never dedupe-eligible: a fresh ai_job, a fresh worker_profiles row and a
 * fresh AI call on every profile-preview mount, indefinitely.
 *
 * THREE cases have to stay apart, not two (PR #438 review). PR #438 wrote this
 * leg as `richProfileDraft != null`, which collapses the third into the first:
 * `/profile/extract` returns a draft UNCONDITIONALLY on its success path, so an
 * extraction run on an empty transcript also yields a non-null draft — one that
 * carries only `role_family`, "unknown" enums, `missing_fields` and
 * `clarification_questions`. Treating that as content pins the session forever
 * with no self-heal: the #430 HIGH again, through the AI-UP door.
 *
 * Fixtures go through `WorkerProfileDraftSchema` so they cannot drift from the
 * real shape — the earlier `{ skill_labels: [...] }` fixture named a field that
 * does not exist on the draft (it is `skills`), and passed only because the leg
 * was reading nullness.
 */
describe("hasExtractedContent — content-poor REAL extraction vs the AI-down fallback", () => {
  /** Every legacy column at its schema default — shared by every case below. */
  const legacyColumnsEmpty = DraftProfileSchema.parse({});

  /**
   * (a) A real extraction of "main CNC operator hoon" that the gazetteer could
   * not canonicalize: null ids, empty legacy arrays — but the AI DID extract a
   * skill label into the rich draft.
   */
  const contentPoorButReal = persisted(
    legacyColumnsEmpty,
    WorkerProfileDraftSchema.parse({ skills: ["machine operation"] }),
  );

  /**
   * (b) The AI was UP but the transcript said nothing ("hmm"). Every
   * content-bearing field is at its default; only the always-populated fields
   * carry anything.
   */
  const contentlessButAnswered = persisted(
    legacyColumnsEmpty,
    WorkerProfileDraftSchema.parse({
      role_family: "cnc_vmc",
      experience_level: "unknown",
      availability: "unknown",
      confidence_score: 0.3,
      missing_fields: ["primary_role", "experience_years", "current_city"],
      clarification_questions: ["Aap kaun si machine chalate hain?"],
    }),
  );

  /** (c) The AI-down fallback: the same empty columns, and NO rich draft. */
  const aiDownFallback = persisted(legacyColumnsEmpty, null);

  it("all three cases are identical across every legacy column — only the rich draft separates them", () => {
    const legacyOf = ({ richProfileDraft: _drop, ...legacy }: ProfileContentFields) => legacy;
    expect(legacyOf(contentPoorButReal)).toEqual(legacyOf(aiDownFallback));
    expect(legacyOf(contentlessButAnswered)).toEqual(legacyOf(aiDownFallback));
  });

  it("(a) a content-poor but REAL extraction IS usable — it must dedupe (no unbounded spend loop)", () => {
    expect(hasExtractedContent(contentPoorButReal)).toBe(true);
  });

  it("(b) a CONTENTLESS draft from a reachable AI is NOT usable — nullness alone must never dedupe", () => {
    // This is the #438 correction: the draft is non-null, so the old
    // `richProfileDraft != null` leg returned true here and pinned the session.
    expect(contentlessButAnswered.richProfileDraft).not.toBeNull();
    expect(hasExtractedContent(contentlessButAnswered)).toBe(false);
  });

  it("(c) the AI-down fallback is STILL not usable — it must never dedupe (the #430 HIGH stays closed)", () => {
    expect(hasExtractedContent(aiDownFallback)).toBe(false);
  });

  it("an empty-object rich draft is not content — the AI answered, but with nothing", () => {
    expect(hasExtractedContent(persisted(legacyColumnsEmpty, {}))).toBe(false);
  });

  it("does not regress rows written before migration 0046, where the column is null", () => {
    // Null rich draft + real legacy content still dedupes on the legacy legs.
    expect(hasExtractedContent({ ...aiDownFallback, canonicalRoleId: "vmc_operator" })).toBe(true);
  });
});

/**
 * Each content-bearing rich-draft field on its own, and — the part that matters —
 * each always-populated field on its own NOT counting. The second group is what
 * keeps the leg from decaying back into a reachability probe.
 */
describe("hasExtractedContent — which rich-draft fields count as content", () => {
  const legacyColumnsEmpty = DraftProfileSchema.parse({});
  const draft = (patch: Record<string, unknown>): ProfileContentFields =>
    persisted(legacyColumnsEmpty, WorkerProfileDraftSchema.parse(patch));

  it.each([
    ["skills", { skills: ["machine operation"] }],
    ["controllers", { controllers: ["fanuc"] }],
    ["primary_role", { primary_role: "VMC Operator" }],
    ["current_city", { current_city: "pune" }],
    ["education", { education: ["ITI Fitter"] }],
    ["certifications", { certifications: ["NSQF Level 4"] }],
  ])("%s alone is content", (_name, patch) => {
    expect(hasExtractedContent(draft(patch))).toBe(true);
  });

  it.each([
    ["role_family (always 'cnc_vmc')", { role_family: "cnc_vmc" }],
    ["experience_level 'unknown'", { experience_level: "unknown" }],
    ["availability 'unknown'", { availability: "unknown" }],
    ["confidence_score", { confidence_score: 0.9 }],
    ["missing_fields", { missing_fields: ["primary_role", "current_city"] }],
    ["clarification_questions", { clarification_questions: ["Kaun si machine?"] }],
    ["unmatchable_reason", { unmatchable_reason: "outside_cnc_vmc_scope" }],
  ])("%s alone is NOT content", (_name, patch) => {
    expect(hasExtractedContent(draft(patch))).toBe(false);
  });

  it("blank strings and blank-only arrays are not content", () => {
    expect(hasExtractedContent(draft({ primary_role: "   " }))).toBe(false);
    expect(hasExtractedContent(draft({ skills: ["", "  "] }))).toBe(false);
  });

  it("tolerates a malformed rich draft without throwing or counting it", () => {
    const empty = persisted(legacyColumnsEmpty, null);
    expect(hasExtractedContent({ ...empty, richProfileDraft: "nonsense" })).toBe(false);
    expect(hasExtractedContent({ ...empty, richProfileDraft: [1, 2, 3] })).toBe(false);
    expect(hasExtractedContent({ ...empty, richProfileDraft: 42 })).toBe(false);
    // Right field name, wrong shape — must not be mistaken for content.
    expect(hasExtractedContent({ ...empty, richProfileDraft: { skills: "welding" } })).toBe(false);
  });
});
