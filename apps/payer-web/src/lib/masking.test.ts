import { describe, expect, it } from "vitest";
import { bandLabel, maskedInitials, monthsLabel, opaqueId } from "./masking";

describe("maskedInitials — 1–2 uppercase initials, '?' fallback", () => {
  it("takes the first + last word initials for a multi-word label", () => {
    expect(maskedInitials("Acme Tools")).toBe("AT");
    expect(maskedInitials("a b c d")).toBe("AD"); // first + last only, never the middle
  });

  it("takes a single initial for a one-word label", () => {
    expect(maskedInitials("cnc")).toBe("C");
    expect(maskedInitials("Pune")).toBe("P");
  });

  it("uppercases the result", () => {
    expect(maskedInitials("acme tools")).toBe("AT");
  });

  it("falls back to '?' for empty / whitespace / undefined", () => {
    expect(maskedInitials("")).toBe("?");
    expect(maskedInitials("   ")).toBe("?");
    expect(maskedInitials(undefined)).toBe("?");
  });

  it("collapses repeated inner whitespace", () => {
    expect(maskedInitials("Acme    Tools")).toBe("AT");
  });

  it("never returns more than two characters (cannot reconstruct a name)", () => {
    expect(maskedInitials("One Two Three Four Five").length).toBeLessThanOrEqual(2);
  });
});

describe("opaqueId — truncated opaque-id chip text", () => {
  it("takes the first 8 chars + a horizontal ellipsis by default", () => {
    expect(opaqueId("3f2a9c1e-7b4d-4a11-9c2e-aabbccddeeff")).toBe("3f2a9c1e…");
  });

  it("honours a custom length", () => {
    expect(opaqueId("abcdef123456", 4)).toBe("abcd…");
  });

  it("returns a short id whole (still suffixed) — it is opaque either way", () => {
    expect(opaqueId("abc")).toBe("abc…");
  });
});

describe("bandLabel — middot-joined non-PII fragments, empties dropped", () => {
  it("joins present fragments with the DS middot", () => {
    expect(bandLabel(["6–10 yrs", "Pune"])).toBe("6–10 yrs · Pune");
  });

  it("drops nullish / empty parts", () => {
    expect(bandLabel([undefined, "Pune"])).toBe("Pune");
    expect(bandLabel(["6–10 yrs", null])).toBe("6–10 yrs");
    expect(bandLabel(["", "Pune", undefined])).toBe("Pune");
  });

  it("returns an empty string when nothing survives the filter", () => {
    expect(bandLabel([])).toBe("");
    expect(bandLabel([undefined, null, ""])).toBe("");
  });
});

describe("monthsLabel — ADR-0036 bucketed months as a COARSE label", () => {
  it("reads whole years back, with a 6-month half-step", () => {
    expect(monthsLabel(12)).toBe("1 yr");
    expect(monthsLabel(24)).toBe("2 yrs");
    expect(monthsLabel(48)).toBe("4 yrs");
    expect(monthsLabel(54)).toBe("4.5 yrs");
    expect(monthsLabel(18)).toBe("1.5 yrs");
  });

  it("keeps sub-year values in months (the bucket floor is 6)", () => {
    expect(monthsLabel(6)).toBe("6 mo");
  });

  it("NEVER renders more precision than the 6-month bucket supports", () => {
    // The stored number is already floored to a bucket; a raw "47 months" on screen
    // would put back exactly the precision the bucketing removed. Even if an unbucketed
    // value somehow arrived, the label must not expose it.
    expect(monthsLabel(47)).toBe("3.5 yrs");
    expect(monthsLabel(59)).toBe("4.5 yrs");
  });

  it("ROUNDS DOWN — a worker's own estimate is never inflated on a paid screen", () => {
    expect(monthsLabel(23)).toBe("1.5 yrs"); // not "2 yrs"
    expect(monthsLabel(11)).toBe("11 mo"); // not "1 yr"
  });

  it("renders nothing for unknown / zero / nonsense (never '0 yrs')", () => {
    expect(monthsLabel(0)).toBe("");
    expect(monthsLabel(null)).toBe("");
    expect(monthsLabel(undefined)).toBe("");
    expect(monthsLabel(-6)).toBe("");
    expect(monthsLabel(Number.NaN)).toBe("");
    expect(monthsLabel(Number.POSITIVE_INFINITY)).toBe("");
  });
});
