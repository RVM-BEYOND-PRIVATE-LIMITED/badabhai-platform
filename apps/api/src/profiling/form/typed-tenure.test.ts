import { describe, expect, it } from "vitest";

import { typedTenureYears } from "./typed-tenure";

/**
 * Fix Q10 — years read out of a worker's TYPED answer to the form's tenure question.
 *
 * The first case is the audit's own run 5, verbatim. Every "null" below is a case where the
 * form must keep today's behaviour, because guessing would put a wrong tier on a real worker.
 */
describe("typedTenureYears", () => {
  it.each([
    // The audit's run 5: a figure with its unit, plus a date that is NOT a figure of years.
    ["10 saal ho gaye sir… sep 2016 se", 10],
    ["das saal", 10],
    // A bare number: safe here because the question on screen asks in years.
    ["10", 10],
    // A fresher phrase from the reviewed list means 0.
    ["fresher", 0],
    ["experience nahi hai", 0],
    // Known and accepted, the same reading the chat road gives: only "2 saal" carries a unit.
    ["2 saal turning, 8 VMC", 2],
    ["ITI 2 saal ki", 2],
    // The shared parser's documented range rule: the figure touching the unit wins.
    ["7-8 saal", 8],
  ])("%j reads %d", (text, years) => {
    expect(typedTenureYears(text)).toBe(years);
  });

  it.each([
    // Two figures with units: which one answers THIS question is not ours to guess.
    ["8 saal VMC, 2 saal turning"],
    // No figure of years at all.
    ["sep 2016 se"],
    ["6 mahine"],
    ["pata nahi"],
    [""],
    // Negated.
    ["5 saal nahi"],
    // Outside the 0–60 bound the chat applies to experience_years.
    ["80 saal"],
  ])("%j derives nothing", (text) => {
    expect(typedTenureYears(text)).toBeNull();
  });
});
