import { describe, expect, it } from "vitest";

import { titleCaseName, titleCaseRoleLabel } from "./resume-text-case";
import { buildEmploymentBlock } from "./resume-employment-rows";
import { buildLocationLine } from "./resume-sheet-rows";
import { ROLE_FORM_DESCRIPTORS } from "../profiling/roles/role-registry";

/**
 * PROPER-NOUN CASING (owner ruling 2026-09-08).
 *
 * THE TWO HALVES OF THE RULING ARE ONE RULE AND TWO RISKS. Raising `sandhar` to `Sandhar` is the
 * ask; NOT lowering `TVS` to `Tvs` is what makes it safe to apply to a field nobody reviews. Every
 * assertion below is one of those two sentences.
 */
describe("titleCaseName", () => {
  it("raises the first letter of every word — the ruling", () => {
    expect(titleCaseName("sandhar technologies pvt ltd")).toBe("Sandhar Technologies Pvt Ltd");
    expect(titleCaseName("faridabad")).toBe("Faridabad");
    expect(titleCaseName("new delhi")).toBe("New Delhi");
    expect(titleCaseName("shri ram auto-parts (india)")).toBe("Shri Ram Auto-Parts (India)");
    expect(titleCaseName("l&t")).toBe("L&T");
  });

  it("NEVER lowercases — an acronym a worker typed in capitals survives intact", () => {
    // The failure this rules out is worse than the one it fixes: `Tvs` is not the name of the
    // company the worker worked for, and an employer reading it sees a résumé that got his own
    // industry's names wrong.
    expect(titleCaseName("TVS Motors")).toBe("TVS Motors");
    expect(titleCaseName("JBM auto")).toBe("JBM Auto");
    expect(titleCaseName("Dubai, UAE")).toBe("Dubai, UAE");
    expect(titleCaseName("NCVT")).toBe("NCVT");
  });

  it("leaves an apostrophe and a slash alone — both would be mangled by a naive boundary", () => {
    expect(titleCaseName("shri ram's auto works")).toBe("Shri Ram's Auto Works");
    expect(titleCaseName("m/s sharma engineering")).toBe("M/s Sharma Engineering");
  });

  it("adds nothing, drops nothing, and translates nothing", () => {
    // §8. The word is the same word; only its first byte changes. Devanagari has no case, so a
    // name in the worker's own script passes through untouched.
    expect(titleCaseName("फरीदाबाद")).toBe("फरीदाबाद");
    expect(titleCaseName("sandhar")).toBe("Sandhar");
    expect(titleCaseName("  spaced  out  ")).toBe("  Spaced  Out  ");
  });

  it("is total — null, undefined and empty come back unchanged", () => {
    expect(titleCaseName(null)).toBeNull();
    expect(titleCaseName(undefined)).toBeUndefined();
    expect(titleCaseName("")).toBe("");
  });
});

describe("the ruling on the printed sheet", () => {
  it("cases the employer and its city/state in Zone 4", () => {
    const block = buildEmploymentBlock(
      [
        {
          employer: "sandhar technologies pvt ltd",
          employerCity: "gurugram",
          employerState: "haryana",
          startYm: "2023-01",
          endYm: null,
          durationStated: true,
          roles: [{ roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC turning" }],
        },
      ],
      { asOf: new Date("2026-09-08T00:00:00Z"), polishEnabled: false },
    );
    expect(block.employments[0]!.employer).toBe("Sandhar Technologies Pvt Ltd");
    expect(block.employments[0]!.location_suffix).toBe(" · Gurugram, Haryana");
  });

  it("leaves the ROLE and the work line exactly as the worker wrote them", () => {
    // The casing rule is for names and places only. `cnc turner` title-cased reads `Cnc Turner`,
    // which is a misspelt trade, and the work line is verbatim by contract (§8.4).
    const block = buildEmploymentBlock(
      [
        {
          employer: "acme forgings",
          employerCity: null,
          employerState: null,
          startYm: "2022-01",
          endYm: "2023-01",
          durationStated: true,
          roles: [
            {
              roleLabel: "cnc turner",
              startYm: null,
              endYm: null,
              workDone: "lathe pe shaft banata tha",
            },
          ],
        },
      ],
      { asOf: null, polishEnabled: false },
    );
    const row = block.employments[0]!;
    expect(row.employer).toBe("Acme Forgings");
    expect(`${row.role_inline}${row.work ?? ""}`).toContain("cnc turner");
    expect(row.work).toContain("lathe pe shaft banata tha");
  });

  it("leaves the §11 #4 literal alone — it is a guideline label, not a company name", () => {
    // A worker with no company to name gets "Contract work", resolved by capture. Re-casing it
    // would edit a reviewed string; the ruling is about the name of a company the worker typed.
    const block = buildEmploymentBlock(
      [
        {
          employer: "Contract work",
          employerCity: "manesar",
          employerState: null,
          startYm: "2021-01",
          endYm: "2022-01",
          durationStated: true,
          roles: [{ roleLabel: "Fitter", startYm: null, endYm: null, workDone: null }],
        },
      ],
      { asOf: null, polishEnabled: false },
    );
    expect(block.employments[0]!.employer).toBe("Contract work");
    // …while the city beside it is still cased, because that IS a place the worker typed.
    expect(block.employments[0]!.location_suffix).toBe(" · Manesar");
  });

  it("cases the masthead location line the same way", () => {
    expect(buildLocationLine({ city: "faridabad", state: "haryana" })).toBe("Faridabad, Haryana");
    expect(buildLocationLine({ city: "new delhi", state: null })).toBe("New Delhi");
  });
});

/**
 * #1434 — THE HEADLINE'S ROLE, whose author is the model rather than the worker.
 *
 * The reported defect is one screenshot — "CNC turner · 6 yrs 4 mo" — but the interesting half of
 * this suite is the input NEXT to it. `titleCaseName` fixes the reported string and breaks its
 * neighbour, which is why `titleCaseRoleLabel` resolves against the reviewed role vocabulary
 * before it falls back to casing at all.
 */
describe("titleCaseRoleLabel — the model's free-text role", () => {
  it("fixes the reported headline", () => {
    expect(titleCaseRoleLabel("CNC turner")).toBe("CNC Turner");
  });

  it("ALSO fixes the input a casing rule alone gets wrong", () => {
    // THE WHOLE REASON THIS IS NOT `titleCaseName`. That function never lowercases, so it turns
    // "CNC turner" into "CNC Turner" correctly — and turns an all-lowercase "cnc turner" into
    // "Cnc Turner", a misspelt trade on the one page a worker hands across a factory gate. The
    // vocabulary lookup is what makes both inputs land on the reviewed spelling.
    expect(titleCaseName("cnc turner")).toBe("Cnc Turner"); // the hazard, pinned
    expect(titleCaseRoleLabel("cnc turner")).toBe("CNC Turner"); // what we actually print
  });

  it("prints the reviewed spelling for every declared role, however the model cased it", () => {
    for (const descriptor of ROLE_FORM_DESCRIPTORS) {
      const name = descriptor.displayName;
      expect(titleCaseRoleLabel(name.toLowerCase())).toBe(name);
      expect(titleCaseRoleLabel(name.toUpperCase())).toBe(name);
      expect(titleCaseRoleLabel(`  ${name}  `)).toBe(name);
    }
  });

  it("MATCHES THE WHOLE LABEL, never a substring — §8", () => {
    // A worker who is a "CNC turner helper" is not a CNC Turner, and rewriting him into one would
    // be the renderer adding a claim. He keeps his own words, cased and nothing more.
    expect(titleCaseRoleLabel("cnc turner helper")).toBe("Cnc Turner Helper");
    expect(titleCaseRoleLabel("assistant welder")).toBe("Assistant Welder");
  });

  it("cases a trade we have no descriptor for, and never lowercases an acronym", () => {
    expect(titleCaseRoleLabel("tandoor cook")).toBe("Tandoor Cook");
    expect(titleCaseRoleLabel("ITI instructor")).toBe("ITI Instructor");
    expect(titleCaseRoleLabel("HVAC technician")).toBe("HVAC Technician");
  });

  it("is null-safe and leaves Devanagari alone", () => {
    expect(titleCaseRoleLabel(null)).toBeNull();
    expect(titleCaseRoleLabel(undefined)).toBeUndefined();
    expect(titleCaseRoleLabel("")).toBe("");
    expect(titleCaseRoleLabel("वेल्डर")).toBe("वेल्डर");
  });
});
