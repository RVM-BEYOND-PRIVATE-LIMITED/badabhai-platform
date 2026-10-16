import { describe, expect, it } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { isBareNone, isFreeTextItem } from "./none-answer";

/** #2328 — "I have none" to a free-text question, read with no model. */

describe("isBareNone — strict: a false yes drops a real answer", () => {
  it.each(["nahi", "Nahi", "nahi ki", "nahin kiya", "nahi kiya hai", "nai", "no", "koi nahi", "kuch nahi"])(
    "%s is a bare none",
    (text) => {
      expect(isBareNone(text)).toBe(true);
    },
  );

  it.each([
    "ITI se welding ka course", // a real answer
    "ITI nahi, private se Tally kiya", // a real answer that contains a "nahi"
    "koi course nahi kiya", // content: the model reads this one
    "maine koi course nahin kiya bhai mere ko profile", // content: the model reads this one
    "haan", // a yes
    "main theek nahi hoon", // a negated state (#2250), never a "none"
    "",
  ])("%s is not", (text) => {
    expect(isBareNone(text)).toBe(false);
  });
});

describe("isFreeTextItem", () => {
  const base = { target_field: null, answer_type: "text" } as unknown as QuestionPackItem;

  it("is a text question with no typed parser for its field", () => {
    expect(isFreeTextItem({ ...base, target_field: "training_name" })).toBe(true);
    // A typed field reads no value from "nahi" and is asked again; a yes/no reads it as its answer.
    expect(isFreeTextItem({ ...base, target_field: "current_city" })).toBe(false);
    expect(isFreeTextItem({ ...base, answer_type: "boolean" })).toBe(false);
    expect(isFreeTextItem({ ...base, answer_type: "number", target_field: "training_year" })).toBe(false);
  });
});
