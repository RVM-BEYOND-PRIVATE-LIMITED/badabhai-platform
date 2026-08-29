import { describe, expect, it } from "vitest";

import { routeToTradeForm, type TradeFormKind } from "./trade-form-router";

/**
 * THE ROUTING TABLE, ASSERTED CASE BY CASE.
 *
 * The regression that matters is NOT "does a turner reach the form" — it is "does anyone else".
 * Every wrong route ends a worker's interview and hands them eighteen questions about a machine
 * they have never touched, so the negative cases outnumber the positive ones deliberately.
 */
function route(
  domain: string | null,
  role: string | null,
  familyId: string | null = null,
): TradeFormKind | null {
  return routeToTradeForm({
    draft: { domain_label: domain, role_label: role, skills: [], experiences: [] },
    occupationFamilyId: familyId,
  });
}

describe("routeToTradeForm", () => {
  describe("routes a turner", () => {
    const turners: readonly (readonly [string, string | null, string | null])[] = [
      ["CNC Machining", "CNC Turner", null],
      ["CNC Machining", "CNC Turner/Operator", null],
      ["Manufacturing", "Turner", null],
      ["CNC Turning", "Operator", null],
      ["Machining", "turning operator", null],
      ["सीएनसी", "टर्नर", null],
      // Machine-only evidence, corroborated by the pin retrieval made independently.
      ["Manufacturing", "lathe operator", "fam_cnc_turning"],
      ["Manufacturing", "khraad chalata hoon", "fam_cnc_turning"],
      ["विनिर्माण", "खराद ऑपरेटर", "fam_cnc_turning"],
    ];
    for (const [domain, role, family] of turners) {
      it(`${JSON.stringify({ domain, role, family })}`, () => {
        expect(route(domain, role, family)).toBe("cnc_turner");
      });
    }
  });

  describe("does not route a machine name on its own", () => {
    // The `signals.py` rule: a lathe is equipment, not an occupation. Without the corroborating
    // pin these fall through to the interview, which is what already handles an unclear trade.
    const uncorroborated: readonly (readonly [string, string])[] = [
      ["Manufacturing", "lathe operator"],
      ["Manufacturing", "khraad par kaam"],
      ["Engineering", "CNC operator"],
      ["Manufacturing", "machine operator"],
    ];
    for (const [domain, role] of uncorroborated) {
      it(`${role} with no pin`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("a lathe term pinned to some OTHER family is still not a turner", () => {
      expect(route("Manufacturing", "lathe operator", "fam_machining")).toBeNull();
    });
  });

  describe("a competing specialisation vetoes the route", () => {
    const conflicted: readonly (readonly [string, string])[] = [
      // The ratified sample's own worker. Milling, not turning — and the sheet proves it.
      ["CNC Machining", "VMC Setter-cum-Operator"],
      ["CNC Machining", "VMC Operator"],
      ["Manufacturing", "milling machine operator"],
      ["Manufacturing", "grinding operator"],
      ["Manufacturing", "drilling operator"],
      // Ambiguous by the worker's own account: keep talking rather than guess which form fits.
      ["CNC Machining", "CNC Turner cum VMC Operator"],
      ["CNC Machining", "turner and milling operator"],
    ];
    for (const [domain, role] of conflicted) {
      it(`${role}`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("vetoes even when the turning family is pinned", () => {
      expect(route("CNC Machining", "CNC Turner cum VMC Operator", "fam_cnc_turning")).toBeNull();
    });
  });

  describe("routes nobody else", () => {
    const others: readonly (readonly [string | null, string | null])[] = [
      ["Retail", "Cashier"],
      ["Transport", "Bus driver"],
      ["Construction", "Electrician"],
      ["Garments", "Tailor"],
      ["Hospitality", "Cook"],
      ["Welding", "MIG welder"],
      [null, null],
      ["", ""],
      [null, "   "],
    ];
    for (const [domain, role] of others) {
      it(`${JSON.stringify({ domain, role })}`, () => {
        expect(route(domain, role, null)).toBeNull();
      });
    }

    it("a pinned turning family alone does not route a label that never mentions turning", () => {
      // The pin corroborates a machine term; it is not evidence by itself. A mis-pin must not be
      // able to end an interview on its own.
      expect(route("Retail", "Cashier", "fam_cnc_turning")).toBeNull();
    });
  });

  describe("substring safety", () => {
    it("does not match a term inside a longer word", () => {
      // "returner" contains "turner"; token-boundary matching is what keeps it out.
      expect(route("Retail", "goods returner")).toBeNull();
    });

    it("matches across punctuation the model may emit", () => {
      expect(route("CNC-Machining", "CNC Turner / Operator")).toBe("cnc_turner");
    });
  });

  it("is pure — the same input routes the same way every time", () => {
    const once = route("CNC Machining", "CNC Turner");
    const twice = route("CNC Machining", "CNC Turner");
    expect(once).toBe(twice);
  });
});
