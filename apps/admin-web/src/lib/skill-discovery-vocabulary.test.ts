import { describe, it, expect } from "vitest";
import {
  ADMIN_SKILL_DECISION_CONFLICTS,
  ADMIN_SKILL_REVIEW_DECISIONS,
  ADMIN_SKILL_REVIEW_DECISION_LABELS,
  ADMIN_SKILL_REVIEW_REASON_MIN,
  ADMIN_SKILLS_QUERY_MIN,
  auditActionLabel,
  basisMarkerLabel,
  isTerminalSkillStatus,
  parseSkillDecisionConflict,
  phraseClassLabel,
  relationLabel,
  skillDecisionClientErrors,
  SKILL_AUDIT_CAP_NOTE,
  SKILL_AUDIT_MAX_ENTRIES,
  SKILL_CANDIDATE_STATUSES,
  SKILL_CANDIDATE_STATUS_LABELS,
  SKILL_CANDIDATE_TERMINAL_STATUSES,
  SKILL_DECISION_EFFECT_RECORDED_ONLY,
  SKILL_MATCH_RELATION_LABELS,
  SKILL_PHRASE_CLASS_LABELS,
  SKILL_PROVENANCE_RUN_NOTE,
  type SkillDecisionRequest,
} from "./skill-discovery-vocabulary";

describe("status ladder", () => {
  it("every status has a label", () => {
    for (const status of SKILL_CANDIDATE_STATUSES) {
      expect(SKILL_CANDIDATE_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("terminal statuses are exactly the four approved_*/rejected members", () => {
    expect([...SKILL_CANDIDATE_TERMINAL_STATUSES].sort()).toEqual(
      ["approved_create", "approved_map", "approved_merge", "rejected"].sort(),
    );
  });

  it("isTerminalSkillStatus is true only for the terminal four", () => {
    expect(isTerminalSkillStatus("approved_create")).toBe(true);
    expect(isTerminalSkillStatus("rejected")).toBe(true);
    expect(isTerminalSkillStatus("pending")).toBe(false);
    expect(isTerminalSkillStatus("needs_review")).toBe(false);
    // `deferred` is a human decision but NOT terminal — it is deliberately re-openable.
    expect(isTerminalSkillStatus("deferred")).toBe(false);
  });
});

describe("relation and phrase-class labels — never a raw code for a KNOWN value", () => {
  it("translates every known relation", () => {
    for (const [relation, label] of Object.entries(SKILL_MATCH_RELATION_LABELS)) {
      expect(relationLabel(relation)).toBe(label);
    }
  });

  it("falls back to the raw code for an unrecognised relation, never a guessed sentence", () => {
    expect(relationLabel("some_future_relation")).toContain("some_future_relation");
  });

  it("translates every known phrase class", () => {
    for (const [cls, label] of Object.entries(SKILL_PHRASE_CLASS_LABELS)) {
      expect(phraseClassLabel(cls)).toBe(label);
    }
  });

  it("falls back to the raw code for an unrecognised phrase class", () => {
    expect(phraseClassLabel("SOME_NEW_CLASS")).toContain("SOME_NEW_CLASS");
  });

  it("never mentions cosine, embedding or vector score wording beyond the sanctioned sentence", () => {
    // The one relation that IS allowed to say "vector_cosine" describes it in plain English —
    // this guards against a raw score or model name ever entering the label map.
    const all = Object.values(SKILL_MATCH_RELATION_LABELS).join(" ");
    expect(all).not.toMatch(/\b0\.\d+\b/); // no bare similarity-score-shaped number
    expect(all.toLowerCase()).not.toContain("embedding model");
  });
});

describe("every decision has a button label", () => {
  it("all five", () => {
    for (const decision of ADMIN_SKILL_REVIEW_DECISIONS) {
      expect(ADMIN_SKILL_REVIEW_DECISION_LABELS[decision]).toBeTruthy();
    }
  });
});

describe("skillDecisionClientErrors — the client-side gate, never the authority", () => {
  const base = {
    expected_status: "pending" as const,
  };

  it("flags a reason shorter than the floor", () => {
    const req: SkillDecisionRequest = { ...base, decision: "reject", review_reason: "too short" };
    expect(skillDecisionClientErrors(req).some((e) => e.includes("12 characters"))).toBe(true);
  });

  it("a reason at exactly the floor passes", () => {
    const req: SkillDecisionRequest = {
      ...base,
      decision: "reject",
      review_reason: "x".repeat(ADMIN_SKILL_REVIEW_REASON_MIN),
    };
    expect(skillDecisionClientErrors(req)).toEqual([]);
  });

  it("whitespace does not buy the minimum — trimmed before the length check", () => {
    const req: SkillDecisionRequest = {
      ...base,
      decision: "hold",
      review_reason: "   " + "x".repeat(ADMIN_SKILL_REVIEW_REASON_MIN - 1) + "   ",
    };
    expect(skillDecisionClientErrors(req).length).toBeGreaterThan(0);
  });

  it("create with zero job domains is blocked with a plain-English reason", () => {
    const req: SkillDecisionRequest = {
      ...base,
      decision: "create",
      review_reason: "a real reviewer reason here",
      proposed_skill_name: "Arc Welding",
      approved_job_domain_ids: [],
      approved_requirement: "preferred",
    };
    const errors = skillDecisionClientErrors(req);
    expect(errors.some((e) => e.toLowerCase().includes("trade"))).toBe(true);
  });

  it("create with at least one job domain and a name passes", () => {
    const req: SkillDecisionRequest = {
      ...base,
      decision: "create",
      review_reason: "a real reviewer reason here",
      proposed_skill_name: "Arc Welding",
      approved_job_domain_ids: ["jd_nco_7212_0100"],
      approved_requirement: "preferred",
    };
    expect(skillDecisionClientErrors(req)).toEqual([]);
  });

  it("alias/merge without a target skill id is blocked", () => {
    const req: SkillDecisionRequest = {
      ...base,
      decision: "alias",
      review_reason: "a real reviewer reason here",
      resulting_skill_id: "",
    };
    expect(skillDecisionClientErrors(req).length).toBeGreaterThan(0);
  });
});

describe("parseSkillDecisionConflict — narrows an unknown 409 body, never guesses", () => {
  it("recognises a well-formed conflict body", () => {
    const info = parseSkillDecisionConflict({
      message: "conflict",
      candidate_id: "c-1",
      conflict: "stale_expected_status",
      current_status: "approved_create",
      expected_status: "pending",
    });
    expect(info).toEqual({
      conflict: "stale_expected_status",
      current_status: "approved_create",
      expected_status: "pending",
    });
  });

  it("every real conflict code round-trips", () => {
    for (const conflict of ADMIN_SKILL_DECISION_CONFLICTS) {
      const info = parseSkillDecisionConflict({
        conflict,
        current_status: "rejected",
        expected_status: "pending",
      });
      expect(info?.conflict).toBe(conflict);
    }
  });

  it("returns null for a body with an unrecognised conflict code", () => {
    expect(
      parseSkillDecisionConflict({
        conflict: "some_future_conflict",
        current_status: "pending",
        expected_status: "pending",
      }),
    ).toBeNull();
  });

  it("returns null for null, undefined, an array, or a body missing a field", () => {
    expect(parseSkillDecisionConflict(null)).toBeNull();
    expect(parseSkillDecisionConflict(undefined)).toBeNull();
    expect(parseSkillDecisionConflict([])).toBeNull();
    expect(parseSkillDecisionConflict({ conflict: "already_decided" })).toBeNull();
  });

  it("returns null when a status field holds a value not in the ladder", () => {
    expect(
      parseSkillDecisionConflict({
        conflict: "already_decided",
        current_status: "not_a_real_status",
        expected_status: "pending",
      }),
    ).toBeNull();
  });
});

describe("auditActionLabel — the decision-history action codes (#1280)", () => {
  it("translates every real skill_candidate_* action code", () => {
    expect(auditActionLabel("skill_candidate_approved_create")).toBe(
      "Approved — create new skill",
    );
    expect(auditActionLabel("skill_candidate_approved_map")).toBe("Approved — add as alias");
    expect(auditActionLabel("skill_candidate_approved_merge")).toBe(
      "Approved — merge into skill",
    );
    expect(auditActionLabel("skill_candidate_rejected")).toBe("Rejected");
    expect(auditActionLabel("skill_candidate_deferred")).toBe("Held");
  });

  it("falls back to the raw code for an unrecognised action, never a guessed sentence", () => {
    expect(auditActionLabel("skill_candidate_some_future_code")).toBe(
      "skill_candidate_some_future_code",
    );
  });
});

describe("the MAP/MERGE picker's search bound (#1280)", () => {
  it("mirrors the server's two-character floor", () => {
    expect(ADMIN_SKILLS_QUERY_MIN).toBe(2);
  });
});

describe("basisMarkerLabel — the in-band markers, rendered not paraphrased (#1280, correction 3)", () => {
  it("translates each of the three markers the read routes carry", () => {
    expect(basisMarkerLabel("groups_are_derived_not_stored")).toContain(
      "worked out fresh on every read",
    );
    expect(basisMarkerLabel("review_tier_is_derived_not_stored")).toContain(
      "not a stored column",
    );
    expect(basisMarkerLabel("decision_recorded_no_corpus_write")).toContain(
      "does not change the taxonomy",
    );
  });

  it("falls back to the raw marker, never a guessed sentence", () => {
    // These markers exist so the surface cannot paraphrase what the server said about its own
    // answer. Inventing a sentence for an unknown one would defeat the whole device.
    expect(basisMarkerLabel("some_marker_added_later")).toBe("some_marker_added_later");
  });

  it("keys the corpus-effect entry off the mirrored literal, not a copy of the string", () => {
    // If the server ever renames the literal, the mirror moves with it and this label follows —
    // rather than silently degrading to the raw-code fallback on a decided candidate.
    expect(basisMarkerLabel(SKILL_DECISION_EFFECT_RECORDED_ONLY)).not.toBe(
      SKILL_DECISION_EFFECT_RECORDED_ONLY,
    );
  });
});

describe("the audit read's silent cap (#1280, correction 6)", () => {
  it("mirrors the route's own LIMIT", () => {
    expect(SKILL_AUDIT_MAX_ENTRIES).toBe(200);
  });

  it("the note names the number and refuses to claim completeness", () => {
    expect(SKILL_AUDIT_CAP_NOTE).toContain("200");
    expect(SKILL_AUDIT_CAP_NOTE).toContain("cannot be treated as the complete history");
    // The response has no truncation flag, so the note must not imply the console detected a cut.
    expect(SKILL_AUDIT_CAP_NOTE).toContain("no marker for whether anything was left out");
  });
});

describe("the provenance run note (#1280, correction 5)", () => {
  it("says what the model and prompt version are NOT, in the reviewer's own terms", () => {
    expect(SKILL_PROVENANCE_RUN_NOTE).toContain("measures how good a match anything is");
    expect(SKILL_PROVENANCE_RUN_NOTE).toContain("nothing here is a reason to approve or reject");
  });

  it("never teaches the vocabulary the surface exists to spare a reviewer", () => {
    expect(SKILL_PROVENANCE_RUN_NOTE.toLowerCase()).not.toMatch(/cosine|vector|embedding/);
  });
});
