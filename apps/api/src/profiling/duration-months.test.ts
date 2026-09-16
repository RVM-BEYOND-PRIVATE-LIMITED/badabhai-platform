import { describe, expect, it } from "vitest";

import { parseDurationMonths } from "./duration-months";

describe("parseDurationMonths", () => {
  it("reads a plain years count", () => {
    expect(parseDurationMonths("3 saal kaam kiya")).toBe(36);
  });

  it("reads a plain months count", () => {
    expect(parseDurationMonths("8 mahine ke liye")).toBe(8);
  });

  it("sums a years component and a months component", () => {
    expect(parseDurationMonths("2 saal 6 mahine")).toBe(30);
  });

  it("resolves the numeral words dedh/dhai/sawa/ek/do", () => {
    expect(parseDurationMonths("ek saal")).toBe(12);
    expect(parseDurationMonths("do saal")).toBe(24);
    expect(parseDurationMonths("dedh saal")).toBe(18);
    expect(parseDurationMonths("dhai saal")).toBe(30);
    expect(parseDurationMonths("sawa saal")).toBe(15);
  });

  /**
   * #1517 REVIEW, MINOR. `teen`/`char`/`panch`/`chhe`/`saat`/`aath`/`nau`/`das` were absent from
   * `YEAR_WORD_VALUES` and fell through to `numberValue`'s digit path, returning `null` —
   * indistinguishable from a deliberately vague span. This is the API-side fallback for exactly
   * the case where the ai-service's own `duration_months` is null, so that silent `null` held the
   * whole `experience_years` sum unsettled for an ordinary word-form duration.
   */
  it("resolves the numeral words teen/char/panch/chhe/saat/aath/nau/das", () => {
    expect(parseDurationMonths("teen saal")).toBe(36);
    expect(parseDurationMonths("char saal")).toBe(48);
    expect(parseDurationMonths("panch saal")).toBe(60);
    expect(parseDurationMonths("chhe saal")).toBe(72);
    expect(parseDurationMonths("saat saal")).toBe(84);
    expect(parseDurationMonths("aath saal")).toBe(96);
    expect(parseDurationMonths("nau saal")).toBe(108);
    expect(parseDurationMonths("das saal")).toBe(120);
  });

  it("returns null on a vague span with no quantity", () => {
    expect(parseDurationMonths("kaafi saal ho gaye")).toBeNull();
    expect(parseDurationMonths("saal bhar se")).toBeNull();
    // STILL VAGUE after the word-form table widened (#1517 review, MINOR) — "kaafi"/"bhar" are
    // not in `YEAR_WORD_VALUES` and must never be confused with the newly-added digit words.
    expect(parseDurationMonths("kaafi saal se kaam kar raha hoon")).toBeNull();
  });

  it("returns null on nothing resolvable", () => {
    expect(parseDurationMonths("bahut experience hai")).toBeNull();
    expect(parseDurationMonths("")).toBeNull();
  });

  it("returns null when the quantity sits in a negated span", () => {
    expect(parseDurationMonths("3 saal nahi kiya")).toBeNull();
  });

  it("reads Devanagari digits", () => {
    expect(parseDurationMonths("३ साल")).toBe(36);
  });
});
