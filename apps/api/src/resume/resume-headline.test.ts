import { describe, expect, it } from "vitest";

import { buildProfileHeadline, buildProfileSummary } from "./resume-headline";

/**
 * Layer A (h) — the deterministic builders, pinned.
 *
 * The gate that guards the printed atoms lives in `resume-fabrication.gate.test.ts`; these cases
 * pin the COMPOSITION: which segments exist, what separator joins them, and what each absence
 * does (and does not) do.
 */
describe("buildProfileHeadline — role · tenure · tools", () => {
  it("joins all three segments with the sheet's separator", () => {
    expect(
      buildProfileHeadline({ role: "CNC Turner", years: 5.25, tools: ["Fanuc", "Siemens"] }),
    ).toBe("CNC Turner · 5 yrs 3 mo · Fanuc, Siemens");
  });

  it("an absent segment takes its separator with it", () => {
    expect(buildProfileHeadline({ role: "Welder", years: null, tools: [] })).toBe(
      "Welder · duration not stated",
    );
    expect(buildProfileHeadline({ role: "Welder", years: 2, tools: [] })).toBe("Welder · 2 yrs");
    expect(
      buildProfileHeadline({
        role: "Fresher Role",
        years: null,
        tenureLabel: "Fresher",
        tools: [],
      }),
    ).toBe("Fresher Role · Fresher");
  });

  it("caps tools at three, the guideline's controller cap", () => {
    expect(
      buildProfileHeadline({
        role: "Miller",
        years: 1,
        tools: ["A", "B", "C", "D"],
      }),
    ).toBe("Miller · 1 yr · A, B, C");
  });

  it("NULL WITHOUT A ROLE — modifiers of nobody are not a headline", () => {
    expect(buildProfileHeadline({ role: null, years: 8, tools: ["Fanuc"] })).toBeNull();
    expect(buildProfileHeadline({ role: "   ", years: 8, tools: [] })).toBeNull();
  });
});

describe("buildProfileSummary — the headline plus the city", () => {
  it("joins role · tenure · tools · city", () => {
    expect(
      buildProfileSummary({
        role: "CNC Turner",
        years: 8,
        tools: ["Fanuc"],
        city: "Faridabad",
      }),
    ).toBe("CNC Turner · 8 yrs · Fanuc · Faridabad");
  });

  it("a missing city takes its separator and nothing else", () => {
    expect(buildProfileSummary({ role: "Welder", years: 3, tools: [], city: null })).toBe(
      "Welder · 3 yrs",
    );
  });

  it("has the same role-required policy as the headline", () => {
    expect(buildProfileSummary({ role: null, years: 3, tools: [], city: "Pune" })).toBeNull();
  });

  it("is deterministic — the same facts produce the same string", () => {
    const facts = { role: "Plumber", years: 4.5, tools: ["PPR", "CPVC"], city: "Rajkot" };
    expect(buildProfileSummary(facts)).toBe(buildProfileSummary(facts));
  });
});
