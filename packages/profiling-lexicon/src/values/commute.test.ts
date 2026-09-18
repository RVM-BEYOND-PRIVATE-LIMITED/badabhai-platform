import { describe, expect, it } from "vitest";

import { parseCommuteKm } from "./commute.js";

describe("parseCommuteKm", () => {
  it("reads the digits and the unit", () => {
    expect(parseCommuteKm("20 km")?.value).toBe(20);
    expect(parseCommuteKm("2 kilometre")?.value).toBe(2);
    expect(parseCommuteKm("15 kms tak ja sakta hu")?.value).toBe(15);
  });

  it("reads the number word a worker actually says", () => {
    expect(parseCommuteKm("das kilometer")?.value).toBe(10);
    expect(parseCommuteKm("paanch km")?.value).toBe(5);
    expect(parseCommuteKm("twenty kms")?.value).toBe(20);
  });

  it("reads Devanagari digits", () => {
    expect(parseCommuteKm("१२ किलोमीटर")?.value).toBe(12);
  });

  it("takes the stated upper end of a range, never derives one", () => {
    expect(parseCommuteKm("10 se 20 km")?.value).toBe(20);
    expect(parseCommuteKm("5-10 km")?.value).toBe(10);
  });

  it("reports a span over the quantity+unit, for the negation veto", () => {
    const got = parseCommuteKm("main 12 km ja sakta hu");
    expect(got?.span).toEqual({ start: 5, end: 10 });
    expect(got?.negationVetoed).toBe(false);
  });

  it("refuses a quantity that is not a distance", () => {
    expect(parseCommuteKm("paas mein kaam chahiye")).toBeNull();
    expect(parseCommuteKm("bahut door hai")).toBeNull();
    expect(parseCommuteKm("10 saal ka tajurba")).toBeNull();
    expect(parseCommuteKm("")).toBeNull();
  });

  it("refuses the implausible instead of storing an unmatchable number", () => {
    // Above the page's own 500 km ceiling and below 1 — both are unit/typo confusions.
    expect(parseCommuteKm("2000 km")).toBeNull();
    expect(parseCommuteKm("0 km")).toBeNull();
  });

  it("does not fire mid-word", () => {
    expect(parseCommuteKm("adhas kilometer")).toBeNull();
  });
});
