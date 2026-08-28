import { describe, expect, it } from "vitest";

import {
  CHARS_PER_LINE,
  degradeToFit,
  HEADROOM_FLOOR_MM,
  LADDER,
  LINE_MM,
  NEVER_DROPPED,
  rowLines,
  sheetContentLines,
  SHEET_LINE_BUDGET,
  topQualificationLine,
  type DegradableSheet,
} from "./resume-degradation";
import { CAPABILITY_ROW_BUDGET, TRADE_RESUME_MAPS } from "./trade-resume-map";

/**
 * THE DEGRADATION LADDER — what leaves the sheet when it will not fit, and in what order.
 *
 * These are the properties the ladder has to hold no matter what content arrives. The millimetre
 * question — "does the resulting sheet actually fit" — is NOT asked here and cannot be: it needs
 * WeasyPrint, which is Docker-only on this host. That half is `scripts/measure-sheet-headroom.py`
 * over all 56 emitted sheets, and the two together are what "one page" is verified by. Neither
 * alone is enough, and saying so is the point: this file proves the DECISION is sound, the
 * harness proves the decision's CALIBRATION is still true.
 */

function sheet(over: Partial<DegradableSheet> = {}): DegradableSheet {
  return {
    displayName: "Ramesh Kumar Yadav",
    capSectionTitle: "MACHINES, CONTROLLERS & CAPABILITY",
    capChipRows: [],
    capTickRows: [],
    capFactRows: [],
    availFactRows: [],
    qualFactRows: [],
    qualTickRows: [],
    employments: [],
    employmentsMore: null,
    experiences: [],
    ...over,
  };
}

/** A capability row carrying its §5.1 rank, as `buildTradeCapabilityRows` emits it. */
function capRow(key: string, rank: number, values: string[] = ["x"]) {
  return { label: key, values, key, rank };
}

describe("the cost model is calibrated, and the calibration is stated", () => {
  it("prices a row by its wrap, not by counting rows", () => {
    // A fact row and a chips row that wraps to three lines are not the same size, which is the
    // whole reason the budget is denominated in lines. `CAPABILITY_ROW_BUDGET` counts rows and
    // is a different rule (§4.3's per-section cap) — the two coexist deliberately.
    expect(rowLines("Machines", "CNC lathe")).toBe(1);
    expect(rowLines("Operations", "x".repeat(CHARS_PER_LINE * 2))).toBe(3);
    expect(CAPABILITY_ROW_BUDGET).toBe(9);
  });

  it("counts section chrome, because a sheet with fewer sections has more room", () => {
    const withCap = sheetContentLines(sheet({ capSectionTitle: "CAPABILITY" }));
    const withoutCap = sheetContentLines(sheet({ capSectionTitle: null }));
    expect(withCap).toBeGreaterThan(withoutCap);
  });

  it("charges a wrapped 18pt name more than a short one (§11 #9)", () => {
    // The term that was MISSING in the first pass, and its absence made the model confidently
    // wrong on exactly the shape that mattered: it predicted the long-name sheet as roomier than
    // one that measured 9.87mm, while the long-name sheet measured 0.00mm.
    const short = sheetContentLines(sheet({ displayName: "Ramesh Kumar" }));
    const long = sheetContentLines(
      sheet({ displayName: "Venkataramanan Subrahmanya Krishnamurthy Iyengar" }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it("keeps the floor above the largest measured renderer variance", () => {
    // 3.64mm is the largest movement observed across WeasyPrint 63.1/66.0/69.0 and a DejaVu
    // font fallback. A floor at or below it would be a floor that the variance alone can breach.
    expect(HEADROOM_FLOOR_MM).toBeGreaterThan(3.64);
    // ...and it is worth about one shed line, the smallest unit the page can actually give back.
    expect(HEADROOM_FLOOR_MM / LINE_MM).toBeGreaterThan(0.9);
  });
});

describe("the ladder", () => {
  it("does nothing at all when the sheet already fits", () => {
    const s = sheet({ capFactRows: [{ label: "Tolerance held", value: "±0.01 mm" }] });
    const r = degradeToFit(s);
    expect(r.stage).toBe(0);
    expect(r.dropped).toEqual([]);
    expect(r.sheet.capFactRows).toEqual(s.capFactRows);
  });

  it("is deterministic — the same input yields the same drop set", () => {
    const build = () =>
      sheet({
        capChipRows: Array.from({ length: 8 }, (_, i) => capRow(`k${i}`, 20 + i, ["a", "b", "c"])),
        qualTickRows: [{ label: "Documents ready", values: ["Aadhaar", "PAN", "UAN"] }],
        qualFactRows: [{ label: "Languages spoken", value: "Hindi · Haryanvi · English" }],
        employments: Array.from({ length: 4 }, () => ({
          employer: "Sandhar Technologies Limited",
          location_suffix: ", Manesar",
          role_inline: " — CNC Turner",
          when: "Apr 2022 – Present · 3 yrs",
          work: "Setting and running twin-spindle lathes on steering housings",
          roles: [],
        })),
      });
    const a = degradeToFit(build());
    const b = degradeToFit(build());
    expect(a.stage).toBe(b.stage);
    expect(a.dropped).toEqual(b.dropped);
    expect(JSON.stringify(a.sheet)).toBe(JSON.stringify(b.sheet));
  });

  it("stops at the FIRST stage that fits — it drops the minimum, not the tail", () => {
    // One line over budget must cost one effective step, never a cascade. The failure this
    // catches is a ladder that runs to completion and hands back a sheet stripped to the bone
    // because nothing told it to stop.
    const s = sheet({
      capChipRows: Array.from({ length: 40 }, (_, i) => capRow(`k${i}`, 20 + i)),
    });
    const over = sheetContentLines(s) - SHEET_LINE_BUDGET;
    expect(over).toBeGreaterThan(0);
    const r = degradeToFit(s);
    expect(sheetContentLines(r.sheet)).toBeLessThanOrEqual(SHEET_LINE_BUDGET);
    // It removed what it needed and then halted: one more step would put it under by more.
    expect(r.dropped.length).toBeLessThanOrEqual(over + 1);
  });

  it("takes the turner-pack additions before anything the guideline ranks", () => {
    // The R1 §3 default, in order: optional volunteered fields, production mode, sector tag,
    // materials beyond two — and only then reverse §5.1. Pinned because it is trade truth
    // flagged for RVM redline (NEEDS_PRAKASH Q2), not a layout preference someone may reorder.
    const order = LADDER.map((s) => s.what);
    expect(order.slice(0, 4)).toEqual([
      "optional volunteered fields",
      "production mode",
      "sector worked",
      "materials chips beyond two",
    ]);
    expect(order.indexOf("sector worked")).toBeLessThan(order.indexOf("languages"));
    expect(order.indexOf("languages")).toBeLessThan(order.indexOf("education"));
    expect(order.indexOf("education")).toBeLessThan(order.indexOf("employers beyond three"));
  });

  it("sheds capability rows by DESCENDING §5.1 rank — least decisive first", () => {
    const s = sheet({
      capChipRows: [capRow("turning_machine", 21), capRow("sector_worked", 81)],
      capFactRows: Array.from({ length: 40 }, (_, i) => ({
        label: `f${i}`,
        value: "x",
        key: `f${i}`,
        rank: 70,
      })),
    });
    const r = degradeToFit(s);
    const survivingKeys = [...(r.sheet.capChipRows ?? []), ...(r.sheet.capFactRows ?? [])].map(
      (row) => (row as { key?: string }).key,
    );
    // Machines is §5.1 rank 2 — "the literal vocabulary of the job advertisement". It is the last
    // thing that should ever go, and sector_worked (§4.3: display only, never a matching input)
    // is the first.
    expect(survivingKeys).toContain("turning_machine");
    expect(survivingKeys).not.toContain("sector_worked");
  });

  it("counts collapsed employers rather than deleting them silently (§11 #7)", () => {
    const s = sheet({
      capChipRows: Array.from({ length: 30 }, (_, i) => capRow(`k${i}`, 20 + i)),
      employments: Array.from({ length: 4 }, () => ({
        employer: "Rico Auto Industries Limited",
        location_suffix: ", Gurugram",
        role_inline: " — CNC Turner",
        when: "Jun 2019 – Mar 2022 · 2 yrs 10 mo",
        work: "Bar-fed turning of aluminium housings",
        roles: [],
      })),
    });
    const r = degradeToFit(s);
    if ((r.sheet.employments ?? []).length < 4) {
      // A man with four jobs whose sheet shows two and says nothing reads as though he hid
      // something. The count line is what makes the drop honest, so it must exist whenever the
      // drop happened.
      expect(r.sheet.employmentsMore).toMatch(/^\d+ earlier employers/);
    }
  });

  it("runs out of ladder rather than throwing", () => {
    // A pathological profile gets a two-page résumé, which is a bad sheet. An exception gets them
    // NO sheet. The harness is what catches this in CI; the runtime has to degrade.
    const s = sheet({
      capFactRows: Array.from({ length: 400 }, (_, i) => ({
        label: `f${i}`,
        value: "x".repeat(200),
        key: `f${i}`,
        rank: 50,
      })),
    });
    expect(() => degradeToFit(s)).not.toThrow();
    expect(degradeToFit(s).stage).toBeGreaterThan(0);
  });
});

describe("what may never be dropped", () => {
  it("names the protected elements positively, and no ladder step touches one", () => {
    // "We never wrote a step for it" is the ABSENCE of a guarantee, not a guarantee. The next
    // person adding a stage under page pressure reads this list.
    expect([...NEVER_DROPPED]).toEqual([
      "verdict_line",
      "display_name",
      "availability",
      "expected_salary",
      "trust_badge",
      "qr_footer",
      "top_qualification",
    ]);
    const steps = LADDER.map((s) => s.what.toLowerCase()).join(" | ");
    for (const protectedKey of ["verdict", "salary", "badge", "qr"]) {
      expect(steps).not.toContain(protectedKey);
    }
  });

  it("leaves the Verdict Line, the terms row and the footer untouched at the deepest stage", () => {
    const s = sheet({
      availFactRows: [
        { label: "Available from", value: "Immediate" },
        { label: "Salary expected", value: "₹24,000 – ₹28,000" },
      ],
      capFactRows: Array.from({ length: 200 }, (_, i) => ({
        label: `f${i}`,
        value: "x".repeat(120),
        key: `f${i}`,
        rank: 50,
      })),
    });
    const r = degradeToFit(s);
    expect(r.stage).toBeGreaterThan(0);
    // §5.1 rank 6 — two of the four things that actually reject a blue-collar candidate. They
    // survive a sheet stripped of everything the ladder is allowed to take.
    expect(r.sheet.availFactRows).toEqual(s.availFactRows);
    expect(r.sheet.displayName).toBe("Ramesh Kumar Yadav");
  });

  it("never shrinks type or truncates to fit — the ladder only removes whole elements", () => {
    // §6.3 floors and §11 #9 both forbid the obvious alternative. There is no font-size or
    // ellipsis anywhere in this module, and that absence is asserted rather than assumed.
    const steps = LADDER.map((s) => s.what).join(" ");
    expect(steps).not.toMatch(/truncat|abbrev|shrink|font|ellipsis|smaller/i);
  });
});

describe("the credential floor — one qualification line is never dropped (Q2 ruling)", () => {
  /** A sheet that is far over budget, with the credential in the Education row. */
  const credentialled = (educationValue: string) =>
    sheet({
      capFactRows: Array.from({ length: 60 }, (_, i) => ({
        label: `f${i}`,
        value: "x".repeat(100),
        key: `f${i}`,
        rank: 50,
      })),
      qualFactRows: [
        { label: "Education", value: educationValue },
        { label: "Certificates", value: "National Trade Certificate (NTC) — Turner — NCVT — 2015" },
        { label: "Languages spoken", value: "Hindi · Haryanvi" },
      ],
      qualTickRows: [{ label: "Documents ready", values: ["Aadhaar", "PAN"] }],
    });

  it("keeps the highest ITI/NCVT line after the whole credentials block is shed", () => {
    const r = degradeToFit(credentialled("ITI — Turner · NCVT, 2014 · Government ITI Faridabad"));
    const values = (r.sheet.qualFactRows ?? []).map((row) => row.value);
    // The block went; the credential floor did not. A young worker whose certificate IS the
    // signal must not arrive at the gate with a sheet that no longer mentions it.
    expect(r.dropped).toContain("education");
    expect(values.join(" | ")).toContain("ITI — Turner");
    // The Education ROW is gone; what survives is the reserved line under its own label.
    expect((r.sheet.qualFactRows ?? []).map((row) => row.label)).toContain("Qualification");
  });

  it("reserves ONE line, not the row it came from", () => {
    const r = degradeToFit(credentialled("ITI — Turner · NCVT, 2014 · Government ITI Faridabad"));
    const values = (r.sheet.qualFactRows ?? []).map((row) => row.value).join(" | ");
    // ~5mm was the costed price and one line is what that buys. The issuer and the year go.
    expect(values).not.toContain("Government ITI Faridabad");
    expect(values).not.toContain("NCVT, 2014");
  });

  it("protects NOTHING when there is no credential to protect", () => {
    // "10th pass" is not a credential floor, and reserving it would be a larger promise than the
    // one that was ruled — it would also cost a line on the sheets that can least afford one.
    const r = degradeToFit(credentialled("10th pass · Government High School"));
    const values = (r.sheet.qualFactRows ?? []).map((row) => row.value).join(" | ");
    expect(r.dropped).toContain("education");
    expect(values).not.toContain("10th pass");
  });

  it("falls back to the certificate when education carries no credential", () => {
    const r = degradeToFit(credentialled("10th pass"));
    const values = (r.sheet.qualFactRows ?? []).map((row) => row.value).join(" | ");
    expect(values).toContain("NCVT");
  });

  it("survives the deepest stage, like availability and salary do", () => {
    const s = credentialled("ITI — Turner · NCVT, 2014");
    s.availFactRows = [{ label: "Salary expected", value: "₹24,000" }];
    const r = degradeToFit(s);
    expect(r.stage).toBeGreaterThan(4);
    expect((r.sheet.qualFactRows ?? []).map((row) => row.value).join(" | ")).toContain("ITI");
    expect(r.sheet.availFactRows).toEqual(s.availFactRows);
  });

  it("reads it as a whole word, so a random word containing the letters is not a credential", () => {
    expect(
      topQualificationLine(sheet({ qualFactRows: [{ label: "Education", value: "Kaviti" }] })),
    ).toBeNull();
    expect(
      topQualificationLine(
        sheet({ qualFactRows: [{ label: "Education", value: "iti — Turner" }] }),
      ),
    ).toBe("iti — Turner");
  });
});

describe("the ladder covers the trade map it is ordered against", () => {
  it("can shed every capability row the turner pack can produce", () => {
    // If the map grows a row and the ladder's repeat count does not, a maxed-out worker's sheet
    // would run out of ladder before it ran out of rows.
    const turner = TRADE_RESUME_MAPS.find((m) => m.pack_id === "qp_cnc_turning");
    expect(turner).toBeDefined();
    const rankSteps = LADDER.filter((s) => s.what.includes("reverse §5.1")).length;
    expect(rankSteps).toBeGreaterThanOrEqual(turner!.capability.length);
  });
});
