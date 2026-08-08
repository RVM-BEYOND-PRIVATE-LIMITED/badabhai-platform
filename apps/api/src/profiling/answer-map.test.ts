import { describe, expect, it } from "vitest";
import type { AnswerRecord } from "@badabhai/ai-contracts";

import {
  answerSetHash,
  emptyAnswerMap,
  isSettled,
  recordAnswer,
  recordDeclined,
  recordUnanswered,
  toAnswerArray,
  toAnswerMap,
  toCapturedProjection,
  type AnswerMap,
  type CapturedValue,
} from "./answer-map";

function value(overrides: Partial<CapturedValue> & { questionKey: string }): CapturedValue {
  return {
    targetField: null,
    valueRaw: null,
    valueNormalized: null,
    evidence: null,
    ...overrides,
  };
}

describe("the map is the RECORD, and nothing mutates", () => {
  it("returns a new map and leaves the original untouched", () => {
    // The CAS loser re-runs the decision against post-winner state; that is only safe while the
    // functions it re-runs have no history.
    const before = emptyAnswerMap();
    const after = recordAnswer(before, value({ questionKey: "a", valueNormalized: 1 }), 1);
    expect(before).toEqual({});
    expect(after.a?.value_normalized).toBe(1);
  });

  it("round-trips through the contract's array form in a STABLE order", () => {
    // The parse request is content-hashed for the reply cache; a map that serialized in a
    // different order each turn would miss every cache hit.
    let map = emptyAnswerMap();
    for (const key of ["zulu", "alpha", "mike"]) {
      map = recordAnswer(map, value({ questionKey: key, valueNormalized: key }), 1);
    }
    expect(toAnswerArray(map).map((r) => r.question_key)).toEqual(["alpha", "mike", "zulu"]);
    expect(toAnswerMap(toAnswerArray(map))).toEqual(map);
  });

  it("folds a duplicate key deterministically rather than merely improbably", () => {
    // State arrives as jsonb and may have been written by an older build, so the fold has to be
    // DEFINED — last write wins.
    const map = toAnswerMap([
      {
        question_key: "a",
        target_field: null,
        value_raw: null,
        value_normalized: 1,
        status: "answered",
        evidence: null,
        turn: 1,
        history: [],
      },
      {
        question_key: "a",
        target_field: null,
        value_raw: null,
        value_normalized: 2,
        status: "answered",
        evidence: null,
        turn: 2,
        history: [],
      },
    ]);
    expect(map.a?.value_normalized).toBe(2);
  });
});

describe("a correction never discards the old answer", () => {
  it("pushes the superseded value onto history, newest first", () => {
    // LOAD-BEARING for the parse call: the transcript holds both values, so without the history
    // the model has to guess which one won.
    let map = recordAnswer(
      {},
      value({ questionKey: "years", valueNormalized: 5, valueRaw: "5 saal" }),
      1,
    );
    map = recordAnswer(
      map,
      value({ questionKey: "years", valueNormalized: 7, valueRaw: "7 saal" }),
      3,
    );

    expect(map.years?.value_normalized).toBe(7);
    expect(map.years?.turn).toBe(3);
    expect(map.years?.history).toHaveLength(1);
    expect(map.years?.history[0]).toMatchObject({
      value_normalized: 5,
      value_raw: "5 saal",
      status: "superseded",
      turn: 1,
    });

    map = recordAnswer(map, value({ questionKey: "years", valueNormalized: 9 }), 5);
    expect(map.years?.history.map((h) => h.value_normalized)).toEqual([7, 5]);
  });

  it("does NOT grow history when a worker simply repeats themselves", () => {
    // A repeat on a bounded re-ask is not a correction, and a history full of identical entries
    // would make a real correction hard to see.
    let map = recordAnswer({}, value({ questionKey: "city", valueNormalized: "Pune" }), 1);
    map = recordAnswer(map, value({ questionKey: "city", valueNormalized: "Pune" }), 2);
    expect(map.city?.history).toHaveLength(0);
  });

  it("treats an array answer structurally, not by reference", () => {
    let map = recordAnswer({}, value({ questionKey: "m", valueNormalized: ["vmc", "lathe"] }), 1);
    map = recordAnswer(map, value({ questionKey: "m", valueNormalized: ["vmc", "lathe"] }), 2);
    expect(map.m?.history).toHaveLength(0);
    map = recordAnswer(map, value({ questionKey: "m", valueNormalized: ["vmc"] }), 3);
    expect(map.m?.history).toHaveLength(1);
  });
});

describe("declined and unanswered", () => {
  it("marks a declination without erasing a value already captured", () => {
    const answered = recordAnswer({}, value({ questionKey: "city", valueNormalized: "Pune" }), 1);
    const declined = recordDeclined(answered, "city", 4);
    expect(declined.city?.status).toBe("declined");
    // The engine does not overwrite an answer with "don't know" arriving later.
    expect(declined.city?.value_normalized).toBe("Pune");
  });

  it("records an unanswered question when the engine advances past it", () => {
    const map = recordUnanswered({}, "city", 2);
    expect(map.city?.status).toBe("unanswered");
    // Distinct from having no record at all, which means "not yet reached".
    expect(map.other).toBeUndefined();
  });

  it("settles on answered and declined, but never on unanswered", () => {
    const answered = recordAnswer({}, value({ questionKey: "a", valueNormalized: 1 }), 1);
    expect(isSettled(answered, "a")).toBe(true);
    expect(isSettled(recordDeclined({}, "b", 1), "b")).toBe(true);
    expect(isSettled(recordUnanswered({}, "c", 1), "c")).toBe(false);
    expect(isSettled({} as AnswerMap, "missing")).toBe(false);
  });
});

describe("the v1 `captured` projection stays populated across the cutover", () => {
  it("keys on target_field, falls back to question_key, and skips non-answers", () => {
    let map = recordAnswer(
      {},
      value({ questionKey: "q_city", targetField: "current_city", valueNormalized: "Pune" }),
      1,
    );
    map = recordAnswer(
      map,
      value({ questionKey: "q_machines", valueNormalized: ["vmc", "lathe"] }),
      2,
    );
    map = recordDeclined(map, "q_salary", 3);
    map = recordAnswer(map, value({ questionKey: "q_empty", valueNormalized: null }), 4);

    expect(toCapturedProjection(map)).toEqual({
      current_city: "Pune",
      // No target_field: the question key is the honest fallback.
      q_machines: "vmc, lathe",
      // A declined question is not a captured VALUE, and a null normalized value is skipped
      // rather than rendered as the literal "null".
    });
  });
});

/**
 * THE REBUILD TRIGGER'S KEY (#700, owner ruling 2026-08-08).
 *
 * A correction re-triggers the profile build, keyed on this hash rather than on `session_id`. That
 * is what makes it structurally incapable of colliding with the race #420 closed: that was two
 * triggers firing on UNCHANGED data, and a changed answer set is not expressible in this key space
 * as a re-fire on unchanged data.
 *
 * So the two properties below are the load-bearing ones. If the hash moved when the journey moved,
 * a worker who "corrected" an answer to the value it already held would pay for a fresh extraction
 * — which is the exact spend #420 exists to prevent.
 */
describe("answerSetHash — what it must and must not notice", () => {
  const rec = (over: Partial<AnswerRecord> & { question_key: string }): AnswerRecord =>
    ({
      target_field: over.question_key,
      value_raw: null,
      value_normalized: null,
      status: "answered",
      evidence: null,
      turn: 1,
      history: [],
      ...over,
    }) as AnswerRecord;

  const mapOf = (...records: AnswerRecord[]): AnswerMap =>
    Object.fromEntries(records.map((r) => [r.question_key, r]));

  it("is stable across key ORDER — the same answers hash the same", () => {
    const a = mapOf(
      rec({ question_key: "current_city", value_normalized: "Pune" }),
      rec({ question_key: "experience_years", value_normalized: 8 }),
    );
    const b = mapOf(
      rec({ question_key: "experience_years", value_normalized: 8 }),
      rec({ question_key: "current_city", value_normalized: "Pune" }),
    );
    expect(answerSetHash(a)).toBe(answerSetHash(b));
  });

  it("IGNORES the journey — turn, evidence and history do not move it", () => {
    // The property that stops a no-op correction re-spending. A worker who re-confirms an answer
    // reaches this with a different `turn` and possibly a grown history, and must NOT produce a
    // new key.
    const plain = mapOf(rec({ question_key: "current_city", value_normalized: "Pune" }));
    const travelled = mapOf(
      rec({
        question_key: "current_city",
        value_normalized: "Pune",
        turn: 9,
        value_raw: "main Pune mein rehta hoon",
        evidence: { message_index: 3, start: 5, end: 9 } as never,
        history: [
          {
            value_raw: null,
            value_normalized: "Mumbai",
            status: "superseded",
            evidence: null,
            turn: 2,
          },
        ] as never,
      }),
    );
    expect(answerSetHash(travelled)).toBe(answerSetHash(plain));
  });

  it("NOTICES a changed value — that is the whole point of the trigger", () => {
    const before = mapOf(rec({ question_key: "current_city", value_normalized: "Mumbai" }));
    const after = mapOf(rec({ question_key: "current_city", value_normalized: "Pune" }));
    expect(answerSetHash(after)).not.toBe(answerSetHash(before));
  });

  it("NOTICES a changed status, even at the same value", () => {
    // `answered` with no value and `declined` are different facts and build different profiles.
    const answered = mapOf(rec({ question_key: "certification", status: "answered" }));
    const declined = mapOf(rec({ question_key: "certification", status: "declined" }));
    expect(answerSetHash(answered)).not.toBe(answerSetHash(declined));
  });

  it("cannot be confused by a separator inside a value", () => {
    // Two fields vs one field whose value contains the delimiter. A hand-rolled join on a
    // printable character would collide here.
    const twoFields = mapOf(
      rec({ question_key: "a", value_normalized: "x" }),
      rec({ question_key: "b", value_normalized: "y" }),
    );
    const oneField = mapOf(rec({ question_key: "a", value_normalized: "x\u001fanswered\u001eb" }));
    expect(answerSetHash(twoFields)).not.toBe(answerSetHash(oneField));
  });

  it("distinguishes an empty map from one with an empty answer", () => {
    expect(answerSetHash({})).not.toBe(
      answerSetHash(mapOf(rec({ question_key: "a", value_normalized: null }))),
    );
  });
});
