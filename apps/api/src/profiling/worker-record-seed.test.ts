import { describe, expect, it } from "vitest";

import { emptyProfilingEnvelope } from "./conversation-state";
import { recordAnswer } from "./answer-map";
import { seedFromWorkerRecord } from "./worker-record-seed";

const CITY_ITEM = { question_key: "current_city", target_field: "current_city" } as const;
const OTHER_ITEM = { question_key: "primary_trade", target_field: "trade" } as const;

describe("seedFromWorkerRecord", () => {
  it("seeds a canonical city, normalized, and marks the key prefilled", () => {
    const outcome = seedFromWorkerRecord(emptyProfilingEnvelope(), "poona", [
      CITY_ITEM,
      OTHER_ITEM,
    ]);

    expect(outcome.seeded).toBe(true);
    expect(outcome.cityRecognized).toBe(true);
    expect(outcome.envelope.answerMap).toEqual([
      expect.objectContaining({
        question_key: "current_city",
        target_field: "current_city",
        value_raw: null,
        value_normalized: "Pune",
        status: "answered",
        turn: 0,
        evidence: null,
      }),
    ]);
    expect(outcome.envelope.prefilledKeys).toEqual(["current_city"]);
  });

  it("seeds a NON-canonical city AS TYPED, so the interview still skips the question", () => {
    // ("Rampur Gaon XYZ": contains no gazetteer city — "Patna Gaon XYZ" served here before #1560
    // added Patna, and now resolves to "Patna".)
    const outcome = seedFromWorkerRecord(emptyProfilingEnvelope(), "Rampur Gaon XYZ", [CITY_ITEM]);

    expect(outcome.seeded).toBe(true);
    expect(outcome.cityRecognized).toBe(false);
    expect(outcome.envelope.answerMap[0]?.value_normalized).toBe("Rampur Gaon XYZ");
    expect(outcome.envelope.prefilledKeys).toEqual(["current_city"]);
  });

  it("skips a blank or whitespace-only city", () => {
    for (const city of ["", "   "]) {
      const outcome = seedFromWorkerRecord(emptyProfilingEnvelope(), city, [CITY_ITEM]);
      expect(outcome.seeded).toBe(false);
      expect(outcome.cityRecognized).toBeNull();
      expect(outcome.envelope.answerMap).toEqual([]);
      expect(outcome.envelope.prefilledKeys).toEqual([]);
    }
  });

  it("skips when no current_city item is in this interview's resolved packs", () => {
    const outcome = seedFromWorkerRecord(emptyProfilingEnvelope(), "Pune", [OTHER_ITEM]);
    expect(outcome.seeded).toBe(false);
    expect(outcome.envelope).toEqual(emptyProfilingEnvelope());
  });

  it("first-write-wins: skips when current_city is already settled", () => {
    const answered = recordAnswer(
      {},
      {
        questionKey: "current_city",
        targetField: "current_city",
        valueRaw: "mumbai bolा",
        valueNormalized: "Mumbai",
        evidence: null,
      },
      1,
    );
    const withAnswer = { ...emptyProfilingEnvelope(), answerMap: Object.values(answered) };

    const outcome = seedFromWorkerRecord(withAnswer, "Pune", [CITY_ITEM]);
    expect(outcome.seeded).toBe(false);
    // The pre-existing settled answer is untouched.
    expect(outcome.envelope.answerMap[0]?.value_normalized).toBe("Mumbai");
    expect(outcome.envelope.prefilledKeys).toEqual([]);
  });

  it("first-write-wins also refuses over a DECLINED current_city", () => {
    const answered = recordAnswer(
      {},
      {
        questionKey: "current_city",
        targetField: "current_city",
        valueRaw: null,
        valueNormalized: null,
        evidence: null,
      },
      1,
    );
    // Simulate a declined record directly, since recordAnswer always writes "answered".
    const declined = {
      ...answered,
      current_city: { ...answered.current_city!, status: "declined" as const },
    };
    const withAnswer = { ...emptyProfilingEnvelope(), answerMap: Object.values(declined) };

    const outcome = seedFromWorkerRecord(withAnswer, "Pune", [CITY_ITEM]);
    expect(outcome.seeded).toBe(false);
  });

  it("is idempotent: seeding twice against the same envelope does not duplicate the key", () => {
    const first = seedFromWorkerRecord(emptyProfilingEnvelope(), "Pune", [CITY_ITEM]);
    const second = seedFromWorkerRecord(first.envelope, "Pune", [CITY_ITEM]);
    // First-write-wins closes the second call as a no-op (already settled).
    expect(second.seeded).toBe(false);
    expect(second.envelope.prefilledKeys).toEqual(["current_city"]);
  });
});
