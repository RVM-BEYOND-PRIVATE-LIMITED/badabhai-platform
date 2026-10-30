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

  it("prints the rung LAST, and only when the worker stated one (Middle Way P5)", () => {
    expect(
      buildProfileHeadline({
        role: "CNC Turner",
        years: 6,
        tools: ["Fanuc"],
        level: "Setter",
      }),
    ).toBe("CNC Turner · 6 yrs · Fanuc · Setter");
    // Absent rung takes its separator with it — every pre-P5 render is byte-identical.
    expect(
      buildProfileHeadline({ role: "CNC Turner", years: 6, tools: ["Fanuc"], level: null }),
    ).toBe("CNC Turner · 6 yrs · Fanuc");
    expect(
      buildProfileHeadline({ role: "CNC Turner", years: 6, tools: ["Fanuc"], level: "   " }),
    ).toBe("CNC Turner · 6 yrs · Fanuc");
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

  it("slots the rung before the city (Middle Way P5)", () => {
    expect(
      buildProfileSummary({
        role: "CNC Turner",
        years: 8,
        tools: ["Fanuc"],
        level: "Setter",
        city: "Faridabad",
      }),
    ).toBe("CNC Turner · 8 yrs · Fanuc · Setter · Faridabad");
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
