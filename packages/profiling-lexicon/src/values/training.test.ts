import { describe, expect, it } from "vitest";

import { parseTrainingYear } from "./training.js";

describe("parseTrainingYear", () => {
  it("reads a four-digit year", () => {
    expect(parseTrainingYear("2019")?.value).toBe(2019);
    expect(parseTrainingYear("training 2019 mein ki thi")?.value).toBe(2019);
  });

  it("reads Devanagari digits", () => {
    expect(parseTrainingYear("२०१८ में की")?.value).toBe(2018);
  });

  it("reports a span over the year digits", () => {
    const got = parseTrainingYear("2019 me ki");
    expect(got?.span).toEqual({ start: 0, end: 4 });
    expect(got?.negationVetoed).toBe(false);
  });

  it("refuses a year the worker_training CHECK would reject", () => {
    // `wt_year_chk` is 1950..2100; a refused value must leave the question askable, not fail the
    // insert at write time.
    expect(parseTrainingYear("1949")).toBeNull();
    expect(parseTrainingYear("2101")).toBeNull();
  });

  it("refuses a number that merely contains four digits", () => {
    expect(parseTrainingYear("12019")).toBeNull();
    expect(parseTrainingYear("20190")).toBeNull();
    expect(parseTrainingYear("1000")).toBeNull();
    expect(parseTrainingYear("")).toBeNull();
  });
});
