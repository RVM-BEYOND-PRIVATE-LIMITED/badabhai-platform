import { describe, it, expect } from "vitest";
import openingKeys from "./__fixtures__/profiling-opening.keys.json";
import jobPostingChatKeys from "./__fixtures__/job-posting-chat.keys.json";
import profilingKeys from "./__fixtures__/profiling.keys.json";
import oieKeys from "./__fixtures__/oie.keys.json";
import aiCallMetadataKeys from "./__fixtures__/ai-call-metadata.keys.json";
import companionKeys from "./__fixtures__/companion.keys.json";
import freeChatKeys from "./__fixtures__/free-chat.keys.json";
import {
  COMPANION_V2_EDIT_OPS,
  COMPANION_V2_EDIT_SECTIONS,
  COMPANION_V2_INTENTS,
  COMPANION_V2_UNSUPPORTED_EDIT_TARGETS,
  FREE_CHAT_CATEGORIES,
  FREE_CHAT_REFUSAL_TOPICS,
  FREE_CHAT_REPLY_CATEGORIES,
  FREE_CHAT_REPLY_LANGUAGES,
} from "@badabhai/types";
import {
  FreeChatAnswerSchema,
  FreeChatClassifyInputSchema,
  FreeChatClassifyOutputSchema,
  FreeChatRefuseSchema,
  FreeChatReplyInputSchema,
  FreeChatReplyOutputSchema,
  FreeChatSummarizeInputSchema,
  FreeChatSummarizeOutputSchema,
  FreeChatNewsInputSchema,
  FreeChatNewsSourceSchema,
  FreeChatNewsAnswerSchema,
  FreeChatNewsNoResultsSchema,
  FreeChatNewsRefuseSchema,
  FreeChatNewsOutputSchema,
  FreeChatReplyLanguageSchema,
} from "./free-chat";
import {
  CompanionCareerAnswerSchema,
  CompanionCareerInputSchema,
  CompanionCareerRefuseSchema,
  CompanionCareerWorkerContextSchema,
  CompanionClassifyInputSchema,
  CompanionClassifyOutputSchema,
  CompanionEditParseInputSchema,
  CompanionEditParseOutputSchema,
  CompanionEditRowSchema,
  CompanionEditSnapshotRowSchema,
  CompanionRecentTurnSchema,
  EditableFieldSchema,
} from "./companion";
import {
  AnswerRecordHistoryEntrySchema,
  AnswerRecordSchema,
  EvidenceSpanSchema,
  OccupationPinSchema,
  ParsedFieldSchema,
  ExperienceEntrySchema,
  LlmInterviewDraftSchema,
  LLM_INTERVIEW_MODES,
  LlmTurnInputSchema,
  LlmTurnOutputSchema,
  InterviewExtractInputSchema,
  InterviewExtractOutputSchema,
  WorkHistoryPolishInputSchema,
  WorkHistoryPolishOutputSchema,
  PredicateOperandSchema,
  PredicateObjectShapeForParity,
  PredicateSchema,
  ProfileParseInputSchema,
  ProfileParseOutputSchema,
  QuestionPackItemSchema,
  QuestionPackOptionSchema,
  QuestionPackSchema,
  TargetFieldSchema,
  TranscriptLineSchema,
} from "./oie";
import {
  AICallMetadataSchema,
  ConversationMessageSchema,
  ConversationStateSchema,
  DraftProfileSchema,
  JobDomainMatchSchema,
  JOB_DOMAIN_MATCH_STATUSES,
  ProfilingTurnInputSchema,
  ProfilingTurnOutputSchema,
  JobPostingChatOpeningInputSchema,
  JobPostingChatOpeningOutputSchema,
  JobPostingChatStateSchema,
  JobPostingChatTurnInputSchema,
  JobPostingChatTurnOutputSchema,
  JobPostingDraftSchema,
  ProfileExtractionInputSchema,
  ProfilingOpeningInputSchema,
  ProfilingOpeningOutputSchema,
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
  AvailabilitySchema,
  WorkerProfileDraftSchema,
} from "./index";
import {
  ResumeParseInputSchema,
  ResumeParseOutputSchema,
  TradeAssociationSchema,
} from "./resume-import";

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
  it("issue #423: current_city is its own field, defaulting to null (contracts.py parity)", () => {
    // Additive + defaulted, so a payload written before the split still parses and
    // simply reports no current city — which is exactly why every consumer keeps a
    // `?? preferred_cities[0]` fallback rather than switching outright.
    expect(DraftProfileSchema.parse({}).location_preference.current_city).toBeNull();
  });
  it("issue #423: a current city is NOT emitted as a preferred location", () => {
    // The defect: `_build_legacy` prepended the current city to preferred_cities, so
    // "I live in Pune" was recorded as "I want to work in Pune". The two are now
    // independent — setting one must never populate the other.
    const loc = DraftProfileSchema.parse({
      location_preference: { current_city: "pune" },
    }).location_preference;
    expect(loc.current_city).toBe("pune");
    expect(loc.preferred_cities).toEqual([]);
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

describe("ConversationStateSchema (contracts.py parity — INTERVIEW-1 ask_counts)", () => {
  it("defaults ask_counts to {} so LEGACY states without the field still load", () => {
    // Backward compat (CLAUDE.md §2 #8): a state minted before INTERVIEW-1 carries
    // asked_question_ids but no ask_counts — it must parse, not throw.
    const st = ConversationStateSchema.parse({
      role_family: "cnc_vmc",
      turn_count: 4,
      answered_topics: ["role"],
      asked_question_ids: ["role", "machines"],
      collected: { role: "VMC Operator" },
    });
    expect(st.ask_counts).toEqual({});
    expect(st.unanswered_essentials).toEqual([]);
    expect(st.asked_question_ids).toEqual(["role", "machines"]);
  });
  it("defaults unanswered_essentials to [] and round-trips the declared gaps", () => {
    // The completeness signal: extraction_ready keeps its frozen v1 meaning ("the
    // interview is over, run extraction"), so THIS is what declares an incomplete
    // profile — a role: null resume becomes a known outcome, not a surprise.
    expect(ConversationStateSchema.parse({}).unanswered_essentials).toEqual([]);
    const st = ConversationStateSchema.parse({
      answered_topics: ["role", "experience"],
      unanswered_essentials: ["machines", "current_location"],
    });
    expect(st.unanswered_essentials).toEqual(["machines", "current_location"]);
  });
  it("rejects a non-string-array unanswered_essentials", () => {
    expect(() => ConversationStateSchema.parse({ unanswered_essentials: "machines" })).toThrow();
    expect(() => ConversationStateSchema.parse({ unanswered_essentials: [1] })).toThrow();
  });
  it("round-trips per-topic ask counts at the bound", () => {
    const st = ConversationStateSchema.parse({
      ask_counts: { role: 1, machines: 2 },
      clarify_count: 1,
    });
    expect(st.ask_counts).toEqual({ role: 1, machines: 2 });
    expect(st.clarify_count).toBe(1);
  });
  it("rejects a negative / non-integer ask count (same convention as clarify_count)", () => {
    expect(() => ConversationStateSchema.parse({ ask_counts: { role: -1 } })).toThrow();
    expect(() => ConversationStateSchema.parse({ ask_counts: { role: 1.5 } })).toThrow();
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

  /**
   * THE TEXT PAIR — the field group whose absence was a live privacy defect.
   *
   * `apps/ai-service` populated `prompt_text`/`response_text` with post-pseudonymization text,
   * and this schema had no such fields. A bare `z.object` STRIPS unknown keys, silently, so the
   * masked text was produced, sent over the wire and discarded at `AiService`'s
   * `schema.parse(await res.json())` — after which the trace writer fell back to the API-side
   * request object, i.e. the worker's raw name, phone number and address, into `prompt_enc`.
   *
   * Every suite in both languages was green. That is the failure this block exists to make
   * impossible: it asserts the fields SURVIVE A PARSE, which is the property that was actually
   * broken — not that they appear in the type, which they would have done either way.
   */
  it("carries the masked prompt/response pair THROUGH a parse — the fields are not stripped", () => {
    const meta = AICallMetadataSchema.parse({
      ...minimal,
      prompt_text: "mera naam [PERSON_1] hai, number [PHONE_1], main VMC operator hu, Pune se",
      response_text: "the model's answer",
    });
    expect(meta.prompt_text).toContain("[PERSON_1]");
    expect(meta.response_text).toBe("the model's answer");
  });

  it("defaults both to null, so an older ai-service does not 500 every AI call", () => {
    // Additive and defaulted, exactly like the diagnostics trio above. A deploy in which the api
    // leads the ai-service, and every surface that does not route through `AIRouter` (embeddings,
    // STT, translate), sends neither field.
    const meta = AICallMetadataSchema.parse(minimal);
    expect(meta.prompt_text).toBeNull();
    expect(meta.response_text).toBeNull();
  });

  it("matches contracts.py key-for-key, against the fixture the python suite reads too", () => {
    // Neither CI job compares the two languages. This file and
    // `apps/ai-service/tests/test_contract_parity.py` assert against the SAME json, so a field
    // added on one side only turns the other side red.
    expect(Object.keys(AICallMetadataSchema.shape).sort()).toEqual(
      [...aiCallMetadataKeys.AICallMetadata].sort(),
    );
    // ...and the text pair is named separately in the fixture, because it is the half with a
    // privacy contract attached (`TRACE_TEXT_FIELDS` excludes exactly these from the ai-service's
    // span metadata and its cost log). A third text field must update both lists.
    for (const field of aiCallMetadataKeys._text_fields) {
      expect(Object.keys(AICallMetadataSchema.shape)).toContain(field);
    }
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
    expect(ProfileExtractionInputSchema.safeParse({ transcript: "I run a VMC" }).success).toBe(
      true,
    );
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
  it("accepts an optional opaque worker_ref (D-2 spend attribution) and rejects an empty one", () => {
    // contracts.py parity: TranscriptionInput.worker_ref (str | None = None).
    expect(
      TranscriptionInputSchema.safeParse({ storage_path: "w/s/v1.m4a", worker_ref: "w-1" }).success,
    ).toBe(true);
    expect(
      TranscriptionInputSchema.safeParse({ storage_path: "w/s/v1.m4a", worker_ref: "" }).success,
    ).toBe(false);
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
    const inp = SkillCanonicalizationInputSchema.parse({
      phrase: "VMC operator",
      domain_id: "vmc-machining",
    });
    expect(inp.lang).toBe("en");
  });

  // ── Phase 1.5 canonicalizer cutover: two domain id spaces, exactly one per call ──
  it("input accepts the LEGACY domain_id alone (every pre-cutover caller is unchanged)", () => {
    const inp = SkillCanonicalizationInputSchema.parse({
      phrase: "VMC operator",
      domain_id: "cnc-machining",
      lang: "en",
    });
    expect(inp.domain_id).toBe("cnc-machining");
    expect(inp.job_domain_id).toBeUndefined();
  });

  it("input accepts the CANONICAL job_domain_id alone", () => {
    const inp = SkillCanonicalizationInputSchema.parse({
      phrase: "kharad",
      job_domain_id: "jd_nco_7223_0100",
      lang: "hi",
    });
    expect(inp.job_domain_id).toBe("jd_nco_7223_0100");
    expect(inp.domain_id).toBeUndefined();
  });

  it("input rejects NEITHER domain — an unscoped skill search is never the fallback", () => {
    // The rule with real consequences: without a domain the vector layer would return the
    // nearest alias in ANY trade at a plausible score. There is no safe default, so the
    // contract refuses the call rather than degrading it.
    const res = SkillCanonicalizationInputSchema.safeParse({ phrase: "kharad", lang: "hi" });
    expect(res.success).toBe(false);
    expect(res.success === false && JSON.stringify(res.error.issues)).toContain(
      "exactly one of domain_id",
    );
  });

  it("input rejects BOTH domains — the slug space and the jd_* space are disjoint", () => {
    const res = SkillCanonicalizationInputSchema.safeParse({
      phrase: "kharad",
      domain_id: "cnc-machining",
      job_domain_id: "jd_nco_7223_0100",
      lang: "hi",
    });
    expect(res.success).toBe(false);
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
      GrowthPhraseSchema.safeParse({ id: "p1", phrase: "x", count: 1, vector: [0.1, 0.2] }).success,
    ).toBe(false);
    expect(GrowthAnchorSchema.safeParse({ skill_id: "s", vector: vec() }).success).toBe(true);
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
      RetagResolvedEntrySchema.safeParse({ deprecated_id: "a", terminal_id: "a", hops: 0 }).success,
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

describe("ProfilingOpening contract parity", () => {
  // Asserted against a JSON fixture that the PYTHON suite asserts against too
  // (tests/test_contract_parity.py). Neither side can add or rename a field
  // without the other going red. Without this, both suites stay green when only
  // one side changes: Pydantic silently drops unknown request keys, and CI runs
  // the node and ai-service jobs independently.
  it("input keys match the golden fixture shared with Pydantic", () => {
    expect(Object.keys(ProfilingOpeningInputSchema.shape).sort()).toEqual(
      [...openingKeys.ProfilingOpeningInput].sort(),
    );
  });

  it("output keys match the golden fixture shared with Pydantic", () => {
    expect(Object.keys(ProfilingOpeningOutputSchema.shape).sort()).toEqual(
      [...openingKeys.ProfilingOpeningOutput].sort(),
    );
  });

  it("output requires opening_text — an empty body must not parse", () => {
    expect(ProfilingOpeningOutputSchema.safeParse({}).success).toBe(false);
    expect(ProfilingOpeningOutputSchema.safeParse({ opening_text: "hi" }).success).toBe(true);
  });
});

describe("Job-posting chat contract parity (ADR-0035 — contracts.py mirror)", () => {
  // Asserted against a JSON fixture the PYTHON suite asserts against too
  // (apps/ai-service/tests/test_contract_parity.py). Neither side can add, rename or
  // remove a field without the other going red.
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["JobPostingChatState", JobPostingChatStateSchema.shape],
    ["JobPostingDraft", JobPostingDraftSchema.shape],
    ["JobPostingChatOpeningInput", JobPostingChatOpeningInputSchema.shape],
    ["JobPostingChatOpeningOutput", JobPostingChatOpeningOutputSchema.shape],
    ["JobPostingChatTurnInput", JobPostingChatTurnInputSchema.shape],
    ["JobPostingChatTurnOutput", JobPostingChatTurnOutputSchema.shape],
  ];
  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    // `_why` is prose documentation in the fixture, so the record is not uniformly
    // string[] — narrow the one entry we read.
    const golden = (jobPostingChatKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the draft carries NO org_label — the payer's org name is never asked (§Decision 3)", () => {
    // The rule is structural, not stylistic: the org name is already on
    // `payers.orgNameEnc` and is stamped server-side at publish. A field here would
    // mean asking for it in free text, which both duplicates data we hold and
    // invites a payer to type personal contact details next to it.
    const banned = ["org_label", "org_name", "company", "company_name", "employer_name"];
    for (const field of banned) {
      expect(Object.keys(JobPostingDraftSchema.shape)).not.toContain(field);
    }
  });

  it("an empty draft parses to the all-empty defaults", () => {
    const draft = JobPostingDraftSchema.parse({});
    expect(draft.role_title).toBeNull();
    expect(draft.vacancy_band).toBeNull();
    expect(draft.skills).toEqual([]);
    expect(draft.confidence).toBe(0);
    expect(draft.missing_fields).toEqual([]);
    // #1726 — the card fields default to null ("never answered"), never a guessed value.
    expect(draft.city).toBeNull();
    expect(draft.pay_type).toBeNull();
    expect(draft.min_experience_years).toBeNull();
    expect(draft.max_experience_years).toBeNull();
    expect(draft.needed_by).toBeNull();
  });

  it("pay_type and needed_by accept only their closed vocabularies (#1726)", () => {
    for (const payType of ["in_hand", "gross", "ctc"]) {
      expect(JobPostingDraftSchema.safeParse({ pay_type: payType }).success).toBe(true);
    }
    expect(JobPostingDraftSchema.safeParse({ pay_type: "net" }).success).toBe(false);
    for (const neededBy of ["immediate", "soon", "flexible"]) {
      expect(JobPostingDraftSchema.safeParse({ needed_by: neededBy }).success).toBe(true);
    }
    expect(JobPostingDraftSchema.safeParse({ needed_by: "urgent" }).success).toBe(false);
  });

  it("caps city at 80 chars and the experience window at whole years 0..60 (#1726)", () => {
    expect(JobPostingDraftSchema.safeParse({ city: "x".repeat(80) }).success).toBe(true);
    expect(JobPostingDraftSchema.safeParse({ city: "x".repeat(81) }).success).toBe(false);
    for (const key of ["min_experience_years", "max_experience_years"]) {
      expect(JobPostingDraftSchema.safeParse({ [key]: 0 }).success).toBe(true);
      expect(JobPostingDraftSchema.safeParse({ [key]: 60 }).success).toBe(true);
      expect(JobPostingDraftSchema.safeParse({ [key]: 61 }).success).toBe(false);
      expect(JobPostingDraftSchema.safeParse({ [key]: -1 }).success).toBe(false);
      expect(JobPostingDraftSchema.safeParse({ [key]: 2.5 }).success).toBe(false);
    }
  });

  it("vacancy_band accepts ONLY the five shipped bands (ADR-0012 — never an integer)", () => {
    for (const band of ["1", "2-5", "6-10", "11-25", "25+"]) {
      expect(JobPostingDraftSchema.safeParse({ vacancy_band: band }).success).toBe(true);
    }
    expect(JobPostingDraftSchema.safeParse({ vacancy_band: "7" }).success).toBe(false);
    expect(JobPostingDraftSchema.safeParse({ vacancy_band: 7 }).success).toBe(false);
  });

  it("caps skills at 10 phrases of 80 chars (matches the publish DTO's skillsInput)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `skill ${i}`);
    expect(JobPostingDraftSchema.safeParse({ skills: ten }).success).toBe(true);
    expect(JobPostingDraftSchema.safeParse({ skills: [...ten, "one more"] }).success).toBe(false);
    expect(JobPostingDraftSchema.safeParse({ skills: ["x".repeat(81)] }).success).toBe(false);
  });

  it("shift accepts only the closed jobs.shift enum", () => {
    expect(JobPostingDraftSchema.safeParse({ shift: "rotational" }).success).toBe(true);
    expect(JobPostingDraftSchema.safeParse({ shift: "evening" }).success).toBe(false);
  });

  it("state defaults mirror Pydantic and reject a non-slug topic id", () => {
    const st = JobPostingChatStateSchema.parse({});
    expect(st.trade_hint).toBeNull();
    expect(st.ask_counts).toEqual({});
    expect(st.unanswered_essentials).toEqual([]);
    expect(JobPostingChatStateSchema.safeParse({ answered_topics: ["Role Title"] }).success).toBe(
      false,
    );
    expect(JobPostingChatStateSchema.safeParse({ ask_counts: { role_title: -1 } }).success).toBe(
      false,
    );
  });

  it("turn input requires session_id + message_text and has NO history field (COST-3)", () => {
    expect(JobPostingChatTurnInputSchema.safeParse({ message_text: "welder" }).success).toBe(false);
    expect(
      JobPostingChatTurnInputSchema.safeParse({ session_id: "s1", message_text: "welder" }).success,
    ).toBe(true);
    expect(Object.keys(JobPostingChatTurnInputSchema.shape)).not.toContain("history");
  });

  it("a blocked turn output carries a null draft and a null state", () => {
    const out = JobPostingChatTurnOutputSchema.parse({
      reply_text: "…",
      blocked: true,
      blocked_reason: "residual numeric sequence detected",
    });
    expect(out.draft).toBeNull();
    expect(out.updated_state).toBeNull();
    expect(out.draft_ready).toBe(false);
    expect(out.is_mock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generalized profiling — Zod <-> Pydantic parity, asserted against a golden file
// that apps/ai-service/tests/test_contract_parity.py reads too.
// ---------------------------------------------------------------------------

describe("Generalized profiling contract parity (contracts.py mirror)", () => {
  // WHY A SHARED FILE AND NOT TWO LISTS. CI runs the node job and the ai-service job
  // independently and neither compares the two, so a field added on ONE side only
  // passes both suites — Pydantic IGNORES unknown request keys and a Zod object STRIPS
  // unknown response keys, and neither says a word.
  //
  // Measured during this refactor: `captured` (the Resume Field Set the entire
  // LLM-driven interview accumulates) existed only in Pydantic, so
  // `ProfilingTurnOutputSchema.parse` silently discarded every answer the model
  // collected on the way back into the API. No error, no failing test, just an
  // interview that re-asks the same seven questions until the turn cap fires. These
  // assertions are what turn that into a red build.
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["ConversationMessage", ConversationMessageSchema.shape],
    ["ConversationState", ConversationStateSchema.shape],
    ["ProfilingTurnInput", ProfilingTurnInputSchema.shape],
    ["ProfilingTurnOutput", ProfilingTurnOutputSchema.shape],
    // `.innerType()` because ProfileExtractionInputSchema carries a `.refine`
    // ("transcript OR a non-empty messages array"), which wraps the object in a
    // ZodEffects whose `.shape` is undefined. Reaching through it keeps the refinement
    // — the thing that makes an empty extraction request invalid — rather than
    // deleting it to make the shape reachable.
    ["ProfileExtractionInput", ProfileExtractionInputSchema.innerType().shape],
    ["ProfileExtractionOutput", ProfileExtractionOutputSchema.shape],
    ["JobDomainMatch", JobDomainMatchSchema.shape],
  ];

  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    // Keys starting `_` are prose documentation in the fixture, so the record is not
    // uniformly string[] — narrow the one entry we read.
    const golden = (profilingKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the fixture declares no contract the TypeScript side lacks", () => {
    // The mirror of the Python suite's equivalent check. Together they mean a contract
    // can only be added to the fixture if BOTH sides define it.
    const declared = Object.keys(profilingKeys).filter((k) => !k.startsWith("_"));
    expect(declared.sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it("ConversationState carries the seven OIE fields the Phase 0 freeze requires", () => {
    // Belt to the fixture's braces: the fixture proves TS and Python agree, but both
    // could agree on the OLD shape. This pins the seven fields BY NAME, because their
    // absence is precisely the Phase 0 gap that shipped once already — the PR that
    // "froze" the contract froze it without them, and every suite stayed green.
    const keys = Object.keys(ConversationStateSchema.shape);
    for (const field of [
      "phase",
      "occupation",
      "answer_map",
      "engine_asks",
      "pack_id",
      "pack_version",
      "catalog_version",
    ]) {
      expect(keys, `ConversationState is missing ${field}`).toContain(field);
    }
    // All seven are defaulted, so a state persisted before this change still parses —
    // invariant #8 for sessions mid-flight at deploy time.
    const parsed = ConversationStateSchema.parse({});
    expect(parsed.phase).toBe("identify");
    expect(parsed.occupation).toBeNull();
    expect(parsed.answer_map).toEqual([]);
    expect(parsed.engine_asks).toBe(0);
    expect(parsed.pack_id).toBeNull();
    expect(parsed.pack_version).toBeNull();
    expect(parsed.catalog_version).toBeNull();
  });

  it("the RFS `captured` map survives a round trip through the output schema", () => {
    // The specific regression above, pinned by behaviour rather than by key list: a
    // stripped field would leave `captured` as `{}` here while every other assertion
    // stayed green.
    const parsed = ProfilingTurnOutputSchema.parse({
      reply_text: "Achha. Kitni salary chahiye?",
      updated_state: {
        role_family: "cnc_vmc",
        turn_count: 3,
        captured: { trade: "VMC operator", experience_years: "5 saal" },
        completion_reason: null,
      },
    });
    expect(parsed.updated_state?.captured).toEqual({
      trade: "VMC operator",
      experience_years: "5 saal",
    });
  });

  it("an older state with no `captured` still parses — additive, backward compatible", () => {
    // A session mid-flight at deploy time carries the pre-refactor JSONB shape. It must
    // degrade to an empty RFS, not throw and strand the worker.
    const parsed = ConversationStateSchema.parse({ role_family: "cnc_vmc", turn_count: 2 });
    expect(parsed.captured).toEqual({});
    expect(parsed.completion_reason).toBeNull();
  });

  it("the profiling contracts carry NO identity PII field, by construction", () => {
    // Mechanical, so the rule survives an edit that does not read the comment. There is
    // nowhere in this contract to put a name, phone, address or employer — which is why
    // `captured` cannot hold one even if a worker volunteers it (§2 #2).
    const banned = ["worker_name", "name", "phone", "phone_number", "address", "employer"];
    for (const [contractName, shape] of shapes) {
      for (const field of banned) {
        expect(Object.keys(shape), `${contractName} must not carry ${field}`).not.toContain(field);
      }
    }
  });

  it("JobDomainMatch statuses are exactly the DB CHECK vocabulary", () => {
    // These five strings are also the `job_domain_match_status` CHECK on
    // `worker_profiles` (packages/db/src/schema/worker.ts). A sixth added here without the
    // migration would be rejected at write time, at the end of a long async pipeline,
    // one worker at a time.
    expect([...JOB_DOMAIN_MATCH_STATUSES].sort()).toEqual([
      "matched_auto",
      "matched_llm",
      "unmatched_below_floor",
      "unmatched_degraded",
      "unmatched_llm_declined",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Occupation Intelligence Engine — Zod <-> Pydantic parity, asserted against
// oie.keys.json, which apps/ai-service/tests/test_contract_parity.py reads too.
// ---------------------------------------------------------------------------

describe("OIE contract parity (contracts.py mirror)", () => {
  // Same mechanism, same reasoning, as the profiling block above: neither CI job
  // compares the two languages, so a field that exists on one side only passes both
  // suites while data is silently dropped in flight. And this surface has ALREADY
  // shipped incomplete once — the Phase 0 "contract freeze" merged without these
  // schemas existing at all, and every suite stayed green. This fixture is what makes
  // that impossible to repeat quietly.
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["EvidenceSpan", EvidenceSpanSchema.shape],
    ["AnswerRecordHistoryEntry", AnswerRecordHistoryEntrySchema.shape],
    ["AnswerRecord", AnswerRecordSchema.shape],
    ["OccupationPin", OccupationPinSchema.shape],
    // `.innerType()` because the operand carries an exactly-one-of refinement.
    ["PredicateOperand", PredicateOperandSchema.innerType().shape],
    // `z.lazy` has no `.shape`, so the Predicate key list is asserted via a parallel
    // shape object; the test below proves the two cannot drift apart.
    ["Predicate", PredicateObjectShapeForParity.shape],
    ["QuestionPackOption", QuestionPackOptionSchema.shape],
    ["QuestionPackItem", QuestionPackItemSchema.shape],
    ["QuestionPack", QuestionPackSchema.shape],
    ["TranscriptLine", TranscriptLineSchema.shape],
    ["TargetField", TargetFieldSchema.shape],
    ["ProfileParseInput", ProfileParseInputSchema.shape],
    ["ParsedField", ParsedFieldSchema.shape],
    ["ProfileParseOutput", ProfileParseOutputSchema.shape],
    // Phase A (LLM-led interview) + Phase C (whole-chat extraction).
    ["ExperienceEntry", ExperienceEntrySchema.shape],
    ["LlmInterviewDraft", LlmInterviewDraftSchema.shape],
    ["LlmTurnInput", LlmTurnInputSchema.shape],
    ["LlmTurnOutput", LlmTurnOutputSchema.shape],
    ["InterviewExtractInput", InterviewExtractInputSchema.shape],
    ["InterviewExtractOutput", InterviewExtractOutputSchema.shape],
    // Work-history polish (#1350). The one field the model is allowed to COMPOSE, by owner
    // ruling overriding section 8 — so its parity matters more than most, not less: a field
    // dropped in flight here means a sheet silently printing the raw text while the audit
    // trail says it was polished.
    ["WorkHistoryPolishInput", WorkHistoryPolishInputSchema.shape],
    ["WorkHistoryPolishOutput", WorkHistoryPolishOutputSchema.shape],
  ];

  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    const golden = (oieKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the fixture declares no contract the TypeScript side lacks", () => {
    const declared = Object.keys(oieKeys).filter((k) => !k.startsWith("_"));
    expect(declared.sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it("the parity shape object cannot drift from the real PredicateSchema", () => {
    // The one seam in the mechanism: Predicate's keys are asserted via a parallel
    // object because z.lazy has no .shape. Prove the real schema ACCEPTS a predicate
    // exercising every declared key, and REJECTS one carrying a key the parity shape
    // does not declare — so the two definitions cannot diverge silently.
    const usesEveryKey = {
      op: "all",
      predicates: [
        { op: "not", predicate: { op: "answered", field: "trade" } },
        { op: "declined", field: "salary_expected" },
        { op: "eq", left: { field: "experience_years" }, right: { const: 5 } },
        { op: "occupation_is", job_domain_id: "jd_nco_7212_0100" },
        { op: "occupation_under", isco_code: "72" },
        { op: "phase_is", phase: "occupation_specific" },
        { op: "turn_gte", turn: 3 },
      ],
    };
    expect(PredicateSchema.safeParse(usesEveryKey).success).toBe(true);

    const undeclaredKey = { op: "turn_gte", turn: 3, clock: "now" };
    // Zod objects STRIP unknown keys rather than reject, so assert on the parsed
    // result: the undeclared key must not survive.
    const parsed = PredicateSchema.safeParse(undeclaredKey);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "clock" in (parsed.data as object)).toBe(false);
  });

  it("per-op arity is enforced: a predicate cannot carry another op's operands", () => {
    // The evaluator is ~120 lines of pure code that trusts its input shape; this
    // refinement is what lets it. Wrong-operand predicates must fail at the contract,
    // not at evaluation time inside a live interview.
    expect(PredicateSchema.safeParse({ op: "all" }).success).toBe(false);
    expect(PredicateSchema.safeParse({ op: "answered" }).success).toBe(false);
    expect(PredicateSchema.safeParse({ op: "answered", field: "trade", turn: 3 }).success).toBe(
      false,
    );
    expect(PredicateSchema.safeParse({ op: "eq", left: { field: "x" } }).success).toBe(false);
    expect(
      PredicateSchema.safeParse({ op: "eq", left: { field: "x", const: 1 }, right: { const: 1 } })
        .success,
    ).toBe(false);
  });

  it("ParsedField requires evidence — the provenance gate's contract half", () => {
    // A value with no span is a hallucination by definition. Making `evidence`
    // non-nullable here means such a value cannot even be REPRESENTED, which is a
    // stronger guarantee than rejecting it downstream.
    expect(
      ParsedFieldSchema.safeParse({
        value: "15000",
        source: "answer_map",
        normalization: "numeric",
        confidence: 0.9,
      }).success,
    ).toBe(false);
    expect(
      ParsedFieldSchema.safeParse({
        value: 15000,
        evidence: { message_index: 4, quote: "pandrah hazaar" },
        source: "answer_map",
        normalization: "numeric",
        confidence: 0.9,
      }).success,
    ).toBe(true);
  });

  it("ProfileParseInput defaults are a valid, empty request", () => {
    const parsed = ProfileParseInputSchema.parse({ worker_ref: "w_abc123" });
    expect(parsed.schema_version).toBe("oie.v1");
    expect(parsed.occupation).toBeNull();
    expect(parsed.answer_map).toEqual([]);
    expect(parsed.transcript).toEqual([]);
  });
});

describe("availability — the model's vocabulary vs the canonical enum (production defect 2026-08-21)", () => {
  /**
   * `interview_prompts.py` asks the model for `"immediate" | "15_days" | "1_month" | "unknown"`.
   * This schema accepted `immediate | notice_period | not_looking | unknown`. The two contracts
   * disagreed on two of five values BY CONSTRUCTION, and the validator was the only layer that
   * had not been taught both — the resume text builder and the PDF renderer already had.
   *
   * Measured on production: 53 `profile.extraction_failed`, of which 48 were exactly this
   * (26 x `15_days`, 22 x `1_month`). Each one discarded a WHOLE extraction — role, skills,
   * experience, salary, city — over one optional field the prompt itself asked for.
   */
  it("accepts the notice-period tokens the prompt asks for, as notice_period", () => {
    expect(WorkerProfileDraftSchema.parse({ availability: "15_days" }).availability).toBe(
      "notice_period",
    );
    expect(WorkerProfileDraftSchema.parse({ availability: "1_month" }).availability).toBe(
      "notice_period",
    );
  });

  it("still accepts every canonical value unchanged", () => {
    for (const v of ["immediate", "notice_period", "not_looking", "unknown"] as const) {
      expect(WorkerProfileDraftSchema.parse({ availability: v }).availability).toBe(v);
    }
  });

  it("DOES NOT DISCARD THE REST OF THE PROFILE over one unrecognised token", () => {
    // This is the whole point. Before the fix this parse THREW and the worker got no profile
    // and no resume; the 21% of extractions that died did so with everything else intact.
    const parsed = WorkerProfileDraftSchema.parse({
      availability: "whenever_you_like",
      canonical_role_id: "vmc_operator",
      current_city: "Pune",
      expected_salary: 25000,
    });
    expect(parsed.availability).toBe("unknown");
    expect(parsed.canonical_role_id).toBe("vmc_operator");
    expect(parsed.current_city).toBe("Pune");
    expect(parsed.expected_salary).toBe(25000);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(WorkerProfileDraftSchema.parse({ availability: "  15_DAYS " }).availability).toBe(
      "notice_period",
    );
  });

  it("leaves absent/null to the existing default rather than the normaliser", () => {
    expect(WorkerProfileDraftSchema.parse({}).availability).toBe("unknown");
  });

  it("AvailabilitySchema.status normalises identically — one rule, both sites", () => {
    // The two used to be independent copies of the same enum literal, which is how one of them
    // ended up taught and the other not.
    expect(AvailabilitySchema.parse({ status: "1_month" }).status).toBe("notice_period");
    expect(AvailabilitySchema.parse({ status: "immediate" }).status).toBe("immediate");
    // The day count is where the granularity lives, and it is untouched.
    expect(
      AvailabilitySchema.parse({ status: "15_days", notice_period_days: 15 }).notice_period_days,
    ).toBe(15);
  });
});

describe("ResumeParse trade association (Task 1 B2 — contracts.py parity)", () => {
  it("trade_kinds defaults to [] — old callers send nothing and nothing is classified", () => {
    const input = ResumeParseInputSchema.parse({
      worker_ref: "wr_1",
      storage_key: "resume-uploads/w/x.pdf",
      mime: "application/pdf",
    });
    expect(input.trade_kinds).toEqual([]);
  });

  it("trade_association defaults to null — degraded/older far sides judge nothing", () => {
    expect(ResumeParseOutputSchema.parse({}).trade_association).toBeNull();
  });

  it("kind stays an open string here — the second wall narrows it, not the contract", () => {
    // Mirrors extraction_method's posture exactly: transport, not decision.
    expect(TradeAssociationSchema.parse({ kind: "cnc_turner" }).kind).toBe("cnc_turner");
    expect(TradeAssociationSchema.parse({}).kind).toBeNull();
    expect(TradeAssociationSchema.parse({ kind: null }).kind).toBeNull();
  });
});

describe("LlmTurnInput.interview_mode (ADR-0045)", () => {
  it("is ABSENT when not sent, so a classic request body is byte-identical to today's", () => {
    const parsed = LlmTurnInputSchema.parse({ worker_ref: "w1" });
    expect(Object.prototype.hasOwnProperty.call(parsed, "interview_mode")).toBe(false);
  });

  it("accepts exactly the two modes, and neither the stage word nor an invented one", () => {
    for (const mode of LLM_INTERVIEW_MODES) {
      expect(
        LlmTurnInputSchema.parse({ worker_ref: "w1", interview_mode: mode }).interview_mode,
      ).toBe(mode);
    }
    // `skills` is a STAGE value; the mode is `skills_only` so a trace never confuses the two.
    for (const bad of ["skills", "general", ""]) {
      expect(() => LlmTurnInputSchema.parse({ worker_ref: "w1", interview_mode: bad })).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Chat companion v2 — Zod <-> Pydantic parity (ADR-0046 Phase 1), against the
// golden fixture apps/ai-service/tests/test_contract_parity.py reads too.
// ---------------------------------------------------------------------------

describe("Companion v2 contract parity (contracts.py mirror)", () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["CompanionRecentTurn", CompanionRecentTurnSchema.shape],
    ["EditableField", EditableFieldSchema.shape],
    ["CompanionEditSnapshotRow", CompanionEditSnapshotRowSchema.shape],
    ["CompanionEditRow", CompanionEditRowSchema.shape],
    ["CompanionClassifyInput", CompanionClassifyInputSchema.shape],
    ["CompanionClassifyOutput", CompanionClassifyOutputSchema.shape],
    ["CompanionEditParseInput", CompanionEditParseInputSchema.shape],
    ["CompanionEditParseOutput", CompanionEditParseOutputSchema.shape],
    // ADR-0046 P3 — career talk (the union's two members; the union itself is not a `.shape`).
    ["CompanionCareerWorkerContext", CompanionCareerWorkerContextSchema.shape],
    ["CompanionCareerInput", CompanionCareerInputSchema.shape],
    ["CompanionCareerAnswer", CompanionCareerAnswerSchema.shape],
    ["CompanionCareerRefuse", CompanionCareerRefuseSchema.shape],
  ];

  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    const golden = (companionKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the fixture declares no contract the TypeScript side lacks", () => {
    const declared = Object.keys(companionKeys).filter((k) => !k.startsWith("_"));
    expect(declared.sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it("the closed sets come from @badabhai/types, not a private copy", () => {
    // The same source the API's catalogue and the event spine read — one list, three
    // consumers. A private literal here is how the classifier could start naming an intent
    // the event schema refuses, or a section the catalogue cannot write.
    expect(EditableFieldSchema.shape.section.options).toEqual([...COMPANION_V2_EDIT_SECTIONS]);
    expect(EditableFieldSchema.shape.ops.element.options).toEqual([...COMPANION_V2_EDIT_OPS]);
    expect(CompanionClassifyOutputSchema.shape.intent.options).toEqual([...COMPANION_V2_INTENTS]);
    // `.default([])` wraps the array, so the members are asserted through a PARSE (which is
    // also the behaviour that matters: what the schema actually accepts).
    expect(
      CompanionEditParseOutputSchema.parse({ unsupported: [...COMPANION_V2_UNSUPPORTED_EDIT_TARGETS] })
        .unsupported,
    ).toEqual([...COMPANION_V2_UNSUPPORTED_EDIT_TARGETS]);
    expect(() => CompanionEditParseOutputSchema.parse({ unsupported: ["phone"] })).toThrow();
    // Non-vacuous: the fixtures/source actually carry members.
    expect(EditableFieldSchema.shape.section.options.length).toBeGreaterThanOrEqual(6);
  });

  it("carries NO identity-capable field, by construction", () => {
    // These contracts carry free text (the message, a proposed value) that is pseudonymized
    // before the model — but there is nowhere to put a name, a phone or an ID number.
    const banned = ["worker_id", "worker_ref", "worker_name", "name", "phone", "address"];
    for (const [contractName, shape] of shapes) {
      for (const field of banned) {
        expect(Object.keys(shape), `${contractName} must not declare ${field}`).not.toContain(field);
      }
    }
  });

  it("caps the classify text, the memory turns and the message text", () => {
    const turn = { role: "worker", text: "kuch" };
    expect(CompanionClassifyInputSchema.parse({ text: "x".repeat(1000) }).text).toHaveLength(1000);
    expect(() => CompanionClassifyInputSchema.parse({ text: "x".repeat(1001) })).toThrow();
    expect(
      CompanionClassifyInputSchema.parse({ text: "hi", recent_turns: [turn, turn] }).recent_turns,
    ).toHaveLength(2);
    expect(() =>
      CompanionClassifyInputSchema.parse({ text: "hi", recent_turns: [turn, turn, turn] }),
    ).toThrow();
    // The edit-parse text cap is the companion message DTO's own bound, so a message the API
    // accepted can never be refused by this contract.
    const base = { catalogue: [], snapshot: [], max_rows: 3 };
    expect(CompanionEditParseInputSchema.parse({ ...base, text: "x".repeat(4000) }).text).toHaveLength(
      4000,
    );
    expect(() => CompanionEditParseInputSchema.parse({ ...base, text: "x".repeat(4001) })).toThrow();
  });

  it("bounds max_rows and confidence", () => {
    const base = { text: "kuch", catalogue: [], snapshot: [] };
    expect(CompanionEditParseInputSchema.parse({ ...base, max_rows: 1 }).max_rows).toBe(1);
    expect(() => CompanionEditParseInputSchema.parse({ ...base, max_rows: 0 })).toThrow();
    expect(() => CompanionEditParseInputSchema.parse({ ...base, max_rows: 11 })).toThrow();

    expect(CompanionClassifyOutputSchema.parse({ intent: "unclear", confidence: 0.6 }).confidence).toBe(
      0.6,
    );
    for (const confidence of [-0.1, 1.1]) {
      expect(() =>
        CompanionClassifyOutputSchema.parse({ intent: "unclear", confidence }),
      ).toThrow();
    }
  });

  it("keeps the edit row SHAPE permissive — per-op requirements are the API's validation", () => {
    // The model may return a malformed row; the API drops it deterministically (catalogue,
    // op, ref, DTO, token, no-op) instead of treating a null ref as a transport failure.
    // `blocked` defaults false, so an older far side that omits it still parses.
    expect(CompanionClassifyOutputSchema.parse({ intent: "faltu", confidence: 0.9 }).blocked).toBe(
      false,
    );
    const row = CompanionEditRowSchema.parse({
      op: "add",
      section: "skills",
      ref: null,
      field: "skill",
      value: "welding",
    });
    expect(row).toEqual({ op: "add", section: "skills", ref: null, field: "skill", value: "welding" });
    // ref/field/value may be OMITTED (they default to null, mirroring the Pydantic defaults),
    // which is what lets the API drop a malformed row rather than fail the transport — but op
    // and section are the row's identity and stay required.
    expect(CompanionEditRowSchema.parse({ op: "delete", section: "languages" })).toEqual({
      op: "delete",
      section: "languages",
      ref: null,
      field: null,
      value: null,
    });
    expect(() => CompanionEditRowSchema.parse({ section: "skills" })).toThrow();
    expect(
      CompanionEditParseOutputSchema.parse({
        rows: [{ op: "add", section: "skills" }],
        unsupported: ["identity"],
      }).unsupported,
    ).toEqual(["identity"]);
  });
});

// ---------------------------------------------------------------------------
// The profiling-stage free chat — Zod <-> Pydantic parity (ADR-0051, #2027), against the
// golden fixture apps/ai-service/tests/test_contract_parity.py reads too.
// ---------------------------------------------------------------------------

describe("Free chat contract parity (contracts.py mirror)", () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["FreeChatClassifyInput", FreeChatClassifyInputSchema.shape],
    ["FreeChatClassifyOutput", FreeChatClassifyOutputSchema.shape],
    ["FreeChatReplyInput", FreeChatReplyInputSchema.shape],
    // The reply union's two members; the union itself is not a `.shape`.
    ["FreeChatAnswer", FreeChatAnswerSchema.shape],
    ["FreeChatRefuse", FreeChatRefuseSchema.shape],
    // Release 2 — the rolling summary.
    ["FreeChatSummarizeInput", FreeChatSummarizeInputSchema.shape],
    ["FreeChatSummarizeOutput", FreeChatSummarizeOutputSchema.shape],
    // ADR-0054 — live news: the input, one source, and the three members of the output union.
    ["FreeChatNewsInput", FreeChatNewsInputSchema.shape],
    ["FreeChatNewsSource", FreeChatNewsSourceSchema.shape],
    ["FreeChatNewsAnswer", FreeChatNewsAnswerSchema.shape],
    ["FreeChatNewsNoResults", FreeChatNewsNoResultsSchema.shape],
    ["FreeChatNewsRefuse", FreeChatNewsRefuseSchema.shape],
  ];

  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    const golden = (freeChatKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the fixture declares no contract the TypeScript side lacks", () => {
    const declared = Object.keys(freeChatKeys).filter((k) => !k.startsWith("_"));
    expect(declared.sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it("the closed sets come from @badabhai/types, not a private copy", () => {
    expect(FreeChatClassifyOutputSchema.shape.category.options).toEqual([...FREE_CHAT_CATEGORIES]);
    expect(FreeChatReplyInputSchema.shape.category.options).toEqual([...FREE_CHAT_REPLY_CATEGORIES]);
    expect(FreeChatRefuseSchema.shape.topic.options).toEqual([...FREE_CHAT_REFUSAL_TOPICS]);
    // Non-vacuous: eight categories, two of them model-written.
    expect(FREE_CHAT_CATEGORIES).toHaveLength(8);
    expect(FREE_CHAT_REPLY_CATEGORIES).toEqual(["casual", "career"]);
    // ADR-0051 §11 — the reply languages, one list for the field and the API's detector.
    expect(FreeChatReplyLanguageSchema.options).toEqual([...FREE_CHAT_REPLY_LANGUAGES]);
  });

  it("carries NO identity-capable field, by construction", () => {
    const banned = ["worker_id", "worker_ref", "worker_name", "name", "phone", "address", "city"];
    // THE ONE CARVE-OUT (ADR-0054 security review, H2): the news input's OPAQUE spend ref, so a
    // paid, searched call is charged to the per-worker daily cap. Opaque like the parse's and the
    // transcription's; it never reaches the model. Every other contract stays clean.
    const allowed: Record<string, string[]> = { FreeChatNewsInput: ["worker_ref"] };
    for (const [contractName, shape] of shapes) {
      for (const field of banned) {
        if (allowed[contractName]?.includes(field)) continue;
        expect(Object.keys(shape), `${contractName} must not declare ${field}`).not.toContain(field);
      }
    }
  });

  it("ADR-0054 H2: the news input's worker_ref is an optional, nullable, non-empty spend ref", () => {
    expect(FreeChatNewsInputSchema.parse({ text: "aaj ka mausam" }).worker_ref).toBeNull();
    expect(FreeChatNewsInputSchema.parse({ text: "x", worker_ref: null }).worker_ref).toBeNull();
    expect(FreeChatNewsInputSchema.parse({ text: "x", worker_ref: "w-ref-1" }).worker_ref).toBe("w-ref-1");
    expect(FreeChatNewsInputSchema.safeParse({ text: "x", worker_ref: "" }).success).toBe(false);
    // The carve-out is the news input's alone.
    expect(Object.keys(FreeChatReplyInputSchema.shape)).not.toContain("worker_ref");
  });

  it("caps the classify text, the turns and the pending question", () => {
    const turn = { role: "worker", text: "kuch" };
    const base = { mode: "free" };
    expect(FreeChatClassifyInputSchema.parse({ ...base, text: "x".repeat(1000) }).text).toHaveLength(1000);
    expect(() => FreeChatClassifyInputSchema.parse({ ...base, text: "x".repeat(1001) })).toThrow();
    expect(() =>
      FreeChatClassifyInputSchema.parse({ ...base, text: "hi", recent_turns: [turn, turn, turn] }),
    ).toThrow();
    expect(
      FreeChatClassifyInputSchema.parse({ mode: "resume", text: "5 saal", pending_question: "q".repeat(500) })
        .pending_question,
    ).toHaveLength(500);
    expect(() =>
      FreeChatClassifyInputSchema.parse({ mode: "resume", text: "5 saal", pending_question: "q".repeat(501) }),
    ).toThrow();
    const replyBase = { category: "casual", text: "kaise ho" };
    expect(
      FreeChatReplyInputSchema.parse({ ...replyBase, recent_turns: Array(6).fill(turn) }).recent_turns,
    ).toHaveLength(6);
    expect(() =>
      FreeChatReplyInputSchema.parse({ ...replyBase, recent_turns: Array(7).fill(turn) }),
    ).toThrow();
  });

  it("classifies only in free or résumé mode — the greeting is read deterministically", () => {
    expect(FreeChatClassifyInputSchema.parse({ text: "hi", mode: "free" }).pending_question).toBeNull();
    expect(() => FreeChatClassifyInputSchema.parse({ text: "hi", mode: "greeting" })).toThrow();
  });

  it("writes replies only for casual and career; every other category is fixed copy", () => {
    for (const category of ["jobs", "trash", "off_limits", "distress", "resume", "unclear"]) {
      expect(() => FreeChatReplyInputSchema.parse({ category, text: "kuch" }), category).toThrow();
    }
  });

  it("defaults blocked/ai_metadata so an older far side still parses, and bounds confidence", () => {
    const out = FreeChatClassifyOutputSchema.parse({ category: "casual", confidence: 0.8 });
    expect(out.blocked).toBe(false);
    expect(out.ai_metadata).toBeNull();
    for (const confidence of [-0.1, 1.1]) {
      expect(() => FreeChatClassifyOutputSchema.parse({ category: "casual", confidence })).toThrow();
    }
  });

  it("the reply is a closed union: an answer of 1-4 lines, or one refusal topic", () => {
    expect(FreeChatAnswerSchema.parse({ status: "answer", lines: ["Theek hai."] }).followup_chips).toEqual(
      [],
    );
    expect(FreeChatReplyOutputSchema.parse({ status: "answer", lines: ["Theek hai."] }).status).toBe(
      "answer",
    );
    expect(() => FreeChatReplyOutputSchema.parse({ status: "answer", lines: [] })).toThrow();
    expect(() =>
      FreeChatReplyOutputSchema.parse({ status: "answer", lines: ["a", "b", "c", "d", "e"] }),
    ).toThrow();
    expect(FreeChatReplyOutputSchema.parse({ status: "refuse", topic: "news" }).status).toBe("refuse");
    expect(() => FreeChatReplyOutputSchema.parse({ status: "refuse", topic: "salary_promise" })).toThrow();
  });

  it("Release 2: the reply carries an optional summary, defaulted so an older caller still parses", () => {
    expect(FreeChatReplyInputSchema.parse({ category: "casual", text: "kaise ho" }).summary).toBeNull();
    expect(
      FreeChatReplyInputSchema.parse({ category: "casual", text: "kaise ho", summary: "s".repeat(1200) })
        .summary,
    ).toHaveLength(1200);
    expect(() =>
      FreeChatReplyInputSchema.parse({ category: "casual", text: "kaise ho", summary: "s".repeat(1201) }),
    ).toThrow();
  });

  it("Release 2: the summarize call folds 1-24 turns into an optional previous summary", () => {
    const turn = { role: "worker", text: "aaj thak gaya" };
    expect(FreeChatSummarizeInputSchema.parse({ turns: [turn] }).previous_summary).toBeNull();
    expect(() => FreeChatSummarizeInputSchema.parse({ turns: [] })).toThrow();
    expect(FreeChatSummarizeInputSchema.parse({ turns: Array(24).fill(turn) }).turns).toHaveLength(24);
    expect(() => FreeChatSummarizeInputSchema.parse({ turns: Array(25).fill(turn) })).toThrow();
    expect(() =>
      FreeChatSummarizeInputSchema.parse({ turns: [turn], previous_summary: "p".repeat(1201) }),
    ).toThrow();
  });

  it("Release 2: the summary output is nullable and loose — the API judges length, not the transport", () => {
    const empty = FreeChatSummarizeOutputSchema.parse({});
    expect(empty.summary).toBeNull();
    expect(empty.ai_metadata).toBeNull();
    expect(FreeChatSummarizeOutputSchema.parse({ summary: "x".repeat(2000) }).summary).toHaveLength(2000);
    expect(() => FreeChatSummarizeOutputSchema.parse({ summary: "x".repeat(2001) })).toThrow();
  });

  it("ADR-0054: a news answer carries 1-4 lines, a kind and 1-3 sources", () => {
    const source = { url: "https://www.thehindu.com/a", title: "Headline", site: "thehindu.com" };
    const answer = { status: "answer", kind: "work", lines: ["Ek line"], sources: [source], search_count: 1 };
    const parsed = FreeChatNewsOutputSchema.parse(answer);
    expect(parsed.status).toBe("answer");
    expect(FreeChatNewsAnswerSchema.parse(answer).ai_metadata).toBeNull();
    expect(() => FreeChatNewsAnswerSchema.parse({ ...answer, sources: [] })).toThrow();
    expect(() => FreeChatNewsAnswerSchema.parse({ ...answer, sources: Array(4).fill(source) })).toThrow();
    expect(() => FreeChatNewsAnswerSchema.parse({ ...answer, lines: Array(5).fill("l") })).toThrow();
    expect(() => FreeChatNewsAnswerSchema.parse({ ...answer, kind: "politics" })).toThrow();
    expect(() => FreeChatNewsAnswerSchema.parse({ ...answer, search_count: 4 })).toThrow();
  });

  it("ADR-0054: no_results and refuse are the other two news outcomes the model can return", () => {
    expect(FreeChatNewsOutputSchema.parse({ status: "no_results", search_count: 2 }).status).toBe("no_results");
    expect(FreeChatNewsOutputSchema.parse({ status: "refuse", topic: "off_limits" }).status).toBe("refuse");
    expect(() => FreeChatNewsOutputSchema.parse({ status: "refuse", topic: "gossip" })).toThrow();
    expect(FreeChatNewsInputSchema.parse({ text: "aaj ka mausam" }).recent_turns).toEqual([]);
  });

  describe("ADR-0051 §11: the reply and the news input carry an optional reply_language", () => {
    const inputs = [
      ["FreeChatReplyInput", FreeChatReplyInputSchema, { category: "casual", text: "kaise ho" }],
      ["FreeChatNewsInput", FreeChatNewsInputSchema, { text: "aaj ka mausam" }],
    ] as const;

    it.each(inputs)("%s: absent or null parses to null, as before the field", (_, schema, base) => {
      expect(schema.parse(base).reply_language).toBeNull();
      expect(schema.parse({ ...base, reply_language: null }).reply_language).toBeNull();
    });

    it.each(inputs)("%s: takes every member of FREE_CHAT_REPLY_LANGUAGES", (_, schema, base) => {
      expect(FREE_CHAT_REPLY_LANGUAGES).toHaveLength(7); // non-vacuous
      for (const language of FREE_CHAT_REPLY_LANGUAGES) {
        expect(schema.parse({ ...base, reply_language: language }).reply_language).toBe(language);
      }
    });

    it.each(inputs)("%s: refuses anything outside the closed set", (_, schema, base) => {
      // "hinglish" covers Hindi in either script; there is no separate Hindi, no script variant,
      // no other casing and no free text.
      for (const bad of ["hindi", "devanagari", "English", "bengali", "", "reply in Tamil", 1]) {
        expect(schema.safeParse({ ...base, reply_language: bad }).success, String(bad)).toBe(false);
      }
    });
  });
});
