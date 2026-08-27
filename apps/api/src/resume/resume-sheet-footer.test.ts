import { describe, expect, it } from "vitest";

import { buildSheetFooterMeta, resumeRefCode } from "./resume-sheet-footer";

describe("resume ref code", () => {
  it("is stable across renders of the same résumé", () => {
    // A résumé re-renders on every profile edit. A code that moved would make each regenerated
    // PDF a false diff, and would break the one thing it exists for: quoting it back later.
    expect(resumeRefCode("res-1")).toBe(resumeRefCode("res-1"));
  });

  it("differs between résumés", () => {
    expect(resumeRefCode("res-1")).not.toBe(resumeRefCode("res-2"));
  });

  it("is six characters from the print-unambiguous alphabet", () => {
    // Read aloud on a noisy shop floor and typed from a photocopy: O/0, I/1, S/5, Z/2 and B/8
    // are the pairs that cost a support call, so none of them may appear.
    for (const id of ["res-1", "res-2", "a", "0000", crypto.randomUUID()]) {
      const code = resumeRefCode(id);
      expect(code).toHaveLength(6);
      expect(code, `${code} contains an ambiguous glyph`).toMatch(
        /^[ACDEFGHJKLMNPQRTUVWXY34679]+$/,
      );
    }
  });

  it("is ONE-WAY — the résumé id never appears in the code", () => {
    // The code is printed on a sheet a worker hands to strangers. A slice of the id would make
    // it a lookup key for a row.
    const id = "11111111-2222-3333-4444-555555555555";
    expect(resumeRefCode(id)).not.toContain("1111");
    expect(id.toUpperCase()).not.toContain(resumeRefCode(id));
  });

  it("spreads across the alphabet rather than collapsing onto a few letters", () => {
    // A modulo over a badly-sized alphabet, or a bug that reused one digest byte, still passes
    // every assertion above while making collisions far likelier than 26^6 suggests.
    const codes = new Set<string>();
    for (let i = 0; i < 500; i += 1) codes.add(resumeRefCode(`res-${i}`));
    expect(codes.size).toBe(500);
    const letters = new Set([...codes].join("").split(""));
    expect(letters.size).toBeGreaterThan(20);
  });
});

describe("sheet footer meta", () => {
  const AT = new Date("2026-08-27T12:00:00Z");

  it("spells the date out, so a page read months later is unambiguous", () => {
    // 07/08 is a different day depending on who is holding the sheet.
    expect(buildSheetFooterMeta({ generatedAt: AT, trustBadge: null, refCode: null })).toBe(
      "Generated 27 August 2026",
    );
  });

  it("joins the segments the design uses", () => {
    expect(
      buildSheetFooterMeta({ generatedAt: AT, trustBadge: "Self-declared", refCode: "RK8M2Q" }),
    ).toBe("Generated 27 August 2026  ·  Self-declared  ·  Ref RK8M2Q");
  });

  it("DROPS an empty segment WITH its separator", () => {
    // The failure this prevents is a trailing "  ·  " on a printed résumé, which reads as a
    // rendering fault, and an unverified worker acquiring a conspicuous empty slot where a
    // verification tier would sit.
    const noBadge = buildSheetFooterMeta({ generatedAt: AT, trustBadge: "", refCode: "RK8M2Q" });
    expect(noBadge).toBe("Generated 27 August 2026  ·  Ref RK8M2Q");
    expect(noBadge).not.toMatch(/·\s*$/);
    expect(noBadge).not.toMatch(/·\s+·/);

    const whitespaceOnly = buildSheetFooterMeta({
      generatedAt: AT,
      trustBadge: "   ",
      refCode: "  ",
    });
    expect(whitespaceOnly).toBe("Generated 27 August 2026");
  });

  it("renders the IST calendar day, not the UTC one", () => {
    // A render at 19:30 UTC is already the next day in India, which is where every worker and
    // every employer reading this sheet actually is.
    const lateEvening = new Date("2026-08-27T19:30:00Z");
    expect(buildSheetFooterMeta({ generatedAt: lateEvening })).toBe("Generated 28 August 2026");
  });
});
