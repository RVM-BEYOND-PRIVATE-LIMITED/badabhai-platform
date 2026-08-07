import { describe, expect, it } from "vitest";

import type { AnswerRecord, ParsedField, ProfileParseOutput } from "@badabhai/ai-contracts";

import {
  PROJECTABLE_DRAFT_FIELDS,
  projectProfile,
} from "./answer-map-projector";
import { applyParseGates } from "./parse-gates";

function answer(over: Partial<AnswerRecord> & { question_key: string }): AnswerRecord {
  return {
    target_field: null,
    value_raw: null,
    value_normalized: null,
    status: "answered",
    evidence: null,
    turn: 1,
    history: [],
    ...over,
  };
}

function parsed(value: unknown): ParsedField {
  return {
    value,
    evidence: { message_index: 0, quote: "q" },
    source: "transcript",
    normalization: "verbatim",
    confidence: 0.99,
  };
}

const MAP: AnswerRecord[] = [
  answer({ question_key: "q1", target_field: "trade", value_normalized: "VMC operator" }),
  answer({ question_key: "q2", target_field: "experience_years", value_normalized: 7 }),
  answer({ question_key: "q3", target_field: "current_city", value_normalized: "Pune" }),
  answer({ question_key: "q4", target_field: "salary_expected", value_normalized: 35_000 }),
];

describe("THE FAIL-CLOSED PATH — a real profile from the answer map alone", () => {
  it("projects a usable draft with NO llm parse at all", () => {
    // The LLM is down, blocked, or failed every gate. The worker still gets a profile.
    const { draft, parseStatus, overlayFields } = projectProfile(MAP);
    expect(parseStatus).toBe("deterministic_only");
    expect(overlayFields).toEqual([]);
    expect(draft.primary_role?.value).toBe("VMC operator");
    expect(draft.experience_years?.value).toBe(7);
    expect(draft.current_city?.value).toBe("Pune");
    // The rename the crosswalk exists for: salary_expected -> expected_salary.
    expect(draft.expected_salary?.value).toBe(35_000);
  });

  it("marks every value's provenance, so the audit can say what the model contributed", () => {
    const { draft } = projectProfile(MAP);
    for (const projected of Object.values(draft)) expect(projected.source).toBe("answer_map");
  });

  it("carries NOTHING for a declined or unanswered question", () => {
    // "nahi pata" is a complete ANSWER but not a resume VALUE, and an unanswered question is a
    // gap. Neither may become an empty string on a worker's profile.
    const { draft } = projectProfile([
      answer({ question_key: "q", target_field: "trade", status: "declined" }),
      answer({ question_key: "r", target_field: "current_city", status: "unanswered" }),
    ]);
    expect(draft).toEqual({});
  });

  it("skips a crosswalk entry that deliberately has no draft column", () => {
    // `work_history` is `kind: "none"` — §2 forbids storing employer names. It must not invent a
    // draft field to land in.
    const { draft } = projectProfile([
      answer({ question_key: "q", target_field: "work_history", value_normalized: "Tata Motors" }),
    ]);
    expect(draft).toEqual({});
  });

  it("ignores an RFS id the crosswalk does not know", () => {
    const { draft } = projectProfile([
      answer({ question_key: "q", target_field: "invented_field", value_normalized: "x" }),
    ]);
    expect(draft).toEqual({});
  });
});

describe("THE PRECEDENCE FUNCTION — deterministic map > LLM parse", () => {
  it("lets the MAP win where both have a value, unconditionally", () => {
    // No comparison, no merge, no "unless the model is more confident" — confidence is the
    // model's opinion of itself. The parsed field here carries confidence 0.99 and still loses.
    const { draft } = projectProfile(MAP, { experience_years: parsed(12) });
    expect(draft.experience_years?.value).toBe(7);
    expect(draft.experience_years?.source).toBe("answer_map");
  });

  it("lets the LLM ADD coverage the map has nothing for", () => {
    // The overlay's whole purpose: reach what regexes cannot.
    const { draft, parseStatus, overlayFields } = projectProfile(MAP, {
      certifications: parsed(["ITI Fitter"]),
    });
    expect(draft.certifications?.value).toEqual(["ITI Fitter"]);
    expect(draft.certifications?.source).toBe("llm_parse");
    expect(parseStatus).toBe("llm_overlay");
    expect(overlayFields).toEqual(["certifications"]);
  });

  it("reports deterministic_only when the overlay contributed nothing that survived", () => {
    // The honest signal for "the LLM was down, blocked, or failed every gate" — without this
    // function needing to know which of the three happened.
    const { parseStatus } = projectProfile(MAP, { experience_years: parsed(12) });
    expect(parseStatus).toBe("deterministic_only");
  });

  it("is deterministic across repeated runs", () => {
    const runs = new Set(
      Array.from({ length: 20 }, () =>
        JSON.stringify(projectProfile(MAP, { certifications: parsed(["ITI"]) })),
      ),
    );
    expect(runs.size).toBe(1);
  });
});

describe("the split field", () => {
  it("fans one answer across several draft fields when a splitter is supplied", () => {
    // `tools_equipment` is trade-agnostic: a VMC and a Fanuc arrive in one phrase.
    const { draft } = projectProfile(
      [answer({ question_key: "q", target_field: "tools_equipment", value_normalized: "VMC Fanuc" })],
      {},
      { split: () => ({ machines: ["VMC"], controllers: ["Fanuc"] }) },
    );
    expect(draft.machines?.value).toEqual(["VMC"]);
    expect(draft.controllers?.value).toEqual(["Fanuc"]);
  });

  it("keeps the answer somewhere reviewable when no splitter is supplied", () => {
    // Dropping it entirely would be worse: the worker answered, and a missing splitter is our
    // defect, not theirs.
    const { draft } = projectProfile([
      answer({ question_key: "q", target_field: "tools_equipment", value_normalized: "VMC Fanuc" }),
    ]);
    expect(draft.machines?.value).toBe("VMC Fanuc");
  });

  it("refuses a splitter's output for a draft field the crosswalk did not declare", () => {
    // A splitter must not be able to widen the set of columns a parse can write to.
    const { draft } = projectProfile(
      [answer({ question_key: "q", target_field: "tools_equipment", value_normalized: "x" })],
      {},
      { split: () => ({ machines: ["VMC"], secret_notes: ["nope"] }) },
    );
    expect(draft.machines?.value).toEqual(["VMC"]);
    expect(draft.secret_notes).toBeUndefined();
  });
});

describe("THE ACCEPTANCE CRITERION, end to end: LLM-unavailable ⇒ a real profile", () => {
  it("turns the ai-service's degraded response into deterministic_only, not into nothing", () => {
    // This is the exact body `POST /profile/parse` returns on EVERY degraded path — mock mode, a
    // dead provider, a blown deadline, an unreadable model reply, or a total gate wipeout. Both
    // halves of the criterion are tested separately (the route always answers; the projector reads
    // the map), and this is the join: the two are only worth anything if the shape one emits is the
    // shape the other reads.
    const fromAiService: ProfileParseOutput = {
      fields: {},
      unparsed_field_ids: ["experience_years", "salary_expected"],
      notes: ["llm_unavailable"],
    };
    const gated = applyParseGates(
      fromAiService,
      { answer_map: MAP, transcript: [], target_fields: [] },
      (text) => ({ blocked: false, text }),
    );
    expect(gated.accepted).toEqual({});

    const { draft, parseStatus } = projectProfile(MAP, gated.accepted);
    expect(parseStatus).toBe("deterministic_only");
    // "A valid profile from the answer map alone" — asserted as CONTENT, because an empty draft
    // would also satisfy `deterministic_only` and would satisfy nobody's résumé.
    expect(draft.primary_role?.value).toBe("VMC operator");
    expect(draft.experience_years?.value).toBe(7);
    expect(draft.current_city?.value).toBe("Pune");
    expect(draft.expected_salary?.value).toBe(35_000);
  });
});

describe("the projection can never invent a draft column", () => {
  it("writes only fields the crosswalk declares", () => {
    const { draft } = projectProfile(MAP, {
      certifications: parsed(["ITI"]),
      education_level: parsed("ITI"),
    });
    for (const key of Object.keys(draft)) {
      expect(PROJECTABLE_DRAFT_FIELDS.has(key), key).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The attribute leg — 77% of the authored corpus, which used to land nowhere
// ---------------------------------------------------------------------------

describe("attribute projection", () => {
  it("routes a non-RFS answer to worker_attributes instead of silently dropping it", () => {
    // The finding this closes: 359 of 466 pack items are `target_kind: "attribute"`, and the
    // projector wrote only RFS fields. Every one of those answers was captured, normalized,
    // carried through the interview — and discarded here.
    const result = projectProfile([
      answer({ question_key: "q_forklift", target_field: "forklift", value_normalized: true }),
    ]);
    expect(result.attributes).toEqual([
      { attributeKey: "forklift", valueKind: "boolean", value: true, source: "answer_map" },
    ]);
    // ...and it is NOT on the resume draft. Different destination, different rules.
    expect(result.draft).toEqual({});
  });

  it("keeps RFS answers out of the attribute set", () => {
    // The crosswalk IS the test for "is this RFS" — no second copy of the vocabulary here.
    const result = projectProfile(MAP);
    expect(result.attributes).toEqual([]);
    expect(Object.keys(result.draft).length).toBeGreaterThan(0);
  });

  it("derives value_kind from the value's SHAPE, so a new answer type needs no new case", () => {
    const result = projectProfile([
      answer({ question_key: "a", target_field: "shift_work", value_normalized: false }),
      answer({ question_key: "b", target_field: "hours_per_day", value_normalized: 9 }),
      answer({ question_key: "c", target_field: "workplace_type", value_normalized: "workshop" }),
      answer({ question_key: "d", target_field: "pipe_material", value_normalized: ["pvc", "gi"] }),
    ]);
    expect(result.attributes.map((a) => [a.attributeKey, a.valueKind, a.value])).toEqual([
      ["hours_per_day", "number", 9],
      ["pipe_material", "text_list", ["pvc", "gi"]],
      ["shift_work", "boolean", false],
      ["workplace_type", "text", "workshop"],
    ]);
  });

  it("treats an EMPTY list as a real answer, not as silence", () => {
    // "none of these" is not "unanswered". Collapsing them would re-ask a question the worker has
    // already closed.
    const result = projectProfile([
      answer({ question_key: "a", target_field: "measuring_tools", value_normalized: [] }),
    ]);
    expect(result.attributes).toEqual([
      { attributeKey: "measuring_tools", valueKind: "text_list", value: [], source: "answer_map" },
    ]);
  });

  it("drops a value it cannot represent rather than stringifying it", () => {
    // `worker_attributes` is a matchable inventory. "[object Object]" is a row no query can ever
    // match and no reader can interpret — strictly worse than no row.
    const result = projectProfile([
      answer({ question_key: "a", target_field: "weird", value_normalized: { nested: 1 } }),
      answer({ question_key: "b", target_field: "blank", value_normalized: "   " }),
    ]);
    expect(result.attributes).toEqual([]);
  });

  it("lets the answer map beat the LLM overlay on an attribute, exactly as it does on the draft", () => {
    // The precedence rule is written once, and it has to govern BOTH outputs or a model could
    // overwrite a spoken answer in the matcher's inventory while losing on the resume.
    const result = projectProfile(
      [answer({ question_key: "q", target_field: "forklift", value_normalized: false })],
      { forklift: parsed(true) },
    );
    expect(result.attributes).toEqual([
      { attributeKey: "forklift", valueKind: "boolean", value: false, source: "answer_map" },
    ]);
  });

  it("still records an attribute the LLM contributed and the map had nothing for", () => {
    const result = projectProfile([], { safety_training: parsed(true) });
    expect(result.attributes).toEqual([
      { attributeKey: "safety_training", valueKind: "boolean", value: true, source: "llm_parse" },
    ]);
  });

  it("does not turn a declined or unanswered question into an attribute row", () => {
    // A declination is a complete ANSWER for completion purposes and has no value to store.
    const result = projectProfile([
      answer({ question_key: "a", target_field: "forklift", status: "declined" }),
      answer({ question_key: "b", target_field: "night_work", status: "unanswered" }),
    ]);
    expect(result.attributes).toEqual([]);
  });
});
