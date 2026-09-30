import { describe, expect, it } from "vitest";
import { validateCareerAnswer } from "./career-output.validator";

const answer = (lines: string[], chips: string[] = []) => ({ lines, followup_chips: chips });

describe("validateCareerAnswer (ADR-0046 P3 §2) — every check rejects its own fixture", () => {
  it("a clean answer passes: Latin Hinglish, short, no money, no names", () => {
    expect(
      validateCareerAnswer(
        answer(
          ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."],
          // One "?" is the whole answer's budget, and the chips share it with the lines.
          ["Course kahan milega", "Kitna time lagega?"],
        ),
      ),
    ).toBeNull();
  });

  it("shape: no lines, too many lines, empty lines", () => {
    expect(validateCareerAnswer(answer([]))).toBe("no_lines");
    expect(validateCareerAnswer(answer(["a", "b", "c", "d", "e"]))).toBe("too_many_lines");
    expect(validateCareerAnswer(answer(["ok", "   "]))).toBe("empty_line");
  });

  it("length: a line over twenty words, a chip over four", () => {
    expect(validateCareerAnswer(answer([Array(21).fill("kaam").join(" ")]))).toBe("line_too_long");
    expect(validateCareerAnswer(answer(["line ok"], ["yeh chip bahut lamba hai ji"]))).toBe(
      "chip_too_long",
    );
  });

  it("script: Devanagari is barred outright (O9)", () => {
    expect(validateCareerAnswer(answer(["पहले सर्टिफिकेट करें."]))).toBe("devanagari");
  });

  it("punctuation and emoji: no exclamation, no emoji, at most one question mark", () => {
    expect(validateCareerAnswer(answer(["Yeh kaam kariye!"]))).toBe("exclamation");
    expect(validateCareerAnswer(answer(["Bilkul theek hai 👍"]))).toBe("emoji");
    expect(validateCareerAnswer(answer(["Kyun?", "Kaise?"]))).toBe("too_many_questions");
    // One question mark across lines AND chips is the budget, so two spread out still fail.
    expect(validateCareerAnswer(answer(["Theek hai?"], ["Aur?"]))).toBe("too_many_questions");
  });

  it("persona: the v3.2 scan rejects banned tokens — including the vocative rule (R8)", () => {
    // "bhai" is a banned vocative; "pakka" is a banned promise the persona corpus carries.
    expect(validateCareerAnswer(answer(["Suniye bhai, aise kariye."]))).toBe("persona");
  });

  it("money: a money word fails only NEXT TO a digit", () => {
    expect(validateCareerAnswer(answer(["Salary 25000 milegi."]))).toBe("money");
    expect(validateCareerAnswer(answer(["25 hazaar per mahina milta hai."]))).toBe("money");
    // Advice about salary with NO figure is legal — the rule is the figure, not the word.
    expect(validateCareerAnswer(answer(["Salary ki baat khud tay kariye."]))).toBeNull();
  });

  it("promise: guarantee words fail however phrased", () => {
    expect(validateCareerAnswer(answer(["Job pakka milegi."]))).toBe("promise");
    expect(validateCareerAnswer(answer(["Yeh 100% ho jayega."]))).toBe("promise");
    expect(validateCareerAnswer(answer(["Zaroor milegi, tension na lo."]))).toBe("promise");
  });

  it("sensitive advice: legal / medical / financial terms", () => {
    expect(validateCareerAnswer(answer(["Court ka case vakil se ladiye."]))).toBe(
      "sensitive_advice",
    );
    expect(validateCareerAnswer(answer(["Bank se loan le lijiye."]))).toBe("sensitive_advice");
    expect(validateCareerAnswer(answer(["Bima karwa lijiye."]))).toBe("sensitive_advice");
  });

  it("rating: comparing or scoring the worker", () => {
    expect(validateCareerAnswer(answer(["Aap achhe ho."]))).toBe("worker_rating");
    expect(validateCareerAnswer(answer(["Aapka score 8 out of 10 hai."]))).toBe("worker_rating");
    expect(validateCareerAnswer(answer(["Aapki rank badh jayegi."]))).toBe("worker_rating");
  });

  it("named employer: the platform's legal-entity heuristic", () => {
    expect(validateCareerAnswer(answer(["Sharma Engineering Pvt Ltd me jaiye."]))).toBe(
      "named_employer",
    );
  });

  it("PII: an email or a phone-shaped run", () => {
    expect(validateCareerAnswer(answer(["Mail kariye ramesh@example.com par."]))).toBe("pii");
    expect(validateCareerAnswer(answer(["Call kariye 9876543210 par."]))).toBe("pii");
  });

  it("chips get the SAME content checks as lines", () => {
    expect(validateCareerAnswer(answer(["line ok"], ["Salary 25000?"]))).toBe("money");
    expect(validateCareerAnswer(answer(["line ok"], ["bhai se poocho"]))).toBe("persona");
  });
});
