import { describe, expect, it } from "vitest";

import {
  CHARS_PER_LINE,
  COMPRESSING_LADDER,
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
    // TEN, RE-MEASURED. Counting the capability rows on all twenty-one pages of
    // `BadaBhai_21_Role_Resumes.pdf` puts the ceiling at ten — grinding, turning and milling all
    // reach it. The nine this line used to name came from three sheets, none of which was one of
    // those three, and the cost of the stale number was the grinder's "Sector worked" row.
    expect(CAPABILITY_ROW_BUDGET).toBe(10);
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

  it("stops at the FIRST stage that fits — it compresses the minimum, not the tail", () => {
    // One line over budget must cost one effective step, never a cascade. The failure this
    // catches is a ladder that runs to completion and hands back a sheet stripped to the bone
    // because nothing told it to stop.
    //
    // DRIVEN THROUGH EMPLOYMENTS RATHER THAN CAPABILITY ROWS, and the change of fixture is the
    // 2026-09-03 ruling rather than a convenience: shedding a capability row is now forbidden, so
    // a sheet made of forty of them exercises no step at all. "Employers beyond three" is the
    // only compression a sheet can actually spend, which makes it the only fixture that can still
    // ask this question.
    const s = sheet({
      capChipRows: Array.from({ length: 22 }, (_, i) => capRow(`k${i}`, 20 + i)),
      employments: Array.from({ length: 5 }, () => ({
        employer: "Sandhar Technologies Limited",
        location_suffix: ", Manesar",
        role_inline: " — CNC Turner",
        when: "Apr 2022 – Present · 3 yrs",
        work: "Setting and running twin-spindle lathes on steering housings",
        roles: [],
      })),
    });
    expect(sheetContentLines(s)).toBeGreaterThan(SHEET_LINE_BUDGET);
    const r = degradeToFit(s);
    expect(sheetContentLines(r.sheet)).toBeLessThanOrEqual(SHEET_LINE_BUDGET);
    expect(r.overflows).toBe(false);
    // It compressed what it needed and then halted, rather than running the tail.
    expect(r.dropped).toEqual(["employers beyond three"]);
    expect(r.sheet.capChipRows).toHaveLength(22);
  });

  it("returns an OVERFLOWING sheet rather than shedding a ratified row (2026-09-03 ruling)", () => {
    // THE RULING, AS A UNIT TEST. Forty capability rows cannot be compressed by anything the
    // ladder is still allowed to do — the only steps left match keys no pack defines and an
    // employment list this sheet does not have. Before the ruling this walked the capability
    // rungs and returned a stripped sheet that fitted. It must now return the sheet INTACT and
    // report that it spills.
    const s = sheet({
      capChipRows: Array.from({ length: 40 }, (_, i) => capRow(`k${i}`, 20 + i)),
    });
    const r = degradeToFit(s);
    expect(r.stage).toBe(0);
    expect(r.dropped).toEqual([]);
    expect(r.sheet.capChipRows).toHaveLength(40);
    expect(r.overflows).toBe(true);
    expect(r.overBudgetLines).toBe(Number((sheetContentLines(s) - SHEET_LINE_BUDGET).toFixed(2)));
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

  it("still ORDERS its capability rungs by descending §5.1 rank, though it may no longer run them", () => {
    // ASSERTED ON THE STEP, NOT THROUGH `degradeToFit`, and that is the ruling rather than a
    // weakening. The 2026-09-03 ruling forbade EXECUTING these rungs; it did not re-rank them,
    // and the order is a ruled artefact flagged for RVM redline. Driving this through the ladder
    // would now assert nothing, because the ladder never reaches the rung — so the rung itself is
    // asserted, together with the fact that it is forbidden.
    const rung = LADDER.find((step) => step.what.startsWith("capability row 1"));
    expect(rung, "the capability rungs must still exist, in order").toBeDefined();
    expect(rung!.effect).toBe("sheds-a-ratified-row");

    const s = sheet({
      capChipRows: [capRow("turning_machine", 21), capRow("sector_worked", 81)],
    });
    rung!.apply(s);
    const survivingKeys = (s.capChipRows ?? []).map((row) => (row as { key?: string }).key);
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
      //
      // SINGULAR OR PLURAL, and the `s?` is not cosmetic: this fixture collapses four employers
      // to three, so the count is ONE, and "1 earlier employers" is a grammatical error printed
      // on a worker's résumé. `overflowLine` in the mapper already singularises; the ladder now
      // agrees with it.
      expect(r.sheet.employmentsMore).toMatch(/^\d+ earlier employers?$/);
      expect(r.sheet.employmentsMore).toBe("1 earlier employer");
    }
  });

  it("runs out of PERMITTED ladder rather than throwing, and says the sheet spilled", () => {
    // A pathological profile gets a two-page résumé, which is a bad sheet. An exception gets them
    // NO sheet. The harness is what catches this in CI; the runtime has to degrade.
    //
    // SINCE THE RULING THIS IS THE ORDINARY EXIT, not the pathological one, and the sheet comes
    // back at stage 0: there is nothing here a permitted step can compress, so nothing is spent
    // and nothing is lost. The one thing that must never happen is silence about it.
    const s = sheet({
      capFactRows: Array.from({ length: 400 }, (_, i) => ({
        label: `f${i}`,
        value: "x".repeat(200),
        key: `f${i}`,
        rank: 50,
      })),
    });
    expect(() => degradeToFit(s)).not.toThrow();
    const r = degradeToFit(s);
    expect(r.stage).toBe(0);
    expect(r.sheet.capFactRows).toHaveLength(400);
    expect(r.overflows).toBe(true);
    expect(r.overBudgetLines).toBeGreaterThan(0);
  });
});

describe("the ladder's classification — which steps may still run, and why", () => {
  /**
   * THE 2026-09-03 RULING, PINNED. "The ladder still compresses as hard as it can — but when a
   * sheet STILL will not fit, it SPILLS ONTO PAGE 2 instead of shedding a ratified row."
   *
   * Every step was classified against `BadaBhai_21_Role_Resumes.pdf` and against the `gain` it
   * measurably produces. These tests are what stop the classification drifting back into "the
   * first few steps are cheap", which is what it looked like before anyone counted.
   */
  it("permits exactly three steps, and they are not a prefix of the order", () => {
    // NOT CONTIGUOUS, and that is the whole reason the tag exists rather than an index. A reader
    // who assumed "the early steps are the safe ones" would re-admit `sector worked` — which all
    // twenty-one ratified pages print — while excluding `employers beyond three`, which none of
    // them can even reach.
    expect(COMPRESSING_LADDER.map((s) => s.what)).toEqual([
      "optional volunteered fields",
      "production mode",
      "employers beyond three",
    ]);
    const order = LADDER.map((s) => s.what);
    expect(order.indexOf("employers beyond three")).toBeGreaterThan(order.indexOf("languages"));
  });

  it("gives EVERY step an effect and a stated reason", () => {
    // A tag with no evidence behind it is an opinion. Re-classifying a step then means arguing
    // with a recorded measurement rather than editing an enum.
    for (const step of LADDER) {
      expect(["compresses", "sheds-a-ratified-row"], step.what).toContain(step.effect);
      expect(step.why.trim().length, `${step.what}: no reason recorded`).toBeGreaterThan(60);
    }
  });

  it("never applies a forbidden step, whatever the sheet", () => {
    // THE PROPERTY, not a spot check. Anything `degradeToFit` reports having dropped must be a
    // step the ruling permits — on a sheet built to be far past every budget it has.
    const forbidden = new Set(
      LADDER.filter((s) => s.effect === "sheds-a-ratified-row").map((s) => s.what),
    );
    const s = sheet({
      capChipRows: Array.from({ length: 30 }, (_, i) => capRow(`k${i}`, 20 + i, ["a", "b", "c"])),
      capFactRows: [
        { label: "Sector worked", value: "Automotive", key: "sector_worked", rank: 81 },
      ],
      qualFactRows: [
        { label: "Education", value: "ITI — Turner · NCVT, 2014" },
        { label: "Certificates", value: "NTC — Turner — NCVT — 2015" },
        { label: "Languages spoken", value: "Hindi · Haryanvi" },
      ],
      qualTickRows: [{ label: "Documents ready", values: ["Aadhaar", "PAN", "UAN"] }],
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
    expect(r.dropped.filter((what) => forbidden.has(what))).toEqual([]);
    // The rows the forbidden steps would have taken are all still on the sheet.
    expect((r.sheet.qualFactRows ?? []).map((row) => row.label)).toEqual([
      "Education",
      "Certificates",
      "Languages spoken",
    ]);
    expect(r.sheet.qualTickRows).toHaveLength(1);
    expect((r.sheet.capFactRows ?? []).map((row) => row.label)).toContain("Sector worked");
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
    // UNDER REAL PAGE PRESSURE, which is what `stage > 0` used to stand in for. Since the ruling
    // this sheet comes back at stage 0 — there is nothing on it a permitted step may touch — so
    // the pressure has to be asserted directly, and it is the spill that proves it.
    expect(r.overflows).toBe(true);
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

/**
 * THE CREDENTIAL FLOOR (Q2 ruling), AND WHAT THE 2026-09-03 RULING DID TO IT.
 *
 * Q2 reserved ONE credential line against a ladder that was allowed to shed the whole credentials
 * block. The 2026-09-03 ruling forbids shedding those rows at all, so the floor is now a floor
 * under a floor: the Education row survives INTACT — issuer and year included — and the reserved
 * line is never reached through `degradeToFit`.
 *
 * THE RIDER STAYS, AND SO DO THESE TESTS. `preserveTopQualification` still runs after every step,
 * because it is the guarantee that survives a future ruling re-permitting a Zone-5 rung; deleting
 * it would leave the Q2 promise resting on the absence of a step, which is precisely what
 * `NEVER_DROPPED` exists to say is not a guarantee. What changes below is that the STRONGER
 * outcome is asserted where the weaker one used to be, and the reserved-line behaviour is
 * asserted on `topQualificationLine`, which is the part of it that is still reachable.
 */
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

  it("now keeps the WHOLE Education row — the credential no longer arrives stripped", () => {
    // STRICTLY STRONGER THAN WHAT THIS TEST USED TO ASSERT, which was that the block went and one
    // reserved line came back. Shedding the block is forbidden, so the row survives complete: a
    // young worker whose certificate IS the signal now reaches the gate with the issuer and the
    // year on it, not just the four letters. The page pays for that by spilling.
    const r = degradeToFit(credentialled("ITI — Turner · NCVT, 2014 · Government ITI Faridabad"));
    expect(r.dropped).not.toContain("education");
    expect(r.overflows).toBe(true);
    const rows = new Map((r.sheet.qualFactRows ?? []).map((row) => [row.label, row.value]));
    expect(rows.get("Education")).toBe("ITI — Turner · NCVT, 2014 · Government ITI Faridabad");
    // No reserved line was needed, so none was invented — a duplicate credential row would be the
    // rider firing over a row that never left.
    expect([...rows.keys()]).not.toContain("Qualification");
  });

  it("reserves ONE line, not the row it came from", () => {
    // THE PART OF THE Q2 RIDER THAT IS STILL REACHABLE. `preserveTopQualification` re-inserts
    // whatever `topQualificationLine` picked, so what "one line, not the row" MEANS is decided
    // here: the credential segment alone, without the issuer and without the year. ~5 mm was the
    // costed price and one line is what that buys.
    const reserved = topQualificationLine(
      credentialled("ITI — Turner · NCVT, 2014 · Government ITI Faridabad"),
    );
    expect(reserved).toBe("ITI — Turner");
    expect(reserved).not.toContain("Government ITI Faridabad");
    expect(reserved).not.toContain("2014");
  });

  it("protects NOTHING when there is no credential to protect", () => {
    // "10th pass" is not a credential floor, and reserving it would be a larger promise than the
    // one that was ruled — it would also cost a line on the sheets that can least afford one.
    const schoolingOnly = sheet({
      qualFactRows: [{ label: "Education", value: "10th pass · Government High School" }],
    });
    expect(topQualificationLine(schoolingOnly)).toBeNull();
    // And where a real certificate exists the reserve falls to THAT rather than to the schooling
    // line — the fixture below carries an NTC/NCVT certificate alongside the "10th pass".
    expect(topQualificationLine(credentialled("10th pass · Government High School"))).not.toContain(
      "10th pass",
    );
    // Nothing is invented on the sheet either, now that the row itself is never shed.
    const r = degradeToFit(credentialled("10th pass · Government High School"));
    expect((r.sheet.qualFactRows ?? []).map((row) => row.label)).not.toContain("Qualification");
  });

  it("falls back to the certificate when education carries no credential", () => {
    expect(topQualificationLine(credentialled("10th pass"))).toContain("NCVT");
    const r = degradeToFit(credentialled("10th pass"));
    const values = (r.sheet.qualFactRows ?? []).map((row) => row.value).join(" | ");
    expect(values).toContain("NCVT");
  });

  it("survives a sheet that SPILLS, like availability and salary do", () => {
    // `stage > 4` used to stand for "the ladder went deep". It cannot any more — the deepest a
    // permitted ladder reaches on this sheet is stage 0 — so the pressure is asserted where it
    // now shows: the sheet spills and the credentials are still on it.
    const s = credentialled("ITI — Turner · NCVT, 2014");
    s.availFactRows = [{ label: "Salary expected", value: "₹24,000" }];
    const r = degradeToFit(s);
    expect(r.overflows).toBe(true);
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
