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

  it("returns null on a vague span with no quantity", () => {
    expect(parseDurationMonths("kaafi saal ho gaye")).toBeNull();
    expect(parseDurationMonths("saal bhar se")).toBeNull();
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
