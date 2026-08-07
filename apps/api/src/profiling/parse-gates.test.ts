import { describe, expect, it, vi } from "vitest";

import type {
  AnswerRecord,
  ParsedField,
  TargetField,
  TranscriptLine,
} from "@badabhai/ai-contracts";

import {
  applyParseGates,
  checkAgreement,
  checkPii,
  checkProvenance,
  checkRole,
  checkTypeRange,
  checkVocabulary,
  countByGate,
  isCityUnrecognized,
  type PiiCertifier,
} from "./parse-gates";

const TRANSCRIPT: TranscriptLine[] = [
  { i: 0, role: "assistant", text: "Aap kaunsi machine chalate hain? Jaise VMC, HMC, lathe, CNC turning" },
  { i: 1, role: "worker", text: "main VMC chalata hun, 7 saal se. pune me rehta hun" },
  { i: 2, role: "assistant", text: "Salary kitni chahiye?" },
  { i: 3, role: "worker", text: "35000 chahiye har mahine" },
];

const TARGETS: TargetField[] = [
  { field_id: "trade", type: "string", enum: null, unit: null, required: true },
  { field_id: "experience_years", type: "number", enum: null, unit: "years", required: true },
  { field_id: "current_city", type: "string", enum: null, unit: null, required: true },
  { field_id: "salary_expected", type: "number", enum: null, unit: "inr_per_month", required: true },
  {
    field_id: "availability",
    type: "enum",
    enum: ["immediate", "notice_period", "not_looking", "unknown"],
    unit: null,
    required: true,
  },
];

function field(over: Partial<ParsedField> & { value: unknown }): ParsedField {
  return {
    evidence: { message_index: 1, quote: "main VMC chalata hun" },
    source: "transcript",
    normalization: "verbatim",
    confidence: 0.9,
    ...over,
  };
}

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

/** A certifier that passes everything — the neutral default for tests about other gates. */
const PASS: PiiCertifier = (text) => ({ blocked: false, text });

describe("GATE 1 — PROVENANCE: a hallucinated value has no span to point at", () => {
  it("REJECTS a quote that appears in no message", () => {
    // The crafted hallucination: a perfectly plausible value the worker never said.
    expect(
      checkProvenance({ message_index: 1, quote: "12 saal ka experience" }, TRANSCRIPT),
    ).toBe("quote_not_in_message");
  });

  it("REJECTS a message_index past the end of the transcript", () => {
    expect(checkProvenance({ message_index: 99, quote: "anything" }, TRANSCRIPT)).toBe(
      "message_index_out_of_range",
    );
  });

  it("ACCEPTS a literal quote", () => {
    expect(checkProvenance({ message_index: 1, quote: "7 saal se" }, TRANSCRIPT)).toBeNull();
  });

  it("tolerates reflowed whitespace, which is not fabrication", () => {
    // Models collapse and insert whitespace constantly. Rejecting on it would fail honest
    // citations while catching no invented ones.
    expect(
      checkProvenance({ message_index: 1, quote: "main   VMC\n chalata  hun" }, TRANSCRIPT),
    ).toBeNull();
  });

  it("does NOT tolerate an altered word", () => {
    expect(checkProvenance({ message_index: 1, quote: "main HMC chalata hun" }, TRANSCRIPT)).toBe(
      "quote_not_in_message",
    );
  });
});

describe("GATE 2 — ROLE: the system must not interview itself", () => {
  it("REJECTS a span sourced from OUR OWN question text", () => {
    // THE DEFECT THIS EXISTS FOR. Message 0 is the assistant listing example machines. A quote
    // from it is perfectly real, so provenance passes it — and the worker who named ONE machine
    // ends up with four. Only the role gate catches this.
    const evidence = { message_index: 0, quote: "VMC, HMC, lathe, CNC turning" };
    expect(checkProvenance(evidence, TRANSCRIPT)).toBeNull();
    expect(checkRole(evidence, TRANSCRIPT)).toBe("span_not_from_worker");
  });

  it("ACCEPTS a worker line", () => {
    expect(checkRole({ message_index: 1, quote: "main VMC" }, TRANSCRIPT)).toBeNull();
  });
});

describe("GATE 3 — TYPE / ENUM / RANGE", () => {
  it("REJECTS an out-of-range experience, in both directions", () => {
    expect(checkTypeRange("experience_years", 61, undefined)).toBe(
      "experience_years_out_of_range",
    );
    expect(checkTypeRange("experience_years", -1, undefined)).toBe(
      "experience_years_out_of_range",
    );
    expect(checkTypeRange("experience_years", 0, undefined)).toBeNull();
    expect(checkTypeRange("experience_years", 60, undefined)).toBeNull();
  });

  it("REJECTS a salary outside INR-per-month, which is how a 12x period error shows up", () => {
    // An annual figure read as monthly, and a monthly figure read as annual. Both are the same
    // bug and both are caught here.
    expect(checkTypeRange("salary_expected", 420_000 * 12, undefined)).toBe("salary_out_of_range");
    expect(checkTypeRange("salary_expected", 500, undefined)).toBe("salary_out_of_range");
    expect(checkTypeRange("salary_expected", 1_000, undefined)).toBeNull();
    expect(checkTypeRange("salary_expected", 500_000, undefined)).toBeNull();
  });

  it("REJECTS an availability outside the closed enum", () => {
    expect(checkTypeRange("availability", "maybe_next_month", undefined)).toBe(
      "availability_not_in_enum",
    );
    expect(checkTypeRange("availability", "immediate", undefined)).toBeNull();
  });

  it("KEEPS an unrecognized city rather than dropping it, and flags it", () => {
    // Deleting it would lose a strong matching signal over a gazetteer gap. The flag is the
    // recoverable direction: a human extends the gazetteer.
    expect(checkTypeRange("current_city", "Bhiwadi Phase 4", undefined)).toBeNull();
    expect(isCityUnrecognized("current_city", "Bhiwadi Phase 4")).toBe(true);
    expect(isCityUnrecognized("current_city", "pune")).toBe(false);
  });

  it("enforces the DECLARED type for any other field", () => {
    const t: TargetField = {
      field_id: "skills",
      type: "string_array",
      enum: null,
      unit: null,
      required: false,
    };
    expect(checkTypeRange("skills", "welding", t)).toBe("not_an_array");
    expect(checkTypeRange("skills", ["welding"], t)).toBeNull();
  });

  it("REJECTS an absent value outright", () => {
    expect(checkTypeRange("trade", null, undefined)).toBe("value_absent");
    expect(checkTypeRange("trade", undefined, undefined)).toBe("value_absent");
  });
});

describe("GATE 4 — AGREEMENT: the model can reformat, never contradict", () => {
  const map = [
    answer({ question_key: "q_years", target_field: "experience_years", value_normalized: 7 }),
    answer({ question_key: "q_city", target_field: "current_city", value_normalized: "Pune" }),
  ];

  it("REJECTS a value that contradicts the deterministic map", () => {
    // The single most important gate for trust: the worker SAID seven years.
    expect(checkAgreement("experience_years", 12, map)).toBe("disagrees_with_answer_map");
  });

  it("ACCEPTS agreement, including a reformatted string", () => {
    expect(checkAgreement("experience_years", 7, map)).toBeNull();
    // "pune " and "Pune" are the same answer. Treating that as a disagreement would discard a
    // correct parse AND emit a false disagreement event.
    expect(checkAgreement("current_city", "pune ", map)).toBeNull();
  });

  it("does not constrain a field the map has no live value for", () => {
    expect(checkAgreement("salary_expected", 35_000, map)).toBeNull();
  });

  it("ignores a DECLINED record — 'nahi pata' is not a value to contradict", () => {
    const declined = [
      answer({ question_key: "q_salary", target_field: "salary_expected", status: "declined" }),
    ];
    expect(checkAgreement("salary_expected", 35_000, declined)).toBeNull();
  });
});

describe("GATE 5 — CLOSED VOCABULARY", () => {
  it("DROPS a field nobody asked for", () => {
    // The model inventing a field is the model inventing a question.
    expect(checkVocabulary("employer_name", TARGETS)).toBe("field_id_not_requested");
    expect(checkVocabulary("trade", TARGETS)).toBeNull();
  });
});

describe("GATE 6 — PII RE-CERTIFICATION", () => {
  it("REJECTS a value the certifier blocks", () => {
    const blocking: PiiCertifier = () => ({ blocked: true, text: "" });
    expect(checkPii("call me on 98765 43210", blocking)).toBe("pii_blocked");
  });

  it("REJECTS a value the certifier ALTERED, not just one it blocked", () => {
    // The subtle half. A value silently rewritten is a value that CONTAINED PII, and storing the
    // rewritten form records that the worker said something they did not.
    const rewriting: PiiCertifier = (t) => ({ blocked: false, text: t.replace(/[0-9]{5}/g, "[X]") });
    expect(checkPii("98765 hai mera number", rewriting)).toBe("pii_altered");
  });

  it("ACCEPTS a clean value, and checks every member of an array", () => {
    expect(checkPii("VMC operator", PASS)).toBeNull();
    const rewriting: PiiCertifier = (t) => ({ blocked: false, text: t === "dirty" ? "clean" : t });
    expect(checkPii(["ok", "dirty"], rewriting)).toBe("pii_altered");
  });

  it("has nothing to say about a non-string value", () => {
    expect(checkPii(7, PASS)).toBeNull();
  });
});

describe("THE WALL — all six, over a real parse output", () => {
  it("accepts an honest parse whole", () => {
    const result = applyParseGates(
      {
        fields: {
          trade: field({ value: "VMC operator" }),
          salary_expected: field({
            value: 35_000,
            evidence: { message_index: 3, quote: "35000 chahiye" },
          }),
        },
        unparsed_field_ids: [],
        notes: [],
      },
      { answer_map: [], transcript: TRANSCRIPT, target_fields: TARGETS },
      PASS,
    );
    expect(Object.keys(result.accepted).sort()).toEqual(["salary_expected", "trade"]);
    expect(result.rejections).toEqual([]);
  });

  it("drops every crafted hallucination and keeps the honest field beside them", () => {
    const result = applyParseGates(
      {
        fields: {
          // fabricated — no such quote anywhere
          experience_years: field({
            value: 12,
            evidence: { message_index: 1, quote: "12 saal ka tajurba" },
          }),
          // sourced from OUR question
          trade: field({ value: "HMC operator", evidence: { message_index: 0, quote: "HMC" } }),
          // not requested
          employer_name: field({ value: "Tata Motors" }),
          // an annual figure in a monthly field, far enough out to exceed the ceiling
          salary_expected: field({
            value: 4_200_000,
            evidence: { message_index: 3, quote: "35000 chahiye" },
          }),
          // honest
          current_city: field({
            value: "pune",
            evidence: { message_index: 1, quote: "pune me rehta hun" },
          }),
        },
        unparsed_field_ids: [],
        notes: [],
      },
      { answer_map: [], transcript: TRANSCRIPT, target_fields: TARGETS },
      PASS,
    );

    expect(Object.keys(result.accepted)).toEqual(["current_city"]);
    expect(countByGate(result.rejections)).toMatchObject({
      provenance: 1,
      role: 1,
      vocabulary: 1,
      type_range: 1,
    });
  });

  it("catches a 12x period error INSIDE the range via AGREEMENT, not via range", () => {
    // WORTH STATING PRECISELY, because it is easy to assume the range gate handles all of this.
    // 35,000/month x 12 = 420,000, which is a perfectly legal monthly salary by the plan's own
    // [1,000..500,000] bounds — the range gate accepts it and is right to. What actually catches
    // the error is the deterministic map: the worker said 35,000, so 420,000 contradicts the
    // record and is discarded. Below ~41,667/month the range gate cannot see a 12x error at all,
    // and agreement is the only defence.
    const twelveX = applyParseGates(
      {
        fields: {
          salary_expected: field({
            value: 420_000,
            evidence: { message_index: 3, quote: "35000 chahiye" },
          }),
        },
        unparsed_field_ids: [],
        notes: [],
      },
      {
        answer_map: [
          answer({ question_key: "q", target_field: "salary_expected", value_normalized: 35_000 }),
        ],
        transcript: TRANSCRIPT,
        target_fields: TARGETS,
      },
      PASS,
    );
    expect(checkTypeRange("salary_expected", 420_000, undefined)).toBeNull();
    expect(twelveX.accepted).toEqual({});
    expect(twelveX.disagreements).toEqual(["salary_expected"]);
  });

  it("reports a disagreement separately, so the event can be emitted with ids only", () => {
    const result = applyParseGates(
      {
        fields: {
          experience_years: field({ value: 12, evidence: { message_index: 1, quote: "7 saal se" } }),
        },
        unparsed_field_ids: [],
        notes: [],
      },
      {
        answer_map: [
          answer({ question_key: "q", target_field: "experience_years", value_normalized: 7 }),
        ],
        transcript: TRANSCRIPT,
        target_fields: TARGETS,
      },
      PASS,
    );
    expect(result.accepted).toEqual({});
    expect(result.disagreements).toEqual(["experience_years"]);
    // The DETERMINISTIC value stands; the LLM's is discarded.
    expect(result.rejections[0]?.gate).toBe("agreement");
  });

  it("treats a null field as an honest 'nothing citable', not a failure", () => {
    const result = applyParseGates(
      { fields: { trade: null }, unparsed_field_ids: [], notes: [] },
      { answer_map: [], transcript: TRANSCRIPT, target_fields: TARGETS },
      PASS,
    );
    expect(result.accepted).toEqual({});
    expect(result.rejections).toEqual([]);
  });

  it("never lets a rejection reason carry the offending VALUE (§2)", () => {
    // Rejections reach logs and events. Ids and reason codes only, never worker text.
    const result = applyParseGates(
      {
        fields: {
          employer_name: field({ value: "Tata Motors, Chakan plant, Pune 411501" }),
        },
        unparsed_field_ids: [],
        notes: [],
      },
      { answer_map: [], transcript: TRANSCRIPT, target_fields: TARGETS },
      PASS,
    );
    const serialized = JSON.stringify(result.rejections);
    expect(serialized).not.toContain("Tata");
    expect(serialized).not.toContain("411501");
    expect(serialized).toContain("field_id_not_requested");
  });

  it("runs PII re-certification LAST, so it is never paid for a doomed field", () => {
    const certify = vi.fn(PASS);
    applyParseGates(
      { fields: { employer_name: field({ value: "x" }) }, unparsed_field_ids: [], notes: [] },
      { answer_map: [], transcript: TRANSCRIPT, target_fields: TARGETS },
      certify,
    );
    expect(certify).not.toHaveBeenCalled();
  });

  it("is TOTAL — a malformed output never throws", () => {
    // A pack of nonsense must degrade to "nothing accepted", not to a 500 that loses a real
    // interview's parse.
    expect(() =>
      applyParseGates(
        { fields: {} as never, unparsed_field_ids: [], notes: [] },
        { answer_map: [], transcript: [], target_fields: [] },
        PASS,
      ),
    ).not.toThrow();
  });
});

describe("a WINDOWED transcript — `i` is what spans point at, not array position", () => {
  // The transcript reaching a parse is a window (CHAT_HISTORY_WINDOW_TURNS), so array position
  // and `i` diverge the moment an interview outruns the window. Indexing the array instead would
  // check a DIFFERENT message than the one cited — and here that difference is exactly an
  // assistant line being read as a worker line.
  const WINDOWED: TranscriptLine[] = [
    { i: 10, role: "assistant", text: "Aap kis sheher mein rehte hain?" },
    { i: 11, role: "worker", text: "pune me rehta hun" },
  ];

  it("resolves the cited message by `i`", () => {
    expect(checkProvenance({ message_index: 11, quote: "pune me rehta hun" }, WINDOWED)).toBeNull();
    expect(checkRole({ message_index: 11, quote: "pune" }, WINDOWED)).toBeNull();
  });

  it("does NOT resolve it by array position", () => {
    // Array[1] is the worker line, so a position-indexed implementation would pass this.
    // By `i`, index 1 is not in the window at all.
    expect(checkProvenance({ message_index: 1, quote: "pune me rehta hun" }, WINDOWED)).toBe(
      "message_index_out_of_range",
    );
  });

  it("catches the assistant line that array position would have hidden", () => {
    // Array[0] is the assistant. A position-indexed role gate asked about i=10 would look at
    // array[10] — absent — and reject for the wrong reason; asked about i=0 it would wrongly
    // approve. Resolving by `i` makes the answer the honest one.
    expect(checkRole({ message_index: 10, quote: "Aap kis sheher" }, WINDOWED)).toBe(
      "span_not_from_worker",
    );
  });
});
