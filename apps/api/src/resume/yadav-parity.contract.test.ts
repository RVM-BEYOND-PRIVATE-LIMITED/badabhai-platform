import { describe, expect, it } from "vitest";

import { buildEmploymentBlock, type WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildQualificationRows, buildVerdictLine } from "./resume-sheet-rows";
import { buildSheetFooterMeta } from "./resume-sheet-footer";
import { appendConfiguration, buildTradeCapabilityRows } from "./trade-resume-map";
import { ResumeRenderer } from "./resume-renderer.service";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE YADAV PARITY CONTRACT (R9 §6) — the eight render rules the ratified sheet displays,
 * asserted one by one against the shipped mapper and the shipped template.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE TARGET. `Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator_Faridabad_BadaBhai.pdf` — a real CNC
 * turner's sheet has to sit beside it and read as the same document with different trade content.
 * Q8 ratified STRUCTURAL and DENSITY parity, not identical rows: same zones, same order, same
 * typography, same one-page density, same absence of holes — with Zone 2 carrying the rows that
 * are decisive for turning rather than the ones decisive for milling.
 *
 * WHY SOME OF THESE ARE `it.fails` AND THAT IS DELIBERATE.
 *
 * THREE of the eight rules do not hold today (R14 §4). Writing them as `it.todo` would make them
 * a note nothing enforces; deleting them would lose the specification; asserting them as `it` would
 * leave the suite red and unmergeable. `it.fails` is the honest third option: the test RUNS, the
 * assertion is real and executable, and the suite is green — but the moment someone implements
 * the rule the test goes RED and forces them to flip `it.fails` to `it`. The gap cannot rot into
 * a stale doc row, because the gap is the assertion.
 *
 * Each `it.fails` names exactly what is absent and where it would have to land. That list IS the
 * §2 gap table's executable half, and the two must agree — docs/profiling/yadav-parity-gap.md.
 *
 * THE COUNT ON THE LINE ABOVE WAS WRONG FROM THE DAY THIS FILE WAS WRITTEN, and correcting it is
 * R14 §4. It said "Five" while the file it introduces has only ever had FOUR `it.fails` (commit
 * `7f97b901`), and three since. Five is R9 §6's count of rules that did not hold BEFORE that
 * packet — rule 3 was implemented in the same commit and landed as a passing `it`, so the number
 * was stale before it was committed. A count that has to be maintained by hand beside a list the
 * runner already enumerates is the stale doc row this file's own argument exists to prevent, one
 * paragraph above where it makes it. Where the five stand, R14 §4:
 *
 *     rule 1  single-role on one line   OPEN   `it.fails` below. Implemented and REVERTED in R10:
 *                                              the merged line wraps and takes the parity sheet
 *                                              from degradationStage 0 to 2, shedding Languages
 *                                              and two chips. Blocked on the Zone 2 row-budget
 *                                              ruling (Q2), not on anyone implementing it.
 *     rule 3  configuration appended     GREEN  R10. First shipped user is the milling map (R13).
 *     rule 4  axis segment               GREEN as a unit — and UNREACHABLE: no mapper branch
 *                                              passes `axes`. Pinned in
 *                                              verdict-line-collapse.render.test.ts.
 *     rule 5  structured certificates    OPEN   `it.fails` below. Needs a frozen-contract change.
 *     rule 6  education, four components GREEN  R10 — and the `it.fails` it replaced was WRONGLY
 *                                              SPECIFIED: it asked the sheet to print a city the
 *                                              worker never gave, which §8 forbids.
 *     rule 8  verification state         OPEN   `it.fails` below. Phase 2 by ruling 3; no column
 *                                              exists and the spec forbids inventing the flag.
 *
 * VERBATIM FROM THE SAMPLE. Every expected string below is quoted from the extracted PDF text,
 * not paraphrased. Where the sample and our output differ, the difference is the finding.
 */

/** The Sandhar block — one employer, TWO dated roles. §11 #14, and the sample's hardest case. */
const PROMOTION: WorkerEmploymentRecord = {
  employer: "Sandhar Technologies Ltd",
  employerCity: "Gurugram",
  employerState: "Haryana",
  startYm: "2023-01",
  endYm: null,
  durationStated: true,
  roles: [
    {
      roleLabel: "VMC Setter-cum-Operator",
      startYm: "2024-07",
      endYm: null,
      workDone: "VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components",
    },
    {
      roleLabel: "VMC Operator",
      startYm: "2023-01",
      endYm: "2024-06",
      workDone: "VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components",
    },
  ],
};

/** The Amtek block — one employer, ONE role. The sample puts role and detail on one line. */
const SINGLE_ROLE: WorkerEmploymentRecord = {
  employer: "Amtek Auto Components Ltd",
  employerCity: "Faridabad",
  employerState: "Haryana",
  startYm: "2020-09",
  endYm: "2022-12",
  durationStated: true,
  roles: [
    {
      roleLabel: "VMC Operator",
      startYm: null,
      endYm: null,
      workDone: "VMC 3-axis Siemens, SPM · MS, aluminium",
    },
  ],
};

const AS_OF = new Date("2026-08-27T00:00:00Z");

describe("R9 §6 rule 1 — role and detail placement", () => {
  it("multi-role breaks the employer line, indents the roles, then prints the detail line", () => {
    // The sample's Sandhar block:
    //   Sandhar Technologies Ltd · Gurugram, Haryana        Jan 2023 – Present · 3 yrs 6 mo
    //       VMC Setter-cum-Operator  ·  Jul 2024 – Present · 2 yrs
    //       VMC Operator             ·  Jan 2023 – Jun 2024 · 1 yr 6 mo
    //       VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components
    const { employments } = buildEmploymentBlock([PROMOTION], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.role_inline, "a promotion must NOT collapse onto the employer line").toBe("");
    expect(emp.roles.map((r) => r.role)).toEqual(["VMC Setter-cum-Operator", "VMC Operator"]);
    // Each role carries its OWN range — that is the entire progression signal.
    expect(emp.roles[0]!.when).toContain("Jul 2024");
    expect(emp.roles[1]!.when).toContain("Jan 2023 – Jun 2024");
    expect(emp.work).toBe("VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components");
  });

  it.fails("single-role puts the role and the detail on ONE line, below the employer", () => {
    // THE SAMPLE:
    //   Amtek Auto Components Ltd · Faridabad, Haryana      Sep 2020 – Dec 2022 · 2 yrs
    //       VMC Operator  ·  VMC 3-axis Siemens, SPM · MS, aluminium
    //
    // TRIED IN R10 §2.5 AND MEASURED BACK OUT — which is the assertion working, not a decision to
    // skip it. Merging the role into the detail line keeps the same LINE COUNT but lengthens that
    // line, and on a fully-answered turner it wraps: the parity sheet moved from
    // `degradationStage: 0` to STAGE 2, shedding the Languages row and two materials chips. Under
    // R-2's own principle that is a worse sheet — it drops §5.1-ranked content to gain a
    // placement — and R9 §5 measured `SHEET_LINE_BUDGET = 41` as un-raiseable (42 puts two fixture
    // sheets below the floor). So this rule is blocked on the Zone 2 row-budget ruling, not on
    // anyone implementing it.
    const { employments } = buildEmploymentBlock([SINGLE_ROLE], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.role_inline).toBe("");
    expect(emp.roles).toHaveLength(1);
    expect(emp.roles[0]!.role).toBe("VMC Operator · VMC 3-axis Siemens, SPM · MS, aluminium");
  });
});

describe("R9 §6 rule 2 — where the months sit", () => {
  it("puts the employer total on the employer line and per-role months on the role lines", () => {
    const { employments } = buildEmploymentBlock([PROMOTION], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.when).toBe("Jan 2023 – Present · 3 yrs 8 mo");
    expect(emp.roles[0]!.when).toBe("Jul 2024 – Present · 2 yrs 2 mo");
    expect(emp.roles[1]!.when).toBe("Jan 2023 – Jun 2024 · 1 yr 6 mo");
  });

  it("right-aligns the employer dates in the rendered HTML", () => {
    // Structural rather than pixel-level: `.emp-head` is a flex row with space-between and the
    // date span is its last child, which is what right-alignment IS in this layout.
    const renderer = new ResumeRenderer(null as never);
    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      employments: buildEmploymentBlock([PROMOTION], { asOf: AS_OF }).employments,
    });
    expect(html).toContain("justify-content: space-between");
    // The date span closes the head row — nothing may follow it inside `.emp-head`.
    expect(html).toMatch(/<span class="emp-when">[^<]*<\/span><\/div>/);
  });
});

describe("R9 §6 rule 3 — configuration appends to the machine chip", () => {
  // R10 §2.5. `TradeRowSpec.configFrom` names a SECOND attribute whose values append to the row's
  // first chip. Asserted on the composition helper directly, because no SHIPPED map wires it yet:
  // `qp_cnc_turning` has no configuration question, since axes and spindle configurations are
  // milling facts. The mechanism is what makes a milling map a data change rather than a code
  // change (see the §3.1 estimate) — so the helper is the honest unit to pin.
  const AXES = { three: "3-axis", four: "4-axis" };

  it('appends with a middot — "VMC · 3-axis", not a separate axis row', () => {
    expect(appendConfiguration(["VMC", "SPM"], ["three", "four"], AXES)).toEqual([
      "VMC · 3-axis",
      "VMC · 4-axis",
      "SPM",
    ]);
  });

  it("does NOT build a cross product — the config qualifies the machine it was asked about", () => {
    // "SPM · 4-axis" for a man who runs a 4-axis VMC and a separate SPM is a claim he never made.
    const rows = appendConfiguration(["VMC", "SPM", "VTL"], ["four"], AXES);
    expect(rows).toEqual(["VMC · 4-axis", "SPM", "VTL"]);
    expect(rows.join(" ")).not.toContain("SPM · 4-axis");
  });

  it("leaves the row untouched when the worker answered no configuration", () => {
    expect(appendConfiguration(["VMC"], [], AXES)).toEqual(["VMC"]);
  });

  it("drops a configuration slug the dictionary does not know, like every other value here", () => {
    expect(appendConfiguration(["VMC"], ["five"], AXES)).toEqual(["VMC"]);
  });

  it("is inert for the shipped turner map, which has no configuration question", () => {
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      turning_machine: ["cnc_lathe", "vtl"],
    });
    expect(rows.chipRows.find((r) => r.label === "Machines")?.values).toEqual([
      "CNC lathe / turning centre",
      "VTL",
    ]);
  });
});

describe("R9 §6 rule 4 — the Verdict Line compresses adjacent axes", () => {
  it('appends "3 & 4-axis" as a fourth segment', () => {
    // R10 §2.5. The renderer's slot contract has documented a fourth segment since the sheet
    // shipped ("role · years · controllers · axis") while `buildVerdictLine` composed only three.
    const line = buildVerdictLine({
      role: "VMC Setter-cum-Operator",
      years: 8,
      tools: ["Fanuc", "Siemens", "Mitsubishi"],
      city: "Faridabad",
      availability: "15 days",
      salary: null,
      axes: ["3-axis", "4-axis"],
    });
    expect(line.headlineLine).toBe(
      "VMC Setter-cum-Operator · 8 yrs · Fanuc, Siemens, Mitsubishi · 3 & 4-axis",
    );
  });

  it("compresses by SHARED SUFFIX, not by arithmetic adjacency", () => {
    // "3 & 5-axis" is correct: treating 3 and 5 as implying 4 would put a capability on the sheet
    // the worker never claimed.
    const of = (axes: string[]) =>
      buildVerdictLine({
        role: "R",
        years: 8,
        tools: [],
        city: null,
        availability: null,
        salary: null,
        axes,
      }).headlineLine;
    expect(of(["3-axis", "5-axis"])).toContain("3 & 5-axis");
    expect(of(["3-axis"])).toContain("3-axis");
    // Nothing to share: joined plainly rather than mangled.
    expect(of(["3-axis", "twin-spindle"])).toContain("3-axis, twin-spindle");
  });

  it("takes its separator with it when the trade has no axis ask", () => {
    // The turner case. `qp_cnc_turning` has no axis question, so the segment is absent and the
    // line must not end with a dangling middot.
    const line = buildVerdictLine({
      role: "CNC Setter-cum-Operator",
      years: 8,
      tools: ["Fanuc"],
      city: null,
      availability: null,
      salary: null,
    });
    expect(line.headlineLine).toBe("CNC Setter-cum-Operator · 8 yrs · Fanuc");
  });

  it("does cap the controllers at three, which the sample also does", () => {
    const line = buildVerdictLine({
      role: "R",
      years: 8,
      tools: ["Fanuc", "Siemens", "Mitsubishi", "Haas"],
      city: null,
      availability: null,
      salary: null,
    });
    expect(line.headlineLine).toContain("Fanuc, Siemens, Mitsubishi");
    expect(line.headlineLine).not.toContain("Haas");
  });
});

describe("R9 §6 rule 5 — certificates carry issuer, city and year", () => {
  it.fails('renders "Name (Issuer, City, Year)" joined by a middot', () => {
    // THE SAMPLE:
    //   Certificates  CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021)
    //                 · Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)
    //
    // MISSING LINK: `certifications` is a `string[]` on DraftProfileSchema — one opaque label per
    // certificate with no issuer, city or year field to put anywhere. `buildQualificationRows`
    // joins the strings and can only print what it is given. The composition rule is not the
    // problem; the SHAPE is. Structured rows are a contract change (a joint TS + Python + fixture
    // PR), which is why this is a gap-table row rather than an edit.
    const rows = buildQualificationRows({
      educationHeadline: null,
      education: [],
      certifications: ["CNC / VMC Programming & Setting", "Fire & Safety Awareness"],
      languages: [],
    });
    expect(rows.find((r) => r.label === "Certificates")?.value).toBe(
      "CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021) · " +
        "Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)",
    );
  });
});

describe("R9 §6 rule 6 — education is four components plus the institute's city", () => {
  it("composes level, trade, council, year and institute into one line", () => {
    // R9 §3 BUILT THE THREE MISSING COMPONENTS. The level and the trade are interview answers
    // riding the crosswalk; the council, year and institute are the finishing form's, because a
    // closed council set is the only way §4.5's "never collapse NCVT and SCVT" is enforceable —
    // before this, nothing in the system could even represent the distinction.
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma", education_field: "Machinist" },
      "Ramesh Kumar Yadav",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {
          education_council: "ncvt",
          education_year: 2018,
          education_institute: "Govt. ITI, Faridabad",
        },
      },
    );
    // ENGLISH, per R10 R-3. The level was "ITI ya diploma" until the owner ruled: the PDF is the
    // employer-facing artifact and follows Decision 4's English content; the app stays Hinglish
    // per #963, which is §11 #17's audience-split pattern rather than a new exception.
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toBe(
      "ITI / Diploma — Machinist · NCVT · 2018 · Govt. ITI, Faridabad",
    );
  });

  it("drops each absent segment WITH its separator", () => {
    // A worker who gave only the council must not get "ITI · NCVT ·  · ".
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { education_council: "scvt" } },
    );
    const value = input.qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(value).toBe("ITI / Diploma · SCVT");
    expect(value).not.toMatch(/·\s*·/);
  });

  it("keeps NCVT and SCVT distinct, which §4.5 requires and nothing could do before", () => {
    const of = (council: string) =>
      buildResumeRenderInput(
        { education_level: "iti_diploma" },
        "R",
        "bb_trade",
        null,
        false,
        "worker",
        {
          packId: "qp_cnc_turning",
          attributes: { education_council: council },
        },
      ).qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(of("ncvt")).toContain("NCVT");
    expect(of("scvt")).toContain("SCVT");
    expect(of("ncvt")).not.toBe(of("scvt"));
  });

  it("prints the education LEVEL in English (R10 R-3, ruled)", () => {
    // THE CONFLICT R9 LOGGED, NOW RULED. `KNOWN_EDUCATION_LEVELS` printed the pack's Hinglish chip
    // labels ("ITI ya diploma", "Dasvi paas") on the argument that the résumé should say back the
    // words the worker tapped; #963 names "10th se kam" and the app shows it. But Zone 5's other
    // vocabulary prints English "because this half of the sheet is read by a hiring supervisor",
    // and the two sat on the SAME ROW.
    //
    // R-3: Decision 4 rules English content because the employer's advertisement is in English,
    // and the PDF is the employer-facing artifact. The app stays Hinglish — §11 #17 already
    // establishes these two surfaces differing by audience, so this is that pattern.
    const of = (level: string) =>
      buildResumeRenderInput({ education_level: level }, "R", "bb_trade", null, false, "worker", {
        packId: "qp_cnc_turning",
        attributes: {},
      }).qualFactRows?.find((r) => r.label === "Education")?.value;

    expect(of("iti_diploma")).toBe("ITI / Diploma");
    expect(of("10")).toBe("10th pass");
    expect(of("12")).toBe("12th pass");
    expect(of("graduate")).toBe("Graduate");
    expect(of("below_10")).toBe("Below 10th");
    // Nothing Hinglish survives on this row.
    for (const level of ["iti_diploma", "10", "12", "graduate", "below_10"]) {
      expect(of(level)).not.toMatch(/paas|ya diploma|se kam|Graduation/);
    }
  });

  it("distinguishes an ITI from a Diploma, which the sample does", () => {
    // R11 §3.1 — CLOSED, AND THE FIX IS NOT WHERE THIS TEST ORIGINALLY SAID IT WOULD BE.
    //
    // The `it.fails` this replaces described the gap correctly — Yadav prints "ITI — Machinist" and
    // we printed "ITI / Diploma — Machinist", because `qp_universal`'s education question offers
    // ONE option covering both ("ITI ya diploma", value_text `iti_diploma`) — but it proposed
    // splitting the pack option, and that turned out to be the one route not available. A
    // published pack version is IMMUTABLE and a session pins `(pack_id, version)` for its whole
    // length: editing @2 in place is forbidden, and publishing @3 would still leave every worker
    // mid-interview on @2 answering the merged option, and could never reach a worker who has
    // already finished.
    //
    // So the credential is captured on the finishing form, the same routing and the same closed-set
    // shape as NCVT/SCVT one row above — which reaches finished workers too.
    const of = (attributes: Record<string, unknown>) =>
      buildResumeRenderInput(
        { education_level: "iti_diploma", education_field: "Machinist" },
        "R",
        "bb_trade",
        null,
        false,
        "worker",
        { packId: "qp_cnc_turning", attributes },
      ).qualFactRows?.find((r) => r.label === "Education")?.value;

    expect(of({ education_credential: "iti" })).toBe("ITI — Machinist");
    expect(of({ education_credential: "diploma" })).toBe("Diploma — Machinist");
  });

  it("still prints the merged label for a worker who never answered the form", () => {
    // THE HALF THAT MATTERS MORE, and the reason this is additive rather than a migration.
    // Every worker who finished before R11 has no `education_credential` row. His sheet must
    // render exactly as it did — unspecific, not wrong, and certainly not guessed at.
    const value = buildResumeRenderInput(
      { education_level: "iti_diploma", education_field: "Machinist" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: {} },
    ).qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(value).toBe("ITI / Diploma — Machinist");
  });

  it("NARROWS ONLY THE MERGED LEVEL — a graduate is never demoted to his diploma", () => {
    // THE PROPERTY THIS FEATURE IS REALLY ABOUT, and the direction it must never fail in. A man
    // who holds a polytechnic diploma AND a degree answers `graduate` in the interview; if he
    // also ticks "Diploma" on the form, an override keyed on the credential alone would print
    // "Diploma" and cost him the qualification he actually leads with. That is the
    // under-representation failure R10 R-2 built a gate for, arriving by a different door.
    const of = (level: string) =>
      buildResumeRenderInput({ education_level: level }, "R", "bb_trade", null, false, "worker", {
        packId: "qp_cnc_turning",
        attributes: { education_credential: "diploma" },
      }).qualFactRows?.find((r) => r.label === "Education")?.value;

    expect(of("graduate")).toBe("Graduate");
    expect(of("12")).toBe("12th pass");
    expect(of("10")).toBe("10th pass");
    expect(of("below_10")).toBe("Below 10th");
  });

  it("drops an unknown credential slug rather than printing it", () => {
    // The same drop-the-unknown rule every dictionary on this sheet follows. A slug that stops
    // being a legal option must stop appearing, not start appearing raw.
    const value = buildResumeRenderInput(
      { education_level: "iti_diploma" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { education_credential: "polytechnic" } },
    ).qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(value).toBe("ITI / Diploma");
  });

  it("prints the institute exactly as the worker gave it, city and all", () => {
    // R10 §2.5 — AND A CORRECTION TO THIS TEST'S OWN SPECIFICATION. It was written as an
    // `it.fails` expecting "Govt. ITI" to render as "Govt. ITI, Faridabad", i.e. expecting the
    // sheet to SUPPLY a city the worker never typed. That is the derived claim §8 forbids, and
    // deriving a city from an institute name is exactly the kind of inference the fabrication
    // gate exists to stop. The rule the sample actually shows is that the institute prints
    // verbatim — and Yadav's worker typed the city himself.
    const of = (institute: string) =>
      buildResumeRenderInput(
        { education_level: "iti_diploma" },
        "R",
        "bb_trade",
        null,
        false,
        "worker",
        {
          packId: "qp_cnc_turning",
          attributes: { education_council: "ncvt", education_institute: institute },
        },
      ).qualFactRows?.find((r) => r.label === "Education")?.value;

    expect(of("Govt. ITI, Faridabad")).toBe("ITI / Diploma · NCVT · Govt. ITI, Faridabad");
    // And a worker who gave no city gets no city. The segment is his string, not ours.
    expect(of("Govt. ITI")).toBe("ITI / Diploma · NCVT · Govt. ITI");
  });
});

describe("R9 §6 rule 7 — the documents row wraps with its tick prefix preserved", () => {
  it("renders every document as its own ticked item", () => {
    // The sample wraps seven documents across two lines and every one keeps its tick. Ours are
    // list items inside `ul.ticks`, so the marker is per-item by construction and a wrap cannot
    // strip it — which is exactly why it is a list row rather than a joined sentence.
    const renderer = new ResumeRenderer(null as never);
    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      qualTickRows: [
        {
          label: "Documents ready",
          values: [
            "Aadhaar",
            "PAN",
            "Bank account",
            "UAN / PF",
            "ITI certificate",
            "Experience letter",
            "Passport photos",
          ],
        },
      ],
    });
    expect(html).toContain('class="ticks"');
    for (const doc of ["Aadhaar", "PAN", "UAN / PF", "Passport photos"]) {
      expect(html).toContain(`<li>${doc}</li>`);
    }
    // The tick is a CSS marker on the item, so it survives any wrap.
    expect(html).toMatch(/\.ticks\s*>\s*li[^}]*content:/);
  });
});

describe("R9 §6 rule 8 — the verification state appears twice", () => {
  it("has a masthead slot and a footer segment, and they take the same value", () => {
    const renderer = new ResumeRenderer(null as never);
    const footer = buildSheetFooterMeta({
      generatedAt: new Date("2026-08-27T00:00:00Z"),
      trustBadge: "RVM-attested",
      refCode: "RK8M2Q",
    });
    expect(footer).toContain("RVM-attested");
    expect(footer).toContain("Ref RK8M2Q");

    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      trustBadge: "RVM-attested",
      footerMeta: footer,
    });
    // Twice on the page: the masthead's right slot and the footer meta line.
    expect(html.split("RVM-attested").length - 1).toBeGreaterThanOrEqual(2);
  });

  it.fails("is reachable for a real worker — something must be able to SET it", () => {
    // The two slots exist and both render. NOTHING CAN FILL THEM: there is no verification column
    // on `workers` or `worker_profiles`, and `resume-render.processor.ts` hardcodes
    // `trustBadge: null` with the comment "No verification tier exists in the schema yet".
    //
    // So Yadav's "RVM-attested" is unreachable for every worker in the database, and the
    // unverified state — a blank right slot — is the only state the product can currently
    // produce. That is Phase 2 by ruling 3, and it is recorded here so the slot is not mistaken
    // for a working feature.
    const source = String(buildSheetFooterMeta);
    expect(source).toContain("VERIFICATION_IS_REACHABLE");
  });
});

describe("R9 §7 — the sheet assembles end to end at Yadav's density", () => {
  it("renders all six zones for a fully-populated turner without a hole", () => {
    // Not a parity assertion — a NO-HOLES assertion. Every zone that the sample fills must be
    // non-empty when the equivalent turner data is present, because §1's acceptance test is
    // "same zones, same density, no holes" rather than "same rows".
    const input = buildResumeRenderInput(
      {
        experience: { total_years: 8 },
        education_level: "iti_diploma",
        education_field: "Turner",
        certifications: ["CNC Programming & Setting"],
        salary_expectation: { amount_min: 32000 },
        location_preference: { current_city: "Faridabad" },
        availability: { status: "notice_period", notice_period_days: 15 },
        resume_profile: {
          role_label: "CNC Setter-cum-Operator",
          skills: ["CNC turning"],
          experiences: [],
          current_city: "Faridabad",
          availability: "15_days",
          expected_salary: 32000,
        },
      },
      "Ramesh Kumar Yadav",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {
          turning_machine: ["cnc_lathe", "conventional_lathe"],
          controller_brand: ["fanuc", "siemens"],
          material_worked: ["mild_steel", "alloy_steel"],
          setting_operation: ["tool_offset", "work_offset"],
          measuring_tools: ["vernier", "micrometer"],
          programming_level: ["edit_program"],
          drawing_reading: ["gdt"],
          tolerance_band: ["0.02"],
          languages: ["hindi", "english"],
          documents_ready: ["aadhaar", "pan"],
          // SCALARS, NOT ONE-ELEMENT ARRAYS, and the difference is real rather than cosmetic.
          // `answer-capture.ts:162` wraps a `multi_select` and leaves a `single_select` bare, so
          // the two land in different columns (`value_text_list` vs `value_text`) and
          // `worker-attributes.repository.ts` reads each back in its own shape.
          // `readPreferenceFacts` reads these two through `scalar()`, which correctly refuses an
          // array. The persona harness fixtures wrap every chip in an array, which is harmless
          // for the capability rows (`slugsOf` accepts both) and WRONG here — that mismatch is
          // what this fixture originally had, and it looked like a missing Shift row.
          shift_preference: "rotational",
          job_type: "permanent",
        },
        employments: [PROMOTION, SINGLE_ROLE],
        asOf: AS_OF,
        phone: "+91 98765 43210",
        qrDataUri: "data:image/png;base64,AAA",
        qrCaption: "Scan to open this worker's live profile",
        shortLink: "badabhai.ai",
        footerMeta: "Generated 27 August 2026 · Self-declared · Ref RK8M2Q",
      },
    );

    // Zone 1
    expect(input.headlineLine).toContain("8 yrs");
    expect(input.subheadLine).toContain("Faridabad");
    expect(input.phone).toBe("+91 98765 43210");
    // Zone 2
    expect(input.capSectionTitle).toBeTruthy();
    expect((input.capChipRows?.length ?? 0) + (input.capTickRows?.length ?? 0)).toBeGreaterThan(3);
    expect(input.capFactRows?.some((r) => r.label === "Tolerance held")).toBe(true);
    // Zone 3
    expect(input.availFactRows?.some((r) => r.label === "Available from")).toBe(true);
    expect(input.availFactRows?.some((r) => r.label === "Shift")).toBe(true);
    // Zone 4
    expect(input.employments).toHaveLength(2);
    // Zone 5
    expect(input.qualFactRows?.some((r) => r.label === "Education")).toBe(true);
    expect(input.qualFactRows?.some((r) => r.label === "Languages spoken")).toBe(true);
    expect(input.qualTickRows?.some((r) => r.label === "Documents ready")).toBe(true);
    // Zone 6
    expect(input.qrDataUri).toBeTruthy();
    expect(input.footerMeta).toContain("Ref RK8M2Q");
  });
});
