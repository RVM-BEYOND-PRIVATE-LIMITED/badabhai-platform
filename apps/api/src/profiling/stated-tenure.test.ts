import { describe, expect, it } from "vitest";

import { bareNumberSpan, isLoneDigit, readStatedTenureYears } from "./stated-tenure";

/**
 * #2384 — the total-experience question answered without the word "saal". Device 2026-10-20: "0"
 * re-asked three times; the keypad sends bare digits, so every typed answer looked like this.
 */
describe("readStatedTenureYears — a bare number is years", () => {
  it.each([
    ["0", 0],
    ["5", 5],
    ["12", 12],
    [" 7 ", 7],
    ["2.5", 2.5],
    ["2,5", 2.5],
    ["०", 0],
    ["१२", 12],
    ["3.", 3],
  ])("%j → %d", (text, years) => {
    expect(readStatedTenureYears(text)).toBe(years);
  });

  it("only a WHOLE-message number: a number in a sentence is the shared parser's to read", () => {
    for (const text of ["5 nahi", "salary 15000", "5 ya 6", "123", "around 5"]) {
      expect(readStatedTenureYears(text)).toBeNull();
    }
  });
});

describe("readStatedTenureYears — the fresher words are 0 (owner ruling 2026-10-20)", () => {
  it.each([
    "fresher",
    "Fresher hoon",
    "main abhi fresher hu",
    "zero",
    "Zero saal",
    "koi experience nahi",
    "experience nahi hai",
    "abhi tak koi experience nahin hai",
    "exp nhi",
    "tajurba nahi hai",
    "no experience",
    "मैं फ्रेशर हूँ",
    "कोई अनुभव नहीं है",
  ])("%j → 0", (text) => {
    expect(readStatedTenureYears(text)).toBe(0);
  });

  it("a bare negative says nothing about years, so it reads nothing", () => {
    for (const text of [
      "nahi",
      "koi nahi",
      "kuch nahi",
      "pata nahi",
      "haan",
      "zero se shuru kiya",
    ]) {
      expect(readStatedTenureYears(text)).toBeNull();
    }
  });
});

describe("the helpers capture leans on", () => {
  it("isLoneDigit is exactly one digit, the length the classifier calls empty", () => {
    expect(isLoneDigit("0")).toBe(true);
    expect(isLoneDigit(" ५ ")).toBe(true);
    expect(isLoneDigit("10")).toBe(false);
    expect(isLoneDigit(".")).toBe(false);
    expect(isLoneDigit("")).toBe(false);
  });

  it("bareNumberSpan covers the figure, so it is not left over as unread words", () => {
    expect(bareNumberSpan(" 12 ")).toEqual({ start: 1, end: 3 });
    expect(bareNumberSpan("12 saal")).toBeUndefined();
  });
});
