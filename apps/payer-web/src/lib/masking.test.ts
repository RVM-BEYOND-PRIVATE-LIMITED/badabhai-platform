import { describe, expect, it } from "vitest";
import { bandLabel, maskedInitials, opaqueId } from "./masking";

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
