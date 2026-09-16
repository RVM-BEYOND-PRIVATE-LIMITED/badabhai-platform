import { describe, expect, it } from "vitest";

import { parseStrictNumber } from "./strict-number";

/**
 * ═══ ONE NUMERIC TOKEN OR NOTHING (#1503) ═══
 *
 * The rejected rows are the ones the old `Number(text.replace(/[^\d.-]/g, ""))` turned into false
 * facts — 0, 57, 26 and 6 — so each is a case that parser PASSED and must now fail.
 */
describe("parseStrictNumber", () => {
  it.each([
    ["6", 6],
    [String(6), 6],
    ["  6  ", 6],
    ["15,000", 15000],
    ["₹25,000", 25000],
    ["₹ 25,000", 25000],
    ["1,00,000", 100000],
    ["12,34,567", 1234567],
    ["100,000", 100000],
    ["2.5", 2.5],
  ])("accepts %j as %d", (text, expected) => {
    expect(parseStrictNumber(text)).toBe(expected);
  });

  it.each([
    // What the digit-strip stored instead, so the table documents the defect it closes.
    ["pata nahi", "0"],
    ["5 se 7 saal", "57"],
    ["2 saal 6 mahine", "26"],
    ["6 saal nahi", "6"],
    ["15k", "15"],
    ["5 saal", "5"],
    ["", "0"],
    ["-3", "-3"],
    ["1,0,00", "1000"],
    ["15,00", "1500"],
    ["6.", "6"],
  ])("rejects %j (the digit-strip read it as %s)", (text) => {
    expect(parseStrictNumber(text)).toBeNull();
  });
});
